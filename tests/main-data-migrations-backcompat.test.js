const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), vm = require("node:vm");
const GameStore = require("../src/core/game-store");
const StoredPlan = require("../src/modules/shared/effects/stored-plan");
const Writable = require("../src/modules/shared/backcompat/writable-input");
const { createSettingsSnapshots } = require("../src/core/settings-snapshots");
const { mergeSettingsChanges } = require("../src/core/settings-merge");
const { ORIGINAL_GAME_MIRRORS_MIGRATION: KEY } = require("../src/core/backcompat/data-migrations");

// Exercise the actual startup callbacks and cache-aware writer, following the
// same bounded main.js extraction used by the shutdown/session fixtures.
function fixture(t, settingsDocument = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "main-data-migrations-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userDataDir = path.join(root, "profile"), main = fs.readFileSync(path.join(__dirname, "../src/main/main.js"), "utf8");
  let raw = structuredClone(settingsDocument), writes = 0;
  const snapshots = createSettingsSnapshots({ readSettings: () => structuredClone(raw),
    commitSettings(_before, next) { raw = structuredClone(next);return structuredClone(raw); } });
  const context = vm.createContext({ GAME_SCHEMA_VERSION: GameStore.CURRENT_RECORD_SCHEMA_VERSION, StoredPlan, mergeSettingsChanges,
    require: request => require(path.join(__dirname, "../src/main", request)), ORIGINAL_GAME_MIRRORS_MIGRATION: KEY, userDataDir, settings: snapshots.load(), games: [], gameRecordsCache: [],
    app: { getPath: () => userDataDir }, assertGameNotRemoving() {},
    GameStore: { ...GameStore, writeGameRecord(...args) { writes++;return GameStore.writeGameRecord(...args); } },
    saveSettings: value => snapshots.save(value), logger: { warn() {} }, showStartupMigration() {},
    Modules: { getModule: () => Writable } });
  function section(start, end) {
    const first = main.indexOf(start), last = main.indexOf(end, first);
    assert.ok(first >= 0 && last > first, "The actual main-process migration/writer source must be exercised");
    return main.slice(first, last);
  }
  vm.runInContext(section("function serializeGameEntry(", "// Notices from the one-time graphics upgrade") +
    section("function graphicsNotices(", "function isGameRemoving(") +
    section("function saveGameRecord(", "function saveGameRecords("), context);
  const startup = vm.runInContext("(async function () {" +
    section("    if (settings?.dataMigrations?.[ORIGINAL_GAME_MIRRORS_MIGRATION]?.complete !== true) await require(", "    const synced = LibraryState.syncLibraryStateWithGames(") + "})", context);
  return { root, userDataDir, context, startup, raw: () => raw, replaceRaw: value => { raw = structuredClone(value); }, writes: () => writes };
}

test("main migration persists restored paths before mutating the aliased loaded game-record cache", async t => {
  const f = fixture(t), source = path.join(f.root, "Original"), view = path.join(f.userDataDir, "games/game/modules/renpy/writable-input/files");
  const chosen = path.join(f.root, "Chosen saves");
  const entry = f.context.serializeGameEntry({ gameId: "game", moduleId: "renpy", gamePath: source,
    importPath: path.join(f.root, "original.zip"), name: "Keep title", notes: "Keep notes", networkAccess: false,
    contentRootDir: view, indexDir: path.join(view, "web"), indexHtml: path.join(view, "web/index.html"),
    defaultSaveDir: path.join(view, "game/saves"), saveDirOverride: chosen,
    saveLocations: [{ directory: path.join(view, "game/saves"), label: "Local" }],
    runtimeId: "sdk", runtimeData: { sdk: { version: "8.5.3" } },
    moduleData: { writableInput: { schemaVersion: 1, root: view, sourceRoot: source }, keep: "module bytes" } });
  GameStore.writeGameRecord(f.userDataDir, entry);
  // First loadGamesHydrated shares this exact array/object with its cache.
  f.context.games = [entry];f.context.gameRecordsCache = f.context.games;
  await f.startup();
  assert.equal(f.writes(), 1, "A cache comparison must not suppress the actual restored record write");
  const restored = GameStore.readGameRecord(f.userDataDir, "game");
  assert.equal(restored.contentRootDir, source);assert.equal(restored.indexDir, path.join(source, "web"));
  assert.equal(restored.indexHtml, path.join(source, "web/index.html"));
  assert.equal(restored.defaultSaveDir, path.join(source, "game/saves"));assert.equal(restored.saveDirOverride, chosen);
  assert.equal(restored.saveLocations[0].directory, path.join(source, "game/saves"));
  for (const key of ["gameId", "gamePath", "importPath", "name", "notes", "runtimeData", "moduleData"])
    assert.equal(JSON.stringify(restored[key]), JSON.stringify(entry[key]), key);
  assert.equal(f.raw().dataMigrations[KEY].complete, true);
});

