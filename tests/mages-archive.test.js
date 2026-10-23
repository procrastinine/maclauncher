const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const A = require("../src/modules/mages/archive");
const { archive, script } = require("./helpers/mages-fixture");

function fixture(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), "mages-archive-")); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }

test("MPK v2 reads original ids, Windows directory separators, compressed payloads and trailing zero entries", t => {
  const root = fixture(t), file = archive(path.join(root, "scripts.mpk"), [
    { name: "_STARTUP_WIN.SCX", bytes: script(), id: 12 }, { name: "sub\\menu.scx", bytes: script(), compressed: true, id: 30 }
  ], { padding: 1 }), original = fs.readFileSync(file), indexed = A.inspectArchive(file);
  assert.equal(indexed.format, "MPK 2.0"); assert.equal(indexed.members.size, 2); assert.equal(indexed.paddingEntries, 1);
  const compressed = indexed.members.get("sub/menu.scx"); assert.equal(compressed.id, 30); assert.equal(compressed.relativePath, "sub/menu.scx");
  assert.deepEqual(A.readMember(indexed, compressed), script());
  assert.deepEqual(A.readMember(indexed, indexed.members.get("_startup_win.scx")), script());
  assert.throws(() => A.readMember(indexed, { ...compressed }), /extraction bounds/);
  assert.throws(() => A.readMember(indexed, compressed, { maximumBytes: 2 }), /extraction bounds/);
  assert.throws(() => A.readMember(indexed, compressed, { maximumOutput: 2 }), /extraction bounds/);
  assert.deepEqual(fs.readFileSync(file), original);
});

test("MPK indexes reject traversal, ambiguous names, duplicate ids, invalid ranges and unsupported layouts", t => {
  const root = fixture(t), data = Buffer.from("payload"); let n = 0;
  for (const name of ["../bad.scx", "..\\bad.scx", "/bad.scx", "C:\\bad.scx", "a/../bad.scx", "NUL.scx", "a.\\bad.scx"]) {
    assert.throws(() => A.inspectArchive(archive(path.join(root, `${n++}.mpk`), [{ name, bytes: data }])), /Unsafe/);
  }
  assert.throws(() => A.inspectArchive(archive(path.join(root, "duplicate-name.mpk"), [{ name: "A\\B", bytes: data }, { name: "a/b", bytes: data }])), /Duplicate/);
  assert.throws(() => A.inspectArchive(archive(path.join(root, "duplicate-id.mpk"), [{ name: "A", bytes: data, id: 1 }, { name: "B", bytes: data, id: 1 }])), /Duplicate/);
  for (const mutate of [
    b => b.writeUInt16LE(1, 6), b => b.writeUInt32LE(2, 64), b => b.writeUInt32LE(65536, 8),
    b => b.writeBigUInt64LE(1n, 72), b => b.writeBigUInt64LE(2n ** 63n, 72), b => b.writeBigUInt64LE(100000n, 80),
    b => b.writeBigUInt64LE(1n, 88), b => b.fill(65, 96, 320)
  ]) {
    const file = archive(path.join(root, `invalid-${n++}.mpk`), [{ name: "file", bytes: data }]), bytes = fs.readFileSync(file); mutate(bytes); fs.writeFileSync(file, bytes);
    assert.throws(() => A.inspectArchive(file));
  }
  const overlap = archive(path.join(root, "overlap.mpk"), [{ name: "A", bytes: data }, { name: "B", bytes: data }]), bytes = fs.readFileSync(overlap);
  bytes.writeBigUInt64LE(bytes.readBigUInt64LE(72), 328); fs.writeFileSync(overlap, bytes); assert.throws(() => A.inspectArchive(overlap), /Overlapping/);
  const valid = archive(path.join(root, "valid.mpk"), [{ name: "file", bytes: data }]); fs.symlinkSync(valid, path.join(root, "alias.mpk"));
  assert.throws(() => A.inspectArchive(path.join(root, "alias.mpk")), /regular files/);
});

