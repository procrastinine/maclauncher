const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { monitorEventLoopDelay } = require("node:perf_hooks");
const { createBackendService } = require("../src/core/backend-worker-client");
const { createModuleActionRequests } = require("../src/main/module-action-requests");
const { resolveRuntimeSettingsSchema } = require("../src/core/runtime-settings");
const workerPath = path.join(__dirname, "fixtures", "backend-worker.cjs");

// The launcher's moduleAction and moduleSettingsAction IPC handlers, with the
// given main-process context.
function launcherHandlers(context) {
  const source = fs.readFileSync(path.join(__dirname, "../src/main/main.js"), "utf8");
  const slice = (from, to) => {
    const start = source.indexOf(from), end = source.indexOf(to, start);
    assert.ok(start >= 0 && end > start);
    return source.slice(start, end);
  };
  const handlers = new Map(), sandbox = vm.createContext({ ...context, ipcMain: { handle: (name, handler) => handlers.set(name, handler) } });
  vm.runInContext(slice('ipcMain.handle("launcher:moduleAction",', 'ipcMain.handle("launcher:setCheats",'), sandbox);
  vm.runInContext(slice('ipcMain.handle("launcher:moduleSettingsAction",', "const moduleActionRequests ="), sandbox);
  return handlers;
}
function moduleActionHandler(context) { return launcherHandlers(context).get("launcher:moduleAction"); }

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
    resolveModuleId: game => game.moduleId, resolveRuntimeSettingsSchema });
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

// A runtime settings window lists a game's translator, environment and version
// choices from installed runtimes; Settings lists them for a game type. Both
// use the inspector worker that the launcher prepared, with its reads of
// installed runtimes, so opening either window starts no worker of its own.
test("runtime settings choice lists read through the prepared inspector worker", { timeout: 20000 }, async t => {
  const select = (key, optionsAction) => ({ key, label: key, type: "select", optionsAction, options: [{ value: "", label: "Automatic" }] });
  const info = { runtime: { entries: {
    wine: { statusAction: "runtimeStatus", settings: { fields: [select("translatorRenderer", "listTranslatorOptions"),
      select("environmentReference", "listEnvironments"), { key: "retina", label: "Retina", type: "boolean" }] } },
    player: { settings: { fields: [select("version", "listRuntimeVersions")] } } } } };
  const game = { gameId: "game-0", gamePath: "/fixture/game-0", moduleId: "fixture", runtimeId: "wine" };
  const service = createBackendService({ workerPath, onEvent() {} });
  t.after(() => service.close());
  const lanes = [], request = (lane, ...args) => { lanes.push(lane); return service.request(lane, ...args); };
  const handlers = launcherHandlers({ loadSettings: () => ({}), loadGameHydrated: () => structuredClone(game),
    moduleActionRequests: createModuleActionRequests({ request }), backendService: { request }, gameGraphicsLive: () => false,
    isAbortError: error => error?.name === "AbortError", resolveModuleId: entry => entry.moduleId, resolveRuntimeSettingsSchema,
    Modules: { getModule: id => id === "fixture" ? {} : null, getModuleInfo: id => id === "fixture" ? info : null },
    hostAccountActions: { handles: () => false } });
  const gameChoices = handlers.get("launcher:moduleAction"), settingsChoices = handlers.get("launcher:moduleSettingsAction");
  assert.equal(service.prepareInspectorLane({ prepared: true }), true);
  const owner = { id: 1, once() {}, removeListener() {} };
  const results = [
    ...await Promise.all(["listTranslatorOptions", "listEnvironments"].map(action =>
      gameChoices({ sender: owner }, game.gamePath, action, { runtimeSettings: {} }, { runtimeId: "wine" }))),
    await settingsChoices({}, "fixture", "listTranslatorOptions", { runtimeId: "wine", runtimeSettings: {} }),
    await settingsChoices({}, "fixture", "listRuntimeVersions", { runtimeId: "player" })];
  assert.deepEqual(results.map(result => [result.lane, result.warmed?.prepared]), Array(4).fill(["inspector", true]),
    "each list found the inspector worker the launcher prepared");
  assert.deepEqual([...new Set(lanes)], ["inspector"], "opening runtime settings started no game or settings worker");

  // Other settings actions, and an action the requested runtime's settings do not list, keep their own workers.
  assert.equal((await settingsChoices({}, "fixture", "setup", { runtimeId: "wine" })).lane, "module:fixture:settings");
  assert.equal((await settingsChoices({}, "fixture", "listRuntimeVersions", { runtimeId: "wine" })).lane, "module:fixture:settings");
  assert.equal((await gameChoices({ sender: owner }, game.gamePath, "listRuntimeVersions", {}, { runtimeId: "wine" })).lane, "game:game-0");
  assert.equal((await gameChoices({ sender: owner }, game.gamePath, "listRuntimeVersions", {}, { runtimeId: "player" })).lane, "inspector");

  // Sikarugir, WineCX and CrossOver declare their translator menus this way.
  const wine = require("../src/modules/crossover/main").manifest;
  for (const runtimeId of ["sikarugir", "winecx", "crossover"].filter(id => wine.runtime.entries[id]))
    assert.ok(resolveRuntimeSettingsSchema(wine, runtimeId).fields.some(field => field.key === "translatorRenderer" && field.optionsAction === "listTranslatorOptions"), runtimeId);
});

