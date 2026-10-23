const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { inspectMachOExports, createMachOExportInspector } = require("../src/modules/shared/runtime/macho-exports");
const Observations = require("../src/core/file-observations");

const ARM64 = 0x0100000c, X64 = 0x01000007;
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-macho-exports-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return (bytes, name = "library.dylib") => {
    const file = path.join(root, name); fs.writeFileSync(file, bytes); return file;
  };
}
function uleb(value) {
  value = BigInt(value);
  const bytes = [];
  do { bytes.push(Number(value & 0x7fn) | (value > 127n ? 0x80 : 0)); value >>= 7n; } while (value);
  return Buffer.from(bytes);
}
function terminal(flags = 0, address = 1, extra) {
  return Buffer.concat([uleb(flags), uleb(address), extra || Buffer.alloc(0)]);
}
function trie(root) {
  const nodes = [], ids = new Map();
  const visit = node => {
    if (ids.has(node)) return;
    ids.set(node, nodes.length); nodes.push(node);
    for (const child of node.children || []) visit(child.node);
  };
  visit(root);
  let offsets = nodes.map(() => 0), data;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    data = nodes.map(node => {
      const info = node.terminal || Buffer.alloc(0), children = node.children || [];
      return Buffer.concat([uleb(info.length), info, Buffer.from([children.length]), ...children.flatMap(child =>
        [Buffer.from(child.edge), Buffer.from([0]), uleb(offsets[ids.get(child.node)])])]);
    });
    let position = 0;
    const next = data.map(bytes => { const start = position; position += bytes.length; return start; });
    if (next.every((offset, i) => offset === offsets[i])) return Buffer.concat(data);
    offsets = next;
  }
  throw new Error("Fixture offsets did not converge.");
}
function exportsTrie(names) {
  return trie({ children: names.map(name => ({ edge: name, node: { terminal: terminal() } })) });
}
function thin({ cpu = ARM64, wide = !!(cpu & 0x01000000), little = true, exports, legacy = false, rows, dynamic, extraCommands = [] } = {}) {
  const headerSize = wide ? 32 : 28, commands = [], parts = [];
  const write = (bytes, value, offset) => little ? bytes.writeUInt32LE(value, offset) : bytes.writeUInt32BE(value, offset);
  const command = (kind, size) => { const bytes = Buffer.alloc(size); write(bytes, kind, 0); write(bytes, size, 4); commands.push(bytes); return bytes; };
  const exportCommand = exports !== undefined ? command(legacy ? 0x80000022 : 0x80000033, legacy ? 48 : 16) : null;
  const symbolCommand = rows ? command(2, 24) : null;
  const dynamicCommand = dynamic ? command(11, 80) : null;
  commands.push(...extraCommands);
  let position = headerSize + commands.reduce((size, bytes) => size + bytes.length, 0);
  const append = bytes => { const offset = position; position += bytes.length; parts.push(bytes); return offset; };
  if (exportCommand) {
    write(exportCommand, append(exports), legacy ? 40 : 8);
    write(exportCommand, exports.length, legacy ? 44 : 12);
  }
  if (rows) {
    const stride = wide ? 16 : 12, records = Buffer.alloc(rows.length * stride), strings = [Buffer.from([0])];
    let stringOffset = 1;
    rows.forEach((row, index) => {
      const name = Buffer.concat([Buffer.from(row.name), Buffer.from([0])]);
      write(records, row.stringOffset ?? stringOffset, index * stride);
      records[index * stride + 4] = row.type ?? 0x0f;
      records[index * stride + 5] = row.section ?? 1;
      if (wide) {
        if (little) records.writeBigUInt64LE(BigInt(row.value ?? 1), index * stride + 8);
        else records.writeBigUInt64BE(BigInt(row.value ?? 1), index * stride + 8);
      } else write(records, row.value ?? 1, index * stride + 8);
      strings.push(name); stringOffset += name.length;
    });
    write(symbolCommand, append(records), 8); write(symbolCommand, rows.length, 12);
    write(symbolCommand, append(Buffer.concat(strings)), 16); write(symbolCommand, stringOffset, 20);
  }
  if (dynamicCommand) for (const [index, name] of ["local", "external", "undefined"].entries()) {
    const [start, count] = dynamic[name] || [0, 0];
    write(dynamicCommand, start, 8 + index * 8); write(dynamicCommand, count, 12 + index * 8);
  }
  const header = Buffer.alloc(headerSize);
  write(header, wide ? 0xfeedfacf : 0xfeedface, 0); write(header, cpu, 4); write(header, 6, 12);
  write(header, commands.length, 16); write(header, commands.reduce((size, bytes) => size + bytes.length, 0), 20);
  return Buffer.concat([header, ...commands, ...parts]);
}
function universal(slices, { wide = false, little = false } = {}) {
  const stride = wide ? 32 : 20, header = Buffer.alloc(8 + slices.length * stride);
  const write = (value, offset) => little ? header.writeUInt32LE(value, offset) : header.writeUInt32BE(value, offset);
  write(wide ? 0xcafebabf : 0xcafebabe, 0); write(slices.length, 4);
  let position = header.length, parts = [header];
  for (let i = 0; i < slices.length; i += 1) {
    const slice = slices[i], entry = 8 + i * stride;
    const padding = (8 - position % 8) % 8; parts.push(Buffer.alloc(padding)); position += padding;
    write(slice.cpu, entry);
    if (wide) {
      if (little) { header.writeBigUInt64LE(BigInt(position), entry + 8); header.writeBigUInt64LE(BigInt(slice.bytes.length), entry + 16); }
      else { header.writeBigUInt64BE(BigInt(position), entry + 8); header.writeBigUInt64BE(BigInt(slice.bytes.length), entry + 16); }
    } else { write(position, entry + 8); write(slice.bytes.length, entry + 12); }
    write(3, entry + (wide ? 24 : 16)); parts.push(slice.bytes); position += slice.bytes.length;
  }
  return Buffer.concat(parts);
}
function observedIO(onRead) {
  const counts = { opens: 0, bytes: 0, closes: 0 };
  const fileSystem = {
    realpath: (...args) => fs.promises.realpath(...args), stat: (...args) => fs.promises.stat(...args),
    open: async (...args) => {
      counts.opens += 1;
      const handle = await fs.promises.open(...args);
      return {
        stat: () => handle.stat(), close: async () => { counts.closes += 1; await handle.close(); },
        read: async (...input) => {
          const result = await handle.read(...input); counts.bytes += result.bytesRead;
          if (onRead) await onRead(result, counts);
          return result;
        },
      };
    },
  };
  return { fileSystem, counts };
}

