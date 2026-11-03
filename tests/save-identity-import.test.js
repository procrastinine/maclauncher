const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), vm = require("node:vm");
const {createLauncher, resolveModuleId} = require("../src/core/launcher");
const {applySaveIdentity} = require("../src/core/save-identity");
const GameStore = require("../src/core/game-store"), GameData = require("../src/modules/shared/game-data");
const LibraryState = require("../src/core/library-state"), NetworkAccess = require("../src/core/network-access");

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "save-identity-import-")));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const userDataDir = path.join(root, "profile"), rows = new Map(), gates = new Map();
  const settings = {modules: {}, runtimes: {}, launcher: {networkAccess: false, library: LibraryState.DEFAULT_LIBRARY_STATE}};
  const calls = {identity: 0, patch: 0};
  const manifest = {id: "identity-fixture", gameType: "native", runtime: {default: "runner", supported: ["runner"]}};
  const mod = {id: manifest.id, manifest,
    resolveSaveIdentity(entry) {
      calls.identity++;
      return {namespace: "filesystem", identity: entry.saveDirOverride || entry.defaultSaveDir,
        explicit: Boolean(entry.saveDirOverride), createPatch({gameId}) {
          calls.patch++;
          return {saveDirOverride: path.join(root, "visible-save-choices", gameId)};
        }};
    }};
  function detected(file) {
    assert.ok(rows.has(file), "The fixture only detects its selected original games");
    return {name: "Same title", gamePath: file, contentRootDir: file, moduleId: mod.id,
      defaultSaveDir: rows.get(file), moduleData: {}, runtimeData: {}};
  }
  const registry = {getModule: () => mod, getModuleInfo: () => manifest, listModules: () => [manifest],
    listModuleIds: () => [manifest.id], listSharedRuntimeManagers: () => [],
    async detectGameAsync(file) {const gate = gates.get(file);if (gate) {gate.enter();await gate.wait;}return detected(file);}};
  const launcher = createLauncher({userDataDir, registry, loadSettings: () => settings, logger: {},
    inputPreparation: async file => ({inputPath: file, containerData: null})});
  function game(name, saveName = "shared") {
    const file = path.join(root, "games", name);fs.mkdirSync(file, {recursive: true});fs.writeFileSync(path.join(file, "game.txt"), "original game");
    rows.set(file, path.join(root, "upstream-saves", saveName));return file;
  }
  function block(file) {
    let enter, release;
    const entered = new Promise(resolve => {enter = resolve;}), wait = new Promise(resolve => {release = resolve;});
    gates.set(file, {enter, wait});return {entered, release};
  }
  return {root, userDataDir, settings, calls, registry, launcher, game, detected, block};
}

test("core import commits collision settings once while direct, explicit and inspected games stay unchanged", async t => {
  const f = fixture(t), firstPath = f.game("first"), secondPath = f.game("second"), thirdPath = f.game("third", "different");
  const first = await f.launcher.resolveEntry(firstPath), firstId = first.gameId;
  assert.equal(first.name, "Same title");assert.equal(first.contentRootDir, firstPath);assert.equal(first.saveDirOverride, null);
  assert.equal(GameStore.readGameRecord(f.userDataDir, firstId).saveDirOverride, null);
  const second = await f.launcher.resolveEntry(secondPath);
  assert.equal(second.name, first.name);assert.equal(second.contentRootDir, secondPath);assert.notEqual(second.gameId, firstId);
  assert.equal(second.saveDirOverride, path.join(f.root, "visible-save-choices", second.gameId));
  assert.equal(GameStore.readGameRecord(f.userDataDir, second.gameId).saveDirOverride, second.saveDirOverride);
  assert.equal(f.calls.patch, 1);assert.equal(fs.existsSync(second.saveDirOverride), false, "Import records an ordinary choice without allocating a save mirror");
  const third = await f.launcher.resolveEntry(thirdPath);
  assert.equal(third.name, first.name);assert.equal(third.saveDirOverride, null);assert.equal(f.calls.patch, 1);

  const chosen = path.join(f.root, "user-selected-saves");
  GameStore.writeGameRecord(f.userDataDir, {...first, saveDirOverride: chosen});
  const before = {...f.calls};
  const reimported = await f.launcher.resolveEntry(firstPath), repeatedSecond = await f.launcher.resolveEntry(secondPath);
  assert.equal(reimported.gameId, firstId);assert.equal(reimported.saveDirOverride, chosen);
  assert.equal(repeatedSecond.saveDirOverride, second.saveDirOverride);assert.deepEqual(f.calls, before, "Existing imports do not call identity assignment again");
  const inspectedPath = f.game("inspected"), inspected = await f.launcher.resolveEntry(inspectedPath, {persist: false});
  assert.equal(inspected.contentRootDir, inspectedPath);assert.equal(inspected.saveDirOverride, null);assert.deepEqual(f.calls, before);
  assert.equal(GameStore.loadGames(f.userDataDir).length, 3, "Read-only inspection writes no game record");
});

