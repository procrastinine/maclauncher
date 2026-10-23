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
test("Simple Auto reconstruction selects a final scaler and preserves source allocation", () => {
  const entry = {graphics: {neuralMethod: "mlx-dlss", neuralModelPath: neural.neuralModelPath}}, before = structuredClone(entry);
  const options = {graphicsHost: "window", graphicsCapabilities: {spatial: true, spatialMethods: ["bilinear", "bicubic", "metalfx"], resolutionMultipliers: []}};
  const plan = ReShade.automaticPlan(entry, options);
  assert.equal(plan.video[0].presentationScale, .5);assert.equal(plan.video[0].outputSize, undefined);
  assert.deepEqual(ReShade.automaticResolutionOptions(entry, options), {automaticSimple: true, automaticResolutionNode: "legacy-neural-input", automaticSourceResolution: true});
  assert.equal(plan.video[0].resolutionAuto, undefined, "the Advanced draft is an explicit manual baseline");
  assert.throws(() => Plans.validate({...plan, video: [{...plan.video[0], resolutionAuto: true}]}), /unsupported fields/);
  assert.deepEqual(plan.video.map(row => row.method), ["downsample", "mlx-dlss", "metalfx"]);
  assert.equal(plan.renderResolution, undefined);assert.deepEqual(entry, before);
  const engine = ReShade.automaticPlan(entry, {...options, graphicsInputs: {sourceResolution: {control: "engine", heights: true, multipliers: [1, 2]}}});
  assert.equal(engine.renderResolution, undefined, "post-composite reconstruction avoids a scene upscale followed by another reduction");
  const fallback = ReShade.automaticPlan(entry, {...options, graphicsCapabilities: {...options.graphicsCapabilities, spatialMethods: ["bilinear", "bicubic"]}});
  assert.equal(fallback.video.at(-1).method, "bicubic");
  const advanced = {schema: 1, mode: "advanced", video: []};
  assert.equal(ReShade.automaticPlan({...entry, effects: advanced}, options), null);
  assert.deepEqual(ReShade.automaticResolutionOptions({...entry, effects: advanced}, options), {});
});
test("automatic resolution preserves explicit scales and keeps native video at decoded size unless Auto is selected", () => {
  for (const scale of [.25, .5, 2 / 3, 1]) {
    const entry = {graphics: {...neural, neuralInputScale: scale}};
    assert.equal(Graphics.normalizeSettings(entry.graphics).neuralInputScale, scale);
    assert.deepEqual(ReShade.automaticResolutionOptions(entry), {automaticSimple: true});
  }
  const entry = {graphics: {neuralMethod: "mlx-dlss", neuralModelPath: neural.neuralModelPath}}, options = {graphicsInputs: {nativeVideo: true}};
  assert.deepEqual(ReShade.automaticResolutionOptions(entry, options), {automaticSimple: true});
  assert.equal(ReShade.automaticPlan(entry, options).video.some(row => row.id === "legacy-neural-input"), false);
  const explicitAuto = {...entry, graphics: {...entry.graphics, neuralInputScale: null}};
  assert.deepEqual(ReShade.automaticResolutionOptions(explicitAuto, options), {automaticSimple: true, automaticResolutionNode: "legacy-neural-input", automaticSourceResolution: true});
  assert.equal(ReShade.automaticPlan(explicitAuto, options).video[0].method, "downsample");
});
test("Simple automatic reconstruction caps processing before NN and preserves shader, temporal, spatial and frame-generation order", () => {
  const entry = { graphics: { ...neural, temporalMethod: "metalfx", spatialMethod: "metalfx", frameGeneration: "lsfg", effectPlacement: "before" }, reshade: { enabled: true, preset: "cas" } };
  const original = structuredClone(entry), plan = ReShade.automaticPlan(entry, { graphicsHost: "window",
    graphicsInputs: {sourceResolution: {heights: true, multipliers: [1, 1.5, 2, 3], control: "engine"}} });
  assert.deepEqual(plan.video.map(row => row.id), ["legacy-temporal", "legacy-neural-input", "legacy-neural", "legacy-spatial", "legacy-frame-generation", "legacy-shader"]);
  assert.equal(plan.video[1].presentationScale, .5);assert.equal(plan.video[1].outputSize, undefined);assert.equal(plan.video[1].method, "downsample");
  assert.deepEqual(plan.video[2].settings, { modelPath: neural.neuralModelPath, intensity: 1, temporal: false });
  assert.equal(plan.renderResolution, undefined);assert.equal(plan.video[3].settings.spatialMultiplier, null);assert.deepEqual(entry, original);
  const after = ReShade.automaticPlan({ ...entry, graphics: { ...entry.graphics, effectPlacement: "after" } }, { graphicsHost: "remote" });
  assert.deepEqual(after.video.map(row => row.id), plan.video.map(row => row.id));
  assert.deepEqual(after.renderResolution, {multiplier: 2}, "the requested ratio survives a host without source allocation");assert.equal(after.video[1].presentationScale, .5);
  assert.equal(require("../src/modules/shared/reshade/source-resolution").resolve(after.renderResolution, {host: "remote", processing: true}).strategy, "processing");
});
test("Simple neural fits its output, follows producer support and leaves existing Advanced plans explicit", () => {
  const entry = { graphics: neural }, plan = ReShade.automaticPlan(entry, { graphicsHost: "explicit" });
  assert.deepEqual(plan.video.map(row => row.kind), ["spatial", "neural", "spatial"]);assert.deepEqual(plan.renderResolution, {multiplier: 2});assert.equal(entry.effects, undefined);
  const fullInput = ReShade.automaticPlan({ graphics: { ...neural, neuralInputHeight: null, neuralInputScale: 1 } }, { graphicsHost: "window" });
  assert.deepEqual(fullInput.video.map(row => row.kind), ["neural", "spatial"]);assert.equal(fullInput.renderResolution, undefined);
  const advanced = { schema: 1, mode: "advanced", video: [] }, saved = { ...entry, effects: advanced }, before = structuredClone(saved);
  assert.equal(ReShade.automaticPlan(saved, { graphicsHost: "window" }), null);assert.deepEqual(Plans.fromLegacy(saved), advanced);assert.deepEqual(saved, before);
  assert.deepEqual(Plans.fromLegacy(entry).video.map(row => row.kind), ["spatial", "neural"]);
  const video = { graphics: { ...neural, neuralInputHeight: null, neuralInputScale: 1, spatialMethod: "libplacebo:ewa_lanczossharp" } };
  const runtimeVideo = require("../src/modules/video/scaling").sharedEntry(video, ["bilinear", "ewa_lanczossharp"]);
  assert.equal(runtimeVideo.graphics.spatialMethod, "off");assert.equal(runtimeVideo.graphics.neuralMethod, "mlx-dlss");
  const videoPlan = ReShade.automaticPlan(runtimeVideo, { graphicsHost: "window", graphicsInputs: { nativeVideo: true } });
  assert.deepEqual(videoPlan.video.map(row => row.kind), ["neural", "spatial"]);assert.equal(videoPlan.renderResolution, undefined);
});
test("unbound Simple neural live settings defer publication until next launch; bound changes keep source allocation launch-bound", async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "simple-neural-")));t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const Neural = require("../src/modules/shared/reshade/neural"), Effects = require("../src/modules/shared/effects/runtime"), Live = require("../src/modules/shared/reshade/live-controls");
  const entry = { gameId: "nn", graphics: neural }, directory = path.dirname(Live.file(entry, root)), library = "/Graphics/Neural.dylib", calls = [];
  fs.mkdirSync(directory, { recursive: true });const launchFile = path.join(directory, "launch.json"), planFile = path.join(directory, "effect-plan.json");
  fs.writeFileSync(planFile, "current working plan");fs.writeFileSync(launchFile, JSON.stringify({ effectPlanAPI: 1, effectPlanNeuralModels: [] }));
  t.mock.method(Neural, "resolve", () => ({ library }));t.mock.method(Neural, "model", value => value);
  t.mock.method(Effects, "prepare", async (...args) => { calls.push(args);return {}; });
  const options = { userDataDir: root, root: "/Graphics", graphicsHost: "window" };
  assert.equal(await ReShade.updateAutomaticEffects(entry, options), true);assert.equal(calls.length, 0);assert.equal(fs.readFileSync(planFile, "utf8"), "current working plan");
  fs.writeFileSync(launchFile, JSON.stringify({ effectPlanAPI: 1, effectPlanNeuralModels: [neural.neuralModelPath], effectPlanNeuralLibrary: library }));
  assert.equal(await ReShade.updateAutomaticEffects({ ...entry, graphics: { ...neural, neuralIntensity: .6 } }, options), true);
  assert.equal(calls.length, 1);assert.equal(calls[0][1].live, true);assert.equal(calls[0][1].deferRenderResolution, true);
  assert.equal(calls[0][0].effects.video.find(row => row.kind === "neural").settings.intensity, .6);
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
  assert.deepEqual(plan.nodes.map(node => [node.id, node.enabled]), [["legacy-neural", false], ["legacy-spatial", true]]);
  const launch = JSON.parse(fs.readFileSync(path.join(path.dirname(environment.RESHADE_EFFECT_PLAN), "launch.json")));
  assert.deepEqual(launch.graphicsPreparation.requested.map(node => node.id), ["legacy-neural-input", "legacy-neural", "legacy-spatial"]);
  assert.deepEqual(launch.graphicsPreparation.applied.map(node => node.id), ["legacy-spatial"]);
  assert.equal(launch.graphicsWarnings.length, 1);assert.equal(launch.graphicsWarnings[0].kind, "neural");
  assert.match(launch.graphicsWarnings[0].reason, /provider/i);
  assert.match(launch.graphicsWarnings[0].reason, /^DLSS 5/);
  assert.equal(launch.graphicsPreparation.skipped.some(node => node.id === "legacy-neural-input"), true);
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
