const fs = require("node:fs");
const path = require("node:path");
const { TextDecoder } = require("node:util");

const ARCHITECTURES = new Map([
  ["arm64", 0x0100000c], ["x64", 0x01000007], ["x86_64", 0x01000007],
  // Legacy slices may be inspected; this does not provide a 32-bit runtime.
  ["ia32", 7], ["i386", 7], ["arm", 12],
]);
const LIMITS = Object.freeze({
  fatSlices: 32, commands: 8192, commandBytes: 4 * 1024 * 1024,
  trieBytes: 8 * 1024 * 1024, nodes: 65536, visits: 131072, depth: 512,
  symbols: 65536, symbolRecords: 262144, stringTableBytes: 16 * 1024 * 1024,
  nameBytes: 4096, stringWork: 32 * 1024 * 1024, readBytes: 32 * 1024 * 1024,
  cacheEntries: 32,
});
const utf8 = new TextDecoder("utf-8", { fatal: true });

function fail(message, code = "MACHO_MALFORMED") {
  const error = new Error(`Mach-O exports: ${message}`);
  error.code = code;
  throw error;
}
function bounded(value, maximum, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) fail(`${label} exceeds its inspection limit.`, "MACHO_LIMIT");
  return value;
}
function range(offset, size, length, label) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0 || offset > length - size) fail(`Invalid ${label} range.`);
}
function fileIdentity(stat) {
  return JSON.stringify([stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs]);
}
function decode(bytes) {
  try { return utf8.decode(bytes); } catch { fail("Invalid UTF-8 symbol name."); }
}
function normalized(name) {
  const value = name.startsWith("_") ? name.slice(1) : name;
  if (!value) fail("Empty defined symbol name.");
  return value;
}
function addSymbol(symbols, name) {
  symbols.add(normalized(name));
  bounded(symbols.size, LIMITS.symbols, "Export count");
}

function createReader(handle, size) {
  let bytes = 0;
  return async (offset, length) => {
    range(offset, length, size, "file");
    bytes = bounded(bytes + length, LIMITS.readBytes, "Total bytes read");
    const data = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const result = await handle.read(data, read, length - read, offset + read);
      if (!Number.isInteger(result.bytesRead) || result.bytesRead <= 0 || result.bytesRead > length - read) fail("Truncated file range.");
      read += result.bytesRead;
    }
    return data;
  };
}

async function selectSlice(read, fileSize, cpu) {
  if (fileSize < 28) fail("Truncated Mach-O header.");
  const magic = (await read(0, 8)).readUInt32BE(0);
  const fat64 = magic === 0xcafebabf || magic === 0xbfbafeca;
  const fat32 = magic === 0xcafebabe || magic === 0xbebafeca;
  if (!fat64 && !fat32) return { offset: 0, size: fileSize, cpu };
  const little = magic === 0xbfbafeca || magic === 0xbebafeca;
  const header = await read(0, 8);
  const count = bounded(little ? header.readUInt32LE(4) : header.readUInt32BE(4), LIMITS.fatSlices, "Universal slice count");
  if (!count) fail("Empty universal header.");
  const stride = fat64 ? 32 : 20, tableEnd = 8 + count * stride;
  const table = await read(8, count * stride), slices = [];
  const u32 = offset => little ? table.readUInt32LE(offset) : table.readUInt32BE(offset);
  const u64 = offset => Number(little ? table.readBigUInt64LE(offset) : table.readBigUInt64BE(offset));
  for (let i = 0; i < count; i += 1) {
    const entry = i * stride;
    const offset = fat64 ? u64(entry + 8) : u32(entry + 8);
    const size = fat64 ? u64(entry + 16) : u32(entry + 12);
    const alignment = u32(entry + (fat64 ? 24 : 16));
    range(offset, size, fileSize, "universal slice");
    if (offset < tableEnd || size < 28 || alignment > 52 || offset % (2 ** alignment) !== 0) fail("Invalid universal slice alignment or bounds.");
    if (fat64 && u32(entry + 28) !== 0) fail("Invalid universal slice reserved field.");
    const slice = { offset, size, cpu: u32(entry) };
    if (slices.some(other => offset < other.offset + other.size && other.offset < offset + size)) fail("Overlapping universal slices.");
    slices.push(slice);
  }
  const selected = slices.filter(slice => slice.cpu === cpu);
  if (!selected.length) fail("The requested architecture is absent.", "MACHO_ARCH");
  if (selected.length !== 1) fail("The requested architecture has ambiguous slices.", "MACHO_ARCH");
  return selected[0];
}

