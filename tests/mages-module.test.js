const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const Mages = require("../src/modules/mages/main");
const Inspect = require("../src/modules/mages/inspect");
const { archive, script } = require("./helpers/mages-fixture");
const { versionResource, peFixture } = require("./helpers/pe-fixture");

function fixture(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), "mages-module-")); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
function game(root, { pe = true } = {}) {
  fs.mkdirSync(path.join(root, "USRDIR"), { recursive: true });
  archive(path.join(root, "USRDIR", "script.mpk"), [
    { name: "_STARTUP_WIN.SCX", bytes: script(), id: 2 }, { name: "sub\\menu.scx", bytes: script(), compressed: true, id: 3 },
    { name: "ZZZ.SCX", bytes: script({ empty: true }), id: 4 }
  ]);
  archive(path.join(root, "USRDIR", "system.mpk"), [{ name: "image.png", bytes: "synthetic asset" }]);
  if (pe) fs.writeFileSync(path.join(root, "Game.exe"), peFixture({ version: versionResource({ fileVersion: [1, 0, 0, 1], productVersion: [1, 0, 0, 0],
    strings: { ProductName: "Steins;Gate", CompanyName: "MAGES." } }) }).bytes);
  else fs.writeFileSync(path.join(root, "Game.exe"), "unrelated executable");
  fs.writeFileSync(path.join(root, "bink2w32.dll"), "not executed"); fs.writeFileSync(path.join(root, "steam_api.dll"), "not executed");
  fs.mkdirSync(path.join(root, "languagebarrier")); fs.writeFileSync(path.join(root, "languagebarrier", "versioninfo.json"), JSON.stringify({ channel: "stable-steam-win32", intVersion: 4 }));
}
const hash = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

test("MAGES. imports require validated MPK and SC3 and keep original game versions separate from engine version", t => {
  const root = fixture(t); game(root);
  const data = Mages.detectGame({ rootDir: root, inputPath: path.join(root, "Game.exe") });
  assert.equal(data.moduleId, "mages"); assert.equal(data.moduleData.editionId, "steins-gate-windows-hd");
  assert.equal(data.moduleData.originalRunner.fileVersion, "1.0.0.1"); assert.equal(data.moduleData.originalRunner.productVersion, "1.0.0.0");
  assert.match(data.moduleData.originalRunner.source, /Game\.exe!RT_VERSION/); assert.equal(data.moduleData.detectedVersion, "unknown");
  assert.equal(data.moduleData.scriptFormat, "SC3"); assert.equal(data.moduleData.archiveFormat, "MPK 2.0"); assert.equal(data.moduleData.patch.intVersion, 4);
  assert.equal(data.moduleData.boot.id, 2); assert.match(data.moduleData.compatibility, /Runs the Windows HD data profile/);
  assert.equal(data.runtimeId, "impacto");
  assert.equal(Mages.manifest.supports.launch, true); assert.deepEqual(Mages.runtimeManagers.map(manager => manager.id), ["impacto"]);
  assert.equal(Mages.detectGame({ rootDir: root, inputPath: root, isAppBundle: true }), null);
  archive(path.join(root, "USRDIR", "script.mpk"), [{ name: "_STARTUP_WIN.SCX", bytes: Buffer.alloc(34) }]);
  assert.equal(Mages.detectGame({ rootDir: root, inputPath: root }), null);
});

test("wrapper folders, archive imports and case variants resolve one original content root; ambiguous libraries do not", t => {
  const parent = fixture(t), root = path.join(parent, "GATE"); game(root, { pe: false });
  for (const selected of [parent, root, path.join(root, "USRDIR")]) {
    const data = Mages.detectGame({ rootDir: selected, inputPath: selected }); assert.equal(data.contentRootDir, root);
    assert.equal(data.moduleData.editionId, "windows-mpk-sc3"); assert.equal(data.moduleData.originalRunner, null);
  }
  fs.renameSync(path.join(root, "USRDIR"), path.join(root, "usrdir"));
  fs.renameSync(path.join(root, "usrdir", "script.mpk"), path.join(root, "usrdir", "SCRIPT.MPK"));
  assert.equal(Mages.detectGame({ rootDir: path.join(root, "usrdir"), inputPath: path.join(root, "usrdir", "SCRIPT.MPK") }).contentRootDir, root);
  game(path.join(parent, "another"), { pe: false }); assert.equal(Mages.detectGame({ rootDir: parent, inputPath: parent }), null);
});

