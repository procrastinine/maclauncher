const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { EventEmitter } = require("node:events");
const vm = require("node:vm");
const { createBackendOperations } = require("../src/core/backend-operations");
const { createBackendService } = require("../src/core/backend-worker-client");
const { createRuntimeCoordinator } = require("../src/core/runtime-coordinator");
const { createLauncher } = require("../src/core/launcher");
const Store = require("../src/core/game-store");
const Data = require("../src/modules/shared/game-data");

const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
async function waitFor(check) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for game activity.");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-game-removal-")), userDataDir = path.join(root, "data");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const gamePath = path.join(root, "original"); fs.mkdirSync(gamePath); fs.writeFileSync(path.join(gamePath, "original.dat"), "unchanged");
  const entry = { gameId: "game-one", moduleId: "fixture", gamePath, contentRootDir: gamePath, importPath: gamePath,
    runtimeId: "runner", moduleData: {}, notes: "Keep these notes", runtimeSettings: {} };
  Store.writeGameRecord(userDataDir, entry);
  const saved = path.join(Data.resolveGameDir(userDataDir, entry.gameId), "saves", "save.dat");
  fs.mkdirSync(path.dirname(saved)); fs.writeFileSync(saved, "player state");
  const children = [], info = { id: "fixture", label: "Fixture", gameType: "native",
    runtime: { default: "runner", supported: ["runner"], entries: { runner: {} } } };
  let cleanupCalls = 0;
  const mod = { id: info.id, manifest: info,
    launchRuntime: () => {
      const child = Object.assign(new EventEmitter(), { pid: 123450 + children.length, exitCode: null, signalCode: null });
      children.push(child); return child;
    }, cleanupGameData: async (...args) => { cleanupCalls++; await options.cleanup?.(...args); }, ...options.mod };
  const registry = { listModuleIds: () => [info.id], listModules: () => [info], getModule: () => mod,
    getModuleInfo: () => info, getModuleDir: () => root, listSharedRuntimeManagers: () => [], getRuntimeManagerUi: () => null,
    detectGameAsync: async input => ({ gamePath: input, contentRootDir: input, moduleId: info.id, name: "Fixture" }) };
  const coordinator = createRuntimeCoordinator({ userDataDir });
  const operations = createBackendOperations({ userDataDir, registry, runtimeCoordinator: coordinator.client(),
    callHost: options.callHost || (async () => { throw new Error("Unexpected host callback"); }), getRunning: options.getRunning });
  t.after(() => { for (const child of children) { child.exitCode = 0; child.emit("exit", 0); } });
  // Operations as the inspector's lane runs them: its client only reads games.
  const inspector = () => createBackendOperations({ userDataDir, registry, runtimeCoordinator: coordinator.client(undefined, { reads: true }) });
  return { root, userDataDir, entry, gamePath, saved, mod, registry, coordinator, operations, inspector, children, cleanupCalls: () => cleanupCalls };
}

test("running game removal is refused by the backend even without UI running state", async t => {
  const f = fixture(t);
  await f.operations.launchEntry(f.entry, { autoInstallRuntime: false });
  assert.equal(f.coordinator.snapshot().games[0].pids.length, 1);
  await assert.rejects(f.operations.removeGameData(f.entry), { code: "GAME_IN_USE" });
  assert.equal(fs.readFileSync(f.saved, "utf8"), "player state"); assert.equal(f.cleanupCalls(), 0);
  assert.equal(Store.readGameRecord(f.userDataDir, f.entry.gameId).notes, "Keep these notes");
  f.children[0].exitCode = 0; f.children[0].emit("exit", 0);
  await waitFor(() => f.coordinator.snapshot().games.length === 0);
  await f.operations.removeGameData(f.entry);
  assert.equal(fs.existsSync(Data.resolveGameDir(f.userDataDir, f.entry.gameId)), false);
  assert.equal(fs.readFileSync(path.join(f.gamePath, "original.dat"), "utf8"), "unchanged");
});