async function readCommands(read, slice, requestedCpu) {
  const initial = await read(slice.offset, 28), magic = initial.readUInt32BE(0);
  const little = magic === 0xcefaedfe || magic === 0xcffaedfe;
  const wide = magic === 0xfeedfacf || magic === 0xcffaedfe;
  if (!little && magic !== 0xfeedface && magic !== 0xfeedfacf) fail("File is not Mach-O.");
  const u32 = (data, offset) => little ? data.readUInt32LE(offset) : data.readUInt32BE(offset);
  if (u32(initial, 4) !== slice.cpu || slice.cpu !== requestedCpu) fail("The Mach-O slice does not match the requested architecture.", "MACHO_ARCH");
  if (wide !== !!(requestedCpu & 0x01000000)) fail("CPU and Mach-O word size disagree.");
  const headerSize = wide ? 32 : 28;
  range(0, headerSize, slice.size, "Mach-O header");
  const count = bounded(u32(initial, 16), LIMITS.commands, "Load command count");
  const commandBytes = bounded(u32(initial, 20), LIMITS.commandBytes, "Load command bytes");
  if (count * 8 > commandBytes) fail("Truncated load commands.");
  range(headerSize, commandBytes, slice.size, "load commands");
  const data = await read(slice.offset + headerSize, commandBytes);
  const result = { wide, little, slice, dataStart: headerSize + commandBytes };
  let cursor = 0;
  for (let i = 0; i < count; i += 1) {
    range(cursor, 8, data.length, "load command header");
    const command = u32(data, cursor), size = u32(data, cursor + 4);
    if (size < 8 || size % (wide ? 8 : 4) !== 0) fail("Invalid load command size.");
    range(cursor, size, data.length, "load command");
    const field = offset => u32(data, cursor + offset);
    const requireSize = minimum => { if (size < minimum) fail("Truncated export load command."); };
    const assign = (name, value) => { if (result[name]) fail(`Duplicate ${name} load command.`); result[name] = value; };
    if (command === 0x80000033) {
      requireSize(16); assign("trie", { offset: field(8), size: field(12) });
    } else if (command === 0x22 || command === 0x80000022) {
      requireSize(48); assign("dyld", { offset: field(40), size: field(44) });
    } else if (command === 2) {
      requireSize(24); assign("symtab", { offset: field(8), count: field(12), stringsOffset: field(16), stringsSize: field(20) });
    } else if (command === 11) {
      requireSize(80); assign("dysymtab", { local: [field(8), field(12)], external: [field(16), field(20)], undefined: [field(24), field(28)] });
    }
    cursor += size;
  }
  if (cursor !== data.length) fail("Load command count and size disagree.");
  return result;
}

