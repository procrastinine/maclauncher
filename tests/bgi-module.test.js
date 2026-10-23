const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const BGI = require("../src/modules/bgi/main");
const { engineVersionEvidence } = require("../src/modules/bgi/inspect");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bgi-module-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function program(opcode = 0x10) { const data = Buffer.alloc(20); data.writeUInt32LE(16, 0); data.writeUInt32LE(4, 4); data[16] = opcode; return data; }
function archive(root, filename, items) {
  const header = Buffer.alloc(16); header.write("BURIKO ARC20"); header.writeUInt32LE(items.length, 12);
  const records = [], payloads = []; let offset = 0;
  for (const [name, bytes] of items) {
    const record = Buffer.alloc(128); record.write(name); record.writeUInt32LE(offset, 96); record.writeUInt32LE(bytes.length, 100);
    records.push(record); payloads.push(bytes); offset += bytes.length;
  }
  const file = path.join(root, filename); fs.writeFileSync(file, Buffer.concat([header, ...records, ...payloads])); return file;
}
const sha256 = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

test("original engine version requires BGI identity and remains separate from product/compatibility versions", () => {
  const metadata = { fileVersion: "1.643.1.0", productVersion: "1.0.0.0", source: "BGI.exe!RT_VERSION/1/1041",
    strings: { FileDescription: "Ethornell - BURIKO General Interpreter", FileVersion: "Version : 1.643.1 - Compatibility : 1.72" } };
  assert.deepEqual(engineVersionEvidence(metadata), { version: "1.643.1.0", compatibility: "1.72", source: metadata.source });
  assert.deepEqual(engineVersionEvidence({ ...metadata, strings: { ProductName: "Game Installer" } }), { version: null, compatibility: null, source: null });
  assert.equal(engineVersionEvidence({ ...metadata, fileVersion: "0.0.0.0" }).version, null);
  assert.equal(engineVersionEvidence({ ...metadata, strings: { ...metadata.strings, FileVersion: "Compatibility : 1.72beta" } }).compatibility, null);
});

test("BGI imports require a validated boot program and use the caller's bounded reads", t => {
  const root = fixture(t), inputPath = path.join(root, "BGI.exe"); fs.writeFileSync(inputPath, "not a PE");
  archive(root, "system.arc", [["ipl._bp", program()]]);
  const reads = [], detection = { readBytes(file, offset, count) {
    reads.push({ file, offset, count }); const fd = fs.openSync(file, "r");
    try { const data = Buffer.alloc(count), length = fs.readSync(fd, data, 0, count, offset); return data.subarray(0, length); } finally { fs.closeSync(fd); }
  } };
  const entry = BGI.detectGame({ rootDir: root, inputPath, detection });
  assert.equal(entry.moduleId, "bgi"); assert.equal(entry.moduleData.boot.codeBytes, 4);
  assert.equal(entry.moduleData.detectedVersion, "unknown"); assert.equal(BGI.manifest.supports.launch, false);
  assert.deepEqual(BGI.runtimeManagers, []); assert.equal(reads.reduce((total, read) => total + read.count, 0), 164);
  assert.equal(BGI.detectGame({ rootDir: root, inputPath, isAppBundle: true }), null);
  archive(root, "system.arc", [["ipl._bp", Buffer.alloc(20)]]);
  assert.equal(BGI.detectGame({ rootDir: root, inputPath }), null);
});

test("program tools retain safe scripts when unrelated archives fail and exports never write originals", async t => {
  const parent = fixture(t), root = path.join(parent, "game"), userDataDir = path.join(parent, "userData"); fs.mkdirSync(root);
  const original = archive(root, "system.arc", [["ipl._bp", program()]]);
  archive(root, "sysprg.arc", [["settings._bp", program(0x12)], ["image", Buffer.from("asset")]]);
  archive(root, "ambiguous.arc", [["IMAGE", Buffer.from("first")], ["image", Buffer.from("second")]]);
  fs.writeFileSync(path.join(root, "other.arc"), Buffer.alloc(16));
  const hashes = Object.fromEntries(fs.readdirSync(root).map(name => [name, sha256(path.join(root, name))]));
  const entry = BGI.detectGame({ rootDir: root, inputPath: original }); entry.gameId = "bgi-test";
  const report = BGI.actions.inspectPrograms(entry); assert.equal(report.programCount, 2); assert.equal(report.complete, false);
  assert.equal(report.scannedArchives, 4); assert.equal(report.skippedArchives.length, 2);
  assert.match(report.skippedArchives.find(item => item.archive === "ambiguous.arc").reason, /Duplicate/);
  const exported = BGI.actions.exportPrograms(entry, {}, { userDataDir });
  assert.equal(exported.programCount, 2); assert.ok(exported.path.startsWith(path.join(userDataDir, "games", entry.gameId)));
  assert.deepEqual(fs.readdirSync(exported.path).sort(), ["programs.json", "sysprg", "system"]);
  for (const item of report.programs) {
    const file = path.join(exported.path, path.basename(item.archive, ".arc"), item.filename);
    assert.equal(sha256(file), item.sha256); assert.equal(fs.statSync(file).isSymbolicLink(), false);
  }
  for (const [name, hash] of Object.entries(hashes)) assert.equal(sha256(path.join(root, name)), hash);
  assert.throws(() => BGI.actions.exportPrograms({ ...entry, gameId: null }, {}, { userDataDir }), /Import this game/);
  await assert.rejects(BGI.ensureRuntime(entry, {}), /not yet supported for play/);
});
