const test = require("node:test"), assert = require("node:assert/strict");
const Plan = require("../src/modules/shared/effects/plan"), ReShade = require("../src/modules/shared/reshade"), Graphics = require("../src/modules/shared/reshade/graphics-settings");
const StoredPlan = require("../src/modules/shared/effects/stored-plan"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const shader = {enabled: true, preset: "crt"}, neural = {neuralMethod: "mlx-dlss", neuralModelPath: "/Models/Local.dlssmodel"};
const kinds = plan => plan.video.map(row => row.kind === "spatial" ? row.method : row.kind);
test('neutral fit targets accept one pixel axis in both saved schemas without becoming directional',()=>{
  for(const schema of [1,2])for(const outputSize of [{height:540},{width:960}]){
    const value={schema,mode:'advanced',video:[{id:'fit',kind:'spatial',enabled:true,method:'bicubic',settings:{spatialMultiplier:null},outputSize}]};
    const result=Plan.validate(value);assert.equal(result.video[0].kind,'spatial');assert.deepEqual(result.video[0].outputSize,outputSize);
    assert.equal(Plan.migrate(result).video[0].kind,'spatial');
  }
  const legacy={schema:2,mode:'advanced',video:[{id:'input',kind:'downsample',enabled:true,method:'bilinear',settings:{},extent:{relativeTo:'presentation',automatic:true}}]};
  assert.deepEqual(Plan.validate(legacy).video[0].extent,{height:540});
  assert.deepEqual(legacy.video[0].extent,{relativeTo:'presentation',automatic:true},'normalization preserves the original record');
});
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
  for (const traits of [{outputScale: {x: 2, y: 2}}, {conditionalGeometry: true}, {displayDependentGeometry: true},
    {unresolvedGeometry: true}]) {
    const result = kinds(Plan.composeSimple(entry, {shaderFacts: {"legacy-shader": {traits}}}));
    assert.deepEqual(result, ["temporal", "downsample", "neural", "shader", "fsr1", "frame-generation"]);
  }
  for (const traits of [{neural: true}, {category: "restoration"}, {category: "downscaling"}, {category: "upscaling"}]) {
    assert.deepEqual(kinds(Plan.composeSimple(entry, {shaderFacts: {"legacy-shader": {traits}}})),
      ["temporal", "downsample", "neural", "fsr1", "frame-generation", "shader"],
      "semantic tags cannot change a shader's input/output placement");
  }
  assert.deepEqual(kinds(Plan.composeSimple({...entry, graphics: {...entry.graphics, effectPlacement: "after"}})), kinds(Plan.composeSimple(entry)));
  assert.deepEqual(kinds(Plan.composeSimple(entry, {shaderFacts: {"legacy-shader": {traits: {neural: true}, requirements: {depth: true}}}})).slice(0, 2), ["shader", "temporal"]);
});
test("the DLSS preset uses 540 pixels then window fitting and 4x frames, preserving saved order and settings", async () => {
  const entry = {reshade: shader, graphics: {...neural, spatialMethod: "metalfx", frameGeneration: "lsfg", effectPlacement: "before"}};
  const legacy = Plan.fromLegacy(entry), before = structuredClone(entry);
  assert.equal(legacy.video[0].kind, "shader");
  const preset = Plan.reconstructionPreset(entry);
  assert.deepEqual(kinds(preset), ["downsample", "neural", "upscale", "frame-generation", "shader"]);
  assert.equal(preset.schema,2);assert.equal(preset.video[0].method,'bilinear');assert.deepEqual(preset.video[0].extent,{height:540});
  assert.equal(preset.video[1].settings.modelPath, neural.neuralModelPath);
  assert.equal(preset.video[2].method,'metalfx');assert.deepEqual(preset.video[2].extent,{relativeTo:'presentation',factor:1});
  assert.equal(preset.video[3].settings.frameMultiplier, 4);assert.equal(preset.video[3].settings.frameGeneration, "lsfg");
  assert.deepEqual(entry, before);assert.deepEqual(Plan.composeSimple({...entry, effects: legacy}), legacy);
  const browser = await import("../src/modules/shared/effects/plan.mjs");
  assert.deepEqual(kinds(browser.reconstructionPreset(entry)), kinds(preset));
  assert.equal(Plan.reconstructionPreset({}).video.find(row => row.kind === "neural").settings.modelPath, null);
  assert.equal(Graphics.updateStageSettings({}, {spatialMultiplier: 4}).spatialMultiplier, 4);
  assert.equal(Graphics.updateSettings({}, {spatialMultiplier: 4}).spatialMultiplier, 4);
  assert.equal(require("../src/modules/shared/reshade/source-resolution").DIVISORS.includes(4), false,
    "a valid completed-frame processing request does not invent renderer source support");
  const divisor = Plan.reconstructionPreset(entry,{divisor:4});
  assert.deepEqual(divisor.video[0].extent,{relativeTo:'input',factor:.25});
  assert.deepEqual(divisor.video[2].extent,{relativeTo:'presentation',factor:1},'the final window target is independent of the chosen reduction');
  const resized = Plan.validate({...preset, video: [{...preset.video[2], extent:{width:2560,height:1440}}]});
  assert.deepEqual(resized.video[0].extent,{width:2560,height:1440});
  assert.throws(() => Plan.validate({...preset, video: [{...preset.video[0], presentationScale: 4}]}), /output size/);
});
test("the upgraded Simple neural input is a fixed processing height and a lone shader adds no scaling", () => {
  const plan = StoredPlan.upgradeLegacy({graphics: {...neural, spatialMethod: "metalfx"}, reshade: shader}).effects;
  assert.equal(plan.video[0].id, "legacy-neural-input");assert.deepEqual(plan.video[0].extent, {height: 540});
  assert.equal(plan.video[0].presentationScale, undefined);
  const plain = ReShade.executionRequirements(StoredPlan.upgradeLegacy({reshade: shader}));
  assert.equal(plain.needed.neural, false);assert.equal(plain.needed.losslessModel, false);assert.equal(plain.needed.spatial, false);
});
test("a lone legacy shader upgrades to one ordered row without changing source size or discovering providers", t => {
  let discovered = 0;
  t.mock.method(Graphics, "capabilities", () => { discovered++;return {}; });
  const plan = StoredPlan.upgradeLegacy({reshade: shader}).effects;
  assert.deepEqual(plan.video.map(row => row.id), ["legacy-shader"]);
  assert.equal(plan.renderResolution, undefined);
  assert.deepEqual(plan.video[0].shader, ReShade.normalizeSettings(shader));
  const dormant = {get root() { throw Error("Off must not inspect the runtime"); }};
  assert.deepEqual(StoredPlan.upgradeLegacy({}, dormant), {});
  assert.deepEqual(StoredPlan.upgradeLegacy({reshade: {...shader, enabled: false}}, dormant), {effects: null});
  assert.equal(discovered, 0);
});
test("Simple quarter-resolution neural input stays a single processing reduction for native and engine sources", () => {
  const entry = {graphics: {...neural, neuralInputScale: .25, spatialMethod: "bilinear", frameGeneration: "lsfg"}, reshade: shader};
  const before = structuredClone(entry), support = {spatial: true, spatialMethods: ["bilinear"], resolutionMultipliers: [1, 2, 3], virtualWindow: true};
  for (const graphicsInputs of [{}, {sourceResolution: {control: "engine", heights: true, multipliers: [1, 2, 3]}}]) {
    const plan = StoredPlan.upgradeLegacy(entry, {graphicsHost: "window", graphicsInputs, graphicsCapabilities: support}).effects;
    assert.doesNotThrow(() => Plan.validate(plan));assert.equal(plan.renderResolution, undefined);
    assert.deepEqual(kinds(plan), ["downsample", "neural", "bilinear", "frame-generation", "shader"]);
    assert.deepEqual(plan.video[0].extent, {relativeTo: "presentation", factor: .25});
    assert.equal(plan.video.filter(row => row.kind === "downsample").length, 1);
  }
  assert.deepEqual(entry, before);
});
// The upgrade keeps only readable custom files and reads their traits from
// shader analysis; this stub supplies the analyzed traits for one such file.
function scalingShader(t, traits) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "simple-composition-"));t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const effectPath = path.join(directory, "fixed-2x.glsl");fs.writeFileSync(effectPath, "fixture");
  t.mock.method(ReShade, "resolveShaderSelection", selected => {
    if (selected.reshade.effectPath !== effectPath) throw Error("Unresolved shader");
    return {traits};
  });
  return effectPath;
}
test("Simple spatial shaders run after neural reconstruction, fit before generation and leave CRT last", t => {
  const spatialShader = {enabled: true, preset: "custom", effectPath: scalingShader(t, {category: "upscaling", outputScale: {x: 2, y: 2}}), parameters: {Strength: [.6]}};
  const entry = {reshade: shader, graphics: {...neural, neuralInputScale: 1, spatialShader, frameGeneration: "lsfg", frameMultiplier: 4}};
  const before = structuredClone(entry), options = {graphicsHost: "remote", graphicsInputs: {sourceResolution: false},
    graphicsCapabilities: {spatial: true, spatialMethods: ["metalfx", "bilinear"], resolutionMultipliers: []}};
  const legacy = Plan.fromLegacy(entry);
  assert.deepEqual(legacy.video.map(row => row.id), ["legacy-shader", "legacy-neural", "legacy-spatial-shader", "legacy-frame-generation"],
    "literal legacy conversion retains its saved before/after order");
  const upgraded = StoredPlan.upgradeLegacy(entry, options).effects;
  assert.deepEqual(upgraded.video.map(row => row.id), ["legacy-neural", "legacy-spatial-shader", "legacy-spatial-fit", "legacy-frame-generation", "legacy-shader"]);
  assert.deepEqual(upgraded.video.find(row => row.id === "legacy-spatial-shader").shader, spatialShader);
  const fit = upgraded.video.find(row => row.id === "legacy-spatial-fit");
  assert.equal(fit.method, "metalfx");assert.equal(fit.extent, undefined);assert.deepEqual(fit.ownedBy, {id: "legacy-spatial-shader", role: "fit"});
  assert.equal(fit.settings.spatialMultiplier, null);assert.equal(fit.settings.spatialShader, null,
    "the native fit carries no nested Simple shader selection");
  assert.equal(upgraded.renderResolution, undefined, "an intrinsic shader scale alone never lowers the renderer allocation");
  assert.deepEqual(entry, before);
});
test("fixed scaling shader input is reduced only for an explicit Simple source-budget request", t => {
  const entry = {graphics: {spatialShader: {enabled: true, preset: "custom", effectPath: scalingShader(t, {outputScale: {x: 2, y: 2}})}}};
  const options = {graphicsHost: "remote", graphicsInputs: {sourceResolution: false},
    graphicsCapabilities: {spatial: true, spatialMethods: ["bilinear"], resolutionMultipliers: []}};
  const original = StoredPlan.upgradeLegacy(entry, options).effects;
  assert.deepEqual(original.video.map(row => row.id), ["legacy-spatial-shader", "legacy-spatial-fit"]);
  assert.equal(original.renderResolution, undefined);
  const requested = StoredPlan.upgradeLegacy({...entry, graphics: {...entry.graphics, spatialMultiplier: 2}}, options).effects;
  assert.deepEqual(requested.renderResolution, {multiplier: 2});
  assert.equal(requested.video.filter(row => row.kind === "downsample").length, 0,
    "preparation owns the native, virtual or completed-frame fallback decision");
});