function parseTrie(bytes) {
  if (!bytes.length) return [];
  const nodes = new Map(), occupied = new Uint8Array(bytes.length), active = new Set(), symbols = new Set();
  let visits = 0, stringWork = 0;
  function uleb(cursor, end) {
    let value = 0n;
    for (let i = 0; i < 10; i += 1) {
      if (cursor.position >= end) fail("Truncated export ULEB128.");
      const byte = bytes[cursor.position++];
      if (i === 9 && byte > 1) fail("Overflowing export ULEB128.");
      value |= BigInt(byte & 0x7f) << BigInt(i * 7);
      if (!(byte & 0x80)) return value;
    }
    fail("Overflowing export ULEB128.");
  }
  function offsetValue(cursor, end) {
    const value = uleb(cursor, end);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail("Unsafe export offset.");
    return Number(value);
  }
  function string(cursor, end) {
    const start = cursor.position;
    const zero = bytes.subarray(start, Math.min(end, start + LIMITS.nameBytes + 1)).indexOf(0);
    if (zero < 0) fail("Unterminated or oversized export name.");
    cursor.position += zero + 1;
    stringWork = bounded(stringWork + zero + 1, LIMITS.stringWork, "Export string work");
    return bytes.subarray(start, start + zero);
  }
  function node(offset) {
    if (nodes.has(offset)) return nodes.get(offset);
    if (offset >= bytes.length) fail("Export child offset is outside the trie.");
    bounded(nodes.size + 1, LIMITS.nodes, "Export node count");
    const cursor = { position: offset }, terminalSize = offsetValue(cursor, bytes.length);
    range(cursor.position, terminalSize, bytes.length, "export terminal");
    const terminalEnd = cursor.position + terminalSize;
    let defined = false;
    if (terminalSize) {
      const flags = offsetValue(cursor, terminalEnd);
      if (flags > 0x3f || (flags & 3) === 3 || ((flags & 8) && (flags & 0x30))) fail("Unsupported export terminal flags.");
      uleb(cursor, terminalEnd); // address, or an ordinal for a reexport
      if (flags & 8) decode(string(cursor, terminalEnd));
      else {
        if (flags & 0x10) uleb(cursor, terminalEnd); // resolver address, never invoked
        defined = true;
      }
      if (cursor.position !== terminalEnd) fail("Invalid export terminal size.");
    }
    cursor.position = terminalEnd;
    if (cursor.position >= bytes.length) fail("Missing export child count.");
    const count = bytes[cursor.position++], children = [], labels = new Set();
    for (let i = 0; i < count; i += 1) {
      const edge = string(cursor, bytes.length), key = edge.toString("hex");
      // Older linkers encode an exported prefix as an empty edge to a terminal
      // leaf. It retains the prefix; cycle/depth/visit guards still apply.
      if (labels.has(key)) fail("Duplicated export edge.");
      labels.add(key);
      const child = offsetValue(cursor, bytes.length);
      if (child >= bytes.length) fail("Export child offset is outside the trie.");
      children.push({ edge, offset: child });
    }
    for (let i = offset; i < cursor.position; i += 1) if (occupied[i]) fail("Overlapping export trie nodes.");
    occupied.fill(1, offset, cursor.position);
    const value = { defined, children };
    nodes.set(offset, value);
    return value;
  }
  const stack = [{ offset: 0, prefix: Buffer.alloc(0), depth: 0 }];
  while (stack.length) {
    const item = stack.pop();
    if (item.leave) { active.delete(item.offset); continue; }
    if (active.has(item.offset)) fail("Cycle in export trie.");
    bounded(++visits, LIMITS.visits, "Export traversal visits");
    bounded(item.depth, LIMITS.depth, "Export traversal depth");
    active.add(item.offset);
    const value = node(item.offset);
    if (value.defined) addSymbol(symbols, decode(item.prefix));
    stack.push({ offset: item.offset, leave: true });
    for (let i = value.children.length - 1; i >= 0; i -= 1) {
      const child = value.children[i];
      const length = bounded(item.prefix.length + child.edge.length, LIMITS.nameBytes, "Symbol name bytes");
      stringWork = bounded(stringWork + length, LIMITS.stringWork, "Export string work");
      stack.push({ offset: child.offset, prefix: Buffer.concat([item.prefix, child.edge], length), depth: item.depth + 1 });
    }
  }
  return [...symbols].sort();
}

async function parseSymbols(read, commands) {
  const table = commands.symtab;
  if (!table) return [];
  const stride = commands.wide ? 16 : 12, count = bounded(table.count, LIMITS.symbolRecords, "Symbol record count");
  bounded(table.stringsSize, LIMITS.stringTableBytes, "String table bytes");
  range(table.offset, count * stride, commands.slice.size, "symbol table");
  range(table.stringsOffset, table.stringsSize, commands.slice.size, "string table");
  if ((count && table.offset < commands.dataStart) || (table.stringsSize && table.stringsOffset < commands.dataStart)) fail("Symbol tables overlap the Mach-O headers.");
  if (count && table.stringsSize && table.offset < table.stringsOffset + table.stringsSize && table.stringsOffset < table.offset + count * stride) fail("Overlapping symbol and string tables.");
  let start = 0, length = count;
  if (commands.dysymtab) {
    const groups = Object.values(commands.dysymtab);
    groups.forEach(([offset, size]) => range(offset, size, count, "dynamic symbol group"));
    for (let i = 0; i < groups.length; i += 1) for (let j = i + 1; j < groups.length; j += 1) {
      if (groups[i][1] && groups[j][1] && groups[i][0] < groups[j][0] + groups[j][1] && groups[j][0] < groups[i][0] + groups[i][1]) fail("Overlapping dynamic symbol groups.");
    }
    [start, length] = commands.dysymtab.external;
  }
  if (!length) return [];
  const records = await read(commands.slice.offset + table.offset + start * stride, length * stride);
  const strings = await read(commands.slice.offset + table.stringsOffset, table.stringsSize);
  const names = new Map(), symbols = new Set();
  let stringWork = 0;
  for (let i = 0; i < length; i += 1) {
    const offset = i * stride;
    const index = commands.little ? records.readUInt32LE(offset) : records.readUInt32BE(offset);
    const type = records[offset + 4], kind = type & 0x0e;
    if (index && index >= strings.length) fail("Invalid symbol string offset.");
    // N_INDR is not proof of a definition in this image; unresolved aliases
    // and imports must not qualify a native API implementation.
    if ((type & 0xe0) || !(type & 1) || (type & 0x10) || ![2, 14].includes(kind) || !index) continue;
    if (kind === 14 && !records[offset + 5]) fail("Defined symbol has no section.");
    if (!names.has(index)) {
      const end = strings.subarray(index, Math.min(strings.length, index + LIMITS.nameBytes + 1)).indexOf(0);
      if (end < 0) fail("Unterminated or oversized symbol name.");
      stringWork = bounded(stringWork + end + 1, LIMITS.stringWork, "Symbol string work");
      names.set(index, decode(strings.subarray(index, index + end)));
    }
    addSymbol(symbols, names.get(index));
  }
  return [...symbols].sort();
}