test("main migration checkpoints retain concurrently committed unrelated migration settings and completion avoids further callbacks", async t => {
  const f = fixture(t, { launcher: { keep: "preference" }, dataMigrations: { earlier: { complete: true } } });
  let hooks = 0;
  const entry = f.context.serializeGameEntry({ gameId: "game", moduleId: "fixture", gamePath: path.join(f.root, "Original"), networkAccess: false });
  GameStore.writeGameRecord(f.userDataDir, entry);
  f.context.games = [entry];f.context.gameRecordsCache = f.context.games;
  f.context.Modules.getModule = () => ({ legacyGameMirrors() { hooks++;return []; } });
  // Arrives after the loaded snapshot, before the first migration checkpoint.
  f.replaceRaw({ ...f.raw(), dataMigrations: { ...f.raw().dataMigrations, concurrent: { complete: true, keep: "external bytes" } } });
  await f.startup();
  assert.equal(hooks, 1);assert.deepEqual(f.raw().dataMigrations.concurrent, { complete: true, keep: "external bytes" });
  assert.deepEqual(f.raw().dataMigrations.earlier, { complete: true });assert.equal(f.raw().launcher.keep, "preference");
  assert.equal(f.raw().dataMigrations[KEY].complete, true);
  f.context.Modules.getModule = () => assert.fail("Completed startup must not consult modules");
  f.context.saveSettings = () => assert.fail("Completed startup must not persist another checkpoint");
  await f.startup();
  assert.equal(f.writes(), 0);
});

test("one-time module argument and save-location edits persist as ordinary current game settings", async t => {
  const f = fixture(t);
  const entry = f.context.serializeGameEntry({gameId: "game", moduleId: "fixture", gamePath: path.join(f.root, "Original"),
    launchArguments: "--fullscreen", notes: "Keep notes", networkAccess: false});
  GameStore.writeGameRecord(f.userDataDir, entry);
  f.context.games = [entry];f.context.gameRecordsCache = f.context.games;
  let attempts = 0;
  const destination = path.join(f.root, "Engine saves", "released-id");
  f.context.Modules.getModule = () => ({legacyGameMirrors(working) {
    attempts++;
    working.launchArguments += " --gameid=released-id";
    working.defaultSaveDir = destination;
    return [];
  }});
  await f.startup();
  const saved = GameStore.readGameRecord(f.userDataDir, "game");
  assert.equal(saved.launchArguments, "--fullscreen --gameid=released-id");
  assert.equal(saved.defaultSaveDir, destination);assert.equal(saved.notes, "Keep notes");
  assert.equal(f.context.games[0].launchArguments, saved.launchArguments);
  assert.equal(f.writes(), 1);
  await f.startup();
  assert.equal(attempts, 1);assert.equal(f.writes(), 1);
});

test("migration preserves concurrent record edits after the main cache advances", async t => {
  const f = fixture(t), original = path.join(f.root, "Original"), oldView = path.join(f.userDataDir, "games/game/old-view");
  const entry = f.context.serializeGameEntry({ gameId: "game", moduleId: "fixture", gamePath: original,
    contentRootDir: oldView, notes: "Before migration", networkAccess: false,
    runtimeData: { runner: { version: "one", keep: true } } });
  GameStore.writeGameRecord(f.userDataDir, entry);
  f.context.games = [structuredClone(entry)];f.context.gameRecordsCache = [structuredClone(entry)];
  f.context.Modules.getModule = () => ({ async legacyGameMirrors(working) {
    await Promise.resolve();
    f.context.saveGameRecord({ ...entry, notes: "Concurrent user edit",
      runtimeData: { runner: { version: "two", keep: true, workerFact: "new" } } });
    working.contentRootDir = original;
    return [];
  } });
  await f.startup();
  const stored = GameStore.readGameRecord(f.userDataDir, "game");
  assert.equal(stored.contentRootDir, original);
  assert.equal(stored.notes, "Concurrent user edit");
  assert.deepEqual(stored.runtimeData, { runner: { version: "two", keep: true, workerFact: "new" } });
  assert.equal(JSON.stringify(f.context.games[0]), JSON.stringify(stored));
  assert.equal(JSON.stringify(f.context.gameRecordsCache[0]), JSON.stringify(stored));
  assert.equal(f.writes(), 2);
});
