const test = require("node:test"), assert = require("node:assert/strict");
const { ensureGraphicsModel, requiredCapabilities } = require("../src/modules/shared/reshade/simple-setup");
const Graphics = require("../src/modules/shared/reshade/graphics-settings");
const NN = "graphics-neural-models", LS = "graphics-models", version = value => "sha256-" + value.repeat(64);
function model(key, capabilities) {
  return {version: version(key), ready: true, inspection: {capabilities: Object.fromEntries(capabilities.map(name => [name, {compatible: true}]))}};
}
function fixture() {
  const calls = [], neuralRows = [], losslessRows = [];
  const dependencies = {
    neural: {model: file => { if (!file.endsWith(".dlssmodel")) throw Error("Invalid package");return file; }},
    neuralModels: {listInstalled: () => neuralRows, resolveModel: async (_dir, selected) => {
      calls.push(["resolve-neural", selected]);const row = neuralRows.find(row => row.version === selected);if (row.broken) throw Error("changed");return row;
    }},
    losslessModels: {listInstalled: () => losslessRows, resolveModel: async (_dir, selected, capability) => {
      calls.push(["resolve-lossless", selected, capability]);const row = losslessRows.find(row => row.version === selected);if (row.broken) throw Error("changed");return row;
    }},
    sources: {findModels: () => { calls.push(["find"]);return []; }}
  };
  const options = {entry: {graphics: {}}, settings: {}, userDataDir: "/private/profile",
    runRuntimeAction: (...args) => { calls.push(args);assert.fail("unexpected managed action"); }};
  return {calls, neuralRows, losslessRows, dependencies, options};
}
test("Simple setup validates kind and prospective patch before model work and keeps off settings idle", async () => {
  const f = fixture();
  await assert.rejects(ensureGraphicsModel({...f.options, kind: "unknown"}, f.dependencies), /supported graphics/);
  await assert.rejects(ensureGraphicsModel({...f.options, kind: "lossless", patch: {lsfgMode: "invalid"}}, f.dependencies), /supported graphics/);
  assert.equal(await ensureGraphicsModel({...f.options, kind: "lossless"}, f.dependencies), null);
  assert.deepEqual(f.calls, []);
});
test("Simple neural setup reuses a valid local package or selected managed default before acquisition", async () => {
  const f = fixture();
  assert.deepEqual(await ensureGraphicsModel({...f.options, kind: "neural", patch: {neuralModelPath: "/local/model.dlssmodel"}}, f.dependencies), {modelPath: "/local/model.dlssmodel"});
  f.neuralRows.push({version: version("a"), modelPath: "/managed/a.dlssmodel"}, {version: version("b"), modelPath: "/managed/b.dlssmodel"});
  assert.deepEqual(await ensureGraphicsModel({...f.options, kind: "neural", settings: {runtimes: {[NN]: {defaultVersion: version("b")}}}}, f.dependencies), {modelPath: "/managed/b.dlssmodel"});
  f.neuralRows[1].broken = true;
  assert.deepEqual(await ensureGraphicsModel({...f.options, kind: "neural", settings: {runtimes: {[NN]: {defaultVersion: version("b")}}}}, f.dependencies), {modelPath: "/managed/a.dlssmodel"});
  assert.deepEqual(f.options.entry.graphics, {});
});
test("Simple neural acquisition re-lists managed results and treats a declined service boolean as no model", async () => {
  const f = fixture();
  const acquire = {...f.options, kind: "neural", runRuntimeAction: async (...args) => {
    assert.deepEqual(args, [NN, "setup", {setupActionId: "downloadDlssMac"}]);
    f.neuralRows.push({version: version("a"), modelPath: "/managed/new.dlssmodel"});return true;
  }};
  assert.deepEqual(await ensureGraphicsModel(acquire, f.dependencies), {modelPath: "/managed/new.dlssmodel"});
  f.neuralRows.length = 0;
  assert.equal(await ensureGraphicsModel({...acquire, runRuntimeAction: async () => true}, f.dependencies), null);
  assert.deepEqual(await ensureGraphicsModel({...acquire, runRuntimeAction: async () => ({modelPath: "/managed/result.dlssmodel"})}, f.dependencies), {modelPath: "/managed/result.dlssmodel"});
});
test("Lossless requirements include prospective LS1 and the selected LSFG precision and quality", () => {
  assert.deepEqual(requiredCapabilities(Graphics.updateSettings({}, {spatialMethod: "ls1", ls1Mode: "performance", frameGeneration: "lsfg", lsfgFp16: false, lsfgMode: "quality"})), ["ls1Performance", "lsfgFp32Quality"]);
  assert.deepEqual(requiredCapabilities(Graphics.updateSettings({}, {frameGeneration: "lsfg", lsfgMode: "performance"})), ["lsfgFp16Performance"]);
});
test("Lossless selected, default and other installed models must satisfy every capability and checksum", async () => {
  const f = fixture(), required = ["ls1Quality", "lsfgFp16Performance"];
  f.losslessRows.push(model("a", required), model("b", required), model("c", ["ls1Quality"]));
  const options = {...f.options, kind: "lossless", entry: {graphics: {modelVersion: version("a")}},
    settings: {runtimes: {[LS]: {defaultVersion: version("b")}}}, patch: {spatialMethod: "ls1", frameGeneration: "lsfg", lsfgMode: "performance"}};
  const before = structuredClone(options.entry);
  assert.deepEqual(await ensureGraphicsModel(options, f.dependencies), {modelVersion: version("a")});
  f.losslessRows[0].broken = true;
  assert.deepEqual(await ensureGraphicsModel(options, f.dependencies), {modelVersion: version("b")});
  assert.deepEqual(options.entry, before);assert.ok(!f.calls.some(row => row[0] === "find"));
  assert.ok(f.calls.some(row => row[0] === "resolve-lossless" && row[2] === "lsfgFp16Performance"));
});
test("explicit Simple setup imports bounded local discoveries through the managed action before prompting", async () => {
  const f = fixture();f.dependencies.sources.findModels = () => ["/local/Lossless.dll"];
  const options = {...f.options, kind: "lossless", patch: {spatialMethod: "ls1"}, chooseLosslessSource: () => assert.fail("compatible local source needs no acquisition prompt"),
    runRuntimeAction: async (...args) => {
      assert.deepEqual(args, [LS, "setup", {setupActionId: "findInstalled"}]);f.losslessRows.push(model("a", ["ls1Quality"]));return true;
    }};
  assert.deepEqual(await ensureGraphicsModel(options, f.dependencies), {modelVersion: version("a")});
});
test("a returned model keeps its first preference when the same version is also the default", async () => {
  const f = fixture();f.dependencies.sources.findModels = () => ["/local/Lossless.dll"];
  const options = {...f.options, kind: "lossless", entry: {graphics: {modelVersion: version("a")}},
    settings: {runtimes: {[LS]: {defaultVersion: version("b")}}}, patch: {spatialMethod: "ls1"},
    runRuntimeAction: async () => {
      f.losslessRows.push(model("a", ["ls1Quality"]), model("b", ["ls1Quality"]));return f.losslessRows[1];
    }};
  assert.deepEqual(await ensureGraphicsModel(options, f.dependencies), {modelVersion: version("b")});
});
test("failed local imports offer Steam download and accept a verified setup result", async () => {
  const f = fixture(), imported = model("a", ["ls1Quality", "lsfgFp16Quality"]);f.dependencies.sources.findModels = () => ["/local/older.dll"];
  const options = {...f.options, kind: "lossless", patch: {spatialMethod: "ls1", frameGeneration: "lsfg"},
    chooseLosslessSource: async data => { assert.match(data.reason, /Unsupported DLL/);assert.deepEqual(data.requiredCapabilities, ["ls1Quality", "lsfgFp16Quality"]);return "download"; },
    runRuntimeAction: async (_manager, action, payload) => {
      f.calls.push([action, payload]);if (payload.setupActionId === "findInstalled") throw Error("Unsupported DLL");
      assert.equal(payload.setupActionId, "downloadSteam");return imported;
    }};
  assert.deepEqual(await ensureGraphicsModel(options, f.dependencies), {modelVersion: imported.version});
  assert.deepEqual(f.calls.map(row => row[1].setupActionId), ["findInstalled", "downloadSteam"]);
});
test("missing Lossless sources allow explicit import, reject partial capability matches and preserve cancellation", async () => {
  const f = fixture(), options = {...f.options, kind: "lossless", patch: {spatialMethod: "ls1", frameGeneration: "lsfg"}, chooseLosslessSource: async () => "import",
    runRuntimeAction: async (...args) => { assert.deepEqual(args, [LS, "import", {}]);return model("a", ["ls1Quality"]); }};
  await assert.rejects(ensureGraphicsModel(options, f.dependencies), /all selected/);
  assert.equal(await ensureGraphicsModel({...options, runRuntimeAction: async () => false}, f.dependencies), null);
  assert.equal(await ensureGraphicsModel({...options, chooseLosslessSource: async () => null, runRuntimeAction: () => assert.fail("cancelled chooser starts no action")}, f.dependencies), null);
  const controller = new AbortController();controller.abort();
  assert.equal(await ensureGraphicsModel({...options, signal: controller.signal}, f.dependencies), null);
});

test("Off releases model setup while its independently managed acquisition is still pending", async () => {
  const f = fixture(), controller = new AbortController();let finish, started;
  const entered = new Promise(resolve => {started = resolve;});
  const acquisition = new Promise(resolve => {finish = resolve;});
  const setup = ensureGraphicsModel({...f.options, kind: "neural", signal: controller.signal,
    runRuntimeAction: () => {started();return acquisition;}
  }, f.dependencies);
  await entered;controller.abort();
  assert.equal(await setup, null, "setup settles before the manager finishes its independent task");
  f.neuralRows.push({version: version("a"), modelPath: "/managed/late.dlssmodel"});
  finish({version: version("a")});await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.length, 0, "late completion neither selects nor validates a model for the canceled toggle");
  assert.deepEqual(f.options.entry.graphics, {});
});
