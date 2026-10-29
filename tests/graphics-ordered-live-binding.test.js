const test = require("node:test"), assert = require("node:assert/strict");
const Binding = require("../src/modules/shared/reshade/launch-binding"), StoredPlan = require("../src/modules/shared/effects/stored-plan");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const version = "sha256-" + "a".repeat(64), modelPath = "/Models/Lossless.dll", gameId = "ordered";
// Live edits publish the upgraded plan; the running launch admits each enabled row.
function fixture(t, extra = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "graphics-ordered-live-binding-"));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const launch = {schema: 1, pid: 20, live: true, effectPlanAPI: 1, liveModelVersion: null,
    effectPlanModels: [modelPath], effectPlanBindings: {[version]: {path: modelPath, capabilities: ["lsfgFp16Quality"]}},
    effectPlanTemporalMethods: ["metalfx"], ...extra};
  return {launch, directory};
}
const upgraded = graphics => StoredPlan.upgradeLegacy({gameId, graphics}).effects;
test("upgraded Simple LSFG plans recognize the already bound ordered model", t => {
  const {launch} = fixture(t);
  assert.equal(Binding.supportsPlan(launch, upgraded({frameGeneration: "lsfg", modelVersion: version, frameMultiplier: 4})), true,
    "the existing ordered LSFG binding must not be mistaken for an unbound legacy model");
});
test("upgraded Simple temporal plans recognize the already bound ordered method", t => {
  const {launch} = fixture(t);
  assert.equal(Binding.supportsPlan(launch, upgraded({temporalMethod: "metalfx", temporalSharpness: .7})), true,
    "the existing ordered temporal method must not be mistaken for an unbound legacy method");
});
test("upgraded Simple live plans still defer genuinely unbound models and temporal methods", t => {
  const {launch} = fixture(t, {effectPlanModels: [], effectPlanBindings: {}, effectPlanTemporalMethods: []});
  assert.equal(Binding.supportsPlan(launch, upgraded({frameGeneration: "lsfg", modelVersion: version})), false);
  assert.equal(Binding.supportsPlan(launch, upgraded({temporalMethod: "metalfx"})), false);
});
test("ordered model defaults remain launch-bound and all selected modes need bound capabilities", async t => {
  const {launch} = fixture(t);
  assert.equal(Binding.modelForNode(launch, upgraded({frameGeneration: "lsfg"}).video[0]), version);
  assert.deepEqual(await Binding.resolveModel(launch, null, version, "lsfgFp16Quality"), {modelPath});
  await assert.rejects(Binding.resolveModel(launch, null, version, "lsfgFp32Quality"), /do not support that mode/);
  for (const graphics of [
    {frameGeneration: "lsfg", modelVersion: "sha256-" + "b".repeat(64)},
    {frameGeneration: "lsfg", lsfgFp16: false}, {frameGeneration: "lsfg", lsfgMode: "performance"},
    {frameGeneration: "lsfg", spatialMethod: "ls1"}
  ]) assert.equal(Binding.supportsPlan(launch, upgraded(graphics)), false, JSON.stringify(graphics));
});
test("ordered neural edits require the actual model and provider loaded by the process", t => {
  const library = "/Provider/Neural.dylib", Neural = require("../src/modules/shared/reshade/neural");
  const {launch, directory} = fixture(t, {effectPlanNeuralLibrary: library});
  const local = path.join(directory, "Local.dlssmodel"), other = path.join(directory, "Other.dlssmodel");
  for (const file of [local, other]) fs.writeFileSync(file, "model");
  launch.effectPlanNeuralModels = [local];
  t.mock.method(Neural, "model", value => value);
  const plan = upgraded({neuralMethod: "mlx-dlss", neuralModelPath: local});
  assert.equal(plan.video.find(row => row.kind === "neural").enabled, true);
  assert.equal(Binding.supportsPlan(launch, plan, library), true);
  assert.equal(Binding.supportsPlan(launch, upgraded({neuralMethod: "mlx-dlss", neuralModelPath: other}), library), false);
  assert.equal(Binding.supportsPlan(launch, plan, "/Provider/Other.dylib"), false);
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