test("modern and legacy export tries return only exact defined names and normalize one underscore", async t => {
  const write = fixture(t);
  const exports = trie({ children: [
    { edge: "_SteamAPI_", node: { children: [
      { edge: "Init", node: { terminal: terminal() } },
      { edge: "RunCallbacks", node: { terminal: terminal(4) } },
    ] } },
    { edge: "___keep", node: { terminal: terminal(2) } },
    { edge: "_Thread", node: { terminal: terminal(1) } },
    { edge: "_Resolver", node: { terminal: terminal(0x10, 1, uleb(2)) } },
    { edge: "_Imported", node: { terminal: terminal(8, 1, Buffer.from("_Other\0")) } },
  ] });
  for (const legacy of [false, true]) {
    const file = write(thin({ exports, legacy, rows: [{ name: "_NotAnExport" }] }), `library-${legacy}.dylib`);
    assert.deepEqual(await inspectMachOExports(file, { arch: "arm64" }), ["Resolver", "SteamAPI_Init", "SteamAPI_RunCallbacks", "Thread", "__keep"]);
  }
});

test("a modern explicitly empty export trie is authoritative over external symbol records", async t => {
  const file = fixture(t)(thin({ exports: Buffer.alloc(0), rows: [{ name: "_OnlyInSymbolTable" }] }));
  assert.deepEqual(await inspectMachOExports(file, { arch: "arm64" }), []);
});

test("universal 32/64 tables and either byte order select the actual requested slice", async t => {
  const write = fixture(t), slices = [
    { cpu: X64, bytes: thin({ cpu: X64, exports: exportsTrie(["_IntelOnly"]) }) },
    { cpu: ARM64, bytes: thin({ exports: exportsTrie(["_ArmOnly"]) }) },
  ];
  for (const wide of [false, true]) for (const little of [false, true]) {
    const file = write(universal(slices, { wide, little }), `${wide}-${little}.dylib`);
    assert.deepEqual(await inspectMachOExports(file, { arch: "arm64" }), ["ArmOnly"]);
    assert.deepEqual(await inspectMachOExports(file, { arch: "x64" }), ["IntelOnly"]);
    assert.deepEqual(await inspectMachOExports(file, { arch: "x86_64" }), ["IntelOnly"]);
    await assert.rejects(inspectMachOExports(file, { arch: "ia32" }), { code: "MACHO_ARCH" });
  }
});

