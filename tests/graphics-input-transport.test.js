const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const {createBackendService} = require("../src/core/backend-worker-client");
const {createLauncher} = require("../src/core/launcher");
const Video = require("../src/modules/video/main");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-graphics-input-transport-"));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const entry = {gameId: "video-transport", moduleId: "video", runtimeId: "mpv", gamePath: path.join(root, "clip.mp4")};
  fs.writeFileSync(entry.gamePath, "metadata-only fixture");
  return {entry, userDataDir: path.join(root, "data")};
}

test("production backend worker transports video graphics metadata without local callback functions", {timeout: 10000}, async t => {
  const f = fixture(t), service = createBackendService({userDataDir: f.userDataDir, appInfo: {}});
  t.after(() => service.close());
  const result = await service.request("game:video-transport", "moduleAction", f.entry, "graphicsInputs", {}, {});
  assert.equal(result.runtimeId, "mpv");
  assert.equal(result.graphicsInputs.nativeVideo, true);
  assert.equal(result.graphicsInputs.sourceResolution, false);
  assert.ok(result.graphicsInputs.nativeSpatialMethods.includes("libplacebo:hermite"));
  assert.equal(result.graphicsInputs.nativeSpatialMethods.filter(value => value === "bilinear").length, 1);
  assert.equal(Object.hasOwn(result, "prepareEffectsEntry"), false);
  assert.equal(Object.hasOwn(result, "withGraphicsUpdate"), false);
  assert.deepEqual(structuredClone(result), result);
});

test("local graphics preparation retains module callbacks outside the worker transport", async t => {
  const f = fixture(t), launcher = createLauncher({userDataDir: f.userDataDir});
  const result = await launcher.runAction(f.entry, "graphicsInputs", {}, {settings: {}});
  assert.equal(result.graphicsInputs.nativeVideo, true);
  assert.equal(typeof result.prepareEffectsEntry, "function");
  assert.equal(typeof result.withGraphicsUpdate, "function");
});

test("actual App optional graphics inspection failure preserves module runtime metadata", async t => {
  const f = fixture(t), status = Video.actions.runtimeStatus(f.entry, {}, {userDataDir: f.userDataDir, settings: {}});
  const source = fs.readFileSync(path.join(__dirname, "../src/renderer/src/ui/App.tsx"), "utf8");
  const start = source.indexOf("      const [status, graphics] = await Promise.all(["), end = source.indexOf("\n    }).then", start);
  assert.ok(start >= 0 && end > start, "actual App inspection callback is present");
  const inspect = new Function("api", "gamePath", "action", "inspectGraphics", `return (async () => {${source.slice(start, end)}\n})();`);
  const calls = [], api = {moduleAction: async (_path, action) => {
    calls.push(action);if (action === "runtimeStatus") return status;
    throw Error("optional graphics query failed");
  }};
  const result = await inspect(api, f.entry.gamePath, "runtimeStatus", true);
  assert.deepEqual(calls, ["runtimeStatus", "graphicsInputs"]);
  assert.deepEqual(result.graphicsInputs, status.graphicsInputs);
  assert.equal(result.graphicsInputs.sourceResolution, false);
  assert.equal(result.graphicsLive, undefined, "failed optional query does not invent a live binding");
});

test("actual App inspector refreshes graphics metadata after automatic detection invalidates a pending reply", async () => {
  const {react, componentHarness} = require("./helpers/renderer-component");
  const {createInspectionRequests, updatePathValue} = await import("../src/renderer/src/ui/launcher-state-model.mjs");
  const source = fs.readFileSync(path.join(__dirname, "../src/renderer/src/ui/App.tsx"), "utf8");
  const effectStart = source.indexOf("  useEffect(() => {", source.indexOf("  const runtimeInspectionKey"));
  const effectEnd = source.indexOf("\n\n  const sorted", effectStart);
  const actionStart = source.indexOf("async function onModuleAction("), actionEnd = source.indexOf("}, [api, inspectionRequests]);", actionStart);
  assert.ok(effectStart >= 0 && effectEnd > effectStart && actionStart >= 0 && actionEnd > actionStart);
  const compile = async value => (await require("vite").transformWithOxc(value, "inspector-action.ts")).code;
  const inspect = new Function("context", "useEffect", `const {api, inspectionGame, runtimeInspectionKey, inspectionRequests, inspectionActionsBusy, setRuntimeStatusByPath, updatePathValue} = context;${await compile(source.slice(effectStart, effectEnd))}`);
  const action = new Function("context", `const {api, inspectionRequests, moduleActionRequestIds, setModuleActionBusyByPath, setModuleActionErrorByPath, setModuleActionResultsByPath, setModuleActionCancellingByPath} = context;return ${await compile(source.slice(actionStart, actionEnd + 1))}`);
  let resolveFirst, resolveDetection, statusByPath = {}, busy = {}, graphicsCalls = 0;
  const first = new Promise(resolve => {resolveFirst = resolve;}), detection = new Promise(resolve => {resolveDetection = resolve;});
  const metadata = {runtimeId: "mpv", graphicsInputs: Video.resolveGraphicsInputs({}, {}), graphicsLive: false};
  const gamePath = "/Clip.mp4", context = {inspectionGame: {gamePath, runtimeId: "mpv"},
    runtimeInspectionKey: JSON.stringify([null, true, "mpv"]), inspectionActionsBusy: false,
    inspectionRequests: createInspectionRequests(), moduleActionRequestIds: {current: new Map()}, updatePathValue,
    api: {moduleAction: (_path, id) => id === "graphicsInputs" ? ++graphicsCalls === 1 ? first : Promise.resolve(metadata) : detection},
    setRuntimeStatusByPath: update => {statusByPath = update(statusByPath);},
    setModuleActionBusyByPath: update => {busy = update(busy);context.inspectionActionsBusy = Object.values(busy[gamePath] || {}).some(Boolean);},
    setModuleActionErrorByPath() {}, setModuleActionResultsByPath() {}, setModuleActionCancellingByPath() {}};
  const harness = componentHarness(() => {inspect(context, react.useEffect);return null;}, {});
  try {
    harness.render();await Promise.resolve();
    assert.equal(graphicsCalls, 1);
    const detecting = action(context)(gamePath, "explainDetection");harness.render();
    resolveFirst(metadata);await harness.settle();
    assert.equal(statusByPath[gamePath], undefined, "invalidated reply cannot publish during detection");
    assert.equal(graphicsCalls, 1, "no competing inspection while the action is active");
    resolveDetection({});await detecting;await harness.settle();await harness.settle();
    assert.equal(graphicsCalls, 2, "idle inspector retries the invalidated request once");
    assert.equal(statusByPath[gamePath].runtimeId, "mpv");
    assert.equal(statusByPath[gamePath].status.graphicsInputs.nativeVideo, true);
    assert.equal(statusByPath[gamePath].status.graphicsInputs.sourceResolution, false);
  } finally {harness.close();}
});
