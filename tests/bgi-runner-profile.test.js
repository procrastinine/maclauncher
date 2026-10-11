const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parseRunnerProfile, readRunnerProfile } = require("../src/modules/bgi/native/runner-profile");

const evidence = { originalRunner: { fileVersion: "1.643.1.0", strings: { FileDescription: "Ethornell - BURIKO General Interpreter", FileVersion: "Version : 1.643.1 - Compatibility : 1.72" } },
  boot: { codeOffset: 16, codeBytes: 100, headerWords: [16, 100, 0, 0] } };
function image(identifier = "ExampleProject") {
  const b = Buffer.alloc(0xc00), pe = 0x80, opt = pe + 24, sections = opt + 224, base = 0x400000;
  b.writeUInt16LE(0x5a4d, 0); b.writeUInt32LE(pe, 60); b.writeUInt32LE(0x4550, pe); b.writeUInt16LE(0x14c, pe + 4);
  b.writeUInt16LE(2, pe + 6); b.writeUInt16LE(224, pe + 20); b.writeUInt16LE(0x10b, opt); b.writeUInt32LE(base, opt + 28);
  for (const [i, rva, raw, size, flags] of [[0, 0x1000, 0x200, 0x400, 0x60000020], [1, 0x2000, 0x600, 0x600, 0x40000040]]) {
    const at = sections + i * 40; b.writeUInt32LE(rva, at + 12); b.writeUInt32LE(size, at + 16); b.writeUInt32LE(raw, at + 20); b.writeUInt32LE(flags, at + 36);
  }
  const functionRaw = 0x300, functionAddress = base + 0x1100;
  Buffer.from("558bec8b4d08e800000000680000000050e80000000083c40833c05dc3", "hex").copy(b, functionRaw);
  b.writeInt32LE(base + 0x1040 - functionAddress - 11, functionRaw + 7);
  b.writeInt32LE(base + 0x1080 - functionAddress - 22, functionRaw + 18);
  b.writeUInt32LE(base + 0x2440, functionRaw + 12);
  b.write(identifier, 0xa40); b[0xa40 + Buffer.byteLength(identifier)] = 0;
  for (const i of [...Array.from({ length: 64 }, (_, i) => i), 0x52, 0x70, 0xfd]) b.writeUInt32LE(base + 0x1040, 0x600 + i * 4);
  b.writeUInt32LE(functionAddress, 0x600 + 0xe8 * 4);
  return b;
}
test("BGI native project identifier is derived from a version-gated PE service body and its exact dispatch slot", () => {
  const bytes = image(), before = Buffer.from(bytes), result = parseRunnerProfile(bytes, evidence);
  assert.equal(Buffer.from(result.projectIdentifierHex, "hex").toString(), "ExampleProject");
  assert.equal(result.dialect, "ethornell-1.72"); assert.equal(result.windowsExecuted, false); assert.equal(result.source, "original-sys0-e8-service");
  assert.match(result.sourceSha256, /^[a-f0-9]{64}$/); assert.deepEqual(bytes, before);
  const different = parseRunnerProfile(image("AnotherIdentifier"), evidence);
  assert.equal(Buffer.from(different.projectIdentifierHex, "hex").toString(), "AnotherIdentifier");
  assert.notEqual(different.sourceSha256, result.sourceSha256);
});
test("BGI native project identifier rejects wrong CPU, changed code contracts, unbounded pointers and unsafe names", () => {
  const mutations = [b => b.writeUInt16LE(0x8664, 0x84), b => { b[0x316] = 0x90; },
    b => b.writeUInt32LE(0x400000, 0x30c), b => b.writeInt32LE(0x7fffffff, 0x307),
    b => b.writeUInt32LE(0, 0x600 + 0xe8 * 4), b => b.writeUInt32LE(0x90000000, 0x600 + 4),
    b => b.writeUInt32LE(0xffffffff, 0x178 + 16)];
  for (const mutate of mutations) { const bytes = image(); mutate(bytes); assert.throws(() => parseRunnerProfile(bytes, evidence), /project-identifier contract/); }
  for (const identifier of ["", "../Project", "C:\\Project", "Project/State", "A".repeat(97)])
    assert.throws(() => parseRunnerProfile(image(identifier), evidence), /project-identifier contract/);
  assert.throws(() => parseRunnerProfile(image(), { ...evidence, boot: { ...evidence.boot, codeOffset: 8 } }), /native VM dialect/);
});
test("BGI original runner-profile reads are immutable and reject symbolic links", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bgi-runner-profile-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const original = path.join(root, "BGI.exe"), bytes = image(); fs.writeFileSync(original, bytes);
  const result = readRunnerProfile(original, evidence); assert.equal(Buffer.from(result.projectIdentifierHex, "hex").toString(), "ExampleProject");
  assert.deepEqual(fs.readFileSync(original), bytes);
  const link = path.join(root, "linked.exe"); fs.symlinkSync(original, link); assert.throws(() => readRunnerProfile(link, evidence), /bounded regular file/);
});
