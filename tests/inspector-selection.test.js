const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { monitorEventLoopDelay } = require("node:perf_hooks");
const { createBackendService } = require("../src/core/backend-worker-client");
const { createBackendOperations } = require("../src/core/backend-operations");
const { createModuleActionRequests } = require("../src/main/module-action-requests");
const workerPath = path.join(__dirname, "fixtures", "backend-worker.cjs");

// The launcher's moduleAction IPC handler, with the given main-process context.
function moduleActionHandler(context) {
  const source = fs.readFileSync(path.join(__dirname, "../src/main/main.js"), "utf8");
  const start = source.indexOf('ipcMain.handle("launcher:moduleAction",'), end = source.indexOf('ipcMain.handle("launcher:setCheats",', start);
  assert.ok(start >= 0 && end > start);
  const handlers = new Map();
  vm.runInNewContext(source.slice(start, end), { ...context, ipcMain: { handle: (name, handler) => handlers.set(name, handler) } });
  return handlers.get("launcher:moduleAction");
}

// Selecting a game asks for its runtime status, graphics inputs, recommended
// version and Automatic version. Each read of installed runtimes holds its
// worker's thread; the launcher's own event loop keeps running, and every
// selection shares the one inspector worker instead of starting its own.
test("selected games read through the one inspector worker while the launcher's event loop stays free", { timeout: 20000 }, async t => {
  const info = { runtime: { entries: { runner: { statusAction: "runnerStatus" } }, preLaunch: { other: { statusAction: "otherStatus" } } } };
  const games = Array.from({ length: 6 }, (_, index) => ({ gameId: `game-${index}`, gamePath: `/fixture/game-${index}`, moduleId: "fixture", runtimeId: "runner" }));
  const service = createBackendService({ workerPath, onEvent() {} });
  t.after(() => service.close());
  const lanes = [], request = (lane, ...args) => { lanes.push(lane); return service.request(lane, ...args); };
  const handler = moduleActionHandler({ loadSettings: () => ({}),
    loadGameHydrated: gamePath => structuredClone(games.find(game => game.gamePath === gamePath) || null),
    moduleActionRequests: createModuleActionRequests({ request }), backendService: { request }, gameGraphicsLive: () => false,
    isAbortError: error => error?.name === "AbortError", Modules: { getModuleInfo: id => id === "fixture" ? info : null },
    resolveModuleId: game => game.moduleId });
  assert.equal(service.prepareInspectorLane({ prepared: true }), true);
  const owner = { id: 1, once() {}, removeListener() {} };
  const delay = monitorEventLoopDelay({ resolution: 5 });
  delay.enable();
  const started = performance.now();
  const results = [];
  for (const game of games) {
    // Each read models 60 ms of synchronous runtime reads in its worker.
    results.push(...await Promise.all(["runnerStatus", "graphicsInputs", "runtimeRecommendation", "runtimeAutomaticVersion"]
      .map(action => handler({ sender: owner }, game.gamePath, action, { busyMs: 60 }))));
  }
  const elapsed = performance.now() - started;
  delay.disable();
  assert.deepEqual([...new Set(results.map(result => result.lane))], ["inspector"], "every inspector read ran in the inspector worker");
  assert.ok(results.every(result => result.warmed?.prepared === true), "the reads found the worker the launcher prepared");
  assert.deepEqual([...new Set(lanes)], ["inspector"], "selecting games started no game worker");
  assert.ok(elapsed >= 6 * 4 * 60, "the fixture reads ran");
  assert.ok(delay.max / 1e6 < 50, `the launcher's event loop was held for ${(delay.max / 1e6).toFixed(0)} ms during selection`);

  // A game's own tools and the other status action of a runtime it is not using stay with the game.
  const tool = await handler({ sender: owner }, games[0].gamePath, "patch", {});
  assert.equal(tool.lane, "game:game-0");
  assert.equal((await handler({ sender: owner }, games[0].gamePath, "otherStatus", {})).lane, "inspector",
    "a status action declared for another runtime of the module is an inspector read");
});

// The state worker's startup inventory reads the same files every other
// worker reads, so its first report of each manager does not make other
// workers read runtimes again. A later report that differs does.
test("the startup runtime inventory leaves other workers' runtime reads current", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "inspector-selection-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let installed = [{ version: "1.0", ready: true }];
  const manager = { id: "fixture-runtime", label: "Fixture", getState: () => ({ installed, catalog: { versions: [] } }) };
  const registry = { listModuleIds: () => [], listModules: () => [], getModule: () => null, getModuleInfo: () => null,
    getModuleDir: () => __dirname, listSharedRuntimeManagers: () => [manager], getRuntimeManagerUi: () => null };
  const events = [];
  const operations = createBackendOperations({ userDataDir: root, registry, emit: event => events.push(event) });
  const changes = () => events.filter(event => event === "runtimeInventoryChanged").length;
  await operations.runtimeStates({});
  assert.equal(events.filter(event => event === "runtimeState").length, 1);
  assert.equal(changes(), 0, "a first report is not an inventory change");
  await operations.runtimeStates({});
  assert.equal(changes(), 0, "an unchanged report is not an inventory change");
  installed = [...installed, { version: "2.0", ready: true }];
  await operations.runtimeStates({});
  assert.equal(changes(), 1, "a report with another installed version is a change");
});