test("removal refuses the no-PID preparation interval and direct Node launch shares the guard", async t => {
  const gate = deferred(), entered = deferred();
  const f = fixture(t, { mod: { prepareLaunch: async () => { entered.resolve(); await gate.promise; } } });
  const play = f.operations.launchEntry(f.entry); await entered.promise;
  assert.equal(f.coordinator.snapshot().games[0].pids.length, 0);
  await assert.rejects(f.operations.removeGameData(f.entry), { code: "GAME_IN_USE" });
  gate.resolve(); await play;
  const second = createBackendOperations({ userDataDir: f.userDataDir, registry: f.registry, runtimeCoordinator: f.coordinator.client() });
  await assert.rejects(second.removeGameData(f.entry), { code: "GAME_IN_USE" });
  assert.equal(f.cleanupCalls(), 0); assert.equal(fs.readFileSync(f.saved, "utf8"), "player state");
});

// The library selects a game it just added and reads it at once, so Forget
// right after an import meets those reads.
test("removal waits for the game's reads and other actions without a process; work asked for meanwhile waits for the removal", async t => {
  const gates = [deferred(), deferred()], entered = [deferred(), deferred()];
  let calls = 0;
  const f = fixture(t, { mod: { actions: { inspect: async () => { const call = calls++; entered[call].resolve(); await gates[call].promise; return {}; } } } });
  const read = f.operations.moduleAction(f.entry, "inspect", {}, {});await entered[0].promise;
  const removal = f.operations.removeGameData(f.entry);
  // The inspector's next read of the game, such as its graphics editor's,
  // waits instead of failing with an error. Other work is refused.
  const later = f.inspector().moduleAction(f.entry, "inspect", {}, {});
  await assert.rejects(f.operations.moduleAction(f.entry, "inspect", {}, {}), { code: "GAME_IN_USE", message: /removal is in progress/ });
  await assert.rejects(f.operations.launchEntry(f.entry), { code: "GAME_IN_USE" });
  assert.equal(f.cleanupCalls(), 0, "nothing is removed while the read runs");
  gates[0].resolve();await read;await removal;
  await assert.rejects(later, { name: "AbortError", code: "GAME_REMOVED" }, "once the game is gone, the waiting read is cancelled");
  assert.equal(calls, 1, "and never ran");
  assert.equal(Store.readGameRecord(f.userDataDir, f.entry.gameId), null);
  assert.equal(fs.existsSync(Data.resolveGameDir(f.userDataDir, f.entry.gameId)), false);
  assert.equal(f.children.length, 0);assert.equal(f.coordinator.snapshot().games.length, 0);

  // An action that starts a process while the removal waits refuses it, as a running game does.
  const g = fixture(t, { mod: { actions: { inspect: async () => { entered[1].resolve(); await gates[1].promise;
    return { child: Object.assign(new EventEmitter(), { pid: 123499, exitCode: null, signalCode: null }) }; } } } });
  const tool = g.operations.moduleAction(g.entry, "inspect", {}, {});await entered[1].promise;
  const refused = g.operations.removeGameData(g.entry);
  gates[1].resolve();const { child } = await tool;
  await assert.rejects(refused, { code: "GAME_IN_USE", message: /Stop the game/ });
  assert.equal(fs.readFileSync(g.saved, "utf8"), "player state");
  child.exitCode = 0;child.emit("exit", 0);
  await waitFor(() => g.coordinator.snapshot().games.length === 0);
});

test("removal winning the race rejects concurrent and stale launches before mutation or spawning", async t => {
  const gate = deferred(), entered = deferred();
  const f = fixture(t, { cleanup: async () => { entered.resolve(); await gate.promise; } });
  const removal = f.operations.removeGameData(f.entry); await entered.promise;
  const direct = createLauncher({ userDataDir: f.userDataDir, registry: f.registry, runtimeCoordinator: f.coordinator.client() });
  await assert.rejects(direct.launchEntry(f.entry), { code: "GAME_IN_USE" });
  await assert.rejects(f.operations.launchEntry(f.entry), { code: "GAME_IN_USE" });
  assert.equal(f.children.length, 0); assert.equal(fs.readFileSync(f.saved, "utf8"), "player state");
  gate.resolve(); await removal;
  await assert.rejects(direct.launchEntry(f.entry), { code: "GAME_REMOVED" });
  await assert.rejects(f.operations.launchEntry(f.entry), { code: "GAME_REMOVED" });
  assert.equal(f.children.length, 0); assert.equal(fs.existsSync(Data.resolveGameDir(f.userDataDir, f.entry.gameId)), false);
});