test("symbol fallback handles thin 32/64 and either endian without mistaking imports or locals for exports", async t => {
  const write = fixture(t), rows = [
    { name: "_Defined" }, { name: "_Absolute", type: 3, section: 0, value: 0 },
    { name: "_Undefined", type: 1, section: 0 }, { name: "_Local", type: 14 },
    { name: "_PrivateExternal", type: 0x1f }, { name: "_Debug", type: 0xe1 },
    { name: "_Indirect", type: 11, section: 0 },
  ];
  for (const wide of [false, true]) for (const little of [false, true]) {
    const file = write(thin({ cpu: wide ? X64 : 7, wide, little, rows }), `symbols-${wide}-${little}.dylib`);
    assert.deepEqual(await inspectMachOExports(file, { arch: wide ? "x64" : "ia32" }), ["Absolute", "Defined"]);
  }
});

test("LC_DYSYMTAB restricts fallback to its defined external group and validates group bounds", async t => {
  const write = fixture(t), rows = [{ name: "_OutsideDefinedGroup" }, { name: "_Actual" }, { name: "_NotPublic" }];
  const file = write(thin({ rows, dynamic: { local: [0, 1], external: [1, 1], undefined: [2, 1] } }));
  assert.deepEqual(await inspectMachOExports(file, { arch: "arm64" }), ["Actual"]);
  const invalid = write(thin({ rows, dynamic: { external: [2, 2] } }), "invalid.dylib");
  await assert.rejects(inspectMachOExports(invalid, { arch: "arm64" }), /dynamic symbol group range/);
});

test("trie traversal accepts shared suffix nodes and UTF-8 split across edges", async t => {
  const leaf = { terminal: terminal() }, second = { children: [{ edge: Buffer.from([0xa9]), node: leaf }] };
  const root = { children: [
    { edge: "_First", node: leaf }, { edge: "_Second", node: leaf },
    { edge: Buffer.from([0x5f, 0xc3]), node: second },
  ] };
  const file = fixture(t)(thin({ exports: trie(root) }));
  assert.deepEqual(await inspectMachOExports(file, { arch: "arm64" }), ["First", "Second", "é"]);
});

test("legacy empty terminal edges preserve exported prefixes without inventing names or admitting cycles", async t => {
  const write = fixture(t), leaf = { terminal: terminal() };
  // The official steamworks4j 1.9.0 JNI image has this shape for
  // getFavoriteGame and getFavoriteGameCount, among other prefix pairs.
  const file = write(thin({ exports: trie({ children: [{ edge: "_getFavoriteGame", node: { children: [
    { edge: "Count", node: leaf }, { edge: "", node: leaf },
  ] } }] }) }));
  assert.deepEqual(await inspectMachOExports(file, { arch: "arm64" }), ["getFavoriteGame", "getFavoriteGameCount"]);
  const cycle = { children: [] }; cycle.children.push({ edge: "", node: cycle });
  await assert.rejects(inspectMachOExports(write(thin({ exports: trie(cycle) }), "empty-cycle"), { arch: "arm64" }), /Cycle/);
  const duplicate = trie({ children: [{ edge: "_Prefix", node: { children: [
    { edge: "", node: leaf }, { edge: "", node: leaf },
  ] } }] });
  await assert.rejects(inspectMachOExports(write(thin({ exports: duplicate }), "duplicate-empty"), { arch: "arm64" }), /Duplicated export edge/);
  await assert.rejects(inspectMachOExports(write(thin({ exports: trie({ children: [{ edge: "", node: leaf }] }) }), "empty-name"), { arch: "arm64" }), /Empty defined symbol/);
  const reexport = trie({ children: [{ edge: "_Foreign", node: { children: [
    { edge: "", node: { terminal: terminal(8, 1, Buffer.from("\0")) } },
  ] } }] });
  assert.deepEqual(await inspectMachOExports(write(thin({ exports: reexport }), "empty-reexport"), { arch: "arm64" }), []);
});

