const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const Graphics = require("../src/modules/shared/reshade/graphics-settings"), ReShade = require("../src/modules/shared/reshade"), Plans = require("../src/modules/shared/effects/plan");
const neural = { neuralMethod: "mlx-dlss", neuralModelPath: "/Models/Local.dlssmodel", neuralInputHeight: 480, neuralInputScale: .5 };
test("Simple neural settings remain opt-in, validate scalar controls and preserve ordinary graphics defaults", () => {
  const defaults = Graphics.normalizeSettings();assert.equal(defaults.neuralMethod, "off");assert.equal(defaults.neuralInputHeight, null);
  assert.equal(defaults.neuralIntensity, 1);assert.equal(defaults.neuralTemporal, false);assert.equal(defaults.spatialMethod, "off");assert.equal(Graphics.enabled(defaults), false);
  assert.equal(defaults.neuralInputScale, null);
  const settings = Graphics.updateSettings(defaults, neural);assert.equal(Graphics.enabled(settings), true);assert.equal(settings.spatialMethod, "off");
  for (const patch of [{ neuralMethod: "dlss5" }, { neuralModelPath: "../Model.dlssmodel" }, { neuralInputHeight: 0 }, { neuralInputHeight: 480.5 }, { neuralInputHeight: 16385 }, { neuralIntensity: NaN }, { neuralIntensity: 2 }, { neuralTemporal: 1 }])
    assert.throws(() => Graphics.updateSettings(settings, patch), /supported graphics settings/);
});
test("unavailable Simple neural reconstruction drops its automatic input reduction and preserves working spatial stages", async t => {
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "simple-neural-fallback-")));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "runtime"), userDataDir = path.join(temporary, "profile");
  fs.mkdirSync(root);
  for (const file of ["libreshade-macos.dylib", "fx-compile"]) fs.writeFileSync(path.join(root, file), "fixture");
  fs.writeFileSync(path.join(root, "runtime.json"), JSON.stringify({ schema: 1, version: "test", minimumMacOS: "13.0", features: {
    graphics: { effectPlanAPI: 1, spatialMethods: ["bilinear"], presentation: { hosts: { window: { spatial: true, resolutionMultipliers: [1, 2] } } } }
  } }));
  const Native = require("../src/modules/shared/runtime/bundled-native");
  t.mock.method(Native, "systemVersionSync", () => "27.0");
  const entry = { gameId: "fallback", graphics: { ...neural, spatialMethod: "bilinear" } }, before = structuredClone(entry);
  const options = { root, userDataDir, graphicsHost: "window", verify: () => true, diagnostics: false, gpuTiming: false, trace: false,
    execute: () => assert.fail("no shader is selected") };
  const environment = await ReShade.prepare(entry, options);
  assert.equal(environment.RESHADE_RENDER_MAX_HEIGHT, undefined);assert.equal(environment.RESHADE_RENDER_HEIGHT, undefined);
  const plan = JSON.parse(fs.readFileSync(environment.RESHADE_EFFECT_PLAN, "utf8"));
  // The launch upgrades the v0.4.0 record: the unavailable reconstruction and
  // its input reduction stay off (the upgrade records why), the scaler runs.
  assert.deepEqual(plan.nodes.map(node => [node.id, node.enabled]), [["legacy-neural-input", false], ["legacy-neural", false], ["legacy-spatial", true]]);
  const launch = JSON.parse(fs.readFileSync(path.join(path.dirname(environment.RESHADE_EFFECT_PLAN), "launch.json")));
  assert.deepEqual(launch.graphicsPreparation.requested.map(node => node.id), ["legacy-spatial"]);
  assert.deepEqual(launch.graphicsPreparation.applied.map(node => node.id), ["legacy-spatial"]);
  assert.deepEqual(entry, before, "saved Simple neural preferences survive fallback");
  const explicit = await ReShade.prepare({ ...entry, graphics: { ...entry.graphics, spatialMultiplier: 2 } },
    {...options, graphicsInputs: {sourceResolution: {heights: true, multipliers: [1, 2], control: "engine"}}});
  assert.equal(explicit.RESHADE_RENDER_MULTIPLIER, undefined);assert.equal(explicit.RESHADE_RENDER_MAX_HEIGHT, undefined);
  const advancedEntry = {...entry, effects: Plans.fromLegacy(entry)};
  const advanced = await ReShade.prepare(advancedEntry, options);
  const advancedDocument = JSON.parse(fs.readFileSync(advanced.RESHADE_EFFECT_PLAN));
  assert.equal(advancedDocument.nodes.find(node => node.kind === "neural").enabled, false, "ordinary Advanced launch bypasses the unavailable provider");
  assert.equal(advancedDocument.nodes.find(node => node.method === "bilinear").enabled, true, "independent Advanced spatial work remains enabled");
  assert.equal(advancedEntry.effects.video.find(node => node.kind === "neural").enabled, true, "the requested Advanced plan is preserved");
  const previous = fs.readFileSync(environment.RESHADE_EFFECT_PLAN);
  await assert.rejects(require("../src/modules/shared/effects/runtime").prepare(advancedEntry, options), /provider/i,
    "explicit Advanced edits validate their provider before changing the accepted plan");
  assert.deepEqual(fs.readFileSync(environment.RESHADE_EFFECT_PLAN), previous);
});
