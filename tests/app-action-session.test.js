const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const GameStore = require("../src/core/game-store");
const EphemeralEntries = require("../src/core/ephemeral-entries");
const { createModuleAppActions } = require("../src/main/module-app-actions");

// The window module's own app action and manifest, with its session process
// replaced, behind a registry whose detection fails the test when called.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "maclauncher-app-action-session-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userDataDir = path.join(root, "data");
  const manifest = require("../src/modules/window/manifest.json");
  const calls = { detect: 0, launched: [] };
  const mod = { id: manifest.id, manifest, appActions: require("../src/modules/window/app-actions"),
    canLaunchRuntime: runtimeId => runtimeId === "capture",
    launchRuntime: async (runtimeId, entry) => {
      calls.launched.push({ runtimeId, entry });
      return Object.assign(new EventEmitter(), { pid: 4242, exitCode: null, signalCode: null });
    } };
  const detect = () => { calls.detect++;throw new Error("No supported game found."); };
  const registry = { listModuleIds: () => [manifest.id], listModules: () => [manifest],
    getModule: id => id === manifest.id ? mod : null, getModuleInfo: () => manifest,
    getModuleDir: () => path.join(__dirname, "../src/modules/window"),
    listSharedRuntimeManagers: () => [], getRuntimeManagerUi: () => null,
    detectGame: detect, detectGameAsync: async () => detect() };
  const { createBackendOperations } = require("../src/core/backend-operations");
  const operations = createBackendOperations({ userDataDir, registry });
  t.after(() => operations.beginShutdown());
  const actions = createModuleAppActions({ registry, logger: { warn() {} }, choose: () => {} });
  const f = { userDataDir, calls, operations, actions };
  t.after(() => { for (const entry of f.entries || []) mod.appActions.applyGraphics.endEntry({ ...entry, moduleData: { targets: [] } }); });
  return f;
}

// main.js startEphemeralSession: createEntry, mark, store, then Play.
async function startSession(f, target) {
  const entry = f.actions.createEntry("window", "applyGraphics", { target }, { userDataDir: f.userDataDir });
  f.entries ||= [];f.entries.push(entry);
  EphemeralEntries.mark(f.userDataDir, entry.gameId);
  GameStore.writeGameRecord(f.userDataDir, entry);
  const stored = GameStore.readGameRecord(f.userDataDir, entry.gameId);
  const result = await f.operations.launchEntry(stored, { settings: {} });
  return { stored, result };
}

for (const [label, target, moduleData] of [
  ["a window", { kind: "window", windowID: 77, pid: process.pid, name: "iTerm2", title: "Shell" },
    { target: "window", windowID: 77, pid: process.pid, applicationName: "iTerm2", windowTitle: "Shell" }],
  ["an app picked with the system picker", { kind: "application", pid: process.pid, name: "iTerm2" }, { target: "application", pid: process.pid }],
  ["a display", { kind: "display", displayID: 1, name: "Built-in Retina Display" }, { target: "display", displayID: 1, displayName: "Built-in Retina Display" }],
  ["All Displays", { kind: "all-displays" }, { target: "all-displays" }]
]) {
  test(`a session for ${label} starts and refreshes without game detection`, async t => {
    const f = fixture(t);
    const { stored, result } = await startSession(f, target);
    assert.equal(result.kind, "process");
    assert.equal(f.calls.launched.length, 1);
    assert.equal(f.calls.launched[0].runtimeId, "capture");
    assert.equal(f.calls.launched[0].entry.gameId, stored.gameId);
    for (const [key, value] of Object.entries(moduleData)) assert.deepEqual(f.calls.launched[0].entry.moduleData.targets[0][key], value, key);
    await f.operations.refreshEntry(stored, {});
    assert.equal(f.calls.detect, 0, "the session entry never reaches detection");
    // The same record without the session marker is an ordinary library
    // entry, which is detected; the fixture's detection hook is live.
    EphemeralEntries.remove(f.userDataDir, stored.gameId);
    GameStore.writeGameRecord(f.userDataDir, stored);
    await assert.rejects(f.operations.refreshEntry(stored, {}), /No supported game found/);
    assert.equal(f.calls.detect, 1);
  });
}

test("a second choice starts a second entry", async t => {
  const f = fixture(t);
  const first = await startSession(f, { kind: "window", windowID: 71, pid: process.pid, name: "Example" });
  const second = await startSession(f, { kind: "window", windowID: 72, pid: process.pid, name: "Example" });
  assert.notEqual(first.stored.gameId, second.stored.gameId);
  assert.equal(f.calls.launched.length, 2);
  assert.equal(f.actions.runningSession("window", "applyGraphics"), null);
});

test("native target changes rebuild File and Dock menus only for ephemeral entries", () => {
  const vm = require("node:vm"), source = fs.readFileSync(path.join(__dirname, "../src/main/main.js"), "utf8");
  const branch = source.slice(source.indexOf('    if (event === "entryChanged") {'), source.indexOf('    if (event === "runtimeChanged") {'));
  for (const [moduleId, ephemeral, expected] of [["window", true, 1], ["window", false, 0], ["other", true, 1]]) {
    let menus = 0, states = 0;
    const record = { moduleId, gameId: "g" };
    vm.runInNewContext('(function () {' + branch + '})()', { event: "entryChanged", payload: { gameId: "g" },
      GameStore: { readGameRecord: () => record }, EphemeralEntries: { isEphemeral: () => ephemeral },
      userDataDir: "/Library", gameRecordsCache: [record], setupAppMenu: () => menus++, scheduleStateRebuild: () => states++ });
    assert.equal(menus, expected);assert.equal(states, 1);
  }
});