test("work asked for while a removal waits runs as usual when the removal fails", async t => {
  const gate = deferred(), entered = deferred();
  let calls = 0;
  const f = fixture(t, { callHost: async () => { throw new Error("Trash failed"); },
    mod: { actions: { inspect: async () => { const call = ++calls; if (call === 1) { entered.resolve(); await gate.promise; } return { call }; } } } });
  const read = f.operations.moduleAction(f.entry, "inspect", {}, {});await entered.promise;
  const removal = f.operations.removeGameData(f.entry, { trash: true });
  const later = f.inspector().moduleAction(f.entry, "inspect", {}, {});
  gate.resolve();await read;
  await assert.rejects(removal, /Trash failed/);
  assert.deepEqual(await later, { call: 2 });
  assert.equal(fs.readFileSync(f.saved, "utf8"), "player state");
  await waitFor(() => f.coordinator.snapshot().games.length === 0);
});

test("failed Trash leaves game data intact and releases removal admission", async t => {
  const f = fixture(t, { callHost: async () => { throw new Error("Trash failed"); } });
  await assert.rejects(f.operations.removeGameData(f.entry, { trash: true }), /Trash failed/);
  assert.equal(fs.readFileSync(f.saved, "utf8"), "player state"); assert.equal(f.cleanupCalls(), 0);
  assert.equal(f.coordinator.snapshot().games.length, 0);
  await f.operations.launchEntry(f.entry, { autoInstallRuntime: false });
  assert.equal(f.children.length, 1);
});

test("failed module storage removal keeps its library record and permits retry", async t => {
  let blocked = true;
  const f = fixture(t, { cleanup: async () => {
    if (blocked) throw Object.assign(new Error("Storage is unavailable"), { code: "EACCES" });
    fs.rmSync(path.join(f.userDataDir, "private-app-data"), { recursive: true });
  } });
  const container = path.join(f.userDataDir, "private-app-data");
  fs.mkdirSync(container); fs.writeFileSync(path.join(container, "save"), "private state");
  await assert.rejects(f.operations.removeGameData(f.entry), /library entry was kept/);
  assert.equal(Store.readGameRecord(f.userDataDir, f.entry.gameId).notes, "Keep these notes");
  assert.equal(fs.readFileSync(path.join(container, "save"), "utf8"), "private state");
  assert.equal(f.coordinator.snapshot().games.length, 0);
  blocked = false;
  await f.operations.removeGameData(f.entry);
  assert.equal(fs.existsSync(container), false);
  assert.equal(Store.readGameRecord(f.userDataDir, f.entry.gameId), null);
  assert.equal(fs.readFileSync(path.join(f.gamePath, "original.dat"), "utf8"), "unchanged");
});

test("an alias import cannot mutate the canonical game while removal owns it", async t => {
  const gate = deferred(), entered = deferred();
  const f = fixture(t, { cleanup: async () => { entered.resolve(); await gate.promise; },
    mod: { onImport: () => assert.fail("A canonical game import ran during removal") } });
  const alias = path.join(f.gamePath, "game.exe"); fs.writeFileSync(alias, "original executable");
  f.registry.detectGameAsync = async () => ({ gamePath: f.gamePath, contentRootDir: f.gamePath, moduleId: "fixture", name: "Fixture" });
  const removal = f.operations.removeGameData(f.entry); await entered.promise;
  await assert.rejects(f.operations.importEntry(alias), { code: "GAME_IN_USE" });
  assert.equal(fs.readFileSync(f.saved, "utf8"), "player state");
  assert.equal(Store.listGameIds(f.userDataDir).length, 1);
  gate.resolve(); await removal;
  assert.equal(fs.readFileSync(alias, "utf8"), "original executable");
});