async function inspectFile(handle, size, cpu) {
  const read = createReader(handle, size), slice = await selectSlice(read, size, cpu);
  const commands = await readCommands(read, slice, cpu);
  if (commands.trie && commands.dyld?.size && (commands.trie.offset !== commands.dyld.offset || commands.trie.size !== commands.dyld.size)) fail("Conflicting export trie load commands.");
  const trie = commands.trie || (commands.dyld?.size ? commands.dyld : null);
  if (trie) {
    bounded(trie.size, LIMITS.trieBytes, "Export trie bytes");
    range(trie.offset, trie.size, slice.size, "export trie");
    if (trie.size && trie.offset < commands.dataStart) fail("Export trie overlaps the Mach-O headers.");
    return parseTrie(await read(slice.offset + trie.offset, trie.size));
  }
  return parseSymbols(read, commands);
}

/**
 * Pure Node export inspection: Promise<string[]> containing sorted, defined
 * external names, with exactly one Mach-O leading underscore removed. A name
 * does not establish function ABI, language, API usage, or runtime compatibility.
 * Export tries are authoritative; symbol tables are a conservative fallback.
 * No commands, native loading, or whole-file scans. Cached metadata is keyed
 * by real path, architecture and observed dev/inode/size/mtime/ctime identity.
 * Stat/realpath reads also participate in the backend's file-observation cache.
 * The optional filesystem seam is for bounded-read/cache tests and Node hosts.
 */
function createMachOExportInspector({ fileSystem = fs.promises } = {}) {
  const cache = new Map();
  return async function inspectMachOExports(file, { arch = process.arch } = {}) {
    if (typeof file !== "string" || !path.isAbsolute(file) || file.includes("\0")) fail("An absolute local file path is required.", "MACHO_PATH");
    const cpu = ARCHITECTURES.get(arch);
    if (!cpu) fail("Unsupported requested architecture.", "MACHO_ARCH");
    const real = await fileSystem.realpath(file), stat = await fileSystem.stat(file);
    if (!stat.isFile() || !Number.isSafeInteger(stat.size)) fail("A regular Mach-O file is required.");
    const identity = fileIdentity(stat), key = `${real}\0${cpu}`;
    const previous = cache.get(key);
    if (previous?.identity === identity) {
      cache.delete(key); cache.set(key, previous);
      return [...await previous.result];
    }
    const entry = { identity, result: null };
    entry.result = (async () => {
      const handle = await fileSystem.open(real, "r");
      try {
        if (fileIdentity(await handle.stat()) !== identity) fail("Source changed before inspection.", "MACHO_CHANGED");
        const result = await inspectFile(handle, stat.size, cpu);
        if (fileIdentity(await handle.stat()) !== identity || fileIdentity(await fileSystem.stat(file)) !== identity || await fileSystem.realpath(file) !== real) fail("Source changed during inspection.", "MACHO_CHANGED");
        return result;
      } finally { await handle.close(); }
    })();
    cache.set(key, entry);
    while (cache.size > LIMITS.cacheEntries) cache.delete(cache.keys().next().value);
    try { return [...await entry.result]; }
    catch (error) { if (cache.get(key) === entry) cache.delete(key); throw error; }
  };
}

const inspectMachOExports = createMachOExportInspector();
module.exports = { inspectMachOExports, createMachOExportInspector };
