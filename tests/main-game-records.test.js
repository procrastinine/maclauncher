const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), vm = require("node:vm");
const GameStore = require("../src/core/game-store");
const StoredPlan = require("../src/modules/shared/effects/stored-plan");
const {mergeSettingsChanges} = require("../src/core/settings-merge");

// Main's real serializer/cache writer, isolated from Electron like the existing
// shutdown/session fixtures; all record I/O uses owned temporary directories.
function fixture(t) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "main-game-records-"));
  t.after(() => fs.rmSync(userDataDir, {recursive: true, force: true}));
  const source = fs.readFileSync(path.join(__dirname, "../src/main/main.js"), "utf8");
  const section = (start, end) => {
    const first = source.indexOf(start), last = source.indexOf(end, first);
    assert.ok(first >= 0 && last > first, "The actual main record writer must be exercised");
    return source.slice(first, last);
  };
  let writes = 0;
  const context = vm.createContext({GAME_SCHEMA_VERSION: GameStore.CURRENT_RECORD_SCHEMA_VERSION, StoredPlan, mergeSettingsChanges, structuredClone,
    app: {getPath: () => userDataDir}, gameRecordsCache: null,
    assertGameNotRemoving() {}, isGameRemoving: () => false, hydrateCheatsFromFiles: () => false,
    NetworkAccess: {preferenceForEntry: () => false}, loadSettings: () => ({}),
    GameStore: {...GameStore, writeGameRecord(...args) {writes++; return GameStore.writeGameRecord(...args);}}});
  vm.runInContext(section("function serializeGameEntry(", "// Notices from the one-time graphics upgrade") +
    section("function graphicsNotices(", "function isGameRemoving(") +
    section("function saveGameRecord(", "function persistGames(") +
    section("function loadGamesHydrated(", "function orderGames("), context);
  const entry = context.serializeGameEntry({gameId: "game", gamePath: path.join(userDataDir, "Original"),
    name: "Original title", notes: "Original notes", networkAccess: false, moduleId: "fixture",
    moduleData: {version: "old", preferences: {keep: true}}, runtimeData: {runner: {version: "one"}}});
  GameStore.writeGameRecord(userDataDir, entry);
  context.gameRecordsCache = [structuredClone(entry)];
  return {userDataDir, context, entry, writes: () => writes,
    read: () => GameStore.readGameRecord(userDataDir, entry.gameId),
    write: record => GameStore.writeGameRecord(userDataDir, record)};
}

test("main saves a user delta without replacing unseen worker facts or unknown record fields", t => {
  const f = fixture(t), userEdit = structuredClone(f.entry);
  userEdit.notes = "User notes";userEdit.runtimeData.runner.version = "chosen";
  f.write({...f.entry, defaultSaveDir: "/new/portable/save", moduleData: {version: "new", preferences: {keep: true}, detected: true},
    runtimeData: {runner: {version: "one", detectedVersion: "worker"}}, workerField: {keep: "unknown field"}});
  const saved = f.context.saveGameRecord(userEdit), stored = f.read();
  assert.equal(stored.notes, "User notes");assert.equal(stored.defaultSaveDir, "/new/portable/save");
  assert.equal(stored.moduleData.version, "new");assert.equal(stored.moduleData.detected, true);
  assert.equal(stored.moduleData.preferences.keep, true);assert.equal(stored.runtimeData.runner.version, "chosen");
  assert.equal(stored.runtimeData.runner.detectedVersion, "worker");assert.equal(stored.workerField.keep, "unknown field");
  assert.equal(JSON.stringify(saved), JSON.stringify(stored));
  assert.equal(JSON.stringify(f.context.gameRecordsCache[0]), JSON.stringify(stored));assert.equal(f.writes(), 1);
});

test("an unchanged submitted entry synchronizes newer disk facts without another write", t => {
  const f = fixture(t);
  f.write({...f.entry, moduleData: {...f.entry.moduleData, version: "worker"}, notes: "Concurrent notes"});
  const saved = f.context.saveGameRecord(structuredClone(f.entry));
  assert.equal(saved.moduleData.version, "worker");assert.equal(saved.notes, "Concurrent notes");
  assert.equal(f.context.gameRecordsCache[0].moduleData.version, "worker");assert.equal(f.writes(), 0);
});

test("main does not rewrite facts already committed by another operation", t => {
  const f = fixture(t), worker = {...f.entry, moduleData: {...f.entry.moduleData, version: "worker"}};
  f.write(worker);
  f.context.saveGameRecord(worker);
  assert.equal(f.writes(), 0);assert.equal(f.context.gameRecordsCache[0].moduleData.version, "worker");
});

test("batch saves keep freshly merged disk fields in the cache", t => {
  const f = fixture(t), userEdit = structuredClone(f.entry);userEdit.notes = "Batch edit";
  f.write({...f.entry, moduleData: {...f.entry.moduleData, version: "worker"}});
  f.context.saveGameRecords([userEdit]);
  assert.equal(f.read().notes, "Batch edit");assert.equal(f.read().moduleData.version, "worker");
  assert.equal(f.context.gameRecordsCache[0].moduleData.version, "worker");assert.equal(f.writes(), 1);
});

test("the initial hydrated library read cannot mutate the writer's cached baseline", t => {
  const f = fixture(t);f.context.gameRecordsCache = null;
  const first = f.context.loadGamesHydrated();first[0].notes = "Unsaved";first[0].moduleData.preferences.keep = false;
  const second = f.context.loadGamesHydrated();
  assert.equal(second[0].notes, "Original notes");assert.equal(second[0].moduleData.preferences.keep, true);
  assert.equal(f.read().notes, "Original notes");assert.equal(f.writes(), 0);
});