test("an original game can be imported and played again after Forget without reviving stale actions", async t => {
  const f = fixture(t);
  await f.operations.removeGameData(f.entry);
  const launcher = createLauncher({ userDataDir: f.userDataDir, registry: f.registry, runtimeCoordinator: f.coordinator.client() });
  const reimported = await launcher.resolveEntry(f.gamePath);
  assert.notEqual(reimported.gameId, f.entry.gameId);
  assert.equal(reimported.gamePath, f.gamePath);
  await launcher.launchEntry(reimported, { autoInstallRuntime: false });
  await assert.rejects(launcher.launchEntry(f.entry), { code: "GAME_REMOVED" });
  assert.equal(f.children.length, 1);
  assert.equal(fs.readFileSync(path.join(f.gamePath, "original.dat"), "utf8"), "unchanged");
});

test("library publication and cheat synchronization cannot recreate data during worker cleanup", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-removal-publication-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = { gameId: "one", gamePath: path.join(root, "original-one"), moduleId: "fixture", cheats: { enabled: true } };
  const second = { gameId: "two", gamePath: path.join(root, "original-two"), moduleId: "fixture", cheats: { enabled: true }, notes: "Updated" };
  const removals = new Map([[first.gamePath, { ...first, phase: "remove" }]]);
  const context = { app: { getPath: () => root }, GameStore: Store, GameData: Data, gameRemovals: removals,
    gameRecordsCache: [{ ...first }, { ...second, notes: "Old" }], serializeGameEntry: entry => ({ ...entry }),
    getModuleCheats: () => true, resolveModuleId: entry => entry.moduleId, ensureDir: dir => fs.mkdirSync(dir, { recursive: true }),
    cheatsFileWatchers: new Map(), cheatsFileDebounceTimers: new Map(), cheatsFileToGameId: new Map(), cheatsFileToModuleId: new Map(), cheatsFileLastWritten: new Map(),
    watchFileChanges: () => ({ close() {} }), clearTimeout };
  const source = fs.readFileSync(path.join(__dirname, "../src/main/main.js"), "utf8");
  function block(start, end) { const from = source.indexOf(start), to = source.indexOf(end, from); assert.ok(from >= 0 && to > from); return source.slice(from, to); }
  vm.runInNewContext(block("function isGameRemoving(entry)", "let gameRecordsCache"), context);
  vm.runInNewContext(block("function cheatsFilePathForGame(gameId)", "const cheatsFileLastWritten"), context);
  context.writeCheatsFile = (gameId, moduleId, cheats) => {
    const file = context.cheatsFilePathForGame(gameId);
    if (file) fs.writeFileSync(file, JSON.stringify(cheats));
  };
  vm.runInNewContext(block("function syncCheatsFiles(games)", "function resolveModuleNativeLaunchPath"), context);
  assert.throws(() => context.saveGameRecord(first), { code: "GAME_IN_USE" });
  assert.throws(() => context.saveGameRecord({ ...first, gamePath: path.join(root, "alias") }), { code: "GAME_IN_USE" });
  context.persistGames([first, second]);
  assert.equal(fs.existsSync(Data.resolveGameDir(root, first.gameId)), false);
  assert.equal(Store.readGameRecord(root, second.gameId).notes, "Updated");
  assert.equal(fs.existsSync(Data.resolveGameCheatsPath(root, second.gameId)), true);
  assert.equal(context.gameRecordsCache.length, 2, "Removing remains visible until worker completion");
  assert.equal(context.cheatsFileWatchers.size, 1);
  context.syncCheatsFiles([]);
  context.watchFileChanges = () => { throw new Error("Watch limit reached"); };
  context.syncCheatsFiles([second]);
  const secondFile = Data.resolveGameCheatsPath(root, second.gameId);
  context.cheatsFileLastWritten.set(secondFile, "cached cheats");
  assert.equal(context.cheatsFileWatchers.size, 0);
  assert.equal(context.cheatsFileToGameId.size, 1);
  context.syncCheatsFiles([]);
  for (const key of ["cheatsFileWatchers", "cheatsFileToGameId", "cheatsFileToModuleId", "cheatsFileLastWritten", "cheatsFileDebounceTimers"]) {
    assert.equal(context[key].size, 0, key + " releases removed entries even when watch registration failed");
  }
});