test("core collision assignment sees a game committed after asynchronous detection began", async t => {
  const f = fixture(t), delayedPath = f.game("delayed"), directPath = f.game("committed-during-detection");
  const gate = f.block(delayedPath), pending = f.launcher.resolveEntry(delayedPath);
  await gate.entered;
  let direct;
  try {direct = await f.launcher.resolveEntry(directPath);} finally {gate.release();}
  const delayed = await pending;
  assert.equal(direct.saveDirOverride, null);
  assert.equal(delayed.saveDirOverride, path.join(f.root, "visible-save-choices", delayed.gameId));
  assert.equal(GameStore.readGameRecord(f.userDataDir, delayed.gameId).saveDirOverride, delayed.saveDirOverride);
  assert.equal(f.calls.patch, 1);
});

test("main upsert assigns only new real collisions against its committed ordered library", t => {
  const f = fixture(t), source = fs.readFileSync(path.join(__dirname, "../src/main/main.js"), "utf8");
  const start = source.indexOf("function upsertGame("), end = source.indexOf("function removeGameByPath(", start);
  assert.ok(start >= 0 && end > start, "Exercise the actual Electron import commit entry point");
  const context = vm.createContext({LibraryState, NetworkAccess, GameData, applySaveIdentity, resolveModuleId,
    Modules: f.registry, GAME_SCHEMA_VERSION: 1, userDataDir: f.userDataDir, logger: {},
    normalizeGameEntry: entry => structuredClone(entry)});
  vm.runInContext(source.slice(start, end), context);
  function commit(incoming) {
    const result = context.upsertGame(GameStore.loadGames(f.userDataDir), incoming, f.settings);
    GameStore.writeGameRecord(f.userDataDir, result.entry);
    return result;
  }
  const firstPath = f.game("first"), first = commit(f.detected(firstPath));
  assert.equal(first.entry.saveDirOverride, undefined);assert.equal(first.entry.contentRootDir, firstPath);
  const second = commit(f.detected(f.game("second")));
  assert.equal(second.entry.name, first.entry.name);
  assert.equal(second.entry.saveDirOverride, path.join(f.root, "visible-save-choices", second.entry.gameId));
  assert.equal(GameStore.readGameRecord(f.userDataDir, second.entry.gameId).saveDirOverride, second.entry.saveDirOverride);
  const third = commit(f.detected(f.game("third", "different")));
  assert.equal(third.entry.name, first.entry.name);assert.equal(third.entry.saveDirOverride, undefined);
  const chosen = path.join(f.root, "user-selected-saves");
  const explicit = commit({...f.detected(f.game("explicit")), saveDirOverride: chosen});
  assert.equal(explicit.entry.saveDirOverride, chosen);assert.equal(f.calls.patch, 1);
  const before = {...f.calls}, repeated = commit(f.detected(second.entry.gamePath));
  assert.equal(repeated.entry.gameId, second.entry.gameId);assert.equal(repeated.entry.saveDirOverride, second.entry.saveDirOverride);
  assert.deepEqual(f.calls, before, "The actual main commit skips identity dispatch on an existing path");
  assert.equal(GameStore.loadGames(f.userDataDir).length, 4);
  assert.equal(new Set(f.settings.launcher.library.order).size, 4, "Real library state carries each persisted game identity");
});
