const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const test = require("node:test");
const { crc32, inspectRenpySave, listRenpySaves, LIMITS } = require("../src/modules/renpy/save-inspect");
const Renpy = require("../src/modules/renpy/main");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "renpy-tools-save-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function zip(members) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const item of members) {
    const name = Buffer.from(item.name);
    const data = Buffer.isBuffer(item.data) ? item.data : Buffer.from(item.data);
    const method = item.method ?? 8;
    const compressed = item.compressed || (method === 8 ? zlib.deflateRawSync(data) : data);
    const crc = item.crc ?? crc32(data);
    const size = item.declaredSize ?? data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(item.flags || 0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(item.flags || 0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, compressed);
    centrals.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(members.length, 8);
  end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
function basicMembers(extra = []) {
  return [{ name: "json", data: JSON.stringify({ _save_name: "Chapter 2", _renpy_version: [8, 2, 0], _game_runtime: 42 }) },
    { name: "renpy_version", data: "Ren'Py 8.2.0.24012702" }, { name: "extra_info", data: "Chapter 2" },
    { name: "log", data: Buffer.from("cos\nsystem\n(S'touch must-not-exist'\ntR.") }, ...extra];
}

test("save inspection reads metadata but never decodes malicious or oversized state", t => {
  const root = fixture(t);
  const file = path.join(root, "1-1-LT1.save");
  const members = basicMembers([{ name: "signatures", data: "unverified signature" }, { name: "screenshot.png", data: "png" }]);
  members[3].declaredSize = 0xfffffffe;
  members[3].compressed = Buffer.from("invalid deflate and malicious pickle");
  const original = zip(members);
  fs.writeFileSync(file, original);
  const report = inspectRenpySave(file);
  assert.equal(report.metadata._save_name, "Chapter 2");
  assert.equal(report.pythonMajor, 3);
  assert.equal(report.renpyVersion, "Ren'Py 8.2.0.24012702");
  assert.equal(report.state.inspected, false);
  assert.equal(report.state.uncompressedSize, 0xfffffffe);
  assert.deepEqual(report.signatures, { present: true, verified: false });
  assert.equal(report.screenshot.present, true);
  assert.equal(report.saveEditing, false);
  assert.deepEqual(fs.readFileSync(file), original);
  assert.equal(fs.existsSync(path.join(root, "must-not-exist")), false);
});

test("save inspection accepts Ren'Py 7 and older slots without JSON or signatures", t => {
  const root = fixture(t);
  const file = path.join(root, "old.save");
  fs.writeFileSync(file, zip([{ name: "renpy_version", data: "Ren'Py 7.7.3.24041403", method: 0 }, { name: "log", data: "opaque" }]));
  const report = inspectRenpySave(file);
  assert.equal(report.pythonMajor, 2);
  assert.equal(report.metadata, null);
  assert.equal(report.signatures.present, false);
});

test("save inspection rejects ambiguous, corrupt, unsupported and oversized metadata", t => {
  const root = fixture(t);
  const file = path.join(root, "bad.save");
  const cases = [
    [basicMembers([{ name: "json", data: "{}" }]), /duplicate/],
    [basicMembers([{ name: "../escape", data: "bad" }]), /unsafe/],
    [[{ name: "json", data: "{}", crc: 0 }, { name: "log", data: "opaque" }], /integrity/],
    [[{ name: "json", data: "[]" }, { name: "log", data: "opaque" }], /must be an object/],
    [[{ name: "json", data: '{"deep":' + "[".repeat(40) + "0" + "]".repeat(40) + "}" }, { name: "log", data: "opaque" }], /structural limits/],
    [[{ name: "json", data: "x".repeat(LIMITS.metadataBytes + 1), declaredSize: 1 }, { name: "log", data: "opaque" }], /larger than|size|length/i],
    [[{ name: "json", data: "{}", flags: 1 }, { name: "log", data: "opaque" }], /Encrypted/],
    [[{ name: "json", data: "{}", method: 99 }, { name: "log", data: "opaque" }], /compression/],
    [[{ name: "json", data: "{}" }], /no game-state/]
  ];
  for (const [members, pattern] of cases) {
    fs.writeFileSync(file, zip(members));
    assert.throws(() => inspectRenpySave(file), pattern);
  }
  fs.writeFileSync(file, Buffer.from("not a ZIP: persistent pickle"));
  assert.throws(() => inspectRenpySave(file), /standard ZIP/);
  fs.rmSync(file);
  fs.symlinkSync(path.join(root, "persistent"), file);
  fs.writeFileSync(path.join(root, "persistent"), zip(basicMembers()));
  assert.throws(() => inspectRenpySave(file), /regular file/);
});

test("save listing isolates damaged slots and module action stores reports per game", t => {
  const root = fixture(t);
  const saves = path.join(root, "game", "saves");
  fs.mkdirSync(saves, { recursive: true });
  fs.writeFileSync(path.join(saves, "valid.save"), zip(basicMembers()));
  fs.writeFileSync(path.join(saves, "bad.save"), "broken");
  fs.writeFileSync(path.join(saves, "persistent"), "pickle");
  fs.symlinkSync(path.join(saves, "valid.save"), path.join(saves, "link.save"));
  const listed = listRenpySaves([saves, saves, path.join(root, "missing")]);
  assert.equal(listed.count, 2);
  assert.equal(listed.validCount, 1);
  assert.equal(listed.files[0].ok, false);
  const entry = { gameId: "renpy", gamePath: root, moduleData: { version: "8.2.0" } };
  const userDataDir = path.join(root, "user-data");
  const result = Renpy.actions.inspectSaveMetadata(entry, {}, { userDataDir });
  assert.equal(result.count, 2);
  assert.equal(result.detectedRenpyVersion, "8.2.0");
  assert.ok(result.reportPath.startsWith(path.join(userDataDir, "games", entry.gameId)));
  assert.equal(fs.existsSync(result.reportPath), true);
  assert.equal(entry.moduleData.saveMetadataReportPath, result.reportPath);
  assert.equal(Renpy.manifest.supports.saveEditing, false);
  assert.deepEqual(Renpy.save, { extensions: ["save"], names: ["persistent"] });
  entry.runtimeData = { sdk: { version: "7.7.3" } };
  const mismatch = Renpy.actions.inspectSaveMetadata(entry, {}, {});
  assert.equal(mismatch.configuredSdkVersion, "7.7.3");
  assert.equal(mismatch.versionWarnings[0].expectedVersion, "7.7.3");
});