test("host running state is checked again after an asynchronous Trash callback", async t => {
  let running = false;
  const f = fixture(t, { getRunning: () => ({ games: running ? { [f.gamePath]: 1 } : {} }),
    callHost: async () => { running = true; } });
  await assert.rejects(f.operations.removeGameData(f.entry, { trash: true }), { code: "GAME_IN_USE" });
  assert.equal(fs.readFileSync(f.saved, "utf8"), "player state"); assert.equal(f.cleanupCalls(), 0);
});

test("only the inspector's lane reads games, so only its reads wait for a removal", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-removal-lanes-")), userDataDir = path.join(root, "data");
  const real = createRuntimeCoordinator({ userDataDir }), made = new Map();
  const coordinator = { ...real, client: (owner, options) => { made.set(made.size, options?.reads === true); return real.client(owner, options); } };
  const service = createBackendService({ userDataDir, runtimeCoordinator: coordinator, workerPath: path.join(__dirname, "fixtures/coordinated-backend-worker.cjs") });
  t.after(async () => { await service.close(); fs.rmSync(root, { recursive: true, force: true }); });
  for (const lane of ["inspector", "game:one"]) await service.request(lane, "noSuchMethod").catch(() => {});
  assert.deepEqual([...made.values()], [true, false]);
});

test("slow synchronous module cleanup stays in its worker while host timers and another game respond", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-removal-workers-")), userDataDir = path.join(root, "data");
  const coordinator = createRuntimeCoordinator({ userDataDir }), events = [];
  const service = createBackendService({ userDataDir, runtimeCoordinator: coordinator,
    workerPath: path.join(__dirname, "fixtures/coordinated-backend-worker.cjs"),
    callbacks: { "test.settingsGate": async () => true }, onEvent: (event, payload) => events.push({ event, payload }) });
  t.after(async () => { await service.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const make = id => {
    const gamePath = path.join(root, id); fs.mkdirSync(gamePath); fs.writeFileSync(path.join(gamePath, "asset.dat"), "original");
    const entry = { gameId: id, gamePath, contentRootDir: gamePath, importPath: gamePath, moduleId: "fixture", runtimeId: "runner", moduleData: {}, notes: "Retain" };
    Store.writeGameRecord(userDataDir, entry); return entry;
  };
  const first = make("one"), second = make("two");
  first.moduleData.cleanupDelay = 400; Store.writeGameRecord(userDataDir, first);
  await Promise.all([service.request("game:one", "refreshEntry", first, {}), service.request("game:two", "refreshEntry", second, {})]);
  let ticks = 0; const timer = setInterval(() => ticks++, 5); t.after(() => clearInterval(timer));
  const cleanup = service.request("game:one", "removeGameData", first);
  await waitFor(() => events.some(item => item.event === "cleanupStarted"));
  const started = performance.now();
  const other = await service.request("game:two", "refreshEntry", second, {});
  assert.equal(other.gameId, second.gameId); assert.ok(performance.now() - started < 250, "Another game waited for cleanup");
  await cleanup; assert.ok(ticks >= 25, "Launcher host timers were blocked by cleanup");
  assert.equal(fs.readFileSync(path.join(userDataDir, "cleanup-counts"), "utf8"), "one\n");
  assert.equal(Store.readGameRecord(userDataDir, second.gameId).notes, "Retain");
  assert.equal(fs.readFileSync(path.join(first.gamePath, "asset.dat"), "utf8"), "original");
});
