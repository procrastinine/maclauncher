const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Launch = require("../src/modules/siglus/launch");
function fixture(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-siglus-")); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
function siglusPack() {
  const b = Buffer.alloc(124); b.write("pack_scn");
  b.writeUInt32LE(92, 8); b.writeUInt32LE(100, 8 + 13 * 4); b.writeUInt32LE(1, 8 + 14 * 4);
  b.writeUInt32LE(108, 8 + 17 * 4); b.writeUInt32LE(1, 8 + 18 * 4);
  b.writeUInt32LE(116, 8 + 19 * 4); b.writeUInt32LE(1, 8 + 20 * 4);
  b.writeUInt32LE(0, 108); b.writeUInt32LE(8, 112);
  return b;
}
const Backcompat = require("../src/modules/siglus/backcompat");

test("released v0.5.1 Siglus project restores real saves and keys while preserving original conflicts", async t => {
  const root = fs.realpathSync(fixture(t)), game = path.join(root, "Original"), userDataDir = path.join(root, "profile");
  fs.mkdirSync(path.join(game, "savedata"), { recursive: true });
  fs.writeFileSync(path.join(game, "Scene.pck"), siglusPack());
  fs.writeFileSync(path.join(game, "key.toml"), "original key");
  fs.writeFileSync(path.join(game, "savedata", "conflict.sav"), "original progress");
  const mod = Backcompat, entry = { gameId: "released-siglus", gamePath: game, moduleData: { engineKind: "siglus" } };
  const directory = path.join(userDataDir, "games", entry.gameId, "modules", "siglus");
  const releasedProject = path.join(directory, "project");
  fs.mkdirSync(path.join(releasedProject, "savedata"), { recursive: true });
  fs.symlinkSync(path.join(game, "Scene.pck"), path.join(releasedProject, "Scene.pck"));
  fs.writeFileSync(path.join(releasedProject, "key.toml"), "released private key");
  fs.writeFileSync(path.join(releasedProject, "savedata", "new.sav"), "released progress");
  fs.writeFileSync(path.join(releasedProject, "savedata", "conflict.sav"), "released conflicting progress");
  fs.writeFileSync(path.join(directory, "cwd-user-note.txt"), "retain unknown cwd bytes");
  const descriptor = mod.legacyGameMirrors(entry, { userDataDir }).find(row => row.mirrorRoot === releasedProject);
  assert.deepEqual(descriptor, { mirrorRoot: releasedProject, sourceRoot: game,
    releasedSaveRoute: { directory: path.join(releasedProject, "savedata"), entryPatch: { saveDirOverride: path.join(releasedProject, "savedata") }, proven: true, explicit: false },
    entryPatch: { defaultSaveDir: path.join(game, "savedata"), saveLocations: [{ directory: path.join(game, "savedata"), source: "Native interpreter saves", confidence: "exact", label: "Saves" }] } });
  const result = await require("../src/core/backcompat/legacy-game-mirrors").retireLegacyGameMirror(descriptor, { userDataDir });
  assert.equal(result.complete, true, result.reason);
  Object.assign(entry, descriptor.entryPatch); // Success-only standalone proof; runner persistence is a separate root contract.
  assert.equal(fs.readFileSync(path.join(Launch.resolveSaveLocations(entry, {}).primaryDirectory, "new.sav"), "utf8"), "released progress");
  assert.equal(fs.readFileSync(path.join(game, "key.toml"), "utf8"), "original key");
  assert.equal(fs.readFileSync(path.join(game, "savedata", "conflict.sav"), "utf8"), "original progress");
  for (const [relative, bytes] of [["key.toml", "released private key"], ["savedata/conflict.sav", "released conflicting progress"]]) {
    const conflict = result.recoveredFiles.find(file => file.startsWith(path.join(game, relative) + ".MacLauncher-conflict-"));
    assert.ok(conflict); assert.equal(fs.lstatSync(conflict).isFile(), true);
    assert.equal(fs.readFileSync(conflict, "utf8"), bytes);
  }
  assert.equal(fs.readFileSync(path.join(directory, "cwd-user-note.txt"), "utf8"), "retain unknown cwd bytes", "active module cwd is not recursively retired");
  fs.rmSync(userDataDir, { recursive: true });
  assert.equal(fs.readFileSync(path.join(game, "savedata", "new.sav"), "utf8"), "released progress");
});
test("released v0.5.1 Siglus missing original key reaches the actual direct-launch configuration", async t => {
  const root = fs.realpathSync(fixture(t)), game = path.join(root, "Original"), userDataDir = path.join(root, "profile"); fs.mkdirSync(game);
  fs.writeFileSync(path.join(game, "Scene.pck"), siglusPack());
  const entry = { gameId: "released-key", gamePath: game, moduleData: { engineKind: "siglus" } }, context = { userDataDir, runtimeSettings: {} };
  const mirrorRoot = path.join(userDataDir, "games", entry.gameId, "modules", "siglus", "project");
  fs.mkdirSync(mirrorRoot, { recursive: true }); fs.writeFileSync(path.join(mirrorRoot, "key.toml"), "key = [7,8,9]\n");
  fs.mkdirSync(path.join(mirrorRoot, "savedata")); fs.writeFileSync(path.join(mirrorRoot, "savedata", "0001.sav"), "released slot");
  const descriptor = Backcompat.legacyGameMirrors(entry, context).find(row => row.mirrorRoot === mirrorRoot);
  const result = await require("../src/core/backcompat/legacy-game-mirrors").retireLegacyGameMirror(descriptor, { userDataDir });
  assert.equal(result.complete, true, result.reason);
  const launch = Launch.prepareLaunch(entry, context, { libraryPath: "/native/libsiglus.dylib" });
  assert.equal(launch.root, game);
  assert.equal(fs.readFileSync(path.join(launch.root, "key.toml"), "utf8"), "key = [7,8,9]\n");
  assert.equal(fs.readFileSync(path.join(launch.saves, "0001.sav"), "utf8"), "released slot", "project recovery can create its savedata child below an existing original root");
});
for (const engineKind of ["reallive", "avg32"]) test(`released v0.5.1 ${engineKind} save tree restores actual normal files and keeps conflicts`, async t => {
  const root = fs.realpathSync(fixture(t)), game = path.join(root, "Original"), userDataDir = path.join(root, "profile");
  const sourceRoot = engineKind === "reallive" ? path.join(game, "savedata_rs") : game;
  fs.mkdirSync(sourceRoot, { recursive: true });
  const entry = { gameId: "released-" + engineKind, gamePath: game, moduleData: { engineKind } };
  const mirrorRoot = path.join(userDataDir, "games", entry.gameId, "modules", "siglus", "saves");
  fs.mkdirSync(mirrorRoot, { recursive: true });
  const saveName = engineKind === "reallive" ? "save001.sav" : "SAVE.INI";
  fs.writeFileSync(path.join(mirrorRoot, saveName), "released " + engineKind);
  const mod = Backcompat, descriptor = mod.legacyGameMirrors(entry, { userDataDir }).find(row => row.mirrorRoot === mirrorRoot);
  assert.deepEqual(descriptor, { mirrorRoot, sourceRoot, ...(engineKind === "reallive" ? { createSourceWithin: game } : {}),
    releasedSaveRoute: { directory: mirrorRoot, entryPatch: { saveDirOverride: mirrorRoot }, proven: true, explicit: false },
    entryPatch: { defaultSaveDir: sourceRoot, saveLocations: [{ directory: sourceRoot, source: "Native interpreter saves", confidence: "exact", label: "Saves" }] } });
  const result = await require("../src/core/backcompat/legacy-game-mirrors").retireLegacyGameMirror(descriptor, { userDataDir });
  assert.equal(result.complete, true, result.reason);
  assert.equal(Launch.resolveSaveLocations(entry, {}).primaryDirectory, sourceRoot);
  assert.equal(fs.readFileSync(path.join(sourceRoot, saveName), "utf8"), "released " + engineKind);
  // A separate released snapshot conflicts with the already authoritative
  // normal save: it must become a sibling file rather than replacing it.
  fs.mkdirSync(mirrorRoot); fs.writeFileSync(path.join(mirrorRoot, saveName), "released conflict");
  const conflicting = await require("../src/core/backcompat/legacy-game-mirrors").retireLegacyGameMirror(descriptor, { userDataDir });
  assert.equal(conflicting.complete, true, conflicting.reason);
  assert.equal(fs.readFileSync(path.join(sourceRoot, saveName), "utf8"), "released " + engineKind);
  const conflict = conflicting.recoveredFiles.find(file => file.startsWith(path.join(sourceRoot, saveName + ".MacLauncher-conflict-")));
  assert.ok(conflict); assert.equal(fs.readFileSync(conflict, "utf8"), "released conflict");
});
test("released v0.5.1 RealLive creates missing normal destination within the existing original game", async t => {
  const root = fs.realpathSync(fixture(t)), game = path.join(root, "Original"), userDataDir = path.join(root, "profile"); fs.mkdirSync(game);
  const entry = { gameId: "released-missing", gamePath: game, moduleData: { engineKind: "reallive" } };
  const mirrorRoot = path.join(userDataDir, "games", entry.gameId, "modules", "siglus", "saves");
  fs.mkdirSync(mirrorRoot, { recursive: true }); fs.writeFileSync(path.join(mirrorRoot, "new.sav"), "only surviving progress");
  const descriptor = Backcompat.legacyGameMirrors(entry, { userDataDir }).find(row => row.mirrorRoot === mirrorRoot);
  const result = await require("../src/core/backcompat/legacy-game-mirrors").retireLegacyGameMirror(descriptor, { userDataDir });
  assert.equal(descriptor.createSourceWithin, game);
  assert.equal(result.complete, true, result.reason);
  assert.equal(fs.readFileSync(path.join(Launch.resolveSaveLocations(entry, {}).primaryDirectory, "new.sav"), "utf8"), "only surviving progress");
  assert.equal(fs.existsSync(mirrorRoot), false);
});
test("released v0.5.1 RealLive retains private progress when the original game anchor is missing", async t => {
  const root = fs.realpathSync(fixture(t)), game = path.join(root, "MissingOriginal"), userDataDir = path.join(root, "profile");
  const entry = { gameId: "missing-anchor", gamePath: game, moduleData: { engineKind: "reallive" } };
  const mirrorRoot = path.join(userDataDir, "games", entry.gameId, "modules", "siglus", "saves");
  fs.mkdirSync(mirrorRoot, { recursive: true }); fs.writeFileSync(path.join(mirrorRoot, "save001.sav"), "only surviving progress");
  const descriptor = Backcompat.legacyGameMirrors(entry, { userDataDir }).find(row => row.mirrorRoot === mirrorRoot);
  const result = await require("../src/core/backcompat/legacy-game-mirrors").retireLegacyGameMirror(descriptor, { userDataDir });
  assert.equal(result.complete, false); assert.match(result.reason, /ENOENT/);
  assert.equal(fs.existsSync(game), false, "migration must not create a fake game root");
  assert.equal(fs.readFileSync(path.join(mirrorRoot, "save001.sav"), "utf8"), "only surviving progress");
});

test("Siglus released save facts use exact owned layouts and original authored choices only", t => {
  const root = fs.realpathSync(fixture(t)), game = path.join(root, "Original"), userDataDir = path.join(root, "profile"); fs.mkdirSync(game);
  const names = ["REALLIVE_SAVE_DIR", "AVG32_SAVE_DIR"], previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  t.after(() => { for (const name of names) if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; });
  for (const engineKind of ["siglus", "reallive", "avg32"]) {
    for (const name of names) delete process.env[name];
    const baseline = { gameId: "facts-" + engineKind, gamePath: game, runtimeId: "siglus", launchArguments: "--fullscreen", moduleData: { engineKind } };
    const moduleRoot = path.join(userDataDir, "games", baseline.gameId, "modules", "siglus");
    const mirrorRoot = engineKind === "siglus" ? path.join(moduleRoot, "project") : path.join(moduleRoot, "saves");
    const directory = engineKind === "siglus" ? path.join(mirrorRoot, "savedata") : mirrorRoot;
    fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(path.join(directory, "slot.sav"), "released progress");
    const current = { ...baseline, saveDirOverride: path.join(root, "generated-choice") }, before = JSON.stringify(current);
    const context = { userDataDir, games: [baseline], gameArguments: ["--fullscreen"] };
    const row = Backcompat.legacyGameMirrors(current, context).find(value => value.mirrorRoot === mirrorRoot);
    assert.deepEqual(row.releasedSaveRoute, { directory, entryPatch: { saveDirOverride: directory }, proven: true, explicit: false });
    assert.equal(Launch.saveDirectory({ ...current, ...row.releasedSaveRoute.entryPatch }), directory);
    assert.equal(JSON.stringify(current), before, "fact collection never applies the route");
    const pending = Backcompat.legacyGameMirrors({ ...baseline, gamePath: "unknown-original" }, context)[0];
    assert.equal(pending.sourceRoot, null); assert.deepEqual(pending.releasedSaveRoute, row.releasedSaveRoute);
    const authored = { ...baseline, saveDirOverride: path.join(root, "authored") };
    assert.equal(Backcompat.legacyGameMirrors(current, { ...context, games: [authored] }).find(value => value.mirrorRoot === mirrorRoot).releasedSaveRoute.explicit, true);
    process.env[engineKind === "reallive" ? "AVG32_SAVE_DIR" : "REALLIVE_SAVE_DIR"] = path.join(root, "unrelated-env");
    if (engineKind === "siglus") process.env.AVG32_SAVE_DIR = path.join(root, "also-unrelated");
    assert.equal(Backcompat.legacyGameMirrors(current, context).find(value => value.mirrorRoot === mirrorRoot).releasedSaveRoute.explicit, false);
    if (engineKind !== "siglus") {
      process.env[engineKind === "reallive" ? "REALLIVE_SAVE_DIR" : "AVG32_SAVE_DIR"] = path.join(root, "authored-env");
      assert.equal(Backcompat.legacyGameMirrors(current, context).find(value => value.mirrorRoot === mirrorRoot).releasedSaveRoute.explicit, true);
    }
    assert.equal(fs.readFileSync(path.join(directory, "slot.sav"), "utf8"), "released progress");
  }
});
