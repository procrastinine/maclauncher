const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { detectGame, inspectDosProgram } = require("../src/modules/dosbox/detect");
const { prepareGame, driveDirectory } = require("../src/modules/dosbox/prepare");

function temporary(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "dosbox-module-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
function mz(signature) {
  const bytes = Buffer.alloc(512); bytes.write("MZ"); bytes.writeUInt16LE(1, 4); bytes.writeUInt16LE(4, 8);
  if (signature) { bytes.writeUInt32LE(128, 0x3c); bytes.write(signature, 128); }
  return bytes;
}
function detect(file) {
  const stat = fs.statSync(file);
  return detectGame({ inputPath: file, rootDir: stat.isDirectory() ? file : path.dirname(file), stat, isAppBundle: false });
}
const Backcompat = require("../src/modules/dosbox/backcompat");
const { CURRENT_RECORD_SCHEMA_VERSION } = require("../src/core/game-store");

test("DOS backcompat hook is isolated from ordinary module and preparation exports", () => {
  assert.equal(typeof Backcompat.legacyGameMirrors, "function");
  assert.equal(Object.hasOwn(require("../src/modules/dosbox/main"), "legacyGameMirrors"), false);
  assert.equal(Object.hasOwn(require("../src/modules/dosbox/prepare"), "legacyGameMirrors"), false);
});
test("DOS legacy mirrors use shared one-time recovery without retiring active explicit save drives", async t => {
  const root = temporary(t), source = path.join(root, "game"), userDataDir = path.join(root, "profile");
  fs.mkdirSync(source); fs.mkdirSync(userDataDir); fs.writeFileSync(path.join(source, "GAME.EXE"), mz());
  fs.writeFileSync(path.join(source, "GAME.SAV"), "original save");
  const entry = { ...detect(path.join(source, "GAME.EXE")), gameId: "migration", saveDirOverride: path.join(root, "selected-saves") };
  const descriptors = Backcompat.legacyGameMirrors(entry, { userDataDir });
  fs.mkdirSync(descriptors[0].mirrorRoot, { recursive: true });
  fs.writeFileSync(path.join(descriptors[0].mirrorRoot, "GAME.SAV"), "private save");
  fs.mkdirSync(entry.saveDirOverride); fs.writeFileSync(path.join(entry.saveDirOverride, "OTHER.SAV"), "selected save");
  const { retireLegacyGameMirror } = require("../src/core/backcompat/legacy-game-mirrors");
  const result = await retireLegacyGameMirror(descriptors[0], { userDataDir });
  assert.equal(result.complete, true);
  assert.equal(fs.readFileSync(path.join(source, "GAME.SAV"), "utf8"), "original save");
  assert.equal(result.recoveredFiles.length, 1);
  assert.equal(fs.readFileSync(result.recoveredFiles[0], "utf8"), "private save");
  assert.equal(fs.existsSync(descriptors[0].mirrorRoot), false);
  assert.equal(descriptors.length, 1);
  assert.equal(fs.readFileSync(path.join(entry.saveDirOverride, "OTHER.SAV"), "utf8"), "selected save");
});
test("DOS released drive layout recovers nested missing saves at the actual original launch path and preserves conflicts", async t => {
  const root = temporary(t), source = path.join(root, "original"), programs = path.join(source, "BIN");
  fs.mkdirSync(programs, { recursive: true }); fs.writeFileSync(path.join(programs, "GAME.EXE"), mz());
  fs.writeFileSync(path.join(programs, "CONFLICT.SAV"), "original conflict");
  const entry = { ...detect(path.join(programs, "GAME.EXE")), contentRootDir: source, gamePath: source, gameId: "released-layout" };
  const context = { userDataDir: path.join(root, "profile"), gameArguments: ["-test"] };
  // v0.5.1 prepare.js:13,41,67 copied the entire source root and retained
  // the selected executable's relative path beneath the private drive.
  const releasedDrive = path.join(context.userDataDir, "games", entry.gameId, "modules", "dosbox", "drive-c");
  fs.mkdirSync(path.join(releasedDrive, "BIN"), { recursive: true });
  fs.writeFileSync(path.join(releasedDrive, "BIN", "MISSING.SAV"), "only private save");
  fs.writeFileSync(path.join(releasedDrive, "BIN", "CONFLICT.SAV"), "private conflict");
  entry.defaultSaveDir = releasedDrive;
  entry.saveLocations = [{ directory: releasedDrive, role: "primary", label: "DOS files" },
    { directory: path.join(releasedDrive, "BIN"), role: "secondary" }];
  const before = structuredClone(entry);
  const descriptor = Backcompat.legacyGameMirrors(entry, context)[0];
  assert.deepEqual(entry, before, "Describing recovery must not edit persisted fields before success");
  assert.equal(descriptor.entryPatch.defaultSaveDir, programs);
  const Module = require("../src/modules/dosbox/main");
  let persisted;
  const result = await require("../src/core/backcompat/data-migrations").runDataMigrations({ settings: {}, games: [entry],
    registry: { getModule: () => Backcompat }, userDataDir: context.userDataDir,
    saveSettings: async () => {}, saveEntry: async value => { persisted = structuredClone(value); } });
  assert.equal(result.complete, true); assert.deepEqual(result.pendingIds, []);
  assert.equal(persisted.defaultSaveDir, programs);
  assert.deepEqual(persisted.saveLocations, [{ directory: programs, role: "primary", label: "DOS files" },
    { directory: programs, role: "secondary" }]);
  const launch = await prepareGame(entry, context), command = Module.__test.launchArguments(entry, context, launch, "0.83.0");
  assert.equal(launch.drive, programs); assert.equal(launch.executable, path.join(programs, "GAME.EXE"));
  assert.ok(command.args.includes(`mount c "${programs}"`));
  const save = path.join(launch.drive, "MISSING.SAV");
  assert.equal(fs.readFileSync(save, "utf8"), "only private save"); assert.equal(fs.lstatSync(save).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(path.join(programs, "CONFLICT.SAV"), "utf8"), "original conflict");
  const conflict = path.join(programs, fs.readdirSync(programs).find(name => name.startsWith("CONFLICT.SAV.MacLauncher-conflict-")));
  assert.ok(conflict); assert.equal(fs.readFileSync(conflict, "utf8"), "private conflict");
  assert.equal(path.dirname(command.configPath), launch.directory);
  assert.match(fs.readFileSync(command.configPath, "utf8"), /mapperfile=.*modules\/dosbox\/mapper\.map/);
  assert.equal(fs.existsSync(releasedDrive), false);
});
test("DOS failed released save recovery preserves authored overrides and current fields", async t => {
  const root = temporary(t), source = path.join(root, "original"), userDataDir = path.join(root, "profile");
  fs.mkdirSync(source); fs.writeFileSync(path.join(source, "GAME.EXE"), mz());
  const entry = { ...detect(path.join(source, "GAME.EXE")), gameId: "failed-copy", saveDirOverride: path.join(root, "authored-drive") };
  const mirror = path.join(userDataDir, "games", entry.gameId, "modules", "dosbox", "drive-c");
  fs.mkdirSync(mirror, { recursive: true }); fs.writeFileSync(path.join(mirror, "ONLY.SAV"), "sole private save");
  entry.defaultSaveDir = mirror; entry.saveLocations = [{ directory: mirror, role: "primary" }];
  const before = structuredClone(entry);
  t.mock.method(fs.promises, "chmod", async () => {
    throw Object.assign(Error("Injected recovery write refusal"), { code: "EACCES" });
  });
  let persisted;
  const result = await require("../src/core/backcompat/data-migrations").runDataMigrations({ settings: {}, games: [entry],
    registry: { getModule: () => Backcompat }, userDataDir,
    saveSettings: async () => {}, saveEntry: async value => { persisted = structuredClone(value); } });
  assert.deepEqual(result.pendingIds, [entry.gameId]);
  assert.match(result.retained[0].failures[0].reason, /Injected recovery write refusal/);
  const expected = { ...before, schemaVersion: CURRENT_RECORD_SCHEMA_VERSION };
  assert.deepEqual(persisted, expected); assert.deepEqual(entry, expected);
  assert.equal(fs.readFileSync(path.join(mirror, "ONLY.SAV"), "utf8"), "sole private save");
  assert.equal(fs.existsSync(path.join(source, "ONLY.SAV")), false);
});

test("DOS released pending-save facts reproduce the full-drive executable mapping through the visible override", async t => {
  const root = temporary(t), source = path.join(root, "original"), programs = path.join(source, "BIN");
  fs.mkdirSync(programs, { recursive: true }); fs.writeFileSync(path.join(programs, "GAME.EXE"), mz());
  const entry = { ...detect(path.join(programs, "GAME.EXE")), contentRootDir: source, gamePath: source, gameId: "pending-drive" };
  const context = { userDataDir: path.join(root, "profile"), gameArguments: [] };
  const mirror = path.join(context.userDataDir, "games", entry.gameId, "modules/dosbox/drive-c");
  fs.mkdirSync(path.join(mirror, "BIN"), { recursive: true });
  fs.writeFileSync(path.join(mirror, "BIN", "GAME.EXE"), mz());
  fs.writeFileSync(path.join(mirror, "BIN", "ONLY.SAV"), "released save");
  assert.equal(Backcompat.legacyGameMirrors(entry, context)[0].releasedSaveRoute.proven, false, "A folder alone proves no released route");
  entry.defaultSaveDir = mirror;
  const before = structuredClone(entry), route = Backcompat.legacyGameMirrors(entry, context)[0].releasedSaveRoute;
  assert.deepEqual(route, { directory: mirror, entryPatch: { saveDirOverride: mirror }, proven: true, explicit: false });
  assert.deepEqual(entry, before, "Only the shared runner may apply pending-route facts");
  // v0.5.1 prepare.js copied source-relative BIN/GAME.EXE into drive-c;
  // main.js mounted that executable's parent and used it as the native cwd.
  const selected = { ...entry, ...route.entryPatch }, launch = await prepareGame(selected, context);
  assert.equal(launch.drive, mirror);
  assert.equal(launch.executable, path.join(mirror, "BIN", "GAME.EXE"));
  const Module = require("../src/modules/dosbox/main");
  assert.ok(Module.__test.launchArguments(selected, { ...context, gameArguments: ["-test"] }, launch, "0.83.0").args.includes(`mount c "${path.join(mirror, "BIN")}"`));
  assert.equal(fs.readFileSync(path.join(mirror, "BIN", "ONLY.SAV"), "utf8"), "released save");
  for (const patch of [{ saveDirOverride: path.join(root, "authored-drive") }, { launchArguments: "-savedir authored" }]) {
    const authored = { ...entry, ...patch }, unchanged = structuredClone(authored);
    assert.equal(Backcompat.legacyGameMirrors(authored, context)[0].releasedSaveRoute.explicit, true);
    assert.deepEqual(authored, unchanged);
  }
  assert.equal(Backcompat.legacyGameMirrors(entry, { ...context, gameArguments: ["-savedir", "authored"] })[0].releasedSaveRoute.explicit, true);
  assert.equal(Backcompat.legacyGameMirrors({ ...entry, moduleData: { executablePath: path.join(root, "unrelated.exe") } }, context)[0].releasedSaveRoute.proven, false);
});
