const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Backcompat = require("../src/modules/ai5/backcompat");

test("AI5 released save-route facts require the recorded default and preserve explicit choices", t => {
  const root = temporary(t), userDataDir = path.join(root, "profile"), gamePath = path.join(root, "game");
  const oldSaves = path.join(userDataDir, "games", "route", "modules/ai5/saves");
  fs.mkdirSync(oldSaves, { recursive: true });
  const entry = { gameId: "route", gamePath, defaultSaveDir: oldSaves };
  const before = structuredClone(entry), context = { userDataDir, environment: {} };
  const descriptors = Backcompat.legacyGameMirrors(entry, context);
  assert.deepEqual(descriptors[0].releasedSaveRoute, { directory: oldSaves, entryPatch: { saveDirOverride: oldSaves }, proven: true, explicit: false });
  assert.equal(descriptors[1].releasedSaveRoute, undefined, "screenshots have no equivalent visible save override");
  assert.equal(Backcompat.legacyGameMirrors({ ...entry, defaultSaveDir: gamePath }, context)[0].releasedSaveRoute, undefined, "directory name alone is not proof");
  for (const patch of [{ saveDirOverride: path.join(root, "chosen") }, { launchArguments: '--save-dir "chosen"' }, { launchArguments: '"unclosed' }])
    assert.equal(Backcompat.legacyGameMirrors({ ...entry, ...patch }, context)[0].releasedSaveRoute.explicit, true);
  assert.equal(Backcompat.legacyGameMirrors(entry, { userDataDir, environment: { MACLAUNCHER_AI5_SAVE_DIR: path.join(root, "authored") } })[0].releasedSaveRoute.explicit, true);
  assert.deepEqual(entry, before, "module facts never apply a pending route themselves");
});

function temporary(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ai5-backcompat-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
function gameFixture(root) { fs.mkdirSync(root, { recursive: true }); return { root }; }

test("AI5 backcompat declares only released output roots without filesystem work", t => {
  const root = temporary(t), sourceRoot = path.join(root, "original"), userDataDir = path.join(root, "launcher");
  const entry = { gameId: "released", gamePath: sourceRoot }, directory = path.join(userDataDir, "games/released/modules/ai5");
  const expected = [
    { mirrorRoot: path.join(directory, "saves"), sourceRoot },
    { mirrorRoot: path.join(directory, "screenshots"), sourceRoot: path.join(sourceRoot, "Screenshots"), createSourceWithin: sourceRoot }
  ];
  for (const name of ["existsSync", "statSync", "lstatSync", "readdirSync", "readFileSync", "mkdirSync"]) {
    t.mock.method(fs, name, () => assert.fail(`backcompat descriptors must not touch files: ${name}`));
  }
  assert.deepEqual(Backcompat.legacyGameMirrors(entry, { userDataDir }), expected);
  entry.saveDirOverride = path.join(directory, "saves/custom");
  assert.deepEqual(Backcompat.legacyGameMirrors(entry, { userDataDir }), [expected[1]]);
  entry.saveDirOverride = directory;
  assert.deepEqual(Backcompat.legacyGameMirrors(entry, { userDataDir }), []);
  assert.deepEqual(Backcompat.legacyGameMirrors({ ...entry, gameId: "../escape" }, { userDataDir }), []);
});

test("AI5 released private output bytes return to original paths and preserve conflicts", async t => {
  // v0.5.1 main.js:91–93 created these exact module/saves and
  // module/screenshots roots; no generated configuration belongs in either.
  const root = fs.realpathSync(temporary(t)), game = gameFixture(path.join(root, "original"));
  const userDataDir = path.join(root, "launcher"), entry = { gameId: "released-ai5", gamePath: game.root };
  const moduleRoot = path.join(userDataDir, "games/released-ai5/modules/ai5");
  const oldSaves = path.join(moduleRoot, "saves"), oldScreenshots = path.join(moduleRoot, "screenshots");
  const newScreenshots = path.join(game.root, "Screenshots");
  for (const directory of [oldSaves, oldScreenshots, newScreenshots]) fs.mkdirSync(directory, { recursive: true });
  const save = Buffer.from([0x41, 0x49, 0x35, 0, 1, 0xff, 0x80, 7]), oldConflict = Buffer.from("released private progress"), originalConflict = Buffer.from("original progress");
  const screenshot = Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0xff]);
  fs.writeFileSync(path.join(oldSaves, "FLAG00"), save);
  fs.writeFileSync(path.join(oldSaves, "FLAG01"), oldConflict); fs.writeFileSync(path.join(game.root, "FLAG01"), originalConflict);
  fs.writeFileSync(path.join(oldScreenshots, "20261031_000001.png"), screenshot);
  fs.writeFileSync(path.join(oldScreenshots, "20261031_000002.png"), "released capture");
  fs.writeFileSync(path.join(newScreenshots, "20261031_000002.png"), "original capture");
  fs.writeFileSync(path.join(moduleRoot, "AI5SDL2.INI"), "required configuration");
  fs.mkdirSync(path.join(moduleRoot, "disc")); fs.writeFileSync(path.join(moduleRoot, "disc/mes.ARC"), "required descriptor");
  const { retireLegacyGameMirror } = require("../src/core/backcompat/legacy-game-mirrors");
  for (const descriptor of Backcompat.legacyGameMirrors(entry, { userDataDir })) {
    const result = await retireLegacyGameMirror(descriptor, { userDataDir });
    assert.equal(result.complete, true, result.reason);
  }
  assert.deepEqual(fs.readFileSync(path.join(game.root, "FLAG00")), save);
  assert.deepEqual(fs.readFileSync(path.join(game.root, "FLAG01")), originalConflict);
  const saveConflicts = fs.readdirSync(game.root).filter(name => name.startsWith("FLAG01.MacLauncher-conflict-"));
  assert.equal(saveConflicts.length, 1); assert.deepEqual(fs.readFileSync(path.join(game.root, saveConflicts[0])), oldConflict);
  assert.deepEqual(fs.readFileSync(path.join(newScreenshots, "20261031_000001.png")), screenshot);
  assert.equal(fs.readFileSync(path.join(newScreenshots, "20261031_000002.png"), "utf8"), "original capture");
  const shotConflicts = fs.readdirSync(newScreenshots).filter(name => name.startsWith("20261031_000002.png.MacLauncher-conflict-"));
  assert.equal(shotConflicts.length, 1); assert.equal(fs.readFileSync(path.join(newScreenshots, shotConflicts[0]), "utf8"), "released capture");
  assert.equal(fs.existsSync(oldSaves), false); assert.equal(fs.existsSync(oldScreenshots), false);
  assert.equal(fs.readFileSync(path.join(moduleRoot, "AI5SDL2.INI"), "utf8"), "required configuration");
  assert.equal(fs.readFileSync(path.join(moduleRoot, "disc/mes.ARC"), "utf8"), "required descriptor");
  fs.rmSync(userDataDir, { recursive: true });
  assert.deepEqual(fs.readFileSync(path.join(game.root, "FLAG00")), save);
  assert.deepEqual(fs.readFileSync(path.join(newScreenshots, "20261031_000001.png")), screenshot);
  assert.deepEqual(fs.readFileSync(path.join(game.root, saveConflicts[0])), oldConflict);
});

