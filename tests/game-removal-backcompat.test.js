const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const Store = require("../src/core/game-store");
const Data = require("../src/modules/shared/game-data");
const Backcompat = require("../src/core/backcompat/game-removal");
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-removal-backcompat-")), userDataDir = path.join(root, "data"), gamePath = path.join(root, "original");
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  fs.mkdirSync(gamePath); fs.writeFileSync(path.join(gamePath, "original.dat"), "unchanged");
  const entry = {gameId:"game-one", moduleId:"fixture", gamePath, contentRootDir:gamePath, notes:"Keep these notes"};
  Store.writeGameRecord(userDataDir, entry);
  let calls = 0;
  const mod = {cleanupGameData: () => { calls++; }};
  return {root, userDataDir, gamePath, entry, mod, registry:{getModule:()=>mod}, cleanupCalls:()=>calls};
}

test("persisted retained game roots refuse removal before Trash or cleanup without scanning or retrying recovery", async t => {
  const f = fixture(t), { createGameRemoval } = require("../src/core/game-removal");
  const mirrorRoot = path.join(Data.resolveGameDir(f.userDataDir, f.entry.gameId), "modules/dosbox/drive-c");
  fs.mkdirSync(mirrorRoot, { recursive: true }); fs.writeFileSync(path.join(mirrorRoot, "ONLY.SAV"), "sole private save");
  const settings = { dataMigrations: { "original-game-mirrors-v1": { complete: true, pendingIds: [f.entry.gameId],
    retained: [{ id: f.entry.gameId, failures: [{ mirrorRoot, reason: "Original unavailable" }] }] } } };
  const before = JSON.stringify(settings); let reads = 0, trashCalls = 0, runtimeCalls = 0;
  const remove = createGameRemoval({ userDataDir: f.userDataDir, registry: f.registry,
    lifecycle: { remove: async (_entry, action) => action() }, readSettings: () => { reads++; return settings; },
    listRuntimeManagers: () => [{ cleanupGameData: () => { runtimeCalls++; } }], trashItem: () => { trashCalls++; } });
  t.mock.method(fs, "readdirSync", () => assert.fail("Removal must not scan retained roots"));
  f.mod.legacyGameMirrors = () => assert.fail("Removal must not rerun migration hooks");
  for (const trash of [false, true]) await assert.rejects(remove(f.entry, { trash }), { code: "GAME_DATA_RETAINED" });
  assert.equal(reads, 2); assert.equal(trashCalls, 0); assert.equal(runtimeCalls, 0); assert.equal(f.cleanupCalls(), 0);
  assert.equal(fs.readFileSync(path.join(mirrorRoot, "ONLY.SAV"), "utf8"), "sole private save");
  assert.equal(fs.readFileSync(path.join(f.gamePath, "original.dat"), "utf8"), "unchanged");
  assert.equal(Store.readGameRecord(f.userDataDir, f.entry.gameId).notes, "Keep these notes");
  assert.equal(JSON.stringify(settings), before);
  settings.dataMigrations["original-game-mirrors-v1"].retained[0].failures = [{ reason: "Undeclared private roots retained" }];
  await assert.rejects(remove(f.entry), { code: "GAME_DATA_RETAINED" });
});

test("retained external roots or another game's diagnostics preserve normal explicit removal", async t => {
  const f = fixture(t), { createGameRemoval } = require("../src/core/game-removal");
  const external = path.join(f.root, "external-saves"); fs.mkdirSync(external); fs.writeFileSync(path.join(external, "save"), "external state");
  const settings = { dataMigrations: { "original-game-mirrors-v1": { complete: true, retained: [
    { id: f.entry.gameId, failures: [{ mirrorRoot: external, reason: "Outside launcher data" }] },
    { id: "another-game", failures: [{ mirrorRoot: Data.resolveGameDir(f.userDataDir, "another-game") }] }
  ] } } };
  let trashCalls = 0;
  const remove = createGameRemoval({ userDataDir: f.userDataDir, registry: f.registry,
    lifecycle: { remove: async (_entry, action) => action() }, readSettings: () => settings,
    listRuntimeManagers: () => [], trashItem: () => { trashCalls++; } });
  await remove(f.entry, { trash: true });
  assert.equal(trashCalls, 1); assert.equal(f.cleanupCalls(), 1);
  assert.equal(fs.existsSync(Data.resolveGameDir(f.userDataDir, f.entry.gameId)), false);
  assert.equal(fs.readFileSync(path.join(external, "save"), "utf8"), "external state");
});

test("only acknowledgment of this game's exact retained diagnostics permits explicit removal", async t => {
  const f = fixture(t), { createGameRemoval } = require("../src/core/game-removal");
  const mirrorRoot = path.join(Data.resolveGameDir(f.userDataDir, f.entry.gameId), "modules/dosbox/drive-c");
  const settings = { dataMigrations: { legacy: { retained: [{ id: f.entry.gameId, failures: [{ mirrorRoot, reason: "Recovery failed" }] }] } } };
  let trashCalls = 0;
  const remove = createGameRemoval({ userDataDir: f.userDataDir, registry: f.registry,
    lifecycle: { remove: async (_entry, action) => action() }, readSettings: () => settings,
    listRuntimeManagers: () => [], trashItem: () => { trashCalls++; } });
  const acknowledgment = Backcompat.retainedGameDataRemoval(f.entry, settings, f.userDataDir);
  for (const invalid of [true, { ...acknowledgment, gameId: "another-game" }, { ...acknowledgment, retained: [] }])
    await assert.rejects(remove(f.entry, { trash: true, retainedGameDataAcknowledgment: invalid }), { code: "GAME_DATA_RETAINED" });
  assert.equal(trashCalls, 0); assert.equal(f.cleanupCalls(), 0);
  await remove(f.entry, { trash: true, retainedGameDataAcknowledgment: acknowledgment });
  assert.equal(trashCalls, 1); assert.equal(f.cleanupCalls(), 1);
  assert.equal(fs.existsSync(Data.resolveGameDir(f.userDataDir, f.entry.gameId)), false);
});

