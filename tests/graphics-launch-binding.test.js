const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const ReShade = require("../src/modules/shared/reshade"), Binding = require("../src/modules/shared/reshade/launch-binding"), Live = require("../src/modules/shared/reshade/live-controls");
function fixture(t) {
  const userDataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "graphics-launch-binding-")));
  t.after(() => fs.rmSync(userDataDir, {recursive: true, force: true}));
  const entry = {gameId: "pid", reshade: {enabled: true, preset: "crt"}}, directory = path.dirname(Live.file(entry, userDataDir));
  fs.mkdirSync(directory, {recursive: true});const file = path.join(directory, "launch.json");
  fs.writeFileSync(file, JSON.stringify({schema: 1, phase: "prepared", launchId: "selected-launch", pid: 10, live: true,
    effectPlanAPI: 1, effectPlanAutomatic: true, effectPlanNeuralModels: [], liveModelVersion: "old-model"}));
  return {entry, userDataDir, directory, file};
}
test("graphics launch binding uses only the supplied actual child identity and preserves legacy callers", t => {
  const f = fixture(t);
  assert.equal(ReShade.bindLaunchProcess(f.entry, 20, f), true);
  assert.equal(Binding.read(f.entry, {...f, runningPids: [20]}).pid, 20);
  assert.equal(Binding.read(f.entry, {...f, runningPids: [10]}), null);
  assert.equal(Binding.read(f.entry, {...f, runningPids: []}), null);
  assert.equal(Binding.read(f.entry, f).pid, 20, "callers without process metadata retain the existing contract");
  assert.equal(ReShade.bindLaunchProcess(f.entry, 30, f), false, "one prepared launch is not rebound to another process");
  assert.equal(ReShade.bindLaunchProcess(f.entry, 0, f), false);
});
const Hardware = require("../src/modules/shared/reshade/hardware-support");
test("main graphics inspection carries current process identities without a full effects catalog", async t => {
  t.mock.method(Binding, "resolvePayload", async () => null);t.mock.method(Hardware, "inspect", async () => undefined);
  const f = fixture(t), vm = require("node:vm"), source = fs.readFileSync(require.resolve("../src/main/main"), "utf8"),
    start = source.indexOf("function gameGraphicsLive("), end = source.indexOf('ipcMain.handle("launcher:getGameEffects"', start);
  const gamePath = "/Games/Current", entry = {...f.entry, gamePath}, sessions = new Map([[gamePath, new Map([[1, {id: 1, pid: 20}], [2, {id: 2, kind: "window"}]])]]);
  const coordinator = require("../src/core/runtime-coordinator").createRuntimeCoordinator();
  const pendingEdits = [];
  const context = {userDataDir: f.userDataDir, app: {}, runningGameSessions: sessions, loadSettings: () => ({}), runtimeInventoryRevision: 0, ReShade, cachedState: null,
    backendService:{invalidateGraphicsPreparation:async()=>false},
    downloadManager: {}, confirmRuntimeInstallation: () => assert.fail("No download in lifecycle fixture"),
    settingsCoordinator: coordinator.client(), listRuntimeManagers: () => [{id: "graphics-models"}],
    logger: {warn: () => assert.fail("model lease cleanup failed")}, broadcastActivity: () => {},
    Modules: {getModuleInfo: () => ({runtime: {entries: {native: {graphicsHost: "window"}}}})}, resolveModuleId: () => "test",
    launcherService: {runAction: async () => ({runtimeId: "native", graphicsInputs: null})},
    require: id => require(path.resolve(__dirname, "../src/main", id))};
  vm.runInNewContext(source.slice(start, end), context);
  assert.equal(context.gameGraphicsLive(entry), false);
  ReShade.bindLaunchProcess(entry, 20, f);
  assert.equal(context.gameGraphicsLive(entry), true);
  const options = await context.gameEffectsOptions(entry);
  assert.equal(options.running, true);assert.deepEqual([...options.runningPids], [20]);
  assert.equal(options.graphicsRuntimeUse, sessions.get(gamePath).get(1).graphicsRuntimeUse);
  assert.equal(options.graphicsHost, "window");
  const boundInputs = {architecture: "arm64", depth: false, motionVectors: false};
  fs.writeFileSync(f.file, JSON.stringify({...Binding.read(entry, f), runtimeId: "actual-running", graphicsHost: "explicit",
    graphicsArchitecture: "arm64", graphicsInputs: boundInputs}));
  let inspected;
  context.launcherService.runAction = async value => {
    inspected = value.runtimeId;return {runtimeId: "future-runtime", graphicsInputs: {architecture: "x86_64", depth: true}};
  };
  const actual = await context.gameEffectsOptions({...entry, runtimeId: "future-runtime"});
  assert.equal(inspected, "actual-running");assert.equal(actual.graphicsHost, "explicit");
  assert.equal(actual.graphicsArchitecture, "arm64");assert.deepEqual(actual.graphicsInputs, boundInputs);
  assert.equal(entry.runtimeId, undefined, "inspection does not overwrite the saved future selection");
  await options.useModel("live-selected");
  assert.equal(coordinator.snapshot().active.length, 1);
  assert.deepEqual(coordinator.snapshot().active[0].pids, [20]);
  const unregisterStart = source.indexOf("function unregisterGameRun("), unregisterEnd = source.indexOf("function registerGameWindowRun(", unregisterStart);
  vm.runInNewContext(source.slice(unregisterStart, unregisterEnd), context);
  context.unregisterGameRun(gamePath, 1);
  await sessions.get(gamePath)?.get(1)?.graphicsRuntimeUse?.release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(coordinator.snapshot().active.length, 0);
  await assert.rejects(options.useModel("after-exit"), /game has stopped/);
});
function mainFixture(t, {running = true} = {}) {
  t.mock.method(Binding, "resolvePayload", async () => null);t.mock.method(Hardware, "inspect", async () => undefined);
  const f = fixture(t), vm = require("node:vm"), source = fs.readFileSync(require.resolve("../src/main/main"), "utf8"),
    entry = {...f.entry, gamePath: "/Games/Current", runtimeId: "native"},
    session = {id: 1, pid: 20}, sessions = new Map(), saved = [], handlers = new Map();
  if (running) {sessions.set(entry.gamePath, new Map([[session.id, session]]));ReShade.bindLaunchProcess(entry, session.pid, f);}
  const coordinator = require("../src/core/runtime-coordinator").createRuntimeCoordinator();
  const pendingEdits = [];
  const context = {userDataDir: f.userDataDir, app: {}, runningGameSessions: sessions, loadSettings: () => ({}), runtimeInventoryRevision: 0, cachedState: null,
    downloadManager: {}, confirmRuntimeInstallation: () => assert.fail("No download in lifecycle fixture"),
    backendService:{invalidateGraphicsPreparation:async()=>false},
    settingsCoordinator: coordinator.client(), listRuntimeManagers: () => [{id: "graphics-models"}],
    Modules: {getModuleInfo: () => ({runtime: {entries: {native: {graphicsHost: "window"}}}})}, resolveModuleId: () => "test",
    launcherService: {runAction: async () => ({runtimeId: "native", graphicsInputs: null})},
    require: id => require(path.resolve(__dirname, "../src/main", id)),
    ReShade, StoredPlan: require("../src/modules/shared/effects/stored-plan"),
    EffectsPlan: require("../src/modules/shared/effects/plan"), EffectsRuntime: require("../src/modules/shared/effects/runtime"),
    ipcMain: {handle: (name, callback) => handlers.set(name, callback)}, logger: {warn() {}}, BrowserWindow: {getAllWindows: () => []},
    graphicsEditControllers: new Map(),
    editGraphics: (_path, edit) => {const task = Promise.resolve().then(() => edit(new AbortController().signal));pendingEdits.push(task);return task;},
    loadGamesHydrated: () => [entry], findGameByPath: (games, gamePath) => games.find(game => game.gamePath === gamePath),
    saveGameRecord: game => saved.push(JSON.parse(JSON.stringify(game))), buildState: () => ({}), broadcastState: () => {}};
  const start = source.indexOf("function gameGraphicsLive("), end = source.indexOf('ipcMain.handle("launcher:getGameEffects"', start);
  vm.runInNewContext(source.slice(start, end), context);
  const begin = source.indexOf('ipcMain.handle("launcher:setGameEffects"');
  vm.runInNewContext(source.slice(begin, source.indexOf('ipcMain.handle("launcher:resetGameEffects"', begin)), context);
  const replace = () => {
    const next = {id: 2, pid: 21};sessions.set(entry.gamePath, new Map([[next.id, next]]));
    fs.writeFileSync(f.file, JSON.stringify({...Binding.read(entry, f), pid: next.pid, phase: "spawned", launchId: "replacement"}));
  };
  return {...f, entry, session, sessions, saved, handlers, context, replace, pendingEdits};
}
function gate() {
  let enter, release;const started = new Promise(resolve => {enter = resolve;}), resumed = new Promise(resolve => {release = resolve;});
  return {started, release, wait: async () => {enter();await resumed;}};
}
test("main current predicate rejects stop intent, replacement session objects and changed launch identities", async t => {
  const f = mainFixture(t), options = await f.context.gameEffectsOptions(f.entry), bytes = fs.readFileSync(f.file);
  assert.equal(options.isCurrent(), true);assert.equal(options.launchBinding.pid, f.session.pid);
  f.session.stopRequested = true;assert.equal(options.isCurrent(), false);
  f.session.stopRequested = false;assert.equal(options.isCurrent(), true);
  fs.writeFileSync(f.file, JSON.stringify({...options.launchBinding, launchId: "replacement"}));
  assert.equal(options.isCurrent(), false);fs.writeFileSync(f.file, bytes);
  f.sessions.get(f.entry.gamePath).set(f.session.id, {...f.session});
  assert.equal(options.isCurrent(), false);
  await assert.rejects(options.useModel("after-replacement"), /game has stopped/);
});
test("main initially stopped inspection cannot adopt a session created during its first await", async t => {
  const f = mainFixture(t, {running: false}), pause = gate();
  f.context.launcherService.runAction = async () => {await pause.wait();return {runtimeId: "native", graphicsInputs: null};};
  const pending = f.context.gameEffectsOptions(f.entry);await pause.started;f.replace();pause.release();
  const options = await pending;
  assert.equal(options.running, false);assert.deepEqual([...options.runningPids], []);assert.equal(options.isCurrent(), false);
  assert.notEqual(options.launchBinding.launchId, "replacement");
});
for (const boundary of ["active-session-stops", "stopped-session-starts", "stopped-unchanged"]) test(`main Advanced retains captured state for ${boundary}`, async t => {
  const f = mainFixture(t, {running: boundary === "active-session-stops"}), pause = gate(), calls = [];
  if (boundary !== "stopped-unchanged") f.context.launcherService.runAction = async () => {await pause.wait();return {runtimeId: "native", graphicsInputs: null};};
  t.mock.method(f.context.EffectsRuntime, "prepare", async (entry, options) => {calls.push(options);return {plan: entry.effects};});
  const plan = {schema: 2, mode: "advanced", enabled: true, video: []};
  const pending = f.handlers.get("launcher:setGameEffects")(null, f.entry.gamePath, plan);
  if (boundary !== "stopped-unchanged") {
    await pause.started;
    if (boundary === "active-session-stops") {f.session.stopRequested = true;f.sessions.clear();} else f.replace();
    pause.release();
  }
  const acknowledged = await pending;assert.deepEqual(acknowledged.plan, plan);assert.equal(typeof acknowledged.desiredRevision, "string");
  await Promise.all(f.pendingEdits);assert.deepEqual(f.saved[0].effects, plan);
  assert.equal(calls.length, boundary === "stopped-unchanged" ? 1 : 0);
  if (calls.length) {assert.equal(calls[0].live, false);assert.equal(calls[0].isCurrent(), true);}
});