test("cycles, out-of-range children, overflowing ULEB and bad terminal sizes fail closed", async t => {
  const write = fixture(t), cycle = { children: [] };
  cycle.children.push({ edge: "_Loop", node: cycle });
  const cases = [
    [trie(cycle), /Cycle/],
    [Buffer.from([0, 1, 65, 0, 127]), /child offset/],
    [Buffer.alloc(11, 0xff), /Overflowing.*ULEB/],
    [Buffer.from([2, 0, 0]), /Missing export child count/],
    [trie({ children: [{ edge: "_Broken", node: { terminal: Buffer.from([0, 1, 1]) } }] }), /terminal size/],
    [trie({ children: [{ edge: "_UnknownFlags", node: { terminal: terminal(64) } }] }), /terminal flags/],
  ];
  for (const [index, [exports, message]] of cases.entries()) {
    await assert.rejects(inspectMachOExports(write(thin({ exports }), `malformed-${index}.dylib`), { arch: "arm64" }), message);
  }
});

test("names and traversal depth are bounded independently of source size", async t => {
  const write = fixture(t);
  const long = write(thin({ exports: exportsTrie(["_" + "x".repeat(4096)]) }), "long.dylib");
  await assert.rejects(inspectMachOExports(long, { arch: "arm64" }), /oversized|name bytes/);
  let root = { terminal: terminal() };
  for (let i = 0; i < 514; i += 1) root = { children: [{ edge: "a", node: root }] };
  const deep = write(thin({ exports: trie(root) }), "deep.dylib");
  await assert.rejects(inspectMachOExports(deep, { arch: "arm64" }), { code: "MACHO_LIMIT" });
});

test("bad magic, architecture, load commands and metadata ranges are rejected before unsafe reads", async t => {
  const write = fixture(t);
  await assert.rejects(inspectMachOExports("relative.dylib", { arch: "arm64" }), { code: "MACHO_PATH" });
  await assert.rejects(inspectMachOExports(write(Buffer.alloc(40), "not-macho"), { arch: "arm64" }), /not Mach-O/);
  await assert.rejects(inspectMachOExports(write(thin({ cpu: X64 }), "wrong-arch"), { arch: "arm64" }), { code: "MACHO_ARCH" });
  const count = thin(); count.writeUInt32LE(8193, 16);
  await assert.rejects(inspectMachOExports(write(count, "too-many"), { arch: "arm64" }), { code: "MACHO_LIMIT" });
  const bytes = thin({ exports: Buffer.from([0, 0]) }); bytes.writeUInt32LE(0xffffffff, 44);
  await assert.rejects(inspectMachOExports(write(bytes, "too-big"), { arch: "arm64" }), { code: "MACHO_LIMIT" });
  const outside = thin({ exports: Buffer.from([0, 0]) }); outside.writeUInt32LE(500, 40);
  await assert.rejects(inspectMachOExports(write(outside, "outside"), { arch: "arm64" }), /export trie range/);
  const malformed = thin({ exports: Buffer.from([0, 0]) }); malformed.writeUInt32LE(8, 36);
  await assert.rejects(inspectMachOExports(write(malformed, "short-command"), { arch: "arm64" }), /Truncated export load command/);
  const tooManySymbols = thin({ rows: [] }); tooManySymbols.writeUInt32LE(262145, 44);
  await assert.rejects(inspectMachOExports(write(tooManySymbols, "too-many-symbols"), { arch: "arm64" }), { code: "MACHO_LIMIT" });
});

test("universal slice bounds, overlaps, duplicate architecture and header mismatches are rejected", async t => {
  const write = fixture(t), slices = [{ cpu: X64, bytes: thin({ cpu: X64 }) }, { cpu: ARM64, bytes: thin() }];
  const overlap = universal(slices); overlap.writeUInt32BE(overlap.readUInt32BE(16), 36);
  await assert.rejects(inspectMachOExports(write(overlap, "overlap"), { arch: "arm64" }), /Overlapping/);
  const outside = universal(slices); outside.writeUInt32BE(0xffffff00, 36);
  await assert.rejects(inspectMachOExports(write(outside, "outside"), { arch: "arm64" }), /slice range/);
  const duplicate = universal([{ cpu: ARM64, bytes: thin() }, { cpu: ARM64, bytes: thin() }]);
  await assert.rejects(inspectMachOExports(write(duplicate, "duplicate"), { arch: "arm64" }), /ambiguous slices/);
  const mismatch = universal([{ cpu: ARM64, bytes: thin({ cpu: X64 }) }]);
  await assert.rejects(inspectMachOExports(write(mismatch, "mismatch"), { arch: "arm64" }), { code: "MACHO_ARCH" });
});

