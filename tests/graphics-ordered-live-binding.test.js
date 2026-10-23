const test = require("node:test"), assert = require("node:assert/strict");
const ReShade = require("../src/modules/shared/reshade"), Binding = require("../src/modules/shared/reshade/launch-binding"),
  Graphics = require("../src/modules/shared/reshade/graphics-settings");
const version = "sha256-" + "a".repeat(64), modelPath = "/Models/Lossless.dll";
function fixture(t, extra = {}) {
  const launch = {schema: 1, pid: 20, live: true, effectPlanAPI: 1, effectPlanAutomatic: true,
    liveEffectPlacement: true, liveModelVersion: null, liveModelCapabilities: {}, liveTemporalMethods: [],
    effectPlanModels: [modelPath], effectPlanBindings: {[version]: {path: modelPath, capabilities: ["lsfgFp16Quality"]}},
    effectPlanTemporalMethods: ["metalfx"], ...extra};
  t.mock.method(Binding, "read", () => launch);
  t.mock.method(Graphics, "prepare", async () => ({}));
  return {root: "/not-read", runningPids: [20]};
}
test("Simple ordered LSFG edits recognize the already bound ordered model", async t => {
  const options = fixture(t);
  const valid = await ReShade.validateLiveGraphics({graphics: {frameGeneration: "lsfg", modelVersion: version, frameMultiplier: 4}}, options);
  assert.notEqual(valid, false, "the existing ordered LSFG binding must not be mistaken for an unbound legacy model");
});
test("Simple ordered temporal edits recognize the already bound ordered method", async t => {
  const options = fixture(t);
  const valid = await ReShade.validateLiveGraphics({graphics: {temporalMethod: "metalfx", temporalSharpness: .7}}, options);
  assert.notEqual(valid, false, "the existing ordered temporal method must not be mistaken for an unbound legacy method");
});
test("Simple live edits still defer genuinely unbound models and temporal methods", async t => {
  const options = fixture(t, {effectPlanModels: [], effectPlanBindings: {}, effectPlanTemporalMethods: []});
  assert.equal(await ReShade.validateLiveGraphics({graphics: {frameGeneration: "lsfg", modelVersion: version}}, options), false);
  assert.equal(await ReShade.validateLiveGraphics({graphics: {temporalMethod: "metalfx"}}, options), false);
});
test("ordered model defaults remain launch-bound and all selected modes need bound capabilities", async t => {
  const options = fixture(t), entry = {graphics: {frameGeneration: "lsfg"}};
  assert.notEqual(await ReShade.validateLiveGraphics(entry, options), false);
  assert.equal(Graphics.prepare.mock.calls[0].arguments[0].modelVersion, version);
  const resolve = Graphics.prepare.mock.calls[0].arguments[1].resolveModel;
  assert.deepEqual(await resolve(null, version, "lsfgFp16Quality"), {modelPath});
  await assert.rejects(resolve(null, version, "lsfgFp32Quality"), /do not support that mode/);
  for (const graphics of [
    {frameGeneration: "lsfg", modelVersion: "sha256-" + "b".repeat(64)},
    {frameGeneration: "lsfg", lsfgFp16: false}, {frameGeneration: "lsfg", lsfgMode: "performance"},
    {frameGeneration: "lsfg", spatialMethod: "ls1"}
  ]) assert.equal(await ReShade.validateLiveGraphics({graphics}, options), false);
});
test("ordered neural edits require the actual model and provider loaded by the process", async t => {
  const modelPath = "/Models/Local.dlssmodel", library = "/Provider/Neural.dylib", Neural = require("../src/modules/shared/reshade/neural");
  const options = fixture(t, {effectPlanNeuralModels: [modelPath], effectPlanNeuralLibrary: library});
  const provider = t.mock.method(Neural, "resolve", () => ({library}));
  t.mock.method(Neural, "model", value => value);
  const entry = {graphics: {neuralMethod: "mlx-dlss", neuralModelPath: modelPath}};
  assert.notEqual(await ReShade.validateLiveGraphics(entry, options), false);
  assert.equal(await ReShade.validateLiveGraphics({...entry, graphics: {...entry.graphics, neuralModelPath: "/Models/Other.dlssmodel"}}, options), false);
  provider.mock.mockImplementation(() => ({library: "/Provider/Other.dylib"}));
  assert.equal(await ReShade.validateLiveGraphics(entry, options), false);
});
test("ordered model selection rejects ambiguity and honors compatible actual identities", () => {
  const other = "sha256-" + "b".repeat(64), node = {kind: "frame-generation", method: "lsfg", settings: {}},
    launch = {effectPlanModels: [modelPath, "/Models/Other.dll"], effectPlanBindings: {
      [version]: {path: modelPath, capabilities: ["lsfgFp16Quality"]},
      [other]: {path: "/Models/Other.dll", capabilities: ["lsfgFp16Quality"]}
    }};
  assert.equal(Binding.modelForNode(launch, node), null);
  assert.equal(Binding.modelForNode({...launch, liveModelVersion: version}, node), version);
  assert.equal(Binding.modelForNode(launch, {...node, settings: {modelVersion: other}}), other);
  launch.effectPlanBindings[version].capabilities = ["ls1Quality"];
  assert.equal(Binding.modelForNode({...launch, liveModelVersion: version}, node), other);
  assert.equal(Binding.modelForNode(launch, {...node, settings: {modelVersion: version}}), null);
});
