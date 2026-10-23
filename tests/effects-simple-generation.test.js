const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const Policy = require("../src/modules/shared/effects/simple-generation.mjs"), Plan = require("../src/modules/shared/effects/plan"),
  Effects = require("../src/modules/shared/effects/runtime");
const entry = {graphics: {spatialMethod: "bilinear", frameGeneration: "lsfg", frameMultiplier: 4}};

test("Simple candidates retain literal plans and select only the last supported fit scaler", () => {
  const plan = Plan.composeSimple(entry), before = structuredClone(plan), candidate = Plan.simpleGenerationLayout(plan);
  assert.deepEqual(candidate, {generationId: "legacy-frame-generation", spatialNodeId: "legacy-spatial", method: "bilinear", scalerPasses: 1});
  assert.deepEqual(plan, before);
  for (const method of ["ls1", "libplacebo:lanczos", "downsample"])
    assert.equal(Policy.candidate(Plan.composeSimple({...entry, graphics: {...entry.graphics, spatialMethod: method}}).video), null);
  for (const change of [{outputSize: {width: 1280, height: 720}}, {presentationScale: 2}, {settings: {spatialMultiplier: 2}}]) {
    const changed = structuredClone(plan);Object.assign(changed.video[0], change);assert.equal(Policy.candidate(changed.video), null);
  }
  const disabled = structuredClone(plan);disabled.video[1].enabled = false;assert.equal(Policy.candidate(disabled.video), null);
  const suffix = [...plan.video, {id: "scene", kind: "shader", enabled: true, requirements: {depth: true}}];
  assert.equal(Policy.candidate(suffix), null);
});

test("actual extents and delivered scaler passes determine the estimated placement cost", () => {
  const options = {source: {width: 960, height: 540}, output: {width: 3840, height: 2160}, multiplier: 4, method: "fsr1"};
  const baseline = Policy.choose(options);assert.equal(baseline.placement, "output");
  const reduced = Policy.choose({...options, allowSource: true});assert.equal(reduced.placement, "source");
  assert.equal(reduced.work.sourceScaling, 4 * reduced.work.outputScaling, "every real/generated delivery receives the selected scaler");
  assert.equal(reduced.work.sourceGeneration * 16, reduced.work.outputGeneration);
  assert.ok(reduced.work.sourceTotal < reduced.work.outputTotal);
  const lightFlow = Policy.choose({...options, flowScale: .25, allowSource: true});
  assert.ok(lightFlow.work.sourceGeneration < reduced.work.sourceGeneration);
  assert.equal(lightFlow.work.sourceScaling, reduced.work.sourceScaling, "reducing optical flow does not reduce delivered scaler work");
  assert.equal(Policy.choose({source: {width: 1900, height: 1069}, output: {width: 1920, height: 1080}, multiplier: 4,
    method: "fsr1", flowScale: .25, allowSource: true}).placement, "output", "small reductions can cost more when every delivery must scale");
  const large = Policy.choose({...options, source: options.output, allowSource: true});assert.equal(large.placement, "output");
  const mismatch = Policy.choose({...options, source: {width: 960, height: 720}, allowSource: true});assert.equal(mismatch.placement, "output");
  const rounded = Policy.choose({...options, source: {width: 854, height: 480}, output: {width: 2560, height: 1440}, allowSource: true});
  assert.equal(rounded.placement, "source");
  const constrained = Policy.choose({...options, maximumGenerationPixels: 1920 * 1080, allowSource: true});
  assert.equal(constrained.placement, "source");assert.match(constrained.reason, /pixel budget/);
  assert.equal(Policy.choose({...options, maximumGenerationPixels: 100, allowSource: true}).placement, "output");
  for (const invalid of [{source: {width: 0, height: 1}}, {output: {width: Infinity, height: 1}}, {multiplier: 1}, {method: "ls1"}, {flowScale: .1}])
    assert.equal(Policy.choose({...options, ...invalid, allowSource: true}).placement, "output");
});