test("import participates in detection budgets without reading full assets and propagates budget exhaustion", t => {
  const root = fixture(t); game(root); const reads = [], detection = { stat: fs.statSync, readdir: dir => fs.readdirSync(dir, { withFileTypes: true }),
    readText: (file, max) => { assert.ok(fs.statSync(file).size <= max); return fs.readFileSync(file, "utf8"); },
    readBytes(file, offset, size) { reads.push({ file, offset, size }); const fd = fs.openSync(file, "r"), bytes = Buffer.alloc(size);
      try { return bytes.subarray(0, fs.readSync(fd, bytes, 0, size, offset)); } finally { fs.closeSync(fd); } }
  };
  assert.equal(Mages.detectGame({ rootDir: root, inputPath: root, detection }).moduleId, "mages");
  assert.ok(reads.reduce((sum, read) => sum + read.size, 0) < 8192); assert.ok(reads.filter(read => /system\.mpk$/.test(read.file)).every(read => read.offset < 320));
  const error = Object.assign(new Error("byte limit reached"), { code: "DETECTION_LIMIT" });
  assert.throws(() => Mages.detectGame({ rootDir: root, inputPath: root, detection: { readBytes: () => { throw error; } } }), { code: "DETECTION_LIMIT" });
});

test("archive and script actions preserve original bytes and reject an invalid native Windows profile before installation", async t => {
  const parent = fixture(t), root = path.join(parent, "game"), userDataDir = path.join(parent, "data"); game(root);
  fs.writeFileSync(path.join(root, "USRDIR", "unrelated.mpk"), "not an MPK");
  const entry = Mages.detectGame({ rootDir: root, inputPath: root }); entry.gameId = "synthetic-mages";
  const files = [entry.gamePath, path.join(root, "USRDIR", "script.mpk"), path.join(root, "USRDIR", "system.mpk")], before = files.map(hash);
  const archives = Mages.actions.inspectArchives(entry); assert.equal(archives.archiveCount, 2); assert.equal(archives.complete, false); assert.equal(archives.skippedArchives.length, 1);
  const scripts = Mages.actions.inspectScripts(entry); assert.equal(scripts.programCount, 3); assert.equal(scripts.complete, true);
  assert.equal(scripts.scripts.find(item => item.filename === "ZZZ.SCX").empty, true);
  const result = Mages.actions.exportScripts(entry, {}, { userDataDir }); assert.equal(result.programCount, 3);
  assert.ok(result.path.startsWith(path.join(userDataDir, "games", entry.gameId, "modules", "mages", "exports")));
  assert.deepEqual(fs.readdirSync(result.path).sort(), ["compiled", "scripts.json"]);
  for (const item of scripts.scripts) assert.equal(hash(path.join(result.path, "compiled", ...item.relativePath.split("/"))), item.sha256);
  assert.deepEqual(files.map(hash), before);
  assert.throws(() => Mages.actions.exportScripts(entry, {}, { userDataDir: path.join(root, "owned") }), /outside the original game/);
  assert.equal(fs.existsSync(path.join(root, "owned")), false);
  assert.throws(() => Mages.actions.exportScripts({ ...entry, gameId: "../escape" }, {}, { userDataDir }), /Import this game/);
  await assert.rejects(Mages.ensureRuntime(entry, {}), /Windows startup program and return-id table/);
  assert.equal(await Mages.launchRuntime("mages-tools", entry, {}), null);
  assert.equal(Mages.canLaunchRuntime("impacto", { ...entry, moduleData: { editionId: "windows-mpk-sc3" } }), false);
});

test("unknown or malformed compiled scripts stay visible as skipped while safe scripts remain exportable", t => {
  const root = fixture(t); game(root, { pe: false });
  archive(path.join(root, "USRDIR", "script.mpk"), [{ name: "_STARTUP_WIN.SCX", bytes: script() }, { name: "bad.scx", bytes: "unsupported dialect" }]);
  const report = Inspect.inspectScripts(root); assert.equal(report.complete, false); assert.equal(report.programCount, 1);
  assert.equal(report.skippedScripts[0].filename, "bad.scx"); assert.match(report.skippedScripts[0].reason, /SC3 script header/);
});

test("malformed large members cannot bypass the aggregate stored-script budget", t => {
  const root = fixture(t); game(root, { pe: false });
  const file = path.join(root, "USRDIR", "script.mpk");
  archive(file, [{ name: "_STARTUP_WIN.SCX", bytes: script() }, { name: "large-a.scx", bytes: "" }, { name: "large-b.scx", bytes: "" }]);
  const bytes = fs.readFileSync(file), big = 33 * 1024 * 1024, start = bytes.length;
  for (let i = 0; i < 2; i++) {
    const record = 64 + (i + 1) * 256;
    bytes.writeBigUInt64LE(BigInt(start + i * big), record + 8); bytes.writeBigUInt64LE(BigInt(big), record + 16); bytes.writeBigUInt64LE(BigInt(big), record + 24);
  }
  fs.writeFileSync(file, bytes); fs.truncateSync(file, start + 2 * big);
  assert.throws(() => Inspect.inspectScripts(root), /stored scripts exceed their aggregate/);
});
