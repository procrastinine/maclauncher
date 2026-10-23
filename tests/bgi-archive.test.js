const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const A = require("../src/modules/bgi/archive");

function fixture(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), "bgi-archive-")); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
function archive(file, items, format = "ARC20") {
  const stride = format === "ARC20" ? 128 : 32, nameBytes = format === "ARC20" ? 96 : 16;
  const header = Buffer.alloc(16); header.write(format === "ARC20" ? "BURIKO ARC20" : "PackFile    "); header.writeUInt32LE(items.length, 12);
  const records = [], payloads = []; let offset = 0;
  for (const [name, value] of items) {
    const bytes = Buffer.from(value), record = Buffer.alloc(stride); record.write(name, 0, nameBytes, "ascii"); record.writeUInt32LE(offset, nameBytes); record.writeUInt32LE(bytes.length, nameBytes + 4);
    records.push(record); payloads.push(bytes); offset += bytes.length;
  }
  fs.writeFileSync(file, Buffer.concat([header, ...records, ...payloads])); return file;
}
function dsc({ lengths = { 65: 1, 66: 2, 256: 2 }, bits = "01011" + "0".repeat(12), size = 4, count = 3 } = {}) {
  const buffer = Buffer.alloc(0x220 + Math.ceil(bits.length / 8)); buffer.write("DSC FORMAT 1.00"); buffer.writeUInt32LE(7, 16); buffer.writeUInt32LE(size, 20); buffer.writeUInt32LE(count, 24);
  let key = 7;
  for (let symbol = 0; symbol < 512; symbol++) {
    const low = Math.imul(key & 0xffff, 20021) >>> 0, high = (Math.imul(key >>> 16, 20021) + Math.imul(key, 346) + (low >>> 16)) >>> 0;
    key = ((high << 16) + (low & 0xffff) + 1) >>> 0; buffer[32 + symbol] = ((lengths[symbol] || 0) + high) & 255;
  }
  for (let i = 0; i < bits.length; i++) if (bits[i] === "1") buffer[0x220 + (i >>> 3)] |= 1 << (7 - (i & 7));
  return buffer;
}

test("ARC20 and PackFile indexes use validated original offsets and case-insensitive member identity", t => {
  const root = fixture(t);
  for (const format of ["ARC20", "PackFile"]) {
    const file = archive(path.join(root, `${format}.arc`), [["IPL._BP", "program"], ["image", "asset"]], format), before = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    const result = A.inspectArchive(file); assert.equal(result.format, format); assert.equal(result.members.size, 2);
    assert.equal(A.readMember(result, result.members.get("ipl._bp")).toString(), "program");
    assert.throws(() => A.readMember(result, { ...result.members.get("ipl._bp"), offset: 0 }), /extraction bounds/);
    assert.throws(() => A.readMember(result, result.members.get("ipl._bp"), { maximumBytes: 2 }), /extraction bounds/);
    assert.equal(crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"), before);
  }
});

test("ARC bounds reject traversal, duplicate names, outside payloads, oversized indexes and symlink inputs", t => {
  const root = fixture(t);
  assert.throws(() => A.inspectArchive(archive(path.join(root, "traversal.arc"), [["../outside", "bad"]])), /Unsafe/);
  assert.throws(() => A.inspectArchive(archive(path.join(root, "duplicate.arc"), [["A", "one"], ["a", "two"]])), /Duplicate/);
  const file = archive(path.join(root, "outside.arc"), [["file", "test"]]), data = fs.readFileSync(file); data.writeUInt32LE(0xffffffff, 16 + 96); fs.writeFileSync(file, data);
  assert.throws(() => A.inspectArchive(file), /outside/);
  const index = Buffer.alloc(16); index.write("BURIKO ARC20"); index.writeUInt32LE(65537, 12); fs.writeFileSync(path.join(root, "huge.arc"), index);
  assert.throws(() => A.inspectArchive(path.join(root, "huge.arc")), /index exceeds/);
  const valid = archive(path.join(root, "valid.arc"), [["file", "test"]]); fs.symlinkSync(valid, path.join(root, "alias.arc"));
  assert.throws(() => A.inspectArchive(path.join(root, "alias.arc")), /regular files/);
});

test("DSC1 decodes actual Huffman literals and overlapping LZ matches with exact output validation", t => {
  const root = fixture(t), compressed = dsc(); assert.equal(A.decodeDsc(compressed).toString(), "ABAB");
  const file = archive(path.join(root, "program.arc"), [["ipl._bp", compressed]]), indexed = A.inspectArchive(file);
  assert.equal(A.readMember(indexed, indexed.members.get("ipl._bp")).toString(), "ABAB");
  assert.throws(() => A.decodeDsc(compressed, { maximumOutput: 3 }), /output exceeds/);
  assert.throws(() => A.decodeDsc(dsc({ size: 5 })), /decoded size/);
  assert.throws(() => A.decodeDsc(dsc({ bits: "11" + "0".repeat(12), size: 2, count: 1 })), /output window/);
  assert.throws(() => A.decodeDsc(dsc({ bits: "", size: 1, count: 1 })), /Truncated DSC1 bitstream/);
  assert.throws(() => A.decodeDsc(dsc({ lengths: { 65: 1, 66: 1, 67: 1 } })), /Oversubscribed/);
  assert.throws(() => A.decodeDsc(dsc({ lengths: { 65: 255 } })), /Huffman depth/);
});

test("Buriko program code ranges are inspected separately from archive and runtime versions", () => {
  const bytes = Buffer.alloc(21); bytes.writeUInt32LE(16, 0); bytes.writeUInt32LE(5, 4); bytes[16] = 0x10;
  assert.deepEqual(A.inspectProgram(bytes), { codeOffset: 16, codeBytes: 5, firstOpcode: 0x10, headerWords: [16, 5, 0, 0] });
  bytes.writeUInt32LE(100, 4); assert.throws(() => A.inspectProgram(bytes), /code range/);
});