test("the shortcut removes an app the session serves and adds any other app", async () => {
  const vm = require("node:vm"), source = fs.readFileSync(path.join(__dirname, "../src/main/main.js"), "utf8");
  const toggle = source.slice(source.indexOf("async function toggleAppActionSession("), source.indexOf("async function startEphemeralSession("));
  const entry = { moduleId: "window", gameId: "g", gamePath: "/session" }, calls = [];
  let frontmost = 7;
  const context = vm.createContext({ process: { pid: 1 }, GraphicsShortcuts: { frontmostPid: async () => frontmost },
    moduleAppActions: { refresh: async () => false, forShortcut: () => ({ moduleId: "window", action: { id: "applyGraphics" },
      targets: [{ target: { pid: 7 } }, { target: { pid: 8 } }] }), sessionTargets: () => [{ id: "w1", pid: 7 }, { id: "w2", pid: 7 }] },
    runningEphemeralEntries: () => [entry], removeSessionTarget: async (row, id) => calls.push(["remove", id]),
    stopGameRuns: async () => calls.push(["stop"]), startEphemeralSession: async (...args) => calls.push(["start", args[2].target.pid]) });
  vm.runInContext(toggle, context);
  await context.toggleAppActionSession("windowGraphics");
  assert.deepEqual(calls, [["remove", "w1"], ["remove", "w2"]]);
  frontmost = 8;calls.length = 0;
  await context.toggleAppActionSession("windowGraphics");
  assert.deepEqual(calls, [["start", 8]]);
});

test("a new session starts only after an open picker's processes end, and the picker then starts again", async () => {
  const vm = require("node:vm"), source = fs.readFileSync(path.join(__dirname, "../src/main/main.js"), "utf8");
  const start = source.slice(source.indexOf("async function startEphemeralSession("), source.indexOf("async function startNewEphemeralSession("));
  const order = [];
  const context = vm.createContext({ moduleAppActions: { runningSession: () => null },
    appActionPicker: { pause: async () => { order.push("paused");return () => order.push("resumed"); } },
    startNewEphemeralSession: async () => order.push("started") });
  vm.runInContext(start, context);
  await context.startEphemeralSession("window", "applyGraphics", { kind: "window", windowID: 3 });
  assert.deepEqual(order, ["paused", "started", "resumed"]);
});

test("live settings and session events travel through the game's lane", async t => {
  const f = fixture(t), applied = [], events = [];
  const manifest = { id: "stub", runtime: { default: "capture", supported: ["capture"], entries: { capture: {} } } };
  const mod = { id: "stub", manifest, runtimeSettingsChanged: (...args) => { applied.push(args);return true; },
    actions: { ping: (entry, payload, context) => { context.emitSessionEvent({ event: "list", value: payload.value });return true; } } };
  const registry = { listModuleIds: () => ["stub"], listModules: () => [manifest], getModule: id => id === "stub" ? mod : null,
    getModuleInfo: () => manifest, getModuleDir: () => __dirname, listSharedRuntimeManagers: () => [], getRuntimeManagerUi: () => null };
  const { createBackendOperations } = require("../src/core/backend-operations");
  const operations = createBackendOperations({ userDataDir: f.userDataDir, registry, emit: (event, payload) => events.push([event, payload]) });
  t.after(() => operations.beginShutdown());
  const folder = path.join(f.userDataDir, "session");fs.mkdirSync(folder, { recursive: true });
  const entry = { gameId: "g", gamePath: folder, importPath: folder, moduleId: "stub", runtimeId: "capture" };
  assert.equal(operations.runtimeSettingsChanged(entry, "capture", { captureCursor: true }), true);
  assert.deepEqual(applied, [[entry, "capture", { captureCursor: true }]]);
  assert.equal(await operations.moduleAction(entry, "ping", { value: 3 }, {}), true);
  assert.deepEqual(events.filter(([event]) => event === "sessionEvent"), [["sessionEvent", { gameId: "g", gamePath: folder, event: { event: "list", value: 3 } }]]);
});

test("a stored session entry keeps its kind, so the library still shows it as a session", () => {
  const vm = require("node:vm");
  const source = fs.readFileSync(path.join(__dirname, "../src/main/main.js"), "utf8");
  const start = source.indexOf("function serializeGameEntry("), end = source.indexOf("\nfunction isGameRemoving(", start);
  assert.ok(start >= 0 && end > start);
  const context = vm.createContext({ GAME_SCHEMA_VERSION: 1, NetworkAccess: { preferenceForEntry: () => false }, loadSettings: () => ({}),
    SteamClientStart: { startPreference: value => value }, StoredPlan: { serialize: value => value ?? null }, graphicsNotices: () => null });
  vm.runInContext(source.slice(start, end), context);
  assert.equal(context.serializeGameEntry({ gameId: "s", gamePath: "/s", ephemeral: true }).ephemeral, true);
  assert.equal("ephemeral" in context.serializeGameEntry({ gameId: "g", gamePath: "/g" }), false, "an ordinary game record gains no field");
  assert.match(source, /\.\.\.\(entry\.ephemeral === true \? \{ ephemeral: true, \.\.\.sessionTargetsView\(entry\) \} : \{\}\)/,
    "the state view reads the stored kind");
});