function fixture(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "simple-generation-")));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const root = path.join(directory, "runtime"), userDataDir = path.join(directory, "profile"), version = "sha256-" + "a".repeat(64);
  fs.mkdirSync(root);fs.writeFileSync(path.join(root, "libreshade-macos.dylib"), "fixture");fs.writeFileSync(path.join(root, "fx-compile"), "fixture");
  const record = {schema: 1, version: "test", minimumMacOS: "13.0", features: {shaders: {formats: ["fx"]}, graphics: {
    effectPlanAPI: 1, spatialMethods: ["bilinear", "fsr1"], frameGenerationMethods: ["lsfg"],
    presentation: {hosts: {window: {spatial: true, frameGeneration: true}}}}}};
  const save = () => fs.writeFileSync(path.join(root, "runtime.json"), JSON.stringify(record));save();
  const Models = require("../src/modules/shared/reshade/models");
  t.mock.method(Models, "listInstalled", () => [{version, inspection: {capabilities: {lsfgFp16Quality: {compatible: true}}}}]);
  t.mock.method(Models, "resolveModel", async () => ({modelPath: path.join(directory, "Lossless.dll")}));
  const selected = {gameId: "simple-placement", effects: Plan.composeSimple({...entry, graphics: {...entry.graphics, modelVersion: version}})};
  return {selected, record, save, options: {root, userDataDir, graphicsHost: "window", graphicsArchitecture: "arm64", platform: "darwin", macOSVersion: "27.0",
    verify: () => true, execute: () => assert.fail("this graph contains no shader")}};
}

test("compiled Simple hints are feature/qualification gated and never change saved Advanced order", async t => {
  const f = fixture(t), before = structuredClone(f.selected);
  const prepare = options => Effects.prepare(f.selected, {...f.options, automaticSimple: true, ...options});
  const none = await prepare({});assert.equal(none.generationPlacement, undefined);
  assert.equal(none.document.nodes[1].settings.simpleGenerationPlacement, undefined);
  const old = await prepare({simpleGenerationPlacement: Policy.SOURCE_POLICY});assert.equal(old.generationPlacement, undefined);
  f.record.features.graphics.simpleGenerationPlacementAPI = 1;f.save();
  const unqualified = await prepare({});assert.equal(unqualified.generationPlacement, undefined);
  const candidate = await prepare({simpleGenerationPlacement: Policy.SOURCE_POLICY});
  assert.equal(candidate.generationPlacement.spatialNodeId, "legacy-spatial");
  assert.equal(candidate.document.nodes[1].settings.simpleGenerationPlacement, Policy.SOURCE_POLICY);
  assert.equal(candidate.document.nodes[1].settings.simpleSpatialNodeId, "legacy-spatial");
  assert.deepEqual(candidate.document.nodes.map(node => node.id), none.document.nodes.map(node => node.id), "the native owner selects from actual frame extents");
  assert.notEqual(candidate.document.revision, none.document.revision, "the execution hint is part of the immutable compiled identity");
  f.record.features.graphics.simpleGenerationPlacementQualified = true;f.save();
  assert.ok((await prepare({})).generationPlacement);
  const advanced = await Effects.prepare(f.selected, {...f.options, simpleGenerationPlacement: Policy.SOURCE_POLICY});
  assert.equal(advanced.generationPlacement, undefined);assert.deepEqual(advanced.plan, f.selected.effects);
  assert.equal(advanced.document.nodes[1].settings.simpleGenerationPlacement, undefined);
  assert.deepEqual(f.selected, before);
});

test("unavailable projected stages cannot leave a Simple generation-placement hint", async t => {
  const f = fixture(t);f.record.features.graphics.simpleGenerationPlacementAPI = 1;f.record.features.graphics.simpleGenerationPlacementQualified = true;
  f.record.features.graphics.frameGenerationMethods = [];f.save();
  const result = await Effects.prepare(f.selected, {...f.options, automaticSimple: true, fallback: true, fallbackPolicy: "simple"});
  assert.equal(result.generationPlacement, undefined);assert.equal(result.document.nodes.some(node => node.settings?.simpleGenerationPlacement), false);
  assert.equal(result.document.nodes.find(node => node.kind === "frame-generation").enabled, false);
});