function removalUI(t, responses, { retained = true } = {}) {
  const f = fixture(t), requests = [], shown = [], revealed = [], handlers = new Map();
  const mirrorRoot = path.join(Data.resolveGameDir(f.userDataDir, f.entry.gameId), "modules/dosbox/drive-c");
  const settings = { dataMigrations: { legacy: { retained: retained ? [{ id: f.entry.gameId, failures: [{ mirrorRoot, reason: "Original was unavailable" }] }] : [] } } };
  const owner = {};
  const context = { require: name => { assert.equal(name, "../core/backcompat/game-removal"); return Backcompat; },
    loadSettings: () => settings, userDataDir: f.userDataDir, path, GameData: Data,
    dialog: { showMessageBox: async (...args) => { shown.push(args); assert.ok(responses.length, "Unexpected extra confirmation"); return { response: responses.shift() }; } },
    shell: { showItemInFolder: file => revealed.push(file) },
    findGameByPath: () => f.entry, loadGamesHydrated: () => [f.entry], assertGameRemovalAvailable: () => {},
    gameRemovals: new Map(), broadcastState: () => {}, getLauncherDialogOwner: () => owner,
    backendService: { request: async (...args) => {
      requests.push(args); Backcompat.assertRetainedGameDataRemoval(f.entry, settings, f.userDataDir, args[3].retainedGameDataAcknowledgment);
    } }, removeGameByPath: () => ({ games: [] }), persistGames: () => {}, saveSettings: () => {}, buildState: () => ({}),
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, BrowserWindow: { fromWebContents: () => owner } };
  const source = fs.readFileSync(path.join(__dirname, "../src/main/main.js"), "utf8");
  const start = source.indexOf("async function confirmGameRemoval("), end = source.indexOf("async function removeLibraryPaths(", start);
  assert.ok(start >= 0 && end > start); vm.runInNewContext(source.slice(start, end), context);
  const handlerStart = source.indexOf('ipcMain.handle("launcher:deleteGame",');
  const handlerEnd = source.indexOf('ipcMain.handle("launcher:launchGame",', handlerStart);
  vm.runInNewContext(source.slice(handlerStart, handlerEnd), context);
  const forgetStart = source.indexOf('ipcMain.handle("launcher:forgetGame",');
  const forgetEnd = source.indexOf('ipcMain.handle("launcher:findMissingGames",', forgetStart);
  vm.runInNewContext(source.slice(forgetStart, forgetEnd), context);
  return { f, context, requests, shown, revealed, handlers, mirrorRoot, settings, owner };
}

test("retained removal's existing native dialog reveals the exact folder and Cancel never acknowledges", async t => {
  const ui = removalUI(t, [0, 2]);
  assert.equal(await ui.handlers.get("launcher:deleteGame")({ sender: {} }, ui.f.gamePath), false);
  assert.equal(ui.requests.length, 0); assert.equal(ui.shown.length, 2);
  assert.deepEqual(ui.revealed, [ui.mirrorRoot]);
  for (const args of ui.shown) {
    assert.equal(args[0], ui.owner);
    assert.equal(JSON.stringify(args[1].buttons), JSON.stringify(["Show in Finder", "Remove Anyway", "Cancel"]));
    assert.ok(args[1].detail.includes(ui.mirrorRoot)); assert.match(args[1].detail, /Original was unavailable/);
  }
  assert.equal(ui.shown[0][1], ui.shown[1][1], "Finder reopens the same confirmation, not another dialog mechanism");
});

test("Remove Anyway forwards only exact consent, while normal Trash keeps its single confirmation", async t => {
  for (const retained of [true, false]) {
    const ui = removalUI(t, [1], { retained });
    assert.equal(await ui.handlers.get("launcher:deleteGame")({ sender: {} }, ui.f.gamePath), true);
    assert.equal(ui.shown.length, 1); assert.equal(ui.requests.length, 1);
    const options = ui.requests[0][3]; assert.equal(options.trash, true);
    assert.equal(JSON.stringify(options.retainedGameDataAcknowledgment), JSON.stringify(Backcompat.retainedGameDataRemoval(ui.f.entry, ui.settings, ui.f.userDataDir) || undefined));
    if (!retained) assert.equal(JSON.stringify(ui.shown[0][1].buttons), JSON.stringify(["Cancel", "Move to Trash"]));
  }
});

test("Forget reports a retained-data cancellation without removing the library entry", async t => {
  const ui = removalUI(t, [2]);
  assert.equal(await ui.handlers.get("launcher:forgetGame")({}, ui.f.gamePath), false);
  assert.equal(ui.requests.length, 0); assert.equal(ui.shown.length, 1);
});