test("AI5 released screenshots with a missing original destination restore once beside preserved save conflicts", async t => {
  const root = fs.realpathSync(temporary(t)), game = gameFixture(path.join(root, "original")), userDataDir = path.join(root, "launcher");
  const entry = { gameId: "released-ai5-missing-output", moduleId: "ai5", gamePath: game.root };
  const oldScreenshots = path.join(userDataDir, "games", entry.gameId, "modules/ai5/screenshots"), screenshot = Buffer.from("released capture bytes");
  fs.mkdirSync(oldScreenshots, { recursive: true }); fs.writeFileSync(path.join(oldScreenshots, "capture.png"), screenshot);
  const oldSaves = path.join(userDataDir, "games", entry.gameId, "modules/ai5/saves");
  fs.mkdirSync(oldSaves); fs.writeFileSync(path.join(oldSaves, "FLAG01"), "released progress");
  fs.writeFileSync(path.join(game.root, "FLAG01"), "original progress");
  assert.equal(fs.existsSync(path.join(game.root, "Screenshots")), false);
  const { runDataMigrations, ORIGINAL_GAME_MIRRORS_MIGRATION } = require("../src/core/backcompat/data-migrations");
  const GameStore = require("../src/core/game-store");
  GameStore.writeGameRecord(userDataDir, entry);
  let moduleLookups = 0;
  const registry = { getModule: () => { moduleLookups++; return Backcompat; } };
  let recordWrites = 0;
  const first = await runDataMigrations({ settings: {}, games: [entry], registry, userDataDir, saveSettings: async () => {},
    saveEntry: current => { recordWrites++; GameStore.writeGameRecord(userDataDir, current); } });
  assert.equal(first.complete, true);
  assert.deepEqual(first.pendingIds, []); assert.deepEqual(first.retained, []);
  const state = first.settings.dataMigrations[ORIGINAL_GAME_MIRRORS_MIGRATION];
  assert.equal(state.complete, true);
  const persisted = GameStore.readGameRecord(userDataDir, entry.gameId);
  assert.equal(persisted.schemaVersion, GameStore.CURRENT_RECORD_SCHEMA_VERSION);
  assert.equal(persisted.gamePath, game.root); assert.equal(persisted.gameId, entry.gameId);
  assert.equal(recordWrites, 1, "Old record conversion must persist alongside recovered output bytes");
  const restored = path.join(game.root, "Screenshots/capture.png");
  assert.deepEqual(fs.readFileSync(restored), screenshot);
  assert.equal(fs.existsSync(oldScreenshots), false); assert.equal(fs.existsSync(oldSaves), false);
  assert.equal(fs.readFileSync(path.join(game.root, "FLAG01"), "utf8"), "original progress");
  const conflicts = fs.readdirSync(game.root).filter(name => name.startsWith("FLAG01.MacLauncher-conflict-"));
  assert.equal(conflicts.length, 1); assert.equal(fs.readFileSync(path.join(game.root, conflicts[0]), "utf8"), "released progress");
  const second = await runDataMigrations({ settings: first.settings, games: [entry], registry, userDataDir,
    saveSettings: async () => assert.fail("a completed attempt must not repeat filesystem work"),
    saveEntry: async () => assert.fail("a completed attempt must not repeat record persistence") });
  assert.equal(moduleLookups, 1); assert.deepEqual(second.retained, []);
  fs.rmSync(userDataDir, { recursive: true });
  assert.deepEqual(fs.readFileSync(restored), screenshot);
  assert.equal(fs.readFileSync(path.join(game.root, conflicts[0]), "utf8"), "released progress");
});

test("AI5 absent released screenshot mirror does not create an original destination", async t => {
  const root = temporary(t), game = gameFixture(path.join(root, "original")), userDataDir = path.join(root, "launcher");
  fs.mkdirSync(userDataDir);
  const descriptor = Backcompat.legacyGameMirrors({ gameId: "never-private", gamePath: game.root }, { userDataDir })[1];
  const { retireLegacyGameMirror } = require("../src/core/backcompat/legacy-game-mirrors");
  assert.equal((await retireLegacyGameMirror(descriptor, { userDataDir })).complete, true);
  assert.deepEqual(fs.readdirSync(game.root), []);
});
