const test = require("node:test"), assert = require("node:assert/strict");
const Plan = require("../src/modules/shared/effects/plan"), ReShade = require("../src/modules/shared/reshade"), Graphics = require("../src/modules/shared/reshade/graphics-settings");
const shader = {enabled: true, preset: "crt"}, neural = {neuralMethod: "mlx-dlss", neuralModelPath: "/Models/Local.dlssmodel"};
const kinds = plan => plan.video.map(row => row.kind === "spatial" ? row.method : row.kind);
test("automatic Simple composition covers independent method families without adding components", () => {
  const cases = [
    [{}, []], [{reshade: shader}, ["shader"]],
    [{graphics: {frameGeneration: "lsfg"}}, ["frame-generation"]],
    ...["nearest", "bilinear", "bicubic", "metalfx", "fsr1", "mako", "ls1", "libplacebo:lanczos"].flatMap(method => [
      [{graphics: {spatialMethod: method}}, [method]],
      [{graphics: {spatialMethod: method, frameGeneration: "lsfg"}, reshade: shader}, [method, "frame-generation", "shader"]]
    ]),
    [{graphics: {temporalMethod: "fsr2", frameGeneration: "lsfg"}, reshade: shader}, ["temporal", "frame-generation", "shader"]],
    [{graphics: {...neural, spatialMethod: "metalfx", frameGeneration: "lsfg", frameMultiplier: 4}, reshade: shader}, ["downsample", "neural", "metalfx", "frame-generation", "shader"]]
  ];
  for (const [entry, expected] of cases) {
    const before = structuredClone(entry), result = Plan.composeSimple(entry);
    assert.deepEqual(kinds(result), expected);assert.deepEqual(entry, before);
    assert.equal(result.video.some(row => row.kind === "neural"), entry.graphics?.neuralMethod === "mlx-dlss");
    assert.equal(result.video.some(row => row.kind === "frame-generation"), entry.graphics?.frameGeneration === "lsfg");
  }
});
test("shader contracts select source, reconstruction or final display placement without preset-name rules", () => {
  const entry = {reshade: shader, graphics: {...neural, temporalMethod: "fsr2", spatialMethod: "fsr1", frameGeneration: "lsfg"}};
  for (const facts of [{requirements: {depth: true}}, {requirements: ["motion"]}])
    assert.equal(Plan.composeSimple(entry, {shaderFacts: {"legacy-shader": facts}}).video[0].kind, "shader");
  for (const traits of [{neural: true}, {outputScale: {x: 2, y: 2}}, {conditionalGeometry: true}, {displayDependentGeometry: true},
    {unresolvedGeometry: true}, {category: "restoration"}, {category: "downscaling"}, {category: "upscaling"}]) {
    const result = kinds(Plan.composeSimple(entry, {shaderFacts: {"legacy-shader": {traits}}}));
    assert.deepEqual(result, ["temporal", "downsample", "neural", "shader", "fsr1", "frame-generation"]);
  }
  assert.deepEqual(kinds(Plan.composeSimple({...entry, graphics: {...entry.graphics, effectPlacement: "after"}})), kinds(Plan.composeSimple(entry)));
  assert.deepEqual(kinds(Plan.composeSimple(entry, {shaderFacts: {"legacy-shader": {traits: {neural: true}, requirements: {depth: true}}}})).slice(0, 2), ["shader", "temporal"]);
});
test("legacy and saved Advanced order remain literal while contextual reconstruction presets use explicit 4x stages", async () => {
  const entry = {reshade: shader, graphics: {...neural, spatialMethod: "metalfx", frameGeneration: "lsfg", effectPlacement: "before"}};
  const legacy = Plan.fromLegacy(entry), before = structuredClone(entry);
  assert.equal(legacy.video[0].kind, "shader");
  const preset = Plan.reconstructionPreset(entry);
  assert.deepEqual(kinds(preset), ["downsample", "neural", "metalfx", "frame-generation", "shader"]);
  assert.equal(preset.video[0].settings.spatialMultiplier, .25);assert.equal(preset.video[0].presentationScale, undefined);
  assert.equal(preset.video[1].settings.modelPath, neural.neuralModelPath);assert.equal(preset.video[2].settings.spatialMultiplier, 4);
  assert.equal(preset.video[3].settings.frameMultiplier, 4);assert.equal(preset.video[3].settings.frameGeneration, "lsfg");
  assert.deepEqual(entry, before);assert.deepEqual(Plan.composeSimple({...entry, effects: legacy}), legacy);
  const browser = await import("../src/modules/shared/effects/plan.mjs");
  assert.deepEqual(kinds(browser.reconstructionPreset(entry)), kinds(preset));
  assert.equal(Plan.reconstructionPreset({}).video.find(row => row.kind === "neural").settings.modelPath, null);
  assert.equal(Graphics.updateStageSettings({}, {spatialMultiplier: 4}).spatialMultiplier, 4);
  assert.equal(Graphics.updateSettings({}, {spatialMultiplier: 4}).spatialMultiplier, 4);
  assert.equal(require("../src/modules/shared/reshade/source-resolution").DIVISORS.includes(4), false,
    "a valid completed-frame processing request does not invent renderer source support");
  const resized = Plan.validate({...preset, video: [{...preset.video[2], presentationScale: 4}]});
  assert.equal(resized.video[0].presentationScale, 4);
  assert.throws(() => Plan.validate({...preset, video: [{...preset.video[0], presentationScale: 4}]}), /output size/);
});
test("Simple fast paths stay unchanged and dynamic Auto does not capture a launch window size", () => {
  assert.equal(ReShade.automaticPlan({}), null);assert.equal(ReShade.automaticPlan({reshade: shader}), null);
  assert.equal(ReShade.automaticPlan({graphics: {spatialMethod: "metalfx"}}), null);
  assert.equal(ReShade.automaticPlan({graphics: {frameGeneration: "lsfg"}}), null);
  const entry = {graphics: {...neural, spatialMethod: "metalfx"}, reshade: shader};
  for (const size of [{width: 960, height: 540}, {width: 1920, height: 1080}, {width: 3840, height: 2160}]) {
    const live = ReShade.automaticPlan(entry, {presentationSize: size});
    assert.equal(live.video[0].presentationScale, .5);assert.equal(live.video[0].outputSize, undefined);
    assert.equal(ReShade.automaticResolutionOptions(entry).automaticResolutionNode, live.video[0].id);
    const draft = ReShade.automaticPlan(entry, {draftPlan: true, presentationSize: size});
    assert.equal(draft.video[0].presentationScale, 1 / Math.min(4, Math.round(size.height / 540)));
  }
  const plain = ReShade.executionRequirements({reshade: shader});
  assert.equal(plain.needed.neural, false);assert.equal(plain.needed.losslessModel, false);assert.equal(plain.needed.spatial, false);
});
test("Simple quarter-resolution neural input stays a single processing reduction for native and engine sources", () => {
  const entry = {graphics: {...neural, neuralInputScale: .25, spatialMethod: "bilinear", frameGeneration: "lsfg"}, reshade: shader};
  const before = structuredClone(entry), support = {spatial: true, spatialMethods: ["bilinear"], resolutionMultipliers: [1, 2, 3], virtualWindow: true};
  for (const graphicsInputs of [{}, {sourceResolution: {control: "engine", heights: true, multipliers: [1, 2, 3]}}]) {
    const plan = ReShade.automaticPlan(entry, {graphicsHost: "window", graphicsInputs, graphicsCapabilities: support});
    assert.doesNotThrow(() => Plan.validate(plan));assert.equal(plan.renderResolution, undefined);
    assert.deepEqual(kinds(plan), ["downsample", "neural", "bilinear", "frame-generation", "shader"]);
    assert.equal(plan.video[0].presentationScale, .25);
    assert.equal(plan.video.filter(row => row.method === "downsample").length, 1);
  }
  assert.deepEqual(entry, before);
});
test("Simple spatial shaders run after neural reconstruction, fit before generation and leave CRT last", () => {
  const spatialShader = {enabled: true, preset: "custom", effectPath: "/Filters/fixed-2x.glsl", parameters: {Strength: [.6]}};
  const entry = {reshade: shader, graphics: {...neural, neuralInputScale: 1, spatialShader, frameGeneration: "lsfg", frameMultiplier: 4}};
  const before = structuredClone(entry), options = {graphicsHost: "remote", graphicsInputs: {sourceResolution: false},
    graphicsCapabilities: {spatial: true, spatialMethods: ["metalfx", "bilinear"], resolutionMultipliers: []},
    shaderFacts: {"legacy-spatial-shader": {traits: {category: "upscaling", outputScale: {x: 2, y: 2}}}}};
  const legacy = Plan.fromLegacy(entry);
  assert.deepEqual(legacy.video.map(row => row.id), ["legacy-shader", "legacy-neural", "legacy-spatial-shader", "legacy-frame-generation"],
    "literal legacy conversion retains its saved before/after order");
  const automatic = ReShade.automaticPlan(entry, options);
  assert.deepEqual(automatic.video.map(row => row.id), ["legacy-neural", "legacy-spatial-shader", "legacy-spatial-fit", "legacy-frame-generation", "legacy-shader"]);
  assert.deepEqual(automatic.video.find(row => row.id === "legacy-spatial-shader").shader, spatialShader);
  const fit = automatic.video.find(row => row.id === "legacy-spatial-fit");
  assert.equal(fit.method, "metalfx");assert.equal(fit.outputSize, undefined);assert.equal(fit.presentationScale, undefined);
  assert.equal(fit.settings.spatialMultiplier, null);assert.equal(fit.settings.spatialShader, null,
    "the native fit carries no nested Simple shader selection");
  assert.equal(automatic.renderResolution, undefined, "an intrinsic shader scale alone never lowers the renderer allocation");
  assert.deepEqual(entry, before);
  assert.deepEqual(ReShade.automaticPlan(entry, {...options, draftPlan: true}), automatic);
});
test("fixed scaling shader input is reduced only for an explicit Simple source-budget request", () => {
  const entry = {graphics: {spatialShader: {enabled: true, preset: "custom", effectPath: "/Filters/fixed-2x.glsl"}}};
  const options = {graphicsHost: "remote", graphicsInputs: {sourceResolution: false},
    graphicsCapabilities: {spatial: true, spatialMethods: ["bilinear"], resolutionMultipliers: []},
    shaderFacts: {"legacy-spatial-shader": {traits: {outputScale: {x: 2, y: 2}}}}};
  const original = ReShade.automaticPlan(entry, options);
  assert.deepEqual(original.video.map(row => row.id), ["legacy-spatial-shader", "legacy-spatial-fit"]);
  assert.equal(original.renderResolution, undefined);
  const requested = ReShade.automaticPlan({...entry, graphics: {...entry.graphics, spatialMultiplier: 2}}, options);
  assert.deepEqual(requested.renderResolution, {multiplier: 2});
  assert.equal(requested.video.filter(row => row.method === "downsample").length, 0,
    "preparation owns the native, virtual or completed-frame fallback decision");
});