// The inspector's lane keeps listed installations and verified app bundles
// until its runtime inventory changes; any other lane reads them again.
test("the inspector lane keeps listed installations and verified app bundles until the runtime inventory changes", async t => {
  const InventoryRevision = require("../src/core/runtime-inventory-revision");
  const { memoizeRuntimeResolution } = require("../src/core/coordinated-runtime-managers");
  const App = require("../src/modules/shared/runtime/app-bundle");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "inspector-retained-")));
  t.after(() => { InventoryRevision.activate({ retainReads: false }); fs.rmSync(root, { recursive: true, force: true }); });
  const app = path.join(root, "Player.app");
  fs.mkdirSync(path.join(app, "Contents/MacOS"), { recursive: true });
  fs.mkdirSync(path.join(app, "Contents/Resources/deep"), { recursive: true });
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32LE(0xfeedfacf); bytes.writeUInt32LE(0x0100000c, 4); bytes.writeUInt32LE(2, 12);
  fs.writeFileSync(path.join(app, "Contents/MacOS/player"), bytes, { mode: 0o755 });
  fs.writeFileSync(path.join(app, "Contents/Info.plist"), "<plist version=\"1.0\"><dict><key>CFBundleExecutable</key><string>player</string></dict></plist>");
  let observed = 0;
  const lstat = fs.lstatSync;
  t.mock.method(fs, "lstatSync", function (file, ...args) { if (String(file).startsWith(app)) observed++; return lstat.call(this, file, ...args); });
  const owner = {};
  let resolved = 0;
  const listed = () => memoizeRuntimeResolution(owner, "installed", () => ({ listing: ++resolved }));

  assert.equal(App.appBundleStatus(app).ready, true);
  observed = 0; assert.equal(App.appBundleStatus(app).ready, true);
  assert.ok(observed > 0, "outside the inspector lane every status observes the bundle");
  assert.equal(listed().listing, 1); assert.equal(listed().listing, 2, "outside the inspector lane every listing resolves");

  InventoryRevision.activate({ retainReads: true });
  App.appBundleStatus(app);
  observed = 0;
  for (let index = 0; index < 3; index++) assert.equal(App.appBundleStatus(app).ready, true);
  assert.equal(observed, 0, "a confirmed bundle is not observed again before an inventory change");
  assert.equal(listed().listing, 3); assert.equal(listed().listing, 3, "a listing is kept before an inventory change");

  fs.symlinkSync(path.join(root, "outside"), path.join(app, "Contents/Resources/deep/unsafe"));
  InventoryRevision.advance();
  assert.equal(listed().listing, 4, "an inventory change lists installations again");
  observed = 0;
  assert.equal(App.appBundleStatus(app).ready, false, "an inventory change validates the bundle again");
  assert.ok(observed > 0);
});