test("fallback rejects invalid strings instead of fabricating a symbol name", async t => {
  const write = fixture(t);
  await assert.rejects(inspectMachOExports(write(thin({ rows: [{ name: "_Name", stringOffset: 99 }] }), "offset"), { arch: "arm64" }), /string offset/);
  const unterminated = thin({ rows: [{ name: "_Name" }] }); unterminated[unterminated.length - 1] = 65;
  await assert.rejects(inspectMachOExports(write(unterminated, "unterminated"), { arch: "arm64" }), /Unterminated/);
  await assert.rejects(inspectMachOExports(write(thin({ rows: [{ name: Buffer.from([0x5f, 0xff]) }] }), "utf8"), { arch: "arm64" }), /UTF-8/);
});

test("parallel callers share bounded inspection, copies cannot corrupt the cache, and replacement invalidates it", async t => {
  const file = fixture(t)(thin({ cpu: X64, exports: exportsTrie(["_First"]) }));
  const io = observedIO(), inspect = createMachOExportInspector(io);
  const values = await Promise.all([inspect(file, { arch: "x64" }), inspect(file, { arch: "x86_64" }), inspect(file, { arch: "x64" })]);
  assert.equal(io.counts.opens, 1); assert.equal(io.counts.closes, 1);
  values[0].push("Tampered");
  assert.deepEqual(await inspect(file, { arch: "x64" }), ["First"]);
  const replacement = path.join(path.dirname(file), "replacement");
  fs.writeFileSync(replacement, thin({ cpu: X64, exports: exportsTrie(["_Second"]) })); fs.renameSync(replacement, file);
  assert.deepEqual(await inspect(file, { arch: "x64" }), ["Second"]);
  assert.equal(io.counts.opens, 2);
});

test("source replacement during a range read fails and is not retained as a cached success", async t => {
  const write = fixture(t), file = write(thin({ exports: exportsTrie(["_Old"]) }));
  let replaced = false;
  const io = observedIO(() => {
    if (replaced) return;
    replaced = true;
    const replacement = write(thin({ exports: exportsTrie(["_New"]) }), "replacement");
    fs.renameSync(replacement, file);
  });
  const inspect = createMachOExportInspector(io);
  await assert.rejects(inspect(file, { arch: "arm64" }), { code: "MACHO_CHANGED" });
  assert.deepEqual(await inspect(file, { arch: "arm64" }), ["New"]);
  assert.equal(io.counts.closes, 2);
});

test("sparse files use only metadata ranges, not a whole-file scan", async t => {
  const bytes = thin({ rows: [{ name: "_Sparse" }] }), file = fixture(t)(bytes);
  const records = bytes.subarray(56, 72), strings = bytes.subarray(72);
  const size = 64 * 1024 * 1024, fd = fs.openSync(file, "r+");
  try {
    fs.ftruncateSync(fd, size);
    fs.writeSync(fd, records, 0, records.length, size - records.length - strings.length);
    fs.writeSync(fd, strings, 0, strings.length, size - strings.length);
    bytes.writeUInt32LE(size - records.length - strings.length, 40); bytes.writeUInt32LE(size - strings.length, 48);
    fs.writeSync(fd, bytes.subarray(0, 56), 0, 56, 0);
  } finally { fs.closeSync(fd); }
  const io = observedIO(), inspect = createMachOExportInspector(io);
  assert.deepEqual(await inspect(file, { arch: "arm64" }), ["Sparse"]);
  assert.ok(io.counts.bytes < 256, `Read ${io.counts.bytes} bytes of a ${size}-byte sparse file.`);
});

test("cached inspection still observes its original file for persistent metadata invalidation", async t => {
  const write = fixture(t), file = write(thin({ exports: exportsTrie(["_Observed"]) }));
  const inspect = createMachOExportInspector(), root = path.dirname(file);
  await inspect(file, { arch: "arm64" });
  const observation = await Observations.recordReads({ roots: [root] }, () => inspect(file, { arch: "arm64" }));
  assert.deepEqual(observation.value, ["Observed"]);
  assert.equal(observation.cacheable, true);
  assert.ok(observation.files.some(([observed]) => observed === file));
  const replacement = write(thin({ exports: exportsTrie(["_Changed"]) }), "replacement"); fs.renameSync(replacement, file);
  assert.equal(Observations.unchanged(observation.files), false);
});