test("MPK payload reads detect source changes and enforce the decoded size of zlib members", t => {
  const root = fixture(t), file = archive(path.join(root, "compressed.mpk"), [{ name: "script.scx", bytes: script(), compressed: true }]);
  let bytes = fs.readFileSync(file); bytes.writeBigUInt64LE(2n, 88); fs.writeFileSync(file, bytes);
  const archiveWithFalseSize = A.inspectArchive(file); assert.throws(() => A.readMember(archiveWithFalseSize, archiveWithFalseSize.members.get("script.scx")));
  archive(file, [{ name: "script.scx", bytes: script() }]); const indexed = A.inspectArchive(file);
  fs.appendFileSync(file, "changed"); assert.throws(() => A.readMember(indexed, indexed.members.get("script.scx")), /changed during inspection/);
});

test("SC3 headers validate code, label and string ranges separately from engine/runtime versions", () => {
  const bytes = script(), structure = A.inspectScript(bytes);
  assert.equal(structure.format, "SC3"); assert.equal(structure.codeOffset, 16); assert.equal(structure.codeBytes, 4);
  assert.equal(structure.labelCount, 1); assert.equal(structure.stringCount, 1); assert.equal(structure.firstOpcode, "0029");
  assert.equal(A.inspectScript(script({ empty: true })).empty, true);
  for (const mutate of [b => b.write("BAD", 0), b => b.writeUInt32LE(100, 4), b => b.writeUInt32LE(35, 8),
    b => b.writeUInt32LE(15, 12), b => b.writeUInt32LE(22, 12), b => b.writeUInt32LE(0, 20), b => b.writeUInt32LE(34, 20)]) {
    const invalid = Buffer.from(bytes); mutate(invalid); assert.throws(() => A.inspectScript(invalid));
  }
});

test("SC3 auxiliary return tables are distinguished from string data without assuming a game instruction set", () => {
  const bytes = script({ returns: [16] }), structure = A.inspectScript(bytes);
  assert.equal(structure.auxiliaryTableOffset, 24); assert.equal(structure.returnTableOffset, 24);
  assert.equal(structure.returnCount, 1); assert.equal(structure.stringDataOffset, 28);
  const unknown = Buffer.from(bytes); unknown.writeUInt32LE(1000, 24);
  assert.equal(A.inspectScript(unknown).returnCount, null);
  assert.equal(A.inspectScript(unknown).returnTableOffset, null);
  assert.equal(A.inspectScript(unknown).stringDataOffset, 28);
  const legacy = A.inspectScript(script({ includeStrings: false }));
  assert.equal(legacy.stringCount, 0); assert.equal(legacy.returnCount, 0);
  const returnsOnly = A.inspectScript(script({ includeStrings: false, returns: [16, 18] }));
  assert.equal(returnsOnly.stringCount, 0); assert.equal(returnsOnly.returnCount, 2);
  assert.equal(returnsOnly.returnTableOffset, 20);
});

test("large MPK indexes participate in shared detection reads using bounded chunks", t => {
  const root = fixture(t), file = archive(path.join(root, "large.mpk"), Array.from({ length: 8200 }, (_, i) => ({ name: `${i}.dat`, bytes: "" }))), sizes = [];
  const result = A.inspectArchive(file, { detection: { readBytes(_file, offset, length) {
    sizes.push(length); const fd = fs.openSync(file, "r"), bytes = Buffer.alloc(length);
    try { return bytes.subarray(0, fs.readSync(fd, bytes, 0, length, offset)); } finally { fs.closeSync(fd); }
  } } });
  assert.equal(result.members.size, 8200); assert.ok(sizes.every(size => size <= 2 * 1024 * 1024));
  assert.equal(sizes.reduce((total, size) => total + size, 0), result.bytesRead);
});
