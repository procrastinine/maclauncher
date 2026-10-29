const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const Effects = require("../src/modules/shared/effects/runtime"), ReShade = require("../src/modules/shared/reshade");
const StoredPlan = require("../src/modules/shared/effects/stored-plan");
const Sandbox = require("../src/modules/shared/runtime/macos-sandbox");
test('canonical missing models preserve the desired row and independent effects while owned sizing remains pending',async t=>{
 const f=fixture(t),Neural=require('../src/modules/shared/reshade/neural');t.mock.method(Neural,'listModels',()=>[]);
 const entry={...f.entry,effects:{schema:2,mode:'advanced',enabled:true,renderResolution:{multiplier:2,managedBy:'nr'},video:[
  {id:'auto-nr-input-nr',kind:'downsample',method:'bilinear',enabled:true,settings:{},extent:{relativeTo:'presentation',automatic:true},ownedBy:{id:'nr',role:'input'}},
  {id:'nr',kind:'neural',method:'mlx-dlss',enabled:true,settings:{modelPath:null,intensity:1,temporal:false}},
  {id:'auto-nr-fit-nr',kind:'upscale',method:'bilinear',enabled:true,settings:{},ownedBy:{id:'nr',role:'fit'}},...f.entry.effects.video]}},before=structuredClone(entry);
 const result=await Effects.prepare(entry,{...f.options,ensureNeuralModel:()=>assert.fail('editing does not download')});
 assert.equal(result.plan.video.find(node=>node.id==='nr').enabled,true);assert.equal(result.plan.video.find(node=>node.id==='nr').settings.modelPath,null);assert.equal(result.plan.renderResolution.managedBy,'nr');assert.deepEqual(result.preparationStatus.pending.map(node=>node.id).sort(),['auto-nr-fit-nr','auto-nr-input-nr','nr']);
 for(const row of result.preparationStatus.pending)assert.equal(row.requestKey,require('../src/modules/shared/effects/live-plan').selectionKey(result.plan.video.find(node=>node.id===row.id)));
 assert.deepEqual(result.document.nodes.filter(node=>node.enabled).map(node=>node.id),['tone','scale','sharp']);assert.equal(result.preparationStatus.sourceResolution.requested,null);assert.deepEqual(entry,before);
});
test("legacy neural editor conversion keeps fixed pixels across current, stale and absent source receipts", t => {
  const f = fixture(t), Controls = require("../src/modules/shared/reshade/source-controls"), Neural = require("../src/modules/shared/reshade/neural");
  t.mock.method(Neural, "resolve", () => ({library: "/Neural.dylib"}));
  const entry = {...f.entry, effects: undefined, reshade: {enabled: false},
    graphics: {neuralMethod: "mlx-dlss", neuralModelPath: "/Models/Local.dlssmodel"}};
  const support = {control: "virtual", live: true, activationAPI: 1, heights: true, multipliers: [1, 2, 3]};
  const {binding} = Controls.prepare(entry, {userDataDir: f.userDataDir, support, launchId: "fixed-draft", source: {height: 540}});
  const command = JSON.parse(fs.readFileSync(binding.file, "utf8"));
  const launchFile = path.join(path.dirname(binding.file), "launch.json");
  fs.writeFileSync(launchFile, JSON.stringify({schema: 1, phase: "spawned", launchId: binding.launchId, pid: 71,
    effectPlanAPI: 1, effectPlanNeuralModels: [entry.graphics.neuralModelPath], effectPlanNeuralLibrary: "/Neural.dylib", sourceControl: binding}));
  const options = {...f.options, running: true, runningPids: [71]};
  const acknowledge = (width, height, outputWidth, outputHeight, changed = {}) => fs.writeFileSync(binding.statusFile, JSON.stringify({
    schema: 1, launchId: binding.launchId, control: binding.control, epoch: command.epoch, revision: command.revision,
    requested: command.source, applied: {width, height, outputWidth, outputHeight, virtual: true}, observed: {width, height}, reason: "", ...changed}));
  const completed = Controls.completed;
  let reads = 0;
  t.mock.method(Controls, "completed", (...args) => {reads++;return completed(...args);});
  const row = (selected = entry, context = options) => Effects.info(selected, context).plan.video.find(row => row.id === "legacy-neural-input");
  const fixed={height:540};
  acknowledge(960, 540, 3840, 2160);
  assert.deepEqual(row().extent,fixed);assert.equal(row().kind,"downsample");
  acknowledge(854, 480, 2560, 1440);
  assert.deepEqual(row().extent,fixed);
  acknowledge(1000, 563, 1000, 1400);
  assert.deepEqual(row().extent,fixed,"letterboxed and Retina output cannot change the fixed processing height");
  for (const changed of [{epoch: command.epoch + 1}, {revision: "0".repeat(64)}, {launchId: "another-launch"}, {reason: "Waiting for a completed image."}]) {
    acknowledge(960, 540, 3840, 2160, changed);assert.deepEqual(row().extent,fixed);
  }
  fs.unlinkSync(binding.statusFile);assert.deepEqual(row().extent,fixed);
  acknowledge(960, 540, 3840, 2160);
  reads = 0;
  assert.deepEqual(row(entry, {...options, runningPids: [72]}).extent,fixed);
  assert.deepEqual(row({...entry,graphics:{...entry.graphics,neuralInputScale:.5}}).extent,{relativeTo:"presentation",factor:.5});
  assert.deepEqual(row(entry,{...options,running:false}).extent,fixed);
  const migrated=Effects.info(entry,options).plan;assert.deepEqual(Effects.info({...entry,effects:migrated},options).plan.video[0].extent,fixed);
  assert.equal(row(entry,{...options,graphicsInputs:{nativeVideo:true}}),undefined);
  assert.equal(reads,0,"editor conversion never materializes a saved scale from frame receipts");
});
test("legacy adaptive sizing hints cannot replace explicit factor or pixel sizing", async t => {
  const f = fixture(t), row = {id: "legacy-neural-input", kind: "spatial", enabled: true, method: "downsample", presentationScale: .5, settings: {spatialMultiplier: null}};
  const entry = {...f.entry, effects: {...f.entry.effects, video: [row]}}, before = structuredClone(entry);
  const manual = await Effects.prepare(entry, f.options);assert.equal(manual.document.nodes[0].resolutionAuto, undefined);
  const automatic = await Effects.prepare(entry, {...f.options, automaticResolutionNode: row.id});
  assert.equal(automatic.document.nodes[0].resolutionAuto, undefined);assert.equal(automatic.document.nodes[0].presentationScale, .5);
  const height = {...entry, effects: {...entry.effects, video: [{...row, presentationScale: undefined, outputSize: {height: 480}}]}};
  const adaptiveHeight = await Effects.prepare(height, {...f.options, automaticResolutionNode: row.id});
  assert.equal(adaptiveHeight.document.nodes[0].resolutionAuto, undefined);assert.deepEqual(adaptiveHeight.document.nodes[0].outputSize, {height: 480});
  assert.deepEqual((await Effects.prepare(height, f.options)).document.nodes[0].outputSize, {height: 480});
  assert.deepEqual(entry, before);
});
test("legacy neural defaults bind fixed 540p to a compatible source without adaptive sizing", async t => {
  const f = fixture(t), Neural = require("../src/modules/shared/reshade/neural"), model = path.join(f.temporary, "Local.dlssmodel");
  fs.writeFileSync(model, "model");
  t.mock.method(Neural, "listModels", () => [{version: "local", method: "mlx-dlss", modelPath: model, intrinsicScale: 1}]);
  t.mock.method(Neural, "modelScale", (file, method) => {assert.equal(file, model);assert.equal(method, "mlx-dlss");return 1;});
  t.mock.method(Neural, "resolve", () => ({library: "/Neural.dylib"}));
  t.mock.method(Neural, "prepare", settings => ({settings, environment: {RESHADE_NEURAL_LIBRARY: "/Neural.dylib"}}));
  Object.assign(f.record.features.graphics, {virtualWindowAPI: 1, virtualSourceControlAPI: 1, virtualSourceActivationAPI: 1, virtualSourceAutoAPI: 1});
  fs.writeFileSync(path.join(f.root, "runtime.json"), JSON.stringify(f.record));
  const entry = {...f.entry, effects: undefined, reshade: {enabled: false},
    graphics: {neuralMethod: "mlx-dlss", neuralModelPath: model, spatialMethod: "bilinear"}};
  const options = {...f.options, graphicsInputs: {}};
  const environment = await ReShade.prepare(entry, options);
  assert.equal(environment.RESHADE_RENDER_AUTO, undefined);assert.equal(environment.RESHADE_RENDER_MULTIPLIER, undefined);
  assert.equal(environment.RESHADE_RENDER_HEIGHT, "540");assert.equal(environment.RESHADE_RENDER_SOURCE_CONTROL, "virtual");
  const launch = JSON.parse(fs.readFileSync(path.join(path.dirname(environment.RESHADE_EFFECT_PLAN), "launch.json")));
  assert.deepEqual(JSON.parse(fs.readFileSync(launch.sourceControl.file)).source, {height:540});
  assert.deepEqual(launch.graphicsPreparation.sourceResolution.requested, {height:540});
  assert.equal(launch.sourceControl.support.heights, true);
  const document = JSON.parse(fs.readFileSync(environment.RESHADE_EFFECT_PLAN));
  assert.equal(document.nodes.filter(node => node.resolutionAuto).length, 0);
  assert.deepEqual(document.nodes[0].outputSize,{height:540});
  assert.deepEqual(document.nodes.map(node => node.kind), ["spatial", "neural", "spatial"]);
  const upgraded = StoredPlan.upgradeLegacy(entry, options).effects;
  assert.deepEqual(upgraded.renderResolution,{height:540});assert.deepEqual(upgraded.video[0].extent,{height:540});
  assert.doesNotThrow(() => require("../src/modules/shared/effects/plan").validate(upgraded));
  const explicit = StoredPlan.upgradeLegacy({...entry,graphics:{...entry.graphics,neuralInputHeight:480}},options).effects;
  assert.deepEqual(explicit.video[0].extent,{height:480});assert.deepEqual(explicit.renderResolution,{height:480});
  delete f.record.features.graphics.virtualSourceAutoAPI;
  fs.writeFileSync(path.join(f.root, "runtime.json"), JSON.stringify(f.record));
  const fallback = await ReShade.prepare(entry, options), fallbackLaunch = JSON.parse(fs.readFileSync(path.join(path.dirname(fallback.RESHADE_EFFECT_PLAN), "launch.json")));
  assert.equal(fallback.RESHADE_RENDER_AUTO, undefined);
  assert.equal(fallbackLaunch.graphicsPreparation.sourceResolution.strategy, "virtual", "fixed heights work without an adaptive-resolution API");
  assert.equal(JSON.parse(fs.readFileSync(fallback.RESHADE_EFFECT_PLAN)).nodes.filter(node => node.resolutionAuto).length, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(fallbackLaunch.sourceControl.file)).source,{height:540});
});
test("automatic source allocation disappears with unavailable reconstruction and stays out of video defaults", async t => {
  const f = fixture(t), entry = {...f.entry, effects: undefined, reshade: {enabled: false},
    graphics: {neuralMethod: "mlx-dlss", spatialMethod: "bilinear"}};
  Object.assign(f.record.features.graphics, {virtualWindowAPI: 1, virtualSourceControlAPI: 1, virtualSourceActivationAPI: 1, virtualSourceAutoAPI: 1});
  fs.writeFileSync(path.join(f.root, "runtime.json"), JSON.stringify(f.record));
  const environment = await ReShade.prepare(entry, {...f.options, graphicsInputs: {}});
  assert.equal(environment.RESHADE_RENDER_AUTO, undefined);
  assert.equal(JSON.parse(fs.readFileSync(environment.RESHADE_EFFECT_PLAN)).nodes.some(node => node.resolutionAuto), false);
});
test("ordered CRT preparation discovers only selected components and preserves actual compiler validation", async t => {
  const f = fixture(t), unrelated = [];
  const forbid = (object, name) => t.mock.method(object, name, () => { unrelated.push(name);throw new Error("Unselected discovery: " + name); });
  forbid(ReShade, "getState");
  for (const [module, methods] of [
    ["filter-library", ["list"]], ["shader-packs", ["listEffects"]], ["managed-shaders", ["listEffects", "listInstalled"]],
    ["models", ["listInstalled"]], ["neural", ["resolve", "listModels"]], ["temporal/fsr", ["resolve"]], ["temporal/fsr4", ["resolve"]]
  ]) for (const method of methods) forbid(require("../src/modules/shared/reshade/" + module), method);
  f.record.features.graphics.temporalMethods = ["fsr2", "fsr3", "fsr4"];
  fs.mkdirSync(path.join(f.root, "libplacebo"));
  fs.writeFileSync(path.join(f.root, "libplacebo/provider.json"), JSON.stringify({filters: [{name: "lanczos"}]}));
  fs.writeFileSync(path.join(f.root, "runtime.json"), JSON.stringify(f.record));
  fs.writeFileSync(path.join(f.root, "effects/crt.fx"), "fixture");
  f.entry.effects.video = [
    {id: "crt", kind: "shader", enabled: true, shader: {preset: "crt"}},
    {id: "unused-model", kind: "spatial", enabled: false, method: "ls1", settings: {}},
    {id: "unused-neural", kind: "neural", enabled: false, method: "mlx-dlss", settings: {modelPath: null}}
  ];
  const result = await Effects.prepare(f.entry, f.options);
  assert.deepEqual(unrelated, []);
  assert.equal(result.document.nodes[0].format, "fx");
  assert.equal(fs.readFileSync(result.document.nodes[0].file, "utf8"), "fixture");
  assert.equal(f.calls.length, 2, "selected CRT uses the injected compiler and its metadata dump");
  assert.deepEqual(result.document.nodes.slice(1).map(node => node.enabled), [false, false]);
});
test("ordered preparation inventories the module-routed entry rather than native renderer rows", async t => {
  const f = fixture(t), Neural = require("../src/modules/shared/reshade/neural"), Models = require("../src/modules/shared/reshade/models");
  t.mock.method(ReShade, "getState", () => { throw new Error("Full catalog must remain in the editor"); });
  t.mock.method(Neural, "resolve", () => { throw new Error("Native renderer already owns this row"); });
  t.mock.method(Models, "listInstalled", () => { throw new Error("Native renderer already owns this row"); });
  const shared = f.entry.effects.video;
  f.entry.effects.video = [
    {id: "native-model", kind: "spatial", enabled: true, method: "ls1", settings: {}},
    {id: "native-neural", kind: "neural", enabled: true, method: "mlx-dlss", settings: {modelPath: null}}, ...shared
  ];
  const result = await Effects.prepare(f.entry, {...f.options, prepareEffectsEntry: async entry => ({...entry, effects: {...entry.effects, video: shared}})});
  assert.deepEqual(result.document.nodes.map(node => node.id), shared.map(node => node.id));
  assert.deepEqual(result.plan.video.map(node => node.id), f.entry.effects.video.map(node => node.id));
  assert.deepEqual(result.appliedPlan.video.map(node => node.id), shared.map(node => node.id), "launch metadata uses the applied shared plan while the editor retains routed native rows");
});
test("a row the module renderer bypasses is reported with its reason while the other rows run", async t => {
  const f = fixture(t), shared = f.entry.effects.video, reason = "The selected shader is missing.";
  f.entry.effects.video = [{id: "native-missing", kind: "shader", enabled: true, shader: {enabled: true, preset: "custom", effectPath: "/missing.hook"}}, ...shared];
  const result = await Effects.prepare(f.entry, {...f.options,
    prepareEffectsEntry: async entry => ({...entry, effects: {...entry.effects, video: shared}, effectsSkipped: [{id: "native-missing", reason}]})});
  assert.deepEqual(result.document.nodes.map(node => node.id), shared.map(node => node.id));
  assert.deepEqual(result.preparationStatus.skipped.filter(row => row.id === "native-missing").map(row => row.reason), [reason]);
});
test("custom rows validate their own provider without disabling independent custom shaders", async t => {
  const f = fixture(t), warnings = [], hook = path.join(f.temporary, "missing-provider.hook"), fx = path.join(f.temporary, "working.fx");
  fs.writeFileSync(hook, "//!HOOK MAIN\nvec4 hook(){return vec4(1);}");fs.writeFileSync(fx, "fixture");
  f.entry.effects.video = [hook, fx].map((effectPath, index) => ({id: "custom-" + index, kind: "shader", enabled: true,
    shader: {preset: "custom", effectPath}}));
  const result = await Effects.prepare(f.entry, {...f.options, fallback: true, logger: {warn: message => warnings.push(message)}});
  assert.deepEqual(result.document.nodes.map(node => node.enabled), [false, true]);
  assert.equal(result.document.nodes[1].format, "fx");
  assert.match(warnings[0], /libplacebo provider is unavailable/);
  assert.equal(f.calls.length, 2, "working FX still uses normal preparation after the unavailable provider");
});
test("prepared native color filters retain their exact coordinate contract beside other custom files", async t => {
  const f = fixture(t), filter = path.join(f.temporary, "Exposure.mclfilter"), depth = path.join(f.temporary, "Depth.fx");
  fs.writeFileSync(filter, JSON.stringify({schema: 1, method: "histogram-exposure"}));
  fs.writeFileSync(depth, "//!INPUT_POLICY source\nneed-depth");
  f.record.features.shaders.formats.push("native");
  f.record.features.shaders.providers = {native: {methods: ["histogram-exposure"]}};
  f.record.features.graphics.shaderInputPolicyAPI = 1;
  fs.writeFileSync(path.join(f.root, "runtime.json"), JSON.stringify(f.record));
  f.entry.effects.video = [filter, depth].map((effectPath, index) => ({id: "custom-" + index,
    kind: "shader", enabled: true, shader: {preset: "custom", effectPath}}));
  const execute = f.options.execute;
  const result = await Effects.prepare(f.entry, {...f.options, execute: async (command, args, options) => {
    await execute(command, args, options);
    if (args[0] !== "--prepare") fs.writeFileSync(path.join(args[1], "requirements.json"), JSON.stringify({depth: true, motion: false}));
  }});
  assert.equal(result.document.nodes[0].preservesCoordinates, true);
  assert.equal(result.document.nodes[0].inputPolicy, "source");
  assert.equal(result.document.nodes[1].preservesCoordinates, false, "a shared custom ID never transfers another file's identity transform");
  assert.equal(result.document.nodes[1].inputPolicy, "source");
  assert.equal(result.document.nodes[1].requirements.depth, true);
  assert.equal(ReShade.resolveShaderSelection({reshade: {enabled: true, preset: "custom", effectPath: depth}}, f.options).traits.inputPolicy, "source");
  delete f.record.features.graphics.shaderInputPolicyAPI;
  fs.writeFileSync(path.join(f.root, "runtime.json"), JSON.stringify(f.record));
  const older = await Effects.prepare(f.entry, f.options);
  assert.ok(older.document.nodes.every(node => !Object.hasOwn(node, "inputPolicy")), "older strict parsers receive no unsupported policy field");
});
test("the game's depth input reaches the .fx compiler and recompiles only rows that read depth", async t => {
  const f = fixture(t), depth = path.join(f.temporary, "Depth.fx"), color = path.join(f.temporary, "Color.fx");
  fs.writeFileSync(depth, "need-depth");fs.writeFileSync(color, "color only");
  f.entry.effects = {schema: 2, mode: "advanced", enabled: true, video: [depth, color].map((effectPath, index) => ({id: "custom-" + index,
    kind: "shader", enabled: true, shader: {preset: "custom", effectPath}}))};
  let prepared = [];
  const options = {...f.options, execute: async (command, args, options) => {
    await f.options.execute(command, args, options);
    if (args[0] === "--prepare") prepared.push([fs.readFileSync(args[1], "utf8"),
      Object.fromEntries(Object.entries(options.env).filter(([name]) => name.startsWith("RESHADE_DEPTH_")))]);
    else fs.writeFileSync(path.join(args[1], "requirements.json"), JSON.stringify({depth: fs.readFileSync(args[0], "utf8").includes("depth"), motion: false}));
  }};
  const first = await Effects.prepare(f.entry, options);
  assert.deepEqual(prepared, [["need-depth", {RESHADE_DEPTH_INPUT_IS_REVERSED: "0"}], ["color only", {RESHADE_DEPTH_INPUT_IS_REVERSED: "0"}]]);
  prepared = [];
  f.entry.effects = {...f.entry.effects, depthInput: {reversed: true, farPlane: 300}};
  const reversed = await Effects.prepare(f.entry, options);
  assert.deepEqual(prepared, [["need-depth", {RESHADE_DEPTH_INPUT_IS_REVERSED: "1", RESHADE_DEPTH_LINEARIZATION_FAR_PLANE: "300.0"}]], "the color-only row keeps its compiled revision");
  assert.notEqual(reversed.document.nodes[0].revision, first.document.nodes[0].revision);
  assert.equal(reversed.document.nodes[1].revision, first.document.nodes[1].revision);
  prepared = [];
  await Effects.prepare(f.entry, options);
  assert.deepEqual(prepared, [], "an unchanged depth input reuses both revisions");
});
test("ordinary Advanced launch preserves requested settings and reports unavailable stages while retaining independent effects", async t => {
  const f=fixture(t),warnings=[];
  f.entry.effects.video[0]={id:"selected",kind:"neural",enabled:true,method:"mlx-dlss",settings:{modelPath:null}};
  const selected=structuredClone(f.entry);
  const environment=await ReShade.prepare(f.entry,{...f.options,logger:{warn:message=>warnings.push(message)}});
  const document=JSON.parse(fs.readFileSync(environment.RESHADE_EFFECT_PLAN));
  assert.deepEqual(document.nodes.map(node=>node.enabled),[false,true,true,false]);
  assert.deepEqual(f.entry,selected);
  const launch=JSON.parse(fs.readFileSync(path.join(path.dirname(environment.RESHADE_EFFECT_PLAN),"launch.json")));
  assert.equal(launch.graphicsPreparation.requested[0].method,"mlx-dlss");
  assert.equal(launch.graphicsPreparation.applied.some(node=>node.id==="selected"),false);
  assert.deepEqual(launch.graphicsPreparation.pending.map(row=>row.id),["selected"]);
  assert.match(launch.graphicsPreparation.pending[0].reason,/compatible model is needed/);
  assert.deepEqual(launch.graphicsWarnings,[]);assert.deepEqual(warnings,[]);
});
test("upgraded Simple retains valid shader and scaler while reporting unavailable optional reconstruction", async t => {
  const f = fixture(t), entry = {...f.entry, effects: undefined,
    graphics: {neuralMethod: "mlx-dlss", neuralModelPath: null, spatialMethod: "bilinear"}};
  const environment = await ReShade.prepare(entry, f.options), document = JSON.parse(fs.readFileSync(environment.RESHADE_EFFECT_PLAN));
  assert.deepEqual(document.nodes.map(node => [node.id, node.enabled]),
    [["legacy-neural-input", false], ["legacy-neural", false], ["legacy-spatial", true], ["legacy-shader", true]]);
  const launch = JSON.parse(fs.readFileSync(path.join(path.dirname(environment.RESHADE_EFFECT_PLAN), "launch.json")));
  assert.deepEqual(launch.graphicsPreparation.applied.map(node => node.kind), ["spatial", "shader"]);
  assert.deepEqual(launch.graphicsPreparation.pending.map(node => node.id), ["legacy-neural", "legacy-neural-input"]);
  assert.deepEqual(launch.graphicsWarnings, []);
  assert.equal(launch.graphicsPreparation.sourceResolution.applied, null);
  assert.equal(launch.effectPlanRevision, require("../src/modules/shared/effects/stored-plan").read(entry, f.options).revision,
    "the launch records the saved plan revision it prepared");
  assert.equal(entry.graphics.neuralMethod, "mlx-dlss");assert.equal(entry.effects, undefined);
});
test("upgraded Simple bypasses failed shaders and incompatible stages while retaining independent effects", async t => {
  const f = fixture(t), working = await Effects.prepare(f.entry, f.options), before = fs.readFileSync(working.file);
  const entry = {...f.entry, effects: undefined, graphics: {spatialMethod: "bilinear", neuralMethod: "mlx-dlss"},
    reshade: {enabled: true, preset: "custom", effectPath: "/missing.fx"}};
  const missing = await ReShade.prepare(entry, f.options), partial = JSON.parse(fs.readFileSync(missing.RESHADE_EFFECT_PLAN));
  assert.equal(partial.nodes.find(node => node.kind === "shader").enabled, false);
  assert.equal(partial.nodes.find(node => node.method === "bilinear").enabled, true);
  assert.match(StoredPlan.upgradeLegacy(entry, f.options).effectsNotices.find(notice => notice.rowId === "legacy-shader").message, /missing or unreadable/);
  assert.notDeepEqual(fs.readFileSync(working.file), before, "the compatible remainder replaces the old chain");
  const source = path.join(f.root, "Depth.fx");fs.writeFileSync(source, "fixture");
  f.record.features.graphics.temporalMethods = ["metalfx"];f.record.features.graphics.presentation.hosts.window.temporal = true;
  fs.writeFileSync(path.join(f.root, "runtime.json"), JSON.stringify(f.record));
  const execute = f.options.execute;
  const incompatible = await ReShade.prepare({...entry, graphics: {temporalMethod: "metalfx", spatialMethod: "bilinear"},
    reshade: {...entry.reshade, effectPath: source}}, {...f.options,
    graphicsInputs: {...f.options.graphicsInputs, depth: true, motionVectors: true, methods: ["metalfx"]},
    execute: async (...args) => {
      const result = await execute(...args);
      if (args[1][0] !== "--prepare") fs.writeFileSync(path.join(args[1][1], "requirements.json"), JSON.stringify({depth: true, motion: false}));
      return result;
    }});
  // The upgraded order is literal: a scene shader after scaling is bypassed and the temporal stage stays.
  const remainder = JSON.parse(fs.readFileSync(incompatible.RESHADE_EFFECT_PLAN));
  assert.equal(remainder.nodes.find(node => node.kind === "temporal").enabled, true);
  assert.equal(remainder.nodes.find(node => node.kind === "shader").enabled, false);
  assert.equal(remainder.nodes.find(node => node.method === "bilinear").enabled, true);
  const conflictLaunch = JSON.parse(fs.readFileSync(path.join(path.dirname(incompatible.RESHADE_EFFECT_PLAN), "launch.json")));
  assert.ok(conflictLaunch.graphicsWarnings.some(node => node.kind === "shader" && /matching coordinates/.test(node.reason)));
});
test("Simple CRT survives unavailable frame generation and a failed shader leaves a working scaler", async t => {
  const f = fixture(t);fs.writeFileSync(path.join(f.root, "effects/crt.fx"), "fixture");
  const entry = {...f.entry, effects: undefined, reshade: {enabled: true, preset: "crt"}, graphics: {frameGeneration: "lsfg"}};
  const environment = await ReShade.prepare(entry, f.options), document = JSON.parse(fs.readFileSync(environment.RESHADE_EFFECT_PLAN));
  assert.equal(document.nodes.find(node => node.kind === "frame-generation").enabled, false);
  assert.equal(document.nodes.find(node => node.kind === "shader").enabled, true);
  assert.equal(entry.graphics.frameGeneration, "lsfg", "saved preferences survive a launch-time failure");
  assert.equal(entry.reshade.enabled, true);
  const failedShader = {...entry, reshade: {enabled: true, preset: "custom", effectPath: "/missing.fx"}, graphics: {spatialMethod: "bilinear"}};
  const other = await ReShade.prepare(failedShader, f.options), otherDocument = JSON.parse(fs.readFileSync(other.RESHADE_EFFECT_PLAN));
  assert.equal(otherDocument.nodes.find(node => node.kind === "shader").enabled, false);
  assert.equal(otherDocument.nodes.find(node => node.kind === "spatial").enabled, true);
  const temporal = await ReShade.prepare({...entry, reshade: {enabled: false}, graphics: {temporalMethod: "fsr2", spatialMethod: "bilinear"}}, f.options);
  const temporalDocument = JSON.parse(fs.readFileSync(temporal.RESHADE_EFFECT_PLAN));
  assert.equal(temporalDocument.nodes.find(node => node.kind === "temporal").enabled, false);
  assert.equal(temporalDocument.nodes.find(node => node.kind === "spatial").enabled, true,
    "a failed renderer-native temporal stage cannot disable an independent spatial stage");
});
test("advanced stage scale does not require producer allocation support and publishes actual pixel outputs", async t => {
  const f = fixture(t);
  delete f.record.features.graphics.presentation.hosts.window.resolutionMultipliers;
  fs.writeFileSync(path.join(f.root, "runtime.json"), JSON.stringify(f.record));
  f.entry.effects = {schema: 1, mode: "advanced", renderResolution: {height: 480}, video: [
    {id: "small", kind: "spatial", enabled: true, method: "downsample", settings: {spatialMultiplier: .5}, outputSize: {width: 854, height: 480}},
    {id: "fit", kind: "spatial", enabled: true, method: "bilinear", settings: {spatialMultiplier: 2}}
  ]};
  const result = await Effects.prepare(f.entry, f.options);
  assert.equal(result.environment.RESHADE_RENDER_HEIGHT, "480"); assert.equal(result.environment.RESHADE_RESOLUTION_MULTIPLIER, undefined);
  assert.deepEqual(result.document.nodes[0].outputSize, {width: 854, height: 480});
  assert.equal(result.document.nodes[0].settings.spatialMultiplier, .5); assert.equal(result.document.nodes[1].settings.spatialMultiplier, 2);
  fs.writeFileSync(path.join(path.dirname(result.file), "launch.json"), JSON.stringify({effectPlanAPI: 1, effectPlanRenderResolution: {height: 480}}));
  const live = await Effects.prepare({...f.entry, effects: {...f.entry.effects, renderResolution: {height: 720}}}, {...f.options, live: true});
  assert.deepEqual(live.document.nodes[0].outputSize, {height: 720});
  assert.equal(live.preparationStatus.sourceResolution.strategy, "processing");
  assert.deepEqual(live.appliedPlan.renderResolution, {height: 480});
  const deferred = await Effects.prepare({...f.entry, effects: {...f.entry.effects, renderResolution: {height: 720}}}, {...f.options, live: true, deferRenderResolution: true});
  assert.deepEqual(deferred.plan.renderResolution, {height: 720});
  assert.deepEqual(deferred.appliedPlan.renderResolution, {height: 480});
  assert.deepEqual(deferred.preparationStatus.sourceResolution.requested, {height: 720});
  assert.deepEqual(deferred.preparationStatus.sourceResolution.applied, {height: 480});
  assert.equal(deferred.preparationStatus.sourceResolution.strategy, "processing");
  assert.equal(deferred.environment.RESHADE_RENDER_HEIGHT, undefined);
  assert.equal(deferred.environment.RESHADE_RESOLUTION_MULTIPLIER, undefined);
});
test("source control follows native renderer capability while unsupported requests retain remaining stages", async t => {
  const f = fixture(t), warnings = [];
  f.record.features.graphics.presentation.hosts.explicit = {spatial: true, resolutionMultipliers: [1, 1.5, 2]};
  f.record.features.graphics.presentation.hosts.remote = {spatial: true};
  fs.writeFileSync(path.join(f.root, "runtime.json"), JSON.stringify(f.record));
  f.entry.effects.renderResolution = {multiplier: 2};
  const explicit = {...f.options, graphicsHost: "explicit"};
  assert.deepEqual(Effects.info(f.entry, explicit).sourceResolution, {heights: false, multipliers: [1, 1.5, 2], processing: true});
  const prepared = await Effects.prepare(f.entry, explicit);
  assert.equal(prepared.environment.RESHADE_RESOLUTION_MULTIPLIER, "2");
  assert.equal(prepared.environment.RESHADE_RENDER_MULTIPLIER, undefined);
  assert.deepEqual(prepared.appliedPlan.renderResolution, {multiplier: 2});
  const remote = {...f.options, graphicsHost: "remote", logger: {warn: message => warnings.push(message)}};
  assert.deepEqual(Effects.info(f.entry, remote).sourceResolution, {heights: false, multipliers: [], processing: true});
  const fallback = await Effects.prepare(f.entry, remote);
  assert.equal(fallback.document.nodes.filter(row => row.enabled).length, 4);
  assert.equal(fallback.document.nodes[0].method, "downsample");assert.equal(fallback.document.nodes[0].presentationScale, .5);
  assert.equal(fallback.preparationStatus.sourceResolution.strategy, "processing");
  assert.equal(fallback.environment.RESHADE_RENDER_MULTIPLIER, undefined);assert.equal(warnings.length, 1);
  assert.deepEqual(fallback.plan.renderResolution, {multiplier: 2});assert.equal(fallback.appliedPlan.renderResolution, undefined);
  const height = await Effects.prepare({...f.entry, effects: {...f.entry.effects, renderResolution: {height: 480, maximum: true}}}, remote);
  assert.deepEqual(height.plan.renderResolution, {height: 480, maximum: true});assert.equal(height.appliedPlan.renderResolution, undefined);
  assert.deepEqual(height.document.nodes[0].outputSize, {height: 480});
  assert.equal(height.environment.RESHADE_RENDER_MAX_HEIGHT, undefined);
  assert.deepEqual(Effects.info(f.entry, {...f.options, graphicsInputs: {nativeVideo: true}}).sourceResolution, {heights: false, multipliers: [], processing: true});
});
test("source filters are renderer declared and unavailable launch selections keep working stages", async t => {
  const f = fixture(t), warnings = [];
  f.options.graphicsInputs.sourceResolution.methods = ["fsr1", "metalfx"];
  f.options.graphicsInputs.sourceResolution.methodLabels = {fsr1: "FSR 1"};
  f.entry.effects.renderResolution = {multiplier: 2, method: "fsr1"};
  const info = Effects.info(f.entry, f.options);
  assert.deepEqual(info.sourceResolution.methods, ["fsr1", "metalfx"]);
  assert.deepEqual(info.sourceResolution.methodLabels, {fsr1: "FSR 1"});
  const result = await Effects.prepare(f.entry, f.options);
  assert.equal(result.environment.RESHADE_RENDER_SOURCE_METHOD, "fsr1");
  assert.equal(result.environment.RESHADE_RENDER_MULTIPLIER, "2");
  assert.deepEqual(result.appliedPlan.renderResolution, {multiplier: 2, method: "fsr1"});
  const working = fs.readFileSync(result.file);
  f.entry.effects.renderResolution.method = "missing";
  await assert.rejects(Effects.prepare(f.entry, f.options), /selected source filter/);
  assert.deepEqual(fs.readFileSync(result.file), working);
  const fallback = await Effects.prepare(f.entry, {...f.options, fallback: true, logger: {warn: message => warnings.push(message)}});
  assert.equal(fallback.environment.RESHADE_RENDER_SOURCE_METHOD, undefined);
  assert.equal(fallback.environment.RESHADE_RENDER_MULTIPLIER, "2");
  assert.deepEqual(fallback.plan.renderResolution, {multiplier: 2, method: "missing"});
  assert.deepEqual(fallback.appliedPlan.renderResolution, {multiplier: 2});
  assert.equal(fallback.document.nodes.filter(row => row.enabled).length, 4);
  assert.equal(fallback.preparationStatus.sourceResolution.processingGuard, true);
  assert.equal(warnings.length, 1);
});
test("source editor reports live allocation changes only for the current launch binding", async t => {
  const f = fixture(t), options = {...f.options, graphicsInputs: {sourceResolution: {
    control: "engine", heights: true, multipliers: [1, 2], live: true}}};
  assert.equal(Effects.info(f.entry, options).sourceResolution.live, true, "declared live source support reaches the stopped editor");
  const environment = await ReShade.prepare(f.entry, options), launchFile = path.join(path.dirname(environment.RESHADE_EFFECT_PLAN), "launch.json");
  const launch = JSON.parse(fs.readFileSync(launchFile));
  fs.writeFileSync(launchFile, JSON.stringify({...launch, pid: 111, phase: "spawned"}));
  assert.equal(Effects.info(f.entry, {...options, running: true, runningPids: [111]}).sourceResolution.live, true);
  assert.equal(Effects.info(f.entry, {...options, running: true, runningPids: [222]}).sourceResolution.live, undefined,
    "an adapter declaration cannot make an uninjected or replaced process live");
  fs.writeFileSync(launchFile, JSON.stringify({...launch, pid: 111, phase: "spawned", sourceControl: {
    ...launch.sourceControl, control: "virtual", support: {...launch.sourceControl.support, control: "virtual"}}}));
  assert.equal(Effects.info(f.entry, {...f.options, graphicsInputs: {}, running: true, runningPids: [111]}).sourceResolution.live, true,
    "an already-bound virtual source remains live without a dormant activation declaration");
});
test("live source recovery preserves dimensions when the next allocation cannot select the requested filter", async t => {
  const f = fixture(t), warnings = [];
  Object.assign(f.record.features.graphics, {virtualWindowAPI: 1, virtualSourceControlAPI: 1,
    virtualSourceActivationAPI: 1, virtualSourceChannelAPI: 1});
  fs.writeFileSync(path.join(f.root, "runtime.json"), JSON.stringify(f.record));
  const options = {...f.options, graphicsInputs: {sourceResolution: {
    control: "engine", heights: true, multipliers: [1, 2], methods: ["bilinear"], live: true}},
    logger: {warn: message => warnings.push(message)}};
  const environment = await ReShade.prepare(f.entry, options);
  const initial = JSON.parse(fs.readFileSync(environment.RESHADE_EFFECT_PLAN));
  ReShade.bindLaunchProcess(f.entry, 111, options);acknowledgePlan(t, f, initial);
  const launch = require("../src/modules/shared/reshade/launch-binding").read(f.entry, options);
  assert.deepEqual(Object.keys(launch.sourceControls).sort(), ["engine", "virtual"]);
  const candidate = {...f.entry, effects: {...f.entry.effects, renderResolution: {multiplier: 2, method: "bilinear"}}};
  const before = structuredClone(candidate), accepted = fs.readFileSync(environment.RESHADE_EFFECT_PLAN);
  const publication = ReShade.createPublication();t.after(() => publication.rollback());
  const result = await Effects.prepare(candidate, {...options, live: true, runningPids: [111], publication,
    sourceResolutionFailures: {engine: "The active renderer cannot apply this source filter."}});
  assert.equal(result.preparationStatus.sourceResolution.strategy, "virtual");
  assert.deepEqual(result.preparationStatus.sourceResolution.requested, {multiplier: 2, method: "bilinear"});
  assert.equal(result.preparationStatus.sourceResolution.applied, null, "preparation cannot claim an unacknowledged allocation was applied");
  assert.match(result.preparationStatus.sourceResolution.reason, /preserves the renderer's filter/);
  assert.deepEqual(result.preparationStatus.sourceResolution.fallbackReasons, [
    {control: "engine", reason: "The active renderer cannot apply this source filter."}]);
  assert.equal(publication.metadata.sourceResolutionControl, "virtual");
  assert.deepEqual(publication.metadata.sourceResolutionCandidate, {multiplier: 2});
  assert.deepEqual(result.document.nodes.filter(node => node.enabled).map(node => node.id), ["tone", "scale", "sharp"]);
  assert.deepEqual(fs.readFileSync(environment.RESHADE_EFFECT_PLAN), accepted, "preparation retains the accepted coherent graph until the source transaction commits");
  assert.deepEqual(candidate, before);
  assert.equal(warnings.filter(message => /preserving the renderer filter and remaining effects/.test(message)).length, 1);
  assert.ok(warnings.some(message => /strategy=virtual/.test(message)));
});
test("source fallback stays resize-relative, round-trips its applied plan and preserves the saved request", async t => {
  const f = fixture(t), Plans = require("../src/modules/shared/effects/plan");
  f.record.features.graphics.presentation.hosts.remote = {spatial: true};
  fs.writeFileSync(path.join(f.root, "runtime.json"), JSON.stringify(f.record));
  f.entry.effects.renderResolution = {multiplier: 3};
  const before = structuredClone(f.entry);
  const result = await Effects.prepare(f.entry, {...f.options, graphicsHost: "remote", fallback: true});
  assert.equal(result.document.nodes[0].presentationScale, 1 / 3);
  assert.equal(result.document.nodes[0].outputSize, undefined);
  assert.equal(Plans.validate(result.appliedPlan).video[0].presentationScale, 1 / 3);
  assert.equal(result.appliedPlan.renderResolution, undefined);
  assert.deepEqual(result.plan.renderResolution, {multiplier: 3});
  assert.deepEqual(f.entry, before);
  const reduction = {id: "manual-small", kind: "spatial", method: "downsample", enabled: true,
    presentationScale: 1 / 3, settings: {spatialMultiplier: null}};
  const already = await Effects.prepare({...f.entry, effects: {...f.entry.effects, video: [reduction, ...f.entry.effects.video]}},
    {...f.options, graphicsHost: "remote", fallback: true});
  assert.equal(already.document.nodes.filter(node => node.method === "downsample").length, 1);
  assert.equal(already.document.nodes[0].id, "manual-small");
  const automatic = await Effects.prepare({...f.entry, effects: {...f.entry.effects, renderResolution: {multiplier: 2},
    video: [{...reduction, presentationScale: .5}, ...f.entry.effects.video]}},
    {...f.options, graphicsHost: "remote", fallback: true, automaticResolutionNode: reduction.id});
  assert.equal(automatic.document.nodes[0].presentationScale, .5);
  assert.equal(automatic.document.nodes[0].resolutionAuto, undefined);
  assert.equal(automatic.document.nodes[0].id,reduction.id);
  assert.equal(automatic.document.nodes.filter(node=>node.method==='downsample').length,1,"matching fixed reduction is reused even when an old caller supplies an adaptive hint");
  assert.ok(automatic.document.nodes.every(node=>node.resolutionAuto===undefined));
});
test("Advanced quarter source requests preserve independent stages and reuse matching processing reductions", async t => {
  const f = fixture(t), Plans = require("../src/modules/shared/effects/plan");
  Object.assign(f.record.features.graphics, {virtualWindowAPI: 1, virtualSourceControlAPI: 1});
  fs.writeFileSync(path.join(f.root, "runtime.json"), JSON.stringify(f.record));
  f.entry.effects.renderResolution = {multiplier: 4};
  f.entry.effects.video.find(node => node.id === "scale").settings.spatialMultiplier = 4;
  const before = structuredClone(f.entry), options = {...f.options, fallback: true};
  const result = await Effects.prepare(f.entry, options);
  assert.equal(result.preparationStatus.sourceResolution.strategy, "processing");
  assert.deepEqual(result.preparationStatus.sourceResolution.requested, {multiplier: 4});
  assert.equal(result.preparationStatus.sourceResolution.applied, null);
  assert.equal(result.environment.RESHADE_RENDER_MULTIPLIER, undefined);
  assert.equal(result.environment.RESHADE_RESOLUTION_MULTIPLIER, undefined);
  assert.equal(result.document.nodes[0].presentationScale, .25);
  assert.equal(result.document.nodes.find(node => node.id === "scale").settings.spatialMultiplier, 4);
  assert.deepEqual(result.document.nodes.filter(node => node.enabled).map(node => node.id), ["source-resolution-fallback", "tone", "scale", "sharp"]);
  assert.doesNotThrow(() => Plans.validate(result.appliedPlan));assert.deepEqual(f.entry, before);
  const reduction = {id: "manual-small", kind: "spatial", method: "downsample", enabled: true, presentationScale: .25, settings: {spatialMultiplier: null}};
  const already = await Effects.prepare({...f.entry, effects: {...f.entry.effects, video: [reduction, ...f.entry.effects.video]}}, options);
  assert.equal(already.document.nodes.filter(node => node.method === "downsample").length, 1);
  assert.equal(already.document.nodes[0].id, reduction.id);
  const original = await Effects.prepare({...f.entry, effects: {...f.entry.effects, renderResolution: {multiplier: 1}}}, options);
  assert.equal(original.preparationStatus.sourceResolution.strategy, "original");
  assert.equal(original.document.nodes.some(node => node.method === "downsample"), false);
});
test("source fallback does not overflow the native row limit or resize depth inputs", async t => {
  const f = fixture(t);
  f.record.features.graphics.presentation.hosts.remote = {spatial: true};
  fs.writeFileSync(path.join(f.root, "runtime.json"), JSON.stringify(f.record));
  const full = {...f.entry, effects: {schema: 1, mode: "advanced", renderResolution: {multiplier: 2},
    video: Array.from({length: 32}, (_, index) => ({id: "scale-" + index, kind: "spatial", enabled: true, method: "bilinear", settings: {}}))}};
  const limited = await Effects.prepare(full, {...f.options, graphicsHost: "remote", fallback: true});
  assert.equal(limited.document.nodes.length, 32);assert.equal(limited.preparationStatus.sourceResolution.strategy, "original");
  f.record.features.shaders.depth = true;fs.writeFileSync(path.join(f.root, "runtime.json"), JSON.stringify(f.record));
  t.mock.method(require("../src/modules/shared/reshade/live-effect"), "prepare", async (_entry, options) => {
    const revision = "a".repeat(64), effects = path.join(options.directory, "effects"), target = path.join(effects, revision);
    fs.mkdirSync(target, {recursive: true});fs.writeFileSync(path.join(target, "effect.prepared.fx"), "depth");
    fs.writeFileSync(path.join(options.directory, "live-selection.json"), JSON.stringify({revision, key: "b".repeat(64), requirements: {depth: true, motion: false}}));
    return effects;
  });
  const entry = {...f.entry, effects: {...f.entry.effects, renderResolution: {multiplier: 2}, video: [f.entry.effects.video[0]]}};
  const depth = await Effects.prepare(entry, {...f.options, graphicsInputs: {sourceResolution: false}, fallback: true});
  assert.equal(depth.document.nodes[0].requirements.depth, true);
  assert.equal(depth.document.nodes.length, 1);assert.equal(depth.preparationStatus.sourceResolution.strategy, "original");
});
test("ordinary source preparation guards a renderer rejection after spawn without changing the saved chain", async t => {
  const f = fixture(t), Plans = require("../src/modules/shared/effects/plan");
  f.entry.effects.renderResolution = {multiplier: 2};const before = structuredClone(f.entry);
  const result = await Effects.prepare(f.entry, {...f.options, fallback: true});
  assert.equal(result.environment.RESHADE_RENDER_SOURCE_CONTROL, "engine");
  assert.equal(result.environment.RESHADE_RENDER_MULTIPLIER, "2");
  assert.equal(result.preparationStatus.sourceResolution.strategy, "engine");
  assert.equal(result.preparationStatus.sourceResolution.processingGuard, true);
  assert.equal(result.document.nodes[0].method, "downsample");assert.equal(result.document.nodes[0].presentationScale, .5);
  assert.equal(Plans.validate(result.appliedPlan).video[0].presentationScale, .5);
  assert.deepEqual(result.plan, Plans.validate(before.effects));assert.deepEqual(f.entry, before);
});
test("Simple upgrade keeps source divisors separate from automatic final stage size", t => {
  const f = fixture(t), entry = {...f.entry, effects: undefined, graphics: {spatialMethod: "bilinear", spatialMultiplier: 2}};
  const info = Effects.info(entry, f.options);
  assert.equal(info.mode, "advanced");
  assert.deepEqual(info.plan.renderResolution, {multiplier: 2});
  assert.equal(info.plan.video.find(row => row.kind === "spatial").settings.spatialMultiplier, null);
  assert.deepEqual(StoredPlan.upgradeLegacy(entry, f.options).effects.video.map(row => row.kind), ["spatial", "shader"], "mixed Simple places display effects after scaling");
  assert.deepEqual(StoredPlan.upgradeLegacy({...entry, reshade: {enabled: false}}, f.options).effects.renderResolution,
    {multiplier: 2}, "an explicit source reduction uses the shared fallback path");
});
test("resizing shader preparation separates fixed input factors from presentation-dependent output", async t => {
  const f = fixture(t), Live = require("../src/modules/shared/reshade/live-effect");
  f.record.features.shaders.formats.push("libplacebo");
  fs.writeFileSync(path.join(f.root, "runtime.json"), JSON.stringify(f.record));
  let source;
  t.mock.method(Live, "prepare", async (_entry, options) => {
    const revision = "a".repeat(64), effects = path.join(options.directory, "effects"), target = path.join(effects, revision);
    fs.mkdirSync(target, { recursive: true });fs.writeFileSync(path.join(target, "effect.hook"), source);
    fs.writeFileSync(path.join(options.directory, "live-selection.json"), JSON.stringify({ revision, key: "b".repeat(64), format: "libplacebo" }));
    return effects;
  });
  for (const [index, directives] of [
    "//!WIDTH HOOKED.w 2 *\n//!HEIGHT HOOKED.h 2 *",
    "//!WIDTH HOOKED.w 2 *\n//!HEIGHT HOOKED.h 2 *\n//!WHEN OUTPUT.w HOOKED.w >",
    "//!WIDTH OUTPUT.w\n//!HEIGHT OUTPUT.h",
    "//!WIDTH 2\n//!HEIGHT 2",
    ""
  ].entries()) {
    source = `//!HOOK MAIN\n${directives}\nvec4 hook(){return vec4(1);}`;
    const input = path.join(f.temporary, `shader-${index}.hook`);fs.writeFileSync(input, source);
    const entry = { ...f.entry, effects: { schema: 1, mode: "advanced", video: [{ id: `shader-${index}`, kind: "shader", enabled: true,
      shader: { enabled: true, preset: "custom", effectPath: input } }] } };
    const node = (await Effects.prepare(entry, f.options)).document.nodes[0];
    assert.deepEqual(node.outputScale, index === 0 ? { x: 2, y: 2 } : undefined);
    assert.equal(node.outputExtent, index > 0 && index < 3 ? "presentation" : undefined);
    assert.deepEqual(node.outputSize, index === 3 ? { width: 2, height: 2 } : undefined);
    const simple = { ...entry, effects: undefined, graphics: { spatialMethod: "off" }, reshade: entry.effects.video[0].shader };
    const selected = Effects.info(simple, f.options).nodeCatalog["legacy-shader"].traits;
    assert.equal(Boolean(selected.outputScale || selected.unresolvedGeometry), index < 4);
  }
});
test("included virtual presentation enables generic source sizing without overriding engine control", async t => {
  const f = fixture(t);
  f.record.features.graphics.virtualWindowAPI = 1;
  fs.writeFileSync(path.join(f.root, "runtime.json"), JSON.stringify(f.record));
  const options = {...f.options, graphicsInputs: {}};
  f.entry.effects.renderResolution = {multiplier: 2};
  assert.deepEqual(Effects.info(f.entry, options).sourceResolution, {heights: true, multipliers: [1, 1.5, 2, 3], processing: true});
  const generic = await Effects.prepare(f.entry, options);
  assert.equal(generic.environment.RESHADE_RENDER_SOURCE_CONTROL, "virtual");
  assert.equal(generic.environment.RESHADE_RENDER_MULTIPLIER, "2");
  const engine = await Effects.prepare(f.entry, f.options);
  assert.equal(engine.environment.RESHADE_RENDER_SOURCE_CONTROL, "engine");
  f.record.features.graphics.virtualSourceControlAPI = 1;
  fs.writeFileSync(path.join(f.root, "runtime.json"), JSON.stringify(f.record));
  const entry = {...f.entry, effects: {...f.entry.effects, renderResolution: {height: 480}}};
  const environment = await ReShade.prepare(entry, {...f.options,
    graphicsInputs: {sourceResolution: {control: "engine", heights: false, multipliers: [2], live: true}}});
  assert.equal(environment.RESHADE_RENDER_SOURCE_CONTROL, "virtual");
  const launch = JSON.parse(fs.readFileSync(path.join(path.dirname(environment.RESHADE_EFFECT_PLAN), "launch.json")));
  assert.equal(launch.sourceControl.control, "virtual", "the final launch binding follows the effective API rather than the first capability");
  assert.deepEqual(JSON.parse(fs.readFileSync(launch.sourceControl.file)).source, {height: 480});
});
test("a core declaring dormant virtual activation binds untouched Original without enabling image processing", async t => {
  const f = fixture(t);
  Object.assign(f.record.features.graphics, {virtualWindowAPI: 1, virtualSourceControlAPI: 1, virtualSourceActivationAPI: 1});
  fs.writeFileSync(path.join(f.root, "runtime.json"), JSON.stringify(f.record));
  const entry = {gameId: "dormant", gamePath: "/Games/Original"}, options = {...f.options, graphicsInputs: {}};
  const environment = await ReShade.prepare(entry, options);
  assert.equal(environment.RESHADE_RENDER_SOURCE_ACTIVATION_API, "1");
  assert.equal(environment.RESHADE_RENDER_SOURCE_CONTROL, "virtual");
  for (const name of ["RESHADE_RENDER_MULTIPLIER", "RESHADE_RENDER_HEIGHT", "RESHADE_SPATIAL_METHOD", "RESHADE_MODEL_PATH"])
    assert.equal(environment[name], undefined, name);
  const launch = JSON.parse(fs.readFileSync(path.join(path.dirname(environment.RESHADE_EFFECT_PLAN), "launch.json")));
  assert.equal(launch.sourceControl.activationAPI, 1);
  assert.equal(JSON.parse(fs.readFileSync(launch.sourceControl.file)).source, null);
  assert.deepEqual(JSON.parse(fs.readFileSync(environment.RESHADE_EFFECT_PLAN)).nodes, []);
  assert.equal(fs.existsSync(launch.sourceControl.statusFile), false, "preparation cannot fabricate a completed source receipt");
  assert.equal(Effects.info(entry, options).sourceResolution.live, true);assert.deepEqual(f.calls, []);
});
function fixture(t) {
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "effects-runtime-")));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "runtime"), userDataDir = path.join(temporary, "profile"), calls = [];
  fs.mkdirSync(path.join(root, "effects"), { recursive: true });
  for (const file of ["libreshade-macos.dylib", "fx-compile", "effects/grayscale.fx", "effects/cas.fx"])
    fs.writeFileSync(path.join(root, file), "fixture");
  const record = { schema: 1, version: "test", minimumMacOS: "13.0", features: { shaders: { formats: ["fx"] }, graphics: {
    effectPlanAPI: 1, spatialMethods: ["bilinear"], presentation: { hosts: { window: { spatial: true, resolutionMultipliers: [1, 2] } } }
  } } };
  fs.writeFileSync(path.join(root, "runtime.json"), JSON.stringify(record));
  const options = { root, userDataDir, platform: "darwin", macOSVersion: "27.0", graphicsHost: "window", verify: () => true,
    graphicsInputs: {sourceResolution: {heights: true, multipliers: [1, 1.5, 2, 3], control: "engine"}},
    diagnostics: false, gpuTiming: false, trace: false, execute: async (_command, args) => {
      calls.push(args);
      if (args[0] === "--prepare") fs.copyFileSync(args[1], args[2]);
      else { fs.writeFileSync(path.join(args[1], "textures.json"), "[]");fs.writeFileSync(path.join(args[1], "uniforms.json"), "[]"); }
    } };
  const entry = { gameId: "game-a", gamePath: "/Games/A", reshade: { enabled: true, preset: "grayscale" },
    effects: { schema: 1, mode: "advanced", video: [
      { id: "tone", kind: "shader", enabled: true, shader: { preset: "grayscale", parameters: { V__Strength: [.3] } } },
      { id: "scale", kind: "spatial", enabled: true, method: "bilinear", settings: { spatialMultiplier: 2 } },
      { id: "sharp", kind: "shader", enabled: true, shader: { preset: "cas", parameters: { V__Strength: [.7] } } },
      { id: "later", kind: "shader", enabled: false, shader: { preset: "custom", effectPath: "/missing.fx" } }
    ] } };
  return { temporary, root, userDataDir, options, entry, calls, record };
}
test('editor node metadata keeps custom source identities and exact selected model scales',t=>{
 const f=fixture(t),Neural=require('../src/modules/shared/reshade/neural'),models=[{version:'three',method:'realcugan',modelPath:'/Models/Three.restorationmodel',intrinsicScale:3},{version:'four',method:'realcugan',modelPath:'/Models/Four.restorationmodel',intrinsicScale:4},{version:'depth',method:'depth-anything-v2-small',modelPath:'/Models/Depth.depthmodel'}];
 t.mock.method(Neural,'listModels',()=>models);t.mock.method(Neural,'resolve',()=>({library:'/Neural.dylib',supportedMethods:['realcugan','depth-anything-v2-small']}));
 const calls=[];t.mock.method(Neural,'modelScale',(file,method)=>{calls.push([file,method]);if(file==='/Models/Foreign.fgmodel')throw Error('The selected model belongs to a different neural operation.');return file.includes('Three')?3:file.includes('Four')?4:1;});
 t.mock.method(ReShade,'resolveShaderSelection',entry=>({file:entry.reshade.effectPath,format:entry.reshade.effectPath.endsWith('.mclfilter')?'native':'libplacebo',traits:entry.reshade.effectPath.endsWith('.mclfilter')?{modelOperation:'depth-anything-v2-small'}:{outputScale:{x:2,y:2}}}));
 const custom=(id,file)=>({id,kind:'shader',enabled:true,shader:{enabled:true,preset:'custom',effectPath:file,parameters:{Strength:[.4]}},...(file.endsWith('.mclfilter')?{settings:{modelPath:null}}:{})});
 const entry={...f.entry,effects:{schema:2,mode:'advanced',enabled:true,video:[custom('cnn','/Shaders/CNN.glsl'),custom('fog','/Shaders/Fog.mclfilter'),
  {id:'three',kind:'upscale',method:'realcugan',enabled:true,settings:{modelPath:models[0].modelPath}},
  {id:'auto',kind:'upscale',method:'realcugan',enabled:true,settings:{modelPath:null}},
  {id:'foreign',kind:'upscale',method:'realcugan',enabled:true,settings:{modelPath:'/Models/Foreign.fgmodel'}}]}};
 const before=structuredClone(entry),info=Effects.info(entry,{...f.options,settings:{runtimes:{'graphics-neural-models':{defaultVersions:{realcugan:'four','depth-anything-v2-small':'depth'}}}}});
 assert.deepEqual(info.nodeCatalog.cnn.traits.outputScale,{x:2,y:2});assert.equal(info.nodeCatalog.cnn.label,'CNN.glsl');
 assert.equal(info.nodeCatalog.fog.modelOperation,'depth-anything-v2-small');assert.equal(info.nodeCatalog.fog.template.settings.modelPath,null);
 assert.equal(info.nodeCatalog.three.intrinsicScale,3);assert.equal(info.nodeCatalog.auto.intrinsicScale,4);assert.equal(info.nodeCatalog.auto.template.settings.modelPath,null);
 assert.equal(info.nodeCatalog.foreign.available,false);assert.match(info.nodeCatalog.foreign.reason,/different neural operation/);
 const key=require('../src/modules/shared/effects/selection-key.mjs').effectSelectionKey;assert.equal(info.nodeCatalog.cnn.selectionKey,key(entry.effects.video[0]));assert.notEqual(info.nodeCatalog.cnn.selectionKey,info.nodeCatalog.fog.selectionKey);
 assert.ok(calls.some(([file,method])=>file===models[1].modelPath&&method==='realcugan'));assert.deepEqual(entry,before);assert.deepEqual(f.calls,[]);
});
function acknowledgePlan(t, f, document) {
  return t.mock.method(require("../src/modules/shared/reshade/runtime-status"), "accepted", () => {
    const binding = require("../src/modules/shared/reshade/launch-binding").read(f.entry, f.options);
    return {launchId: binding?.launchId, launchPid: binding?.pid, revision: document.revision};
  });
}
test("explicit resize rows compile direction and extent without touching game source allocation", async t => {
  const f = fixture(t);
  Object.assign(f.record.features.graphics, {resizeAPI: 2, spatialMethods: ["bilinear", "bicubic"], downsampleMethods: ["area"]});
  fs.writeFileSync(path.join(f.root, "runtime.json"), JSON.stringify(f.record));
  const entry = {...f.entry, effects: {schema: 2, mode: "advanced", enabled: true, video: [
    {id: "small", kind: "downsample", enabled: true, method: "area", extent: {relativeTo: "input", factor: .375}, settings: {}},
    {id: "large", kind: "upscale", enabled: true, method: "bicubic", extent: {height: 900}, settings: {}}
  ]}};
  const before = structuredClone(entry), prepared = await Effects.prepare(entry, f.options);
  assert.deepEqual(prepared.document.nodes.map(node => [node.kind, node.method, node.resizeDirection]), [["spatial", "area", "downsample"], ["spatial", "bicubic", "upscale"]]);
  assert.equal(prepared.document.nodes[0].settings.spatialMultiplier, .375);
  assert.deepEqual(prepared.document.nodes[1].outputSize, {height: 900});
  assert.equal(prepared.environment.RESHADE_RENDER_HEIGHT, undefined);assert.deepEqual(entry, before);
  const bypass = await Effects.prepare({...entry, effects: {...entry.effects, enabled: false}}, f.options);
  assert.equal(bypass.document.nodes.every(node => node.enabled === false), true);
  assert.equal(bypass.plan.video.every(node => node.enabled === true), true);
  assert.equal(bypass.plan.enabled, false);
});
test("window fractions compile as fits while previous-image factors and pixel sizes retain directions",async t=>{
  const f=fixture(t);Object.assign(f.record.features.graphics,{resizeAPI:2,spatialMethods:["bilinear","metalfx"]});fs.writeFileSync(path.join(f.root,"runtime.json"),JSON.stringify(f.record));
  const nodes=[
    {id:"window",kind:"upscale",method:"bilinear",settings:{}},
    {id:"half-window",kind:"upscale",method:"bilinear",extent:{relativeTo:"presentation",factor:.5},settings:{}},
    {id:"metalfx-target",kind:"upscale",method:"metalfx",extent:{relativeTo:"presentation",factor:1},settings:{}},
    {id:"input",kind:"upscale",method:"bilinear",extent:{relativeTo:"input",factor:2},settings:{}},
    {id:"pixels",kind:"upscale",method:"bilinear",extent:{height:900},settings:{}},
    {id:"down-window",kind:"downsample",method:"bilinear",extent:{relativeTo:"presentation",factor:.5},settings:{}}
  ].map(node=>({...node,enabled:true}));
  const entry={...f.entry,effects:{schema:2,mode:"advanced",enabled:true,video:nodes}},before=structuredClone(entry),prepared=await Effects.prepare(entry,f.options),rows=Object.fromEntries(prepared.document.nodes.map(node=>[node.id,node]));
  for(const id of ["window","half-window","metalfx-target"])assert.equal(rows[id].resizeDirection,undefined,id);
  assert.equal(rows["half-window"].presentationScale,.5);assert.equal(rows["metalfx-target"].presentationScale,1);assert.equal(rows["metalfx-target"].method,"metalfx");
  assert.equal(rows.input.resizeDirection,"upscale");assert.equal(rows.input.settings.spatialMultiplier,2);assert.equal(rows.pixels.resizeDirection,"upscale");assert.deepEqual(rows.pixels.outputSize,{height:900});assert.equal(rows["down-window"].resizeDirection,"downsample");assert.deepEqual(entry,before);
});
test("a 3x model after half-size input gets a real bidirectional owned fit without rewriting desired or manual rows",async t=>{
  const f=fixture(t),Neural=require("../src/modules/shared/reshade/neural"),modelPath="/Models/Three.restorationmodel";
  Object.assign(f.record.features.graphics,{resizeAPI:2,spatialMethods:["bilinear","metalfx"]});fs.writeFileSync(path.join(f.root,"runtime.json"),JSON.stringify(f.record));
  t.mock.method(Neural,"listModels",()=>[{version:"three",method:"realcugan",modelPath,intrinsicScale:3}]);t.mock.method(Neural,"resolve",()=>({library:"/Neural.dylib",supportedMethods:["realcugan"]}));t.mock.method(Neural,"model",file=>file);t.mock.method(Neural,"modelScale",()=>3);
  t.mock.method(Neural,"prepareMethod",(method,settings)=>{assert.equal(method,"realcugan");return {settings,intrinsicScale:3,environment:{RESHADE_NEURAL_LIBRARY:"/Neural.dylib"}};});
  const entry={...f.entry,effects:{schema:2,mode:"advanced",enabled:true,video:[
    {id:"manual-half",kind:"downsample",method:"bilinear",enabled:true,extent:{relativeTo:"input",factor:.5},settings:{}},
    {id:"model",kind:"upscale",method:"realcugan",enabled:true,settings:{modelPath}},
    {id:"auto-scale-fit-model",kind:"upscale",method:"metalfx",enabled:true,settings:{},ownedBy:{id:"model",role:"fit"}},
    {id:"manual-final",kind:"upscale",method:"bilinear",enabled:true,extent:{height:900},settings:{}}
  ]}},before=structuredClone(entry),prepared=await Effects.prepare(entry,f.options),rows=Object.fromEntries(prepared.document.nodes.map(node=>[node.id,node]));
  assert.equal(rows["manual-half"].settings.spatialMultiplier,.5);assert.equal(rows.model.intrinsicScale,3);
  assert.equal(rows["auto-scale-fit-model"].method,"bilinear");assert.equal(rows["auto-scale-fit-model"].resizeDirection,undefined);assert.equal(rows["auto-scale-fit-model"].settings.spatialMultiplier,null);
  assert.equal(rows["manual-final"].resizeDirection,"upscale");assert.deepEqual(rows["manual-final"].outputSize,{height:900});
  assert.equal(prepared.appliedPlan.video.find(node=>node.id==="auto-scale-fit-model").method,"bilinear");assert.equal(prepared.preparationStatus.applied.find(node=>node.id==="auto-scale-fit-model").method,"bilinear");
  const desired=prepared.plan.video.find(node=>node.id==="auto-scale-fit-model");assert.equal(desired.kind,"upscale");assert.equal(desired.method,"metalfx");assert.equal(desired.settings.spatialMethod,"metalfx");assert.equal(desired.extent,undefined);
  assert.deepEqual(prepared.plan.video.find(node=>node.id==="manual-final").extent,{height:900});assert.equal(prepared.plan.renderResolution,undefined);assert.deepEqual(entry,before);
});
test("display-only output prepares an authenticated native policy without loading a model or changing source",async t=>{
  const f=fixture(t),output={motionClarity:"bfi",subframes:2,duty:.5,brightness:1};
  f.record.features.graphics.motionClarityAPI=1;fs.writeFileSync(path.join(f.root,"runtime.json"),JSON.stringify(f.record));
  const entry={...f.entry,effects:{schema:2,mode:"advanced",enabled:true,video:[],output}};
  const prepared=await Effects.prepare(entry,f.options);
  assert.deepEqual(prepared.document.output,output);assert.equal(prepared.document.nodes.length,0);
  assert.equal(require("../src/modules/shared/effects/live-plan").validDocument(prepared.document),true);
  assert.equal(prepared.environment.RESHADE_RENDER_HEIGHT,undefined);
  assert.equal(prepared.environment.RESHADE_NEURAL_LIBRARY,undefined);
  const bypass=await Effects.prepare({...entry,effects:{...entry.effects,enabled:false}},f.options);
  assert.equal(bypass.document.output,undefined);assert.deepEqual(bypass.plan.output,output);
});
async function liveFixture(t) {
  const f = fixture(t), Models = require("../src/modules/shared/reshade/models"), Neural = require("../src/modules/shared/reshade/neural"),
    NeuralModels = require("../src/modules/shared/reshade/neural/models"), Binding = require("../src/modules/shared/reshade/launch-binding");
  const provider = {directory: path.join(f.root, "neural"), library: path.join(f.root, "neural", "provider.dylib")};
  fs.mkdirSync(provider.directory);fs.writeFileSync(provider.library, "provider");
  f.record.features.graphics.spatialMethods.push("ls1");
  f.record.features.graphics.frameGenerationMethods = ["lsfg"];
  Object.assign(f.record.features.graphics.presentation.hosts.window, {frameGeneration: true, adaptive: true});
  fs.writeFileSync(path.join(f.root, "runtime.json"), JSON.stringify(f.record));
  const installed = [], neural = new Map(), checked = [], leased = [];
  t.mock.method(Neural, "listModels", () => [...neural].map(([modelPath, identity]) => ({...identity, modelPath, method: "mlx-dlss", intrinsicScale: 1})));
  t.mock.method(Neural, "modelScale", (file, method) => {assert.ok(neural.has(file));assert.equal(method, "mlx-dlss");return 1;});
  t.mock.method(Models, "listInstalled", () => installed);
  t.mock.method(Models, "resolveModel", async (_dir, version, capability) => {
    checked.push([version, capability]);
    const model = installed.find(model => model.version === version);
    if (!model?.inspection.capabilities[capability]?.compatible || fs.readFileSync(model.modelPath, "utf8") !== version) throw Error("changed model");
    return model;
  });
  t.mock.method(Neural, "resolve", () => provider);
  t.mock.method(Neural, "libraryPath", () => provider.library);
  t.mock.method(Neural, "model", file => fs.realpathSync(file));
  t.mock.method(Neural, "modelIdentity", (_dir, file) => neural.get(file));
  t.mock.method(NeuralModels, "resolveModel", async (_dir, version) => {
    checked.push([version, "neural"]);
    const row = [...neural].find(([, identity]) => identity.version === version);
    if (!row || fs.readFileSync(path.join(row[0], "weights"), "utf8") !== version) throw Error("changed neural weights");
    return {modelPath: row[0]};
  });
  t.mock.method(Neural, "prepare", settings => ({settings: Neural.settings({...settings, modelPath: fs.realpathSync(settings.modelPath)}),
    environment: {RESHADE_NEURAL_LIBRARY: provider.library, RESHADE_NEURAL_ROOT: provider.directory}}));
  const entry = {gameId: f.entry.gameId, gamePath: f.entry.gamePath, reshade: {enabled: false}};
  const environment = await ReShade.prepare(entry, f.options);
  assert.equal(Binding.bind(entry, 20, f.options), true);
  const launch = Binding.read(entry, f.options), resources = launch.effectPlanLiveResources;
  const options = {...f.options, live: true, runningPids: [20], useModel: async version => leased.push(version), useRuntime: async identity => leased.push(identity.version)};
  const add = (kind, character) => {
    const version = "sha256-" + character.repeat(64), directory = path.join(resources.modelRoots[kind], version);
    fs.mkdirSync(directory, {recursive: true});
    if (kind === "lossless") {
      const modelPath = path.join(directory, "Lossless.dll");fs.writeFileSync(modelPath, version);
      installed.push({version, modelPath, inspection: {capabilities: Object.fromEntries(Models.CAPABILITIES.map(name => [name, {compatible: true}]))}});
      return {version, modelPath};
    }
    const modelPath = path.join(directory, "model.dlssmodel");fs.mkdirSync(modelPath);fs.writeFileSync(path.join(modelPath, "weights"), version);
    neural.set(modelPath, {managerId: "graphics-neural-models", version});return {version, modelPath};
  };
  return {...f, entry, options, environment, launch, resources, add, checked, leased, provider};
}
test("all-off shared launches authorize lazy live resources without loading models", async t => {
  const f = await liveFixture(t);
  assert.equal(f.environment.DYLD_INSERT_LIBRARIES, path.join(f.root, "libreshade-macos.dylib"));
  assert.equal(f.environment.RESHADE_NEURAL_LIBRARY, f.provider.library);
  assert.deepEqual(JSON.parse(f.environment.RESHADE_EFFECT_MODEL_ROOTS), Object.values(f.resources.modelRoots));
  assert.deepEqual(f.checked, []);assert.deepEqual(f.leased, []);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.environment.RESHADE_EFFECT_PLAN)).nodes, []);
});
test("upgraded Simple live enable, managed model switch, parameter edits and disable publish the complete chain", async t => {
  const f = await liveFixture(t), lossless = f.add("lossless", "a"), neural = f.add("neural", "b");
  const legacy = {frameGeneration: "lsfg", frameMultiplier: 5, neuralMethod: "mlx-dlss", neuralModelPath: neural.modelPath, neuralIntensity: .8, neuralTemporal: true, neuralInputScale: .5};
  const upgrade = graphics => StoredPlan.upgradeLegacy({...f.entry, reshade: {enabled: true, preset: "grayscale"}, graphics}, f.options);
  let entry = upgrade(legacy);
  await Effects.prepare(entry, f.options);
  let document = JSON.parse(fs.readFileSync(f.environment.RESHADE_EFFECT_PLAN));
  assert.equal(document.nodes.find(node => node.kind === "neural").modelPath, neural.modelPath);
  assert.equal(document.nodes.find(node => node.method === "lsfg").settings.frameMultiplier, 5);
  assert.equal(document.nodes.find(node => node.method === "lsfg").modelPath, lossless.modelPath);
  assert.ok(document.nodes.some(node => node.kind === "shader" && node.enabled));
  const replacement = f.add("lossless", "c"), nextNeural = f.add("neural", "d");
  entry = upgrade({...legacy, modelVersion: replacement.version, neuralModelPath: nextNeural.modelPath, neuralIntensity: .3, neuralTemporal: false, neuralInputScale: .25});
  await Effects.prepare(entry, f.options);
  document = JSON.parse(fs.readFileSync(f.environment.RESHADE_EFFECT_PLAN));
  assert.equal(document.nodes.find(node => node.kind === "neural").modelPath, nextNeural.modelPath);
  assert.equal(document.nodes.find(node => node.kind === "neural").settings.intensity, .3);
  assert.equal(document.nodes.find(node => node.kind === "neural").settings.temporal, false);
  assert.equal(document.nodes.find(node => node.method === "lsfg").modelPath, replacement.modelPath);
  assert.ok(f.checked.some(([version, capability]) => version === nextNeural.version && capability === "neural"));
  assert.ok(f.leased.includes(replacement.version));assert.ok(f.leased.includes(nextNeural.version));
  await Effects.prepare({...entry, effects: {...entry.effects, enabled: false}}, f.options);
  assert.ok(JSON.parse(fs.readFileSync(f.environment.RESHADE_EFFECT_PLAN)).nodes.every(node => !node.enabled));
});
test("prepared live rows persist across a launcher restart for the same launch", async t => {
  const f = await liveFixture(t), LiveEffect = require("../src/modules/shared/reshade/live-effect"), compile = LiveEffect.prepare;
  const id = require.resolve("../src/modules/shared/effects/prepared-rows"), loaded = require.cache[id];
  t.after(() => {require.cache[id]?.exports.configure();require.cache[id] = loaded;loaded?.exports.configure();});
  require(id).configure({userDataDir: f.options.userDataDir});
  let compiled = [];
  t.mock.method(LiveEffect, "prepare", (value, options) => {compiled.push(value.reshade.preset);return compile(value, options);});
  const gray = {id: "tone", kind: "shader", enabled: true, shader: {enabled: true, preset: "grayscale"}};
  const sharp = {id: "sharp", kind: "shader", enabled: true, shader: {enabled: true, preset: "cas", parameters: {V__Strength: [.7]}}};
  const plan = video => ({...f.entry, effects: {schema: 2, mode: "advanced", enabled: true, video}});
  const first = await Effects.prepare(plan([gray, sharp]), f.options);
  assert.deepEqual(compiled, ["grayscale", "cas"]);
  require(id).flush();
  assert.ok(fs.existsSync(path.join(f.options.userDataDir, "graphics", "live-prepared-rows.json")));
  // A restarted launcher loads the module again.
  delete require.cache[id];require(id).configure({userDataDir: f.options.userDataDir});
  compiled = [];
  const tuned = await Effects.prepare(plan([gray, {...sharp, shader: {...sharp.shader, parameters: {V__Strength: [.4]}}}]), f.options);
  assert.deepEqual(compiled, ["cas"], "only the edited row is prepared after the restart");
  assert.deepEqual(tuned.document.nodes[0], first.document.nodes[0]);
});
test("a live edit prepares only changed rows and reuses the others in any order until the launch changes", async t => {
  const f = await liveFixture(t), LiveEffect = require("../src/modules/shared/reshade/live-effect"), Settings = require("../src/modules/shared/reshade/graphics-settings");
  let compiled = [], staged = 0;
  const compile = LiveEffect.prepare, stage = Settings.prepare;
  t.mock.method(LiveEffect, "prepare", (value, options) => {compiled.push(value.reshade.preset);return compile(value, options);});
  t.mock.method(Settings, "prepare", (...args) => {staged++;return stage(...args);});
  const gray = {id: "tone", kind: "shader", enabled: true, shader: {enabled: true, preset: "grayscale"}};
  const scale = {id: "scale", kind: "spatial", enabled: true, method: "bilinear", settings: {spatialMultiplier: 2}};
  const sharp = {id: "sharp", kind: "shader", enabled: true, shader: {enabled: true, preset: "cas", parameters: {V__Strength: [.7]}}};
  const plan = video => ({...f.entry, effects: {schema: 2, mode: "advanced", enabled: true, video}});
  const first = await Effects.prepare(plan([gray, scale, sharp]), f.options);
  assert.deepEqual(compiled, ["grayscale", "cas"]);assert.equal(staged, 1);
  compiled = [];staged = 0;
  const tuned = {...sharp, shader: {...sharp.shader, parameters: {V__Strength: [.4]}}};
  const second = await Effects.prepare(plan([gray, scale, tuned]), f.options);
  assert.deepEqual(compiled, ["cas"], "only the edited row is prepared");assert.equal(staged, 0);
  assert.deepEqual(second.document.nodes.slice(0, 2), first.document.nodes.slice(0, 2), "unchanged rows keep their prepared output");
  assert.deepEqual(second.document.nodes[2].parameters, {V__Strength: [.4]});
  compiled = [];
  const moved = await Effects.prepare(plan([tuned, scale, gray]), f.options);
  assert.deepEqual(compiled, []);assert.equal(staged, 0);
  assert.deepEqual(moved.document.nodes.map(node => node.id), ["sharp", "scale", "tone"], "reused rows follow the new order");
  const reversed = plan([tuned, scale, gray]);reversed.effects.depthInput = {reversed: true};
  await Effects.prepare(reversed, f.options);
  assert.deepEqual(compiled, ["cas", "grayscale"], "the game's depth input prepares its shader rows again");assert.equal(staged, 0);
  await Effects.prepare(plan([tuned, scale, gray]), f.options);compiled = [];
  const off = await Effects.prepare(plan([{...gray, enabled: false}, scale, tuned]), f.options);
  assert.deepEqual(compiled, []);assert.equal(off.document.nodes[0].enabled, false);
  compiled = [];staged = 0;
  await Effects.prepare(plan([gray, scale, tuned]), {...f.options, force: true});
  assert.deepEqual(compiled, ["grayscale", "cas"], "a forced preparation prepares every row");assert.equal(staged, 1);
  const Binding = require("../src/modules/shared/reshade/launch-binding");
  await ReShade.prepare({...f.entry, reshade: {enabled: false}}, f.options);
  assert.equal(Binding.bind({gameId: f.entry.gameId, gamePath: f.entry.gamePath}, 21, f.options), true);
  compiled = [];staged = 0;
  await Effects.prepare(plan([gray, scale, tuned]), {...f.options, runningPids: [21]});
  assert.deepEqual(compiled, ["grayscale", "cas"], "a new launch prepares every row");assert.equal(staged, 1);
});
for (const method of ["ls1", "lsfg"]) test(`upgraded Simple standalone models retain ordered live ${method} setup from all-off`, async t => {
  const f = await liveFixture(t), model = f.add("lossless", method === "ls1" ? "a" : "b");
  assert.equal(f.environment.RESHADE_LOSSLESS_MODEL, undefined, "the initial legacy environment has no model binding");
  const entry = StoredPlan.upgradeLegacy({...f.entry, graphics: {...(method === "ls1" ? {spatialMethod: method} : {frameGeneration: method}), modelVersion: model.version}}, f.options);
  await Effects.prepare(entry, f.options);
  const document = JSON.parse(fs.readFileSync(f.environment.RESHADE_EFFECT_PLAN));
  assert.equal(document.mode, "advanced");assert.equal(document.nodes.find(node => node.method === method).modelPath, model.modelPath);
  assert.ok(f.checked.some(([version]) => version === model.version));assert.ok(f.leased.includes(model.version));
});
test("live independent shaders apply while an unauthorized model stays requested and its existing native row is retained", async t => {
  const f = await liveFixture(t), model = f.add("lossless", "a");
  const plan = {schema: 1, mode: "advanced", video: [
    {id: "tone", kind: "shader", enabled: true, shader: {preset: "grayscale", parameters: {V__Strength: [.3]}}},
    {id: "fg", kind: "frame-generation", enabled: true, method: "lsfg", settings: {modelVersion: model.version}}
  ]};
  const entry = {...f.entry, effects: plan}, initial = await Effects.prepare(entry, f.options);
  acknowledgePlan(t, f, initial.document);
  const candidate = {...entry, effects: {...plan, video: [
    {...plan.video[0], shader: {...plan.video[0].shader, parameters: {V__Strength: [.9]}}},
    {...plan.video[1], settings: {modelVersion: "sha256-" + "b".repeat(64)}}
  ]}};
  const checked = f.checked.length, publication = ReShade.createPublication(), before = fs.readFileSync(initial.file);
  const updated = await Effects.prepare(candidate, {...f.options, publication});
  assert.deepEqual(fs.readFileSync(initial.file), before, "the old complete publication stays active during preparation");
  assert.equal(f.checked.length, checked, "retained model resources are not reread or prepared");
  assert.deepEqual(updated.document.nodes[0].parameters, {V__Strength: [.9]});
  assert.deepEqual(updated.document.nodes[1], initial.document.nodes[1]);
  assert.deepEqual(updated.plan, require("../src/modules/shared/effects/plan").validate(candidate.effects));
  assert.equal(updated.preparationStatus.pending[0].retained, true);
  publication.commit();
  assert.deepEqual(JSON.parse(fs.readFileSync(initial.file)), updated.document);
  const launch = JSON.parse(fs.readFileSync(path.join(path.dirname(initial.file), "launch.json")));
  assert.equal(launch.graphicsLivePreparation.revision, updated.document.revision);
  assert.deepEqual(launch.graphicsLivePreparation.preparationStatus.pending, updated.preparationStatus.pending);
  assert.equal(Effects.info(candidate, {...f.options, running: true}).live, true, "a pending model cannot disable independent shader live editing");
});
test("a live edit that breaks a working row keeps the row's accepted version and the edit", async t => {
  const f = await liveFixture(t), LiveEffect = require("../src/modules/shared/reshade/live-effect"), compile = LiveEffect.prepare;
  const tone = {id: "tone", kind: "shader", enabled: true, shader: {preset: "grayscale", parameters: {V__Strength: [.3]}}};
  const plan = video => ({...f.entry, effects: {schema: 2, mode: "advanced", enabled: true, video}});
  const initial = await Effects.prepare(plan([tone]), f.options);
  acknowledgePlan(t, f, initial.document);
  t.mock.method(LiveEffect, "prepare", (value, options) => value.reshade.preset === "cas" ? Promise.reject(new Error("The shader did not compile.")) : compile(value, options));
  const edit = plan([{...tone, shader: {preset: "cas", parameters: {V__Strength: [.9]}}}]);
  const updated = await Effects.prepare(edit, {...f.options, publication: ReShade.createPublication()});
  assert.equal(updated.deferred, undefined);
  assert.deepEqual(updated.document.nodes[0], initial.document.nodes[0], "the working version keeps running");
  assert.deepEqual(updated.plan, require("../src/modules/shared/effects/plan").validate(edit.effects), "the edit is kept for a retry");
  assert.deepEqual(updated.preparationStatus.pending.map(row => [row.id, row.retained, row.method]), [["tone", true, "cas"]]);
  assert.match(updated.preparationStatus.pending[0].reason, /did not compile\. The previous version of this effect keeps running/);
});
test("upgraded Simple keeps compatible CRT processing live when a newly requested generator has no installed models", async t => {
  const f = await liveFixture(t), entry = StoredPlan.upgradeLegacy({...f.entry, reshade: {enabled: true, preset: "grayscale"}, graphics: {frameGeneration: "lsfg"}}, f.options);
  acknowledgePlan(t, f, JSON.parse(fs.readFileSync(f.environment.RESHADE_EFFECT_PLAN)));
  const publication = ReShade.createPublication();
  const requested = await Effects.prepare(entry, {...f.options, publication});
  const prepared = JSON.parse(publication.read(f.environment.RESHADE_EFFECT_PLAN, "utf8"));
  assert.equal(prepared.nodes.find(row => row.kind === "shader").enabled, true);
  assert.equal(prepared.nodes.find(row => row.kind === "frame-generation").enabled, false);
  publication.commit();
  const launch = JSON.parse(fs.readFileSync(path.join(path.dirname(f.environment.RESHADE_EFFECT_PLAN), "launch.json")));
  assert.equal(launch.graphicsLivePreparation.preparationStatus.pending[0].kind, "frame-generation");
  assert.equal(requested.plan.video.find(row => row.kind === "frame-generation").enabled, true);
});
test("untouched activation enables a fresh shader with an unavailable new generator without native acceptance", async t => {
  const f = await liveFixture(t), Status = require("../src/modules/shared/reshade/runtime-status");
  t.mock.method(Status, "accepted", () => assert.fail("an untouched activation retains no native processing resources"));
  t.mock.method(Status, "acquireAccepted", () => assert.fail("no status-panel or native processing acknowledgement is required"));
  const entry = {...f.entry, effects: {schema: 1, mode: "advanced", video: [
    {id: "tone", kind: "shader", enabled: true, shader: {preset: "grayscale", parameters: {V__Strength: [.9]}}},
    {id: "new-fg", kind: "frame-generation", enabled: true, method: "lsfg", settings: {modelVersion: "sha256-" + "b".repeat(64)}}
  ]}}, publication = ReShade.createPublication(), before = fs.readFileSync(f.environment.RESHADE_EFFECT_PLAN);
  const prepared = await Effects.prepare(entry, {...f.options, publication});
  assert.equal(prepared.deferred, undefined);assert.deepEqual(prepared.document.nodes.map(node => [node.id, node.enabled]), [["tone", true], ["new-fg", false]]);
  assert.deepEqual(prepared.preparationStatus.pending.map(row => [row.id, row.retained]), [["new-fg", false]]);
  assert.deepEqual(prepared.document.nodes[0].parameters, {V__Strength: [.9]});assert.equal(prepared.plan.video[1].enabled, true);
  assert.equal(f.checked.length, 0);assert.deepEqual(fs.readFileSync(f.environment.RESHADE_EFFECT_PLAN), before);
  publication.commit();assert.equal(JSON.parse(fs.readFileSync(f.environment.RESHADE_EFFECT_PLAN)).nodes[0].enabled, true);
});
test("wholly unsupported requests retain the current graph without starting an acceptance wait", async t => {
  const f = await liveFixture(t), Status = require("../src/modules/shared/reshade/runtime-status"), model = f.add("lossless", "a");
  const plan = {schema: 1, mode: "advanced", video: [{id: "fg", kind: "frame-generation", enabled: true, method: "lsfg", settings: {modelVersion: model.version}}]};
  const initial = await Effects.prepare({...f.entry, effects: plan}, f.options), before = fs.readFileSync(initial.file);
  t.mock.method(Status, "accepted", () => assert.fail("no independent stage can be projected"));
  t.mock.method(Status, "acquireAccepted", () => assert.fail("a wholly pending choice requires no status wait"));
  const requested = {...plan, video: [{...plan.video[0], settings: {modelVersion: "sha256-" + "c".repeat(64)}}]};
  const result = await Effects.prepare({...f.entry, effects: requested}, {...f.options, publication: ReShade.createPublication()});
  assert.equal(result.deferred, true);assert.deepEqual(result.plan.video[0].settings.modelVersion, requested.video[0].settings.modelVersion);
  assert.deepEqual(fs.readFileSync(initial.file), before);
});
for (const failure of ["throw", "reject"]) test(`pending live graphics survive informational notification ${failure}`, async t => {
  const f = await liveFixture(t), model = f.add("lossless", "a"), messages = [];
  const plan = {schema: 1, mode: "advanced", video: [{id: "fg", kind: "frame-generation", enabled: true, method: "lsfg", settings: {modelVersion: model.version}}]};
  const initial = await Effects.prepare({...f.entry, effects: plan}, f.options), before = fs.readFileSync(initial.file);
  const requested = {...plan, video: [{...plan.video[0], settings: {modelVersion: "sha256-" + "c".repeat(64)}}]};
  const publication = ReShade.createPublication();
  const result = await Effects.prepare({...f.entry, effects: requested}, {...f.options, publication, logger: {info(message) {
    messages.push(message);
    if (failure === "throw") throw new Error("notification unavailable");
    return Promise.reject(new Error("notification unavailable"));
  }}});
  await new Promise(setImmediate);
  assert.equal(messages.length, 1);assert.match(messages[0], /remain pending/);
  assert.equal(result.deferred, true);assert.equal(publication.deferred, true);
  assert.deepEqual(result.plan, require("../src/modules/shared/effects/plan").validate(requested));
  assert.deepEqual(fs.readFileSync(initial.file), before);
});
test("past live processing and malformed activation controls cannot authorize an empty-resource projection", async t => {
  const Status = require("../src/modules/shared/reshade/runtime-status"), messages = [];
  const acquired = t.mock.method(Status, "acquireAccepted", async () => null);
  for (const condition of ["on-off", "history", "shader-on", "missing-controls", "malformed-document"]) await t.test(condition, async nested => {
    const f = await liveFixture(nested), Live = require("../src/modules/shared/reshade/live-controls"), directory = path.dirname(f.environment.RESHADE_EFFECT_PLAN);
    if (condition === "on-off") {
      await Effects.prepare({...f.entry, effects: {schema: 1, mode: "advanced", video: [{id: "old", kind: "shader", enabled: true, shader: {preset: "grayscale"}}]}}, f.options);
      Effects.publishSimple(f.entry, f.userDataDir);Live.write(f.entry, f.userDataDir);
    } else if (condition === "history") fs.writeFileSync(path.join(directory, "effect-plan-history.json"), "{}");
    else if (condition === "shader-on") {
      const controls = fs.readFileSync(Live.file(f.entry, f.userDataDir));controls.writeUInt32LE(8, 16);fs.writeFileSync(Live.file(f.entry, f.userDataDir), controls);
    } else if (condition === "missing-controls") fs.unlinkSync(Live.file(f.entry, f.userDataDir));
    else fs.writeFileSync(f.environment.RESHADE_EFFECT_PLAN, JSON.stringify({schema: 1, mode: "simple", revision: "invalid", nodes: []}));
    const before = fs.readFileSync(f.environment.RESHADE_EFFECT_PLAN), calls = f.calls.length;
    const entry = {...f.entry, effects: {schema: 1, mode: "advanced", video: [
      {id: "tone", kind: "shader", enabled: true, shader: {preset: "grayscale"}},
      {id: "new-fg", kind: "frame-generation", enabled: true, method: "lsfg", settings: {modelVersion: "sha256-" + "c".repeat(64)}}
    ]}};
    const result = await Effects.prepare(entry, {...f.options, publication: ReShade.createPublication(), logger: {info: message => messages.push(message)}});
    assert.equal(result.deferred, true, condition);assert.equal(f.calls.length, calls, "unknown old resources cannot be replaced by an empty graph");
    assert.deepEqual(fs.readFileSync(f.environment.RESHADE_EFFECT_PLAN), before);
  });
  assert.equal(acquired.mock.callCount(), 5);
  assert.equal(messages.length, 5);assert.ok(messages.every(message => /remain pending; current rendering is retained/.test(message)));
  assert.ok(messages.every(message => !/next launch|restart/i.test(message)), "missing acceptance is not a renderer restart requirement");
});
test("closed-panel partial edits acquire accepted history and never retain the rejected published model", async t => {
  const f = await liveFixture(t), Status = require("../src/modules/shared/reshade/runtime-status"), first = f.add("lossless", "a"), next = f.add("lossless", "b");
  f.record.features.graphics.runtimeStatusAPI = 1;fs.writeFileSync(path.join(f.root, "runtime.json"), JSON.stringify(f.record));
  const selected = Status.prepare(f.entry, {...f.options, launchId: f.launch.launchId}), launchFile = path.join(path.dirname(f.environment.RESHADE_EFFECT_PLAN), "launch.json");
  fs.writeFileSync(launchFile, JSON.stringify({...f.launch, runtimeStatus: selected.binding}));
  const plan = {schema: 1, mode: "advanced", video: [
    {id: "tone", kind: "shader", enabled: true, shader: {preset: "grayscale", parameters: {V__Strength: [.3]}}},
    {id: "fg", kind: "frame-generation", enabled: true, method: "lsfg", settings: {modelVersion: first.version}}
  ]}, entry = {...f.entry, effects: plan};
  const accepted = await Effects.prepare(entry, f.options);
  const rejected = await Effects.prepare({...entry, effects: {...plan, video: [plan.video[0], {...plan.video[1], settings: {modelVersion: next.version}}]}}, f.options);
  assert.equal(fs.existsSync(selected.binding.file), false, "full supported edits do not request runtime status");
  const candidate = {...entry, effects: {...plan, video: [
    {...plan.video[0], shader: {...plan.video[0].shader, parameters: {V__Strength: [.9]}}},
    {...plan.video[1], settings: {modelVersion: "sha256-" + "c".repeat(64)}}
  ]}}, publication = ReShade.createPublication(), before = fs.readFileSync(accepted.file);
  const preparing = Effects.prepare(candidate, {...f.options, publication});
  await new Promise(resolve => setImmediate(resolve));assert.equal(fs.existsSync(selected.binding.file), true);
  const row = Buffer.alloc(1024), now = BigInt(Date.now());row.writeUInt32LE(process.pid, 0);row.writeBigUInt64LE(1n, 8);row.writeUInt32LE(6, 16);
  row.write(rejected.document.revision, 112);row.writeBigUInt64LE(now, 504);row.writeBigUInt64LE(1n, 512);
  row.write(accepted.document.revision, 528);row.write(require("node:crypto").createHash("sha256").update(fs.readFileSync(require("../src/modules/shared/reshade/live-controls").file(entry, f.userDataDir))).digest("hex"), 593);
  row.writeBigUInt64LE(now, 664);const fd = fs.openSync(selected.binding.file, "r+");try {fs.writeSync(fd, row, 0, row.length, 4096);} finally {fs.closeSync(fd);}
  const result = await preparing;assert.equal(result.deferred, undefined);
  assert.deepEqual(result.document.nodes[1], accepted.document.nodes[1]);assert.notDeepEqual(result.document.nodes[1], rejected.document.nodes[1]);
  assert.deepEqual(result.document.nodes[0].parameters, {V__Strength: [.9]});assert.equal(result.plan.video[1].settings.modelVersion, "sha256-" + "c".repeat(64));
  assert.deepEqual(fs.readFileSync(accepted.file), before);assert.equal(fs.readFileSync(selected.binding.file).readBigUInt64LE(16), 0n);
  const forbidden = t.mock.method(Status, "acquireAccepted", () => assert.fail("supported edits and Off must not acquire status"));
  await Effects.prepare({...entry, effects: {...plan, video: [plan.video[0]]}}, {...f.options, publication: ReShade.createPublication()});
  await Effects.prepare({...entry, effects: {...plan, video: []}}, {...f.options, publication: ReShade.createPublication()});
  assert.equal(forbidden.mock.callCount(), 0);
});
test("partial live edits retain the native-accepted resources when the latest published candidate was rejected", async t => {
  const f = await liveFixture(t), first = f.add("lossless", "a"), next = f.add("lossless", "b");
  f.record.features.graphics.runtimeStatusAPI = 1;
  fs.writeFileSync(path.join(f.root, "runtime.json"), JSON.stringify(f.record));
  const plan = {schema: 1, mode: "advanced", video: [
    {id: "tone", kind: "shader", enabled: true, shader: {preset: "grayscale", parameters: {V__Strength: [.3]}}},
    {id: "fg", kind: "frame-generation", enabled: true, method: "lsfg", settings: {modelVersion: first.version}}
  ]}, entry = {...f.entry, effects: plan};
  const accepted = await Effects.prepare(entry, f.options);
  acknowledgePlan(t, f, accepted.document);
  // Simulate a later pointer accepted by JS preparation but rejected by the
  // native allocator. Resource acknowledgement deliberately remains on A.
  const attempted = {...entry, effects: {...plan, video: [plan.video[0], {...plan.video[1], settings: {modelVersion: next.version}}]}};
  const rejected = await Effects.prepare(attempted, f.options);
  assert.notEqual(rejected.document.revision, accepted.document.revision);
  const candidate = {...entry, effects: {...plan, video: [
    {...plan.video[0], shader: {...plan.video[0].shader, parameters: {V__Strength: [.9]}}},
    {...plan.video[1], settings: {modelVersion: "sha256-" + "c".repeat(64)}}
  ]}};
  const updated = await Effects.prepare(candidate, f.options);
  assert.deepEqual(updated.document.nodes[1], accepted.document.nodes[1]);
  assert.notDeepEqual(updated.document.nodes[1], rejected.document.nodes[1]);
  assert.deepEqual(updated.document.nodes[0].parameters, {V__Strength: [.9]});
  assert.equal(updated.plan.video[1].settings.modelVersion, "sha256-" + "c".repeat(64), "requested future resources remain saved separately");
});
test("Advanced live models are content-validated atomically and keep launch allocation while output sizes change", async t => {
  const f = await liveFixture(t), lossless = f.add("lossless", "e"), neural = f.add("neural", "f");
  const launchFile = path.join(path.dirname(f.environment.RESHADE_EFFECT_PLAN), "launch.json");
  fs.writeFileSync(launchFile, JSON.stringify({...f.launch, effectPlanRenderResolution: {height: 480}}));
  const entry = {...f.entry, effects: {schema: 1, mode: "advanced", renderResolution: {height: 720}, video: [
    {id: "nn", kind: "neural", enabled: true, method: "mlx-dlss", settings: {modelPath: neural.modelPath}},
    {id: "fit", kind: "spatial", enabled: true, method: "bilinear", outputSize: {width: 960, height: 540}, settings: {}},
    {id: "fg", kind: "frame-generation", enabled: true, method: "lsfg", settings: {modelVersion: lossless.version}}
  ]}};
  const result = await Effects.prepare(entry, {...f.options, deferRenderResolution: true});
  assert.deepEqual(result.appliedPlan.renderResolution, {height: 480});
  assert.deepEqual(result.document.nodes.find(node => node.id === "fit").outputSize, {width: 960, height: 540});
  assert.deepEqual(result.document.nodes[0].outputSize, {height: 720});
  assert.equal(result.environment.RESHADE_RENDER_HEIGHT, undefined);
  const before = fs.readFileSync(result.file);
  // A model whose content changed is never used; only its row is bypassed.
  const enabled = (prepared, id) => prepared.document.nodes.find(node => node.id === id).enabled;
  fs.writeFileSync(path.join(neural.modelPath, "weights"), "changed");
  const changedWeights = await Effects.prepare(entry, {...f.options, deferRenderResolution: true});
  assert.match(changedWeights.preparationStatus.skipped.find(row => row.id === "nn").reason, /changed neural weights/);
  assert.deepEqual(["nn", "fit", "fg"].map(id => enabled(changedWeights, id)), [false, true, true]);
  fs.writeFileSync(path.join(neural.modelPath, "weights"), neural.version);
  fs.writeFileSync(lossless.modelPath, "changed");
  const changedModel = await Effects.prepare(entry, {...f.options, deferRenderResolution: true});
  assert.match(changedModel.preparationStatus.skipped.find(row => row.id === "fg").reason, /changed model/);
  assert.deepEqual(["nn", "fit", "fg"].map(id => enabled(changedModel, id)), [true, true, false]);
  fs.writeFileSync(lossless.modelPath, lossless.version);
  await Effects.prepare(entry, {...f.options, deferRenderResolution: true});
  assert.deepEqual(fs.readFileSync(result.file), before, "restored model content runs every row again");
  const external = path.join(f.temporary, "external.dlssmodel");fs.mkdirSync(external);
  const escaped = {...entry, effects: {...entry.effects, video: [{...entry.effects.video[0], settings: {modelPath: external}}]}};
  assert.equal((await Effects.prepare(escaped, f.options)).deferred, true);
  assert.deepEqual(fs.readFileSync(result.file), before);
  f.provider.library = path.join(f.provider.directory, "replacement.dylib");
  acknowledgePlan(t, f, result.document);
  const retained = await Effects.prepare(entry, f.options);
  assert.equal(retained.deferred, undefined);
  assert.equal(retained.preparationStatus.pending.find(row => row.id === "nn").retained, true);
  assert.equal(retained.document.nodes.find(row => row.id === "nn").modelPath, neural.modelPath);
  assert.equal(retained.environment.RESHADE_NEURAL_LIBRARY, undefined, "the replacement provider never enters the live environment");
  assert.deepEqual(fs.readFileSync(result.file), before);
});
test("prepared plans preserve order and independent uniforms, reuse sources and publish atomically", async t => {
  const f = fixture(t), before = structuredClone(f.entry);
  const first = await Effects.prepare(f.entry, f.options);
  assert.deepEqual(first.document.nodes.map(row => row.id), ["tone", "scale", "sharp", "later"]);
  assert.deepEqual(first.document.nodes[0].parameters, { V__Strength: [.3] });
  assert.deepEqual(first.document.nodes[2].parameters, { V__Strength: [.7] });
  assert.equal(first.document.nodes[1].settings.spatialMethod, "bilinear");
  assert.equal(first.document.nodes[1].settings.frameGeneration, "off");
  assert.equal(first.document.nodes[1].settings.temporalMethod, "off");
  assert.deepEqual(first.document.nodes[3], { id: "later", kind: "shader", enabled: false });
  assert.equal(f.calls.length, 4); assert.deepEqual(f.entry, before);
  f.entry.effects.video[0].shader.parameters.V__Strength = [.8];
  const second = await Effects.prepare(f.entry, f.options);
  assert.equal(f.calls.length, 4, "uniform edits retain compiled source resources");
  assert.equal(second.document.nodes[0].file, first.document.nodes[0].file);
  assert.notEqual(second.document.revision, first.document.revision);
  const working = fs.readFileSync(first.file);
  f.entry.effects.video[3].enabled = true;
  await assert.rejects(Effects.prepare(f.entry, f.options), /running effect is unchanged/);
  assert.deepEqual(fs.readFileSync(first.file), working);
});
test("current process identity prevents stale live plans and defers edits without compiling or publishing", async t => {
  const f = fixture(t), initial = await Effects.prepare(f.entry, f.options), launchFile = path.join(path.dirname(initial.file), "launch.json");
  fs.writeFileSync(launchFile, JSON.stringify({schema: 1, launchId: "old", phase: "spawned", pid: 111,
    effectPlanAPI: 1, live: true, effectPlanBindings: {}, effectPlanNeuralModels: []}));
  assert.equal(Effects.info(f.entry, {...f.options, running: true, runningPids: [222]}).live, false);
  const retained = JSON.parse(fs.readFileSync(launchFile, "utf8"));
  assert.equal(Effects.info(f.entry, {...f.options, running: true, runningPids: [222], launchBinding: retained}).live, false,
    "a retained earlier launch supplies catalog context but never claims live editing");
  assert.equal(Effects.info(f.entry, {...f.options, running: true, runningPids: [111]}).live, true);
  const working = fs.readFileSync(initial.file), calls = f.calls.length;
  const deferred = await Effects.prepare(f.entry, {...f.options, live: true, runningPids: [222],
    execute: () => assert.fail("an uninjected process cannot compile a live edit")});
  assert.equal(deferred.deferred, true);assert.deepEqual(deferred.plan.video.map(row => row.id), f.entry.effects.video.map(row => row.id));
  assert.match(deferred.reason, /next launch/, "a deferred edit explains why the running game keeps its graphics");
  assert.deepEqual(fs.readFileSync(initial.file), working);assert.equal(f.calls.length, calls);
  t.mock.method(require("../src/modules/shared/reshade/neural"), "resolve", () => assert.fail("unbound models are next-launch preferences"));
  const neural = {...f.entry, effects: {...f.entry.effects, video: [
    {id: "new-neural", kind: "neural", enabled: true, method: "mlx-dlss", settings: {modelPath: "/new/Model.dlssmodel"}}, ...f.entry.effects.video]}};
  const acknowledgement = acknowledgePlan(t, f, initial.document);
  const partial = await Effects.prepare(neural, {...f.options, live: true, runningPids: [111]});
  assert.equal(partial.deferred, undefined);
  assert.equal(partial.plan.video[0].enabled, true, "the complete requested choice remains saved");
  assert.equal(partial.document.nodes[0].enabled, false, "the unauthorised new stage cannot run");
  assert.equal(partial.preparationStatus.pending[0].id, "new-neural");
  assert.deepEqual(partial.document.nodes.slice(1), initial.document.nodes, "existing compatible effects retain their prepared contract");
  const acceptedBytes = fs.readFileSync(initial.file);
  acknowledgement.mock.mockImplementation(() => null);
  assert.equal((await Effects.prepare(neural, {...f.options, live: true, runningPids: [111]})).deferred, true);
  assert.deepEqual(fs.readFileSync(initial.file), acceptedBytes, "missing native acknowledgement leaves the accepted publication untouched");
  acknowledgement.mock.mockImplementation(() => ({launchId: "another", launchPid: 111, revision: initial.document.revision}));
  assert.equal((await Effects.prepare(neural, {...f.options, live: true, runningPids: [111]})).deferred, true);
});
function pauseShaderPreparation(t, {after = false} = {}) {
  const LiveEffect = require("../src/modules/shared/reshade/live-effect"), original = LiveEffect.prepare;
  let entered, release;
  const started = new Promise(resolve => {entered = resolve;}), resumed = new Promise(resolve => {release = resolve;});
  t.mock.method(LiveEffect, "prepare", async (...args) => {
    const result = after ? await original(...args) : null;
    entered();await resumed;
    return after ? result : original(...args);
  });
  return {started, release};
}
test("live preparation never adopts a launch first seen after its initial await", async t => {
  const f = fixture(t), target = Effects.file(f.entry, f.userDataDir), directory = path.dirname(target);
  fs.mkdirSync(directory, {recursive: true});
  const replacement = Buffer.from(JSON.stringify({schema: 1, mode: "simple", revision: "new-owner", nodes: []}));
  await assert.rejects(Effects.prepare(f.entry, {...f.options, live: true, prepareEffectsEntry: async entry => {
    fs.writeFileSync(path.join(directory, "launch.json"), JSON.stringify({effectPlanAPI: 1, pid: 21, launchId: "replacement", phase: "spawned"}));
    fs.writeFileSync(target, replacement);return entry;
  }}), /Restart the game to use ordered effects/);
  assert.deepEqual(fs.readFileSync(target), replacement);
});
test("stopped editor publication rejects a launch appearing during shader preparation", async t => {
  const f = fixture(t), entry = {...f.entry, effects: {...f.entry.effects, video: [f.entry.effects.video[0]]}},
    baseline = await Effects.prepare(entry, f.options), gate = pauseShaderPreparation(t, {after: true});
  let stoppedStateUnchanged = true;
  const pending = Effects.prepare(entry, {...f.options, force: true, isCurrent: () => stoppedStateUnchanged});
  await gate.started;stoppedStateUnchanged = false;
  const replacement = Buffer.from(JSON.stringify({schema: 1, mode: "simple", revision: "new-owner", nodes: []}));
  fs.writeFileSync(path.join(path.dirname(baseline.file), "launch.json"), JSON.stringify({phase: "spawned", pid: 21, launchId: "replacement"}));
  fs.writeFileSync(baseline.file, replacement);gate.release();
  const result = await pending;
  assert.equal(result.deferred, true);assert.deepEqual(fs.readFileSync(baseline.file), replacement);
});
for (const scenario of ["new-launch-id", "new-pid", "session-retired"]) test(`live publication rechecks ${scenario} after asynchronous shader preparation`, async t => {
  const f = fixture(t), entry = {...f.entry, effects: {...f.entry.effects, video: [f.entry.effects.video[0]]}};
  const baseline = await Effects.prepare(entry, f.options), launchFile = path.join(path.dirname(baseline.file), "launch.json");
  const launch = {effectPlanAPI: 1, pid: 20, launchId: "original", phase: "spawned"};
  fs.writeFileSync(launchFile, JSON.stringify(launch));
  let active = true;
  // Pause after the immutable shader is ready, so this specifically exercises
  // the final plan commit rather than only the shader-selection guard.
  const gate = pauseShaderPreparation(t, {after: true});
  const candidate = {...entry, effects: {...entry.effects, video: [{...entry.effects.video[0], shader: {...entry.effects.video[0].shader, parameters: {V__Strength: [.9]}}}]}};
  const pending = Effects.prepare(candidate, {...f.options, live: true, runningPids: [20], force: true, isCurrent: () => active});
  await gate.started;
  if (scenario === "session-retired") active = false;
  else fs.writeFileSync(launchFile, JSON.stringify({...launch, ...(scenario === "new-pid" ? {pid: 21} : {launchId: "replacement"})}));
  const replacement = Buffer.from(JSON.stringify({schema: 1, mode: "simple", revision: "new-owner", nodes: []}));
  fs.writeFileSync(baseline.file, replacement);gate.release();
  const result = await pending;
  assert.equal(result.deferred, true);assert.deepEqual(result.plan, require("../src/modules/shared/effects/plan").validate(candidate.effects));
  assert.deepEqual(fs.readFileSync(baseline.file), replacement);
});
function stagedLiveFixture(t, f, entry) {
  const directory = path.dirname(Effects.file(entry, f.userDataDir)), launchFile = path.join(directory, "launch.json");
  const launch = {effectPlanAPI: 1, pid: 20, launchId: "original", phase: "spawned"};
  fs.writeFileSync(launchFile, JSON.stringify(launch));
  const Live = require("../src/modules/shared/reshade/live-controls"), Temporal = require("../src/modules/shared/reshade/temporal-controls");
  Live.write(entry, f.userDataDir, {create: true});Temporal.write(entry, f.userDataDir, {create: true});
  const files = [Effects.file(entry, f.userDataDir), Live.file(entry, f.userDataDir), Temporal.file(entry, f.userDataDir),
    ...entry.effects.video.filter(node => node.enabled && node.kind === "shader").map(node => path.join(directory, "plan-nodes", node.id, "live-selection.json"))];
  return {directory, launchFile, launch, Live, files, before: files.map(file => fs.readFileSync(file)),
    options: {...f.options, live: true, runningPids: [20], force: true}};
}
for (const accepted of [false, true]) test(`staged ordered compilation ${accepted ? "commits after native acceptance" : "discards a failed native candidate"}`, async t => {
  const f = fixture(t);await Effects.prepare(f.entry, f.options);
  const live = stagedLiveFixture(t, f, f.entry), publication = ReShade.createPublication();
  const candidate = structuredClone(f.entry);candidate.effects.video[0].shader.parameters.V__Strength = [.9];
  const prepared = await Effects.prepare(candidate, {...live.options, publication});
  live.Live.write(candidate, f.userDataDir, {publication});
  assert.ok(publication.pending >= 5);
  for (let i = 0; i < live.files.length; i++) assert.deepEqual(fs.readFileSync(live.files[i]), live.before[i], live.files[i]);
  assert.equal(JSON.parse(publication.read(prepared.file, "utf8")).nodes[0].parameters.V__Strength[0], .9);
  assert.ok(fs.existsSync(prepared.document.nodes[0].file), "native candidates can inspect immutable compiler output before publication");
  if (!accepted) {
    assert.equal(publication.rollback(), true);
    assert.throws(() => publication.commit(), /already finished/);
    for (let i = 0; i < live.files.length; i++) assert.deepEqual(fs.readFileSync(live.files[i]), live.before[i]);
    return;
  }
  const Writable = require("../src/modules/shared/writable-input"), write = Writable.atomicWrite, written = [];
  t.mock.method(Writable, "atomicWrite", (file, ...args) => {written.push(file);return write(file, ...args);});
  assert.equal(publication.check(), true);assert.equal(publication.commit(), true);
  assert.equal(written.at(-1), prepared.file, "the complete effect plan activates after its selections and controls");
  assert.deepEqual(JSON.parse(fs.readFileSync(prepared.file)), prepared.document);
  assert.equal(publication.rollback(), true, "a failed native post-commit operation can restore the accepted shared files");
  for (let i = 0; i < live.files.length; i++) assert.deepEqual(fs.readFileSync(live.files[i]), live.before[i]);
});
for (const changed of ["stop", "relaunch", "accepted-files"]) test(`staged commit refuses ${changed} after successful preparation`, async t => {
  const f = fixture(t);await Effects.prepare(f.entry, f.options);
  const live = stagedLiveFixture(t, f, f.entry), publication = ReShade.createPublication();let active = true;
  const candidate = structuredClone(f.entry);candidate.effects.video[0].shader.parameters.V__Strength = [.8];
  await Effects.prepare(candidate, {...live.options, publication, isCurrent: () => active});
  live.Live.write(candidate, f.userDataDir, {publication});
  if (changed === "stop") active = false;
  if (changed === "relaunch") fs.writeFileSync(live.launchFile, JSON.stringify({...live.launch, launchId: "replacement", pid: 21}));
  if (changed !== "stop") for (const file of live.files) fs.writeFileSync(file, "new owner: " + path.basename(file));
  const expected = live.files.map(file => fs.readFileSync(file));
  assert.throws(() => publication.commit(), {code: "GRAPHICS_LIVE_STALE"});
  assert.equal(publication.rollback(), true);
  for (let i = 0; i < live.files.length; i++) assert.deepEqual(fs.readFileSync(live.files[i]), expected[i]);
});
test("a failed later shader is bypassed in a running game and a rollback leaves every accepted staged file intact", async t => {
  const f = fixture(t);await Effects.prepare(f.entry, f.options);
  const live = stagedLiveFixture(t, f, f.entry), publication = ReShade.createPublication(), execute = f.options.execute;
  const prepared = await Effects.prepare(f.entry, {...live.options, publication, execute: async (command, args, options) => {
    if (args[0] === "--prepare" && args[1].endsWith("cas.fx")) throw Error("unsupported later shader");
    return execute(command, args, options);
  }});
  assert.deepEqual(prepared.document.nodes.map(node => [node.id, node.enabled]), [["tone", true], ["scale", true], ["sharp", false], ["later", false]]);
  assert.match(prepared.preparationStatus.skipped.find(row => row.id === "sharp").reason, /unsupported later shader/);
  assert.ok(publication.pending > 0, "the other rows are staged for publication");
  publication.rollback();
  for (let i = 0; i < live.files.length; i++) assert.deepEqual(fs.readFileSync(live.files[i]), live.before[i]);
});
test("a missing custom shader is bypassed in a running game while its other rows and later edits apply", async t => {
  const f = fixture(t);await Effects.prepare(f.entry, f.options);
  const live = stagedLiveFixture(t, f, f.entry), broken = structuredClone(f.entry), rows = result => result.document.nodes.map(node => [node.id, node.enabled]);
  broken.effects.video[3].enabled = true;
  const first = await Effects.prepare(broken, live.options);
  assert.equal(first.deferred, undefined);
  assert.deepEqual(rows(first), [["tone", true], ["scale", true], ["sharp", true], ["later", false]]);
  assert.equal(first.preparationStatus.skipped.find(row => row.id === "later").reason,
    "The shader could not be loaded. Choose an included shader or an existing .fx file.");
  assert.deepEqual(JSON.parse(fs.readFileSync(first.file)), first.document, "the readable rows are published");
  broken.effects.video[0].enabled = false;
  const second = await Effects.prepare(broken, live.options);
  assert.deepEqual(rows(second), [["tone", false], ["scale", true], ["sharp", true], ["later", false]], "a later edit applies with the row still bypassed");
  assert.ok(second.preparationStatus.skipped.some(row => row.id === "later"));
  await assert.rejects(Effects.prepare({...broken, effects: {...broken.effects, schema: 99}}, live.options), /newer/i,
    "only an unreadable plan rejects the whole edit");
});
test("renderer-declared live source channels bind actual launch settings and stage upgraded Simple changes", async t => {
  const f = fixture(t), entry = {...f.entry, effects: undefined, reshade: {enabled: false}, graphics: {spatialMethod: "bilinear", spatialMultiplier: 2}};
  const options = {...f.options, graphicsInputs: {sourceResolution: {control: "engine", live: true, heights: true,
    multipliers: [1, 2, 3], methods: ["bilinear"]}}};
  const environment = await ReShade.prepare(entry, options), Binding = require("../src/modules/shared/reshade/launch-binding");
  assert.equal(Binding.bind(entry, 20, options), true);
  const launch = Binding.read(entry, options), source = launch.sourceControl;
  assert.equal(source.launchId, launch.launchId);assert.equal(source.support.live, true);
  assert.equal(environment.RESHADE_RENDER_SOURCE_CONTROL_FILE, source.file);
  assert.deepEqual(JSON.parse(fs.readFileSync(source.file)).source, {multiplier: 2, method: "bilinear"});
  const before = fs.readFileSync(source.file), publication = ReShade.createPublication();
  await Effects.prepare(StoredPlan.upgradeLegacy({...entry, graphics: {...entry.graphics, spatialMultiplier: 3}}, options), {...options, live: true, runningPids: [20], publication});
  assert.deepEqual(publication.metadata.sourceResolutionCandidate, {multiplier: 3, method: "bilinear"});
  assert.deepEqual(fs.readFileSync(source.file), before, "preparation has not changed renderer allocation");
  publication.rollback();
});
test("live ordered source candidates stay unapplied until renderer acknowledgement and Simple reset restores source", async t => {
  const f = fixture(t), options = {...f.options, graphicsInputs: {sourceResolution: {control: "engine", live: true, heights: true, multipliers: [1, 2]}}};
  const base = {...f.entry, effects: undefined, reshade: {enabled: false}}, environment = await ReShade.prepare(base, options);
  const Binding = require("../src/modules/shared/reshade/launch-binding");assert.equal(Binding.bind(base, 20, options), true);
  const launch = Binding.read(base, options), before = fs.readFileSync(launch.sourceControl.file), publication = ReShade.createPublication();
  const entry = {...f.entry, effects: {...f.entry.effects, renderResolution: {height: 540, maximum: true}}};
  const prepared = await Effects.prepare(entry, {...options, live: true, runningPids: [20], publication});
  assert.deepEqual(publication.metadata.sourceResolutionCandidate, {height: 540, maximum: true});
  assert.equal(prepared.environment.RESHADE_RENDER_HEIGHT, undefined);assert.equal(prepared.environment.RESHADE_RENDER_MAX_HEIGHT, undefined);
  assert.equal(prepared.preparationStatus.sourceResolution.applied, null);
  assert.deepEqual(fs.readFileSync(launch.sourceControl.file), before);
  Effects.publishSimple(entry, f.userDataDir, {publication});
  assert.equal(publication.metadata.sourceResolutionCandidate, null);publication.rollback();
  assert.equal(environment.RESHADE_RENDER_SOURCE_CONTROL_FILE, launch.sourceControl.file);
});
test("module preparation separates native renderer shaders while preserving the complete saved plan", async t => {
  const f = fixture(t), source = path.join(f.temporary, "source-plane.hook");
  fs.writeFileSync(source, "//!HOOK CHROMA\n//!BIND HOOKED\n//!BIND LUMA\nvec4 hook(){return HOOKED_tex(HOOKED_pos);}\n");
  const prefix = { id: "native-video", kind: "shader", enabled: true, shader: { enabled: true, preset: "custom", effectPath: source } };
  f.entry.effects.video.unshift(prefix);const before = structuredClone(f.entry), received = [];
  const result = await Effects.prepare(f.entry, { ...f.options, prepareEffectsEntry: async entry => {
    received.push(entry.effects.video.map(row => row.id));
    return { ...entry, effects: { ...entry.effects, video: entry.effects.video.filter(row => row.id !== prefix.id) } };
  } });
  assert.deepEqual(received, [["native-video", "tone", "scale", "sharp", "later"]]);
  assert.deepEqual(result.document.nodes.map(row => row.id), ["tone", "scale", "sharp", "later"]);
  assert.deepEqual(result.plan.video.map(row => row.id), ["native-video", "tone", "scale", "sharp", "later"]);
  assert.equal(result.plan.video[0].shader.effectPath, source);assert.deepEqual(f.entry, before);
  assert.equal(f.calls.length, 4, "native renderer shader is not sent to the shared RGB compiler");
});
test("launch bypasses unavailable and broken stages while preserving working order and saved settings", async t => {
  const f = fixture(t), warnings = [];
  f.entry.effects.video.splice(1, 0, {id: "neural-missing", kind: "neural", enabled: true, method: "mlx-dlss", settings: {modelPath: null}});
  f.entry.effects.video.find(row => row.id === "later").enabled = true;
  const before = structuredClone(f.entry);
  const prepared = await Effects.prepare(f.entry, {...f.options, fallback: true, logger: {warn: message => warnings.push(message)}});
  assert.deepEqual(prepared.document.nodes.map(row => [row.id, row.enabled]), [["tone", true], ["neural-missing", false], ["scale", true], ["sharp", true], ["later", false]]);
  assert.equal(warnings.length, 1);assert.deepEqual(prepared.preparationStatus.pending.map(row=>row.id),["neural-missing"]);assert.deepEqual(f.entry, before);
  const snapshot = fs.readFileSync(prepared.file);
  const throwing = await Effects.prepare(f.entry, {...f.options, fallback: true,
    logger: {warn: () => { throw new Error("Warning sink unavailable"); }}});
  assert.deepEqual(throwing.document, prepared.document, "warning delivery cannot disable compatible remaining stages");
  await assert.rejects(Effects.prepare(f.entry, f.options), /shader could not be loaded/);
  assert.deepEqual(fs.readFileSync(prepared.file), snapshot);
});
test("Advanced model choices and Add defaults do not inherit an unrelated Simple model selection", async t => {
  const f = fixture(t), Models = require("../src/modules/shared/reshade/models");
  const quality = "sha256-" + "a".repeat(64), performance = "sha256-" + "b".repeat(64), missing = "sha256-" + "c".repeat(64);
  t.mock.method(Models, "listInstalled", () => [
    {version: quality, inspection: {capabilities: {ls1Quality: {compatible: true}, lsfgFp16Quality: {compatible: true}}}},
    {version: performance, inspection: {capabilities: {ls1Performance: {compatible: true}, lsfgFp32Performance: {compatible: true}}}}
  ]);
  f.record.features.graphics.spatialMethods.push("ls1");f.record.features.graphics.frameGenerationMethods = ["lsfg"];
  f.record.features.graphics.presentation.hosts.window.frameGeneration = true;
  fs.writeFileSync(path.join(f.root, "runtime.json"), JSON.stringify(f.record));
  const options = {...f.options, settings: {runtimes: {"graphics-models": {defaultVersion: quality}}}};
  const entry = {...f.entry, graphics: {modelVersion: missing}, effects: {schema: 1, mode: "advanced", video: [
    {id: "scale", kind: "spatial", method: "ls1", enabled: false, settings: {modelVersion: performance, ls1Mode: "performance"}},
    {id: "fg", kind: "frame-generation", method: "lsfg", enabled: false, settings: {modelVersion: missing}}
  ]}}, before = structuredClone(entry);
  const info = Effects.info(entry, options);
  for (const id of ["upscale:ls1", "frame-generation:lsfg"]) {
    const row = info.catalog.find(row => row.id === id);
    assert.equal(row.available, true, "Add uses compatible library defaults rather than a stale Simple model");
    assert.equal(row.availableWithoutModel, true);assert.equal(row.template.settings.modelVersion, quality);
  }
  assert.equal(info.plan.video[0].settings.modelVersion, performance);
  assert.equal(info.plan.video[1].settings.modelVersion, missing, "an explicit unavailable row model remains visible");
  const simple = Effects.info({...entry, effects: undefined, graphics: {modelVersion: missing, spatialMethod: "ls1"}}, options);
  assert.equal(simple.catalog.find(row => row.id === "upscale:ls1").available, true, "Add keeps the compatible library default even beside an unavailable selected model");
  assert.equal(simple.plan.video[0].settings.modelVersion, missing);assert.deepEqual(entry, before);
  const selected = {...entry, effects: {...simple.plan, video: [...simple.plan.video, f.entry.effects.video[0]]}};
  const surviving = await Effects.prepare(selected, {...options, fallback: true, resolveModel: async (_directory, version) => {
    if (version === missing) throw new Error("The selected Lossless Scaling model is unavailable.");
    return {modelPath: "/models/" + version};
  }});
  assert.deepEqual(surviving.document.nodes.map(row => [row.id, row.enabled]), [[simple.plan.video[0].id, false], ["legacy-shader", true], ["tone", true]]);
  assert.deepEqual(surviving.preparationStatus.skipped.map(row => row.id), [simple.plan.video[0].id]);
  assert.equal(surviving.plan.video[0].settings.modelVersion, missing, "the unavailable selection stays saved while independent processing runs");
  f.record.features.graphics.effectPlanAPI = 0;fs.writeFileSync(path.join(f.root, "runtime.json"), JSON.stringify(f.record));
  assert.equal(Effects.info(entry, options).catalog.find(row => row.id === "upscale:ls1").availableWithoutModel, false,
    "a compatible row model must not override an unavailable ordered processor");
});
test("draft descriptions do not activate or publish a plan and use the full advanced parameter limit", async t => {
  const f = fixture(t), entry = { ...f.entry, effects: undefined }, before = structuredClone(entry), calls = [];
  t.mock.method(ReShade, "describeParameters", async (value, options) => { calls.push({ value, options });return { key: "key", parameters: [] }; });
  assert.deepEqual(await Effects.describe(entry, "tone", f.entry.effects, f.options), { key: "key", parameters: [] });
  assert.deepEqual(entry, before); assert.equal(calls[0].options.parameterLimit, 4096);
  assert.equal(calls[0].value.reshade.preset, "grayscale");
  assert.equal(fs.existsSync(Effects.file(entry, f.userDataDir)), false);
  await assert.rejects(Effects.describe(entry, "scale", f.entry.effects, f.options), /shader row/);
  await assert.rejects(Effects.describe(entry, "tone", { ...f.entry.effects, schema: 9 }, f.options), /newer schema/);
});
test("migration retains the compatible default model and binds that version on the first advanced edit", async t => {
  const f = fixture(t), Models = require("../src/modules/shared/reshade/models");
  const first = "sha256-" + "a".repeat(64), selected = "sha256-" + "b".repeat(64), resolved = [];
  const capabilities = { ls1Quality: { compatible: true }, lsfgFp16Quality: { compatible: true } };
  const installed = t.mock.method(Models, "listInstalled", () => [first, selected].map(version => ({ version, inspection: { capabilities } })));
  f.record.features.graphics.spatialMethods.push("ls1");
  f.record.features.graphics.frameGenerationMethods = ["lsfg"];
  f.record.features.graphics.presentation.hosts.window.frameGeneration = true;
  fs.writeFileSync(path.join(f.root, "runtime.json"), JSON.stringify(f.record));
  const entry = { gameId: "models", graphics: { spatialMethod: "ls1", frameGeneration: "lsfg" } }, before = structuredClone(entry);
  const options = { ...f.options, settings: { runtimes: { "graphics-models": { defaultVersion: selected } } },
    resolveModel: async (_directory, version, capability) => {
      resolved.push({ version, capability });
      if (![first, selected].includes(version)) throw new Error("Compatible Lossless Scaling models are unavailable for this selection.");
      return { modelPath: "/models/" + version };
    } };
  const draft = Effects.info(entry, options).plan;
  assert.ok(draft.video.every(node => node.settings.modelVersion === selected));assert.deepEqual(entry, before);
  assert.equal(fs.existsSync(Effects.file(entry, f.userDataDir)), false);
  const result = await Effects.prepare({ ...entry, effects: draft }, options);
  assert.equal(installed.mock.callCount(), 2, "the editor and selected LS launch each enumerate model metadata once");
  assert.ok(result.plan.video.every(node => node.settings.modelVersion === selected));
  assert.ok(result.document.nodes.every(node => node.modelPath === "/models/" + selected));
  assert.deepEqual(resolved.map(row => row.version), [selected, selected]);
  assert.ok(Effects.info(entry, { ...options, settings: {} }).plan.video.every(node => node.settings.modelVersion === first));
  const unavailable = { ...draft, video: draft.video.map(node => ({ ...node, settings: { ...node.settings, modelVersion: "sha256-" + "c".repeat(64) } })) };
  const previous = fs.readFileSync(result.file);
  await assert.rejects(Effects.prepare({ ...entry, effects: unavailable }, options), /Compatible Lossless Scaling models/);
  assert.deepEqual(fs.readFileSync(result.file), previous, "failed selected-model validation leaves the accepted publication intact");
});
test("live ordered model defaults retain the bound version when the library default changes", async t => {
  const f = fixture(t), Models = require("../src/modules/shared/reshade/models"), current = "sha256-" + "a".repeat(64), next = "sha256-" + "b".repeat(64);
  t.mock.method(Models, "listInstalled", () => [next, current].map(version => ({version, versionLabel: version,
    inspection: {capabilities: {lsfgFp16Quality: {compatible: true}}}})));
  f.record.features.graphics.frameGenerationMethods = ["lsfg"];f.record.features.graphics.presentation.hosts.window.frameGeneration = true;
  fs.writeFileSync(path.join(f.root, "runtime.json"), JSON.stringify(f.record));
  const entry = {...f.entry, reshade: {enabled: false}, effects: {schema: 1, mode: "advanced", video: [
    {id: "fg", kind: "frame-generation", enabled: true, method: "lsfg", settings: {modelVersion: null}}
  ]}}, directory = path.dirname(Effects.file(entry, f.userDataDir));fs.mkdirSync(directory, {recursive: true});
  fs.writeFileSync(path.join(directory, "launch.json"), JSON.stringify({effectPlanAPI: 1, pid: 20, liveModelVersion: null,
    effectPlanModels: ["/Models/Current.dll"], effectPlanBindings: {[current]: {path: "/Models/Current.dll", capabilities: ["lsfgFp16Quality"]}}}));
  const options = {...f.options, live: true, running: true, runningPids: [20], settings: {runtimes: {"graphics-models": {defaultVersion: next}}}};
  const prepared = await Effects.prepare(entry, options);
  assert.equal(prepared.deferred, undefined);assert.equal(prepared.plan.video[0].settings.modelVersion, current);
  assert.equal(prepared.document.nodes[0].modelPath, "/Models/Current.dll");
  const info = Effects.info(entry, options);assert.equal(info.live, true);assert.equal(info.plan.video[0].settings.modelVersion, current);
  const before = fs.readFileSync(prepared.file), explicit = {...entry, effects: {...entry.effects, video: [{...entry.effects.video[0], settings: {modelVersion: next}}]}};
  assert.equal((await Effects.prepare(explicit, options)).deferred, true);assert.deepEqual(fs.readFileSync(prepared.file), before);
});
test("compiled shader requirements bypass only the row whose depth order is invalid", async t => {
  const f = fixture(t), working = await Effects.prepare(f.entry, f.options);
  const source = path.join(f.root, "Depth.fx");fs.writeFileSync(source, "depth fixture");
  f.record.features.shaders.depth = { hosts: ["window"] };fs.writeFileSync(path.join(f.root, "runtime.json"), JSON.stringify(f.record));
  f.entry.effects.video[2].shader = { enabled: true, preset: "custom", effectPath: source };
  const execute = f.options.execute;
  const bypassed = await Effects.prepare(f.entry, { ...f.options, execute: async (...args) => {
    const result = await execute(...args);
    if (args[1][0] !== "--prepare" && fs.readFileSync(args[1][0], "utf8") === "depth fixture")
      fs.writeFileSync(path.join(args[1][1], "requirements.json"), JSON.stringify({ depth: true, motion: false }));
    return result;
  } });
  assert.match(bypassed.preparationStatus.skipped.find(row => row.id === "sharp").reason, /matching coordinates/);
  assert.deepEqual(bypassed.document.nodes.filter(node => node.enabled !== false).map(node => node.id), ["tone", "scale"],
    "the rows before it keep running");
  f.entry.effects.video = [f.entry.effects.video[2]];
  await Effects.prepare(f.entry, f.options);
  assert.equal(JSON.parse(fs.readFileSync(working.file)).nodes[0].requirements.depth, true);
});
test("source reduction follows surviving processing contracts after a scaler is unavailable", async t => {
  const f = fixture(t), source = path.join(f.temporary, "reconstruction.hook");
  const text = "//!DESC Neural reconstruction\n//!HOOK MAIN\n//!WIDTH HOOKED.w 2 *\n//!HEIGHT HOOKED.h 2 *\nvec4 hook(){return vec4(1);}";
  fs.writeFileSync(source, text);f.record.features.shaders.formats.push("libplacebo");
  fs.writeFileSync(path.join(f.root, "runtime.json"), JSON.stringify(f.record));
  const video = [
    {id: "scale", kind: "spatial", enabled: true, method: "metalfx", settings: {}},
    {id: "display", kind: "shader", enabled: true, shader: {preset: "cas"}}
  ], entry = {...f.entry, effects: {schema: 1, mode: "advanced", renderResolution: {multiplier: 2}, video}},
    options = {...f.options, fallback: true};
  const result = await Effects.prepare(entry, options);
  assert.deepEqual(result.document.nodes.map(node => [node.id, node.enabled]), [["source-resolution-fallback", true], ["scale", false], ["display", true]]);
  assert.deepEqual(result.plan.renderResolution, {multiplier: 2});assert.equal(result.environment.RESHADE_RENDER_MULTIPLIER, "2");
  t.mock.method(require("../src/modules/shared/reshade/live-effect"), "prepare", async (_entry, options) => {
    const revision = "a".repeat(64), effects = path.join(options.directory, "effects"), target = path.join(effects, revision);
    fs.mkdirSync(target, {recursive: true});fs.writeFileSync(path.join(target, "effect.hook"), text);
    fs.writeFileSync(path.join(options.directory, "live-selection.json"), JSON.stringify({revision, key: "b".repeat(64), format: "libplacebo"}));
    return effects;
  });
  const reconstruction = await Effects.prepare({...entry, effects: {...entry.effects, video: [video[0],
    {id: "reconstruct", kind: "shader", enabled: true, shader: {preset: "custom", effectPath: source}}
  ]}}, options);
  assert.equal(reconstruction.document.nodes[0].method, "downsample");
  const reconstruct = reconstruction.document.nodes.find(node => node.id === "reconstruct");
  assert.equal(reconstruct.kind, "shader");assert.deepEqual(reconstruct.outputScale, {x: 2, y: 2});
  assert.deepEqual(reconstruction.appliedPlan.renderResolution, {multiplier: 2});assert.equal(reconstruction.environment.RESHADE_RENDER_MULTIPLIER, "2");
});
test("contextual reconstruction templates use installed bindings and report missing setup without acquiring resources", t => {
  const f = fixture(t), Neural = require("../src/modules/shared/reshade/neural"), Models = require("../src/modules/shared/reshade/models");
  const version = "sha256-" + "e".repeat(64), modelPath = "/Models/Local.dlssmodel";
  t.mock.method(Neural, "resolve", () => ({library: "/Neural.dylib"}));
  t.mock.method(Neural, "listModels", () => [{version, modelPath, versionLabel: "Local model"}]);
  t.mock.method(Neural, "model", value => value);
  const models = t.mock.method(Models, "listInstalled", () => [{version, versionLabel: "Models", inspection: {capabilities: {lsfgFp16Quality: {compatible: true}}}}]);
  f.record.features.graphics.spatialMethods.push("metalfx");
  f.record.features.graphics.frameGenerationMethods = ["lsfg"];f.record.features.graphics.presentation.hosts.window.frameGeneration = true;
  fs.writeFileSync(path.join(f.root, "runtime.json"), JSON.stringify(f.record));
  const entry = {...f.entry, effects: undefined, graphics: {spatialMethod: "metalfx"}}, template = Effects.templates(entry, f.options)[0];
  assert.equal(template.available, true);assert.equal(template.id, "reconstruction-4x");
  assert.equal(template.plan.video.find(row => row.kind === "neural").settings.modelPath, modelPath);
  assert.equal(template.plan.video.find(row => row.kind === "frame-generation").settings.modelVersion, version);
  assert.deepEqual(template.plan.video.find(row => row.id === "legacy-neural-input").extent, {height:540});
  assert.equal(fs.existsSync(Effects.file(entry, f.userDataDir)), false);
  models.mock.restore();t.mock.method(Models, "listInstalled", () => []);
  const unavailable = Effects.templates(entry, f.options)[0];
  assert.equal(unavailable.available, false);assert.match(unavailable.reason, /Lossless Scaling models/);
});
test("contextual canonical reconstruction retains selected NR settings before legacy data",t=>{
 const f=fixture(t),Neural=require('../src/modules/shared/reshade/neural'),Models=require('../src/modules/shared/reshade/models'),version='sha256-'+ 'a'.repeat(64),selected='/Models/Selected.dlssmodel',preferred='/Models/Preferred.dlssmodel';
 t.mock.method(Neural,'resolve',()=>({library:'/Neural.dylib',supportedMethods:['mlx-dlss']}));
 t.mock.method(Neural,'listModels',()=>[{version:'preferred',method:'mlx-dlss',modelPath:preferred},{version:'selected',method:'mlx-dlss',modelPath:selected}]);
 t.mock.method(Neural,'model',(value,operation)=>{assert.equal(operation,'mlx-dlss');return value;});
 t.mock.method(Models,'listInstalled',()=>[{version,inspection:{capabilities:{lsfgFp16Quality:{compatible:true}}}}]);
 f.record.features.graphics.spatialMethods.push('metalfx');f.record.features.graphics.frameGenerationMethods=['lsfg'];f.record.features.graphics.presentation.hosts.window.frameGeneration=true;fs.writeFileSync(path.join(f.root,'runtime.json'),JSON.stringify(f.record));
 const entry={...f.entry,graphics:{spatialMethod:'bilinear',neuralModelPath:'/Legacy.dlssmodel',neuralIntensity:1,neuralTemporal:false},effects:{schema:2,mode:'advanced',enabled:true,video:[{id:'current',kind:'neural',method:'mlx-dlss',enabled:true,settings:{modelPath:selected,intensity:.35,temporal:true}},{id:'fit',kind:'upscale',method:'metalfx',enabled:true,settings:{}}]}},before=structuredClone(entry),options={...f.options,settings:{runtimes:{'graphics-neural-models':{defaultVersions:{'mlx-dlss':'preferred'}}}}};
 const template=Effects.templates(entry,options)[0];assert.equal(template.available,true);const nr=template.plan.video.find(row=>row.kind==='neural');assert.equal(nr.settings.modelPath,selected);assert.equal(nr.settings.intensity,.35);assert.equal(nr.settings.temporal,true);assert.ok(template.plan.video.some(row=>row.kind==='upscale'&&row.method==='metalfx'));
 entry.effects.video[0].settings.modelPath=null;const automatic=Effects.templates(entry,options)[0];assert.equal(automatic.plan.video.find(row=>row.kind==='neural').settings.modelPath,preferred);
 entry.effects.video[0].settings.modelPath=selected;assert.deepEqual(entry,before);assert.equal(fs.existsSync(Effects.file(entry,f.userDataDir)),false);
});
test("Clear effects publishes the document of an empty advanced chain", async t => {
  const f = fixture(t), empty = { ...f.entry, effects: { schema: 1, mode: "advanced", video: [] } };
  const prepared = await Effects.prepare(empty, f.options);
  assert.equal(prepared.document.mode, "advanced"); assert.deepEqual(prepared.document.nodes, []);
  const target = Effects.publishSimple(empty, f.userDataDir);
  assert.equal(target, prepared.file);
  assert.deepEqual(JSON.parse(fs.readFileSync(target)), prepared.document, "native code acknowledges it as pass-through with this revision");
  assert.deepEqual(Effects.emptyDocument(), prepared.document);
  assert.equal(fs.existsSync(path.join(path.dirname(target), "plan-nodes")), true);
  await assert.rejects(Effects.prepare(empty, { ...f.options, live: true }), /Restart the game/);
  fs.writeFileSync(path.join(path.dirname(target), "launch.json"), JSON.stringify({ effectPlanAPI: 1, effectPlanModels: [] }));
  await Effects.prepare(empty, { ...f.options, live: true });
  f.record.features.graphics.effectPlanAPI = 0;fs.writeFileSync(path.join(f.root, "runtime.json"), JSON.stringify(f.record));
  await assert.rejects(Effects.prepare(empty, f.options), /unavailable/);
  assert.ok(Effects.info(empty, f.options).catalog.every(row => !row.available));
});
test("ordered temporal rows retain pending requirements until the exact producer lineage supplies scene inputs", t => {
  const f = fixture(t), graphics = f.record.features.graphics;
  graphics.effectPlanKinds = ["shader", "spatial", "temporal", "frame-generation"];
  graphics.temporalMethods = ["metalfx"];graphics.presentation.hosts.window.temporal = true;
  graphics.effectPlanTemporal = { source: "original-metalfx", output: "acquired-drawable", commandBuffer: "classic", hosts: ["window"] };
  fs.writeFileSync(path.join(f.root, "runtime.json"), JSON.stringify(f.record));
  const input = { depth: true, motionVectors: true, methods: ["metalfx"] };
  const row = graphicsInputs => Effects.info(f.entry, { ...f.options, graphicsInputs }).catalog.find(row => row.id === "temporal:metalfx");
  assert.equal(row(input).available, true);assert.ok(row(input).pendingInputs.includes("scene-frame"));
  const exact = { ...input, temporalSource: "original-metalfx", temporalOutput: "acquired-drawable", commandBuffer: "classic" };
  assert.equal(row(exact).available, true);
  assert.equal(row(exact).pendingInputs,undefined);
  for (const changed of [{ temporalOutput: "offscreen" }, { commandBuffer: "metal4" }, { temporalSource: "camera" }, { motionVectors: false }]){
    const pending=row({...exact,...changed});assert.equal(pending.available,true);assert.ok(pending.pendingInputs.length);
  }
  assert.equal(row({...input,sceneFrameAPI:1}).pendingInputs,undefined);
  const windowScene={...input,sceneFrameAPI:1,sceneDestinationAPI:1};
  assert.ok(row(windowScene).pendingInputs.includes("scene-frame"));
  graphics.sceneWindowContinuationAPI=1;
  fs.writeFileSync(path.join(f.root,"runtime.json"),JSON.stringify(f.record));
  assert.equal(row(windowScene).pendingInputs,undefined);
  assert.ok(row({...windowScene,motionVectors:false}).pendingInputs.includes("motion"));
});
test("sandbox grants prepared plan and Slang resources without granting source folders or writable profiles", async t => {
  const f = fixture(t), prepared = await Effects.prepare(f.entry, f.options);
  const slang = path.join(f.temporary, "shared-slang"), model = path.join(f.temporary, "model.dll");
  fs.mkdirSync(slang);fs.writeFileSync(path.join(slang, "effect.slangp"), "shaders=0");fs.writeFileSync(model, "model");
  const staging = path.join(f.temporary, "sandbox"), output = path.join(f.temporary, "output");fs.mkdirSync(staging);fs.mkdirSync(output);
  const scoped = await Sandbox.isolateGraphics({ RESHADE_EFFECT_PLAN: prepared.file,
    RESHADE_EFFECT_PLAN_ROOT: path.join(path.dirname(prepared.file), "plan-nodes"), RESHADE_EFFECT_PLAN_MODELS: JSON.stringify([model]),
    RESHADE_EFFECT: path.join(slang, "effect.slangp"), RESHADE_RETROARCH_ROOT: slang,
    RESHADE_CAPTURE_PREFIX: "/outside/capture", RESHADE_CAPTURE_TRIGGER: "/outside/request" }, staging, output);
  assert.ok(scoped.readable.includes(prepared.file));assert.ok(scoped.readable.includes(model));
  assert.deepEqual(scoped.readableDirectories.sort(), [slang, path.join(path.dirname(prepared.file), "plan-nodes")].sort());
  assert.ok(!scoped.readableDirectories.includes(f.userDataDir));assert.ok(!scoped.readableDirectories.includes(f.temporary));
  assert.equal(scoped.graphics.RESHADE_CAPTURE_PREFIX, path.join(output, "frame-capture"));
  assert.equal(scoped.graphics.RESHADE_CAPTURE_TRIGGER, path.join(output, "frame-capture.request"));
  t.mock.method(console, "warn", () => {});
  assert.deepEqual(await Sandbox.isolateGraphics({ RESHADE_RETROARCH_ROOT: slang, RESHADE_EFFECT: model }, staging, output),
    {graphics: {}, readable: [], readableDirectories: [], executables: [], capabilities: "", fileExtensions: {}});
});

test('comparison output respects the mapped payload and Off remains compatible with older parsers',async t=>{
 const f=fixture(t),output={comparison:{mode:'wipe',position:.25,gain:2}},entry={...f.entry,effects:{schema:2,mode:'advanced',enabled:true,video:[],output}};
 await assert.rejects(Effects.prepare(entry,f.options),/comparison requires an updated graphics runtime/);
 const off={...entry,effects:{...entry.effects,output:{comparison:{...output.comparison,mode:'off'}}}},old=await Effects.prepare(off,f.options);assert.equal(old.document.output,undefined);assert.deepEqual(old.plan.output,off.effects.output);
 f.record.features.graphics.comparisonAPI=1;fs.writeFileSync(path.join(f.root,'runtime.json'),JSON.stringify(f.record));
 const prepared=await Effects.prepare(entry,f.options);assert.deepEqual(prepared.document.output,output);assert.equal(prepared.document.nodes.length,0);assert.equal(require('../src/modules/shared/effects/live-plan').validDocument(prepared.document),true);assert.equal(prepared.environment.RESHADE_NEURAL_LIBRARY,undefined);assert.equal(prepared.environment.RESHADE_RENDER_HEIGHT,undefined);
});
test('tone mapping prepares output-only plans and old cores retain independent rows with explicit pending output',async t=>{
 const f=fixture(t),output={toneMapping:'pbr-neutral'},entry={...f.entry,effects:{schema:2,mode:'advanced',enabled:true,video:f.entry.effects.video,output}},before=structuredClone(entry);
 const fallback=await Effects.prepare(entry,f.options);
 assert.equal(fallback.document.output,undefined);assert.equal(fallback.document.nodes.filter(row=>row.enabled).length,3);
 assert.deepEqual(fallback.plan.output,output);assert.equal(fallback.appliedPlan.output,undefined);
 assert.equal(fallback.preparationStatus.output.applied,null);assert.match(fallback.preparationStatus.output.pending[0].reason,/Automatic mapping remains active/);
 f.record.features.graphics.outputColorAPI=1;fs.writeFileSync(path.join(f.root,'runtime.json'),JSON.stringify(f.record));
 const empty={...entry,effects:{...entry.effects,video:[]}},prepared=await Effects.prepare(empty,f.options);
 assert.deepEqual(prepared.document.output,output);assert.equal(prepared.document.nodes.length,0);
 assert.equal(prepared.environment.RESHADE_NEURAL_LIBRARY,undefined);assert.equal(prepared.environment.RESHADE_RENDER_HEIGHT,undefined);
 assert.equal(prepared.preparationStatus.output.pending,undefined);
 const automatic=await Effects.prepare({...empty,effects:{...empty.effects,output:{toneMapping:'auto'}}},f.options);
 assert.equal(automatic.document.output,undefined);assert.deepEqual(automatic.plan.output,{toneMapping:'auto'});assert.deepEqual(entry,before);
});
test('sizing helpers retire with an Off or missing owner while independent rows prepare',async t=>{
 const f=fixture(t),Neural=require('../src/modules/shared/reshade/neural');t.mock.method(Neural,'listModels',()=>[]);
 const helpers=owner=>[{id:'auto-nr-input-nr',kind:'downsample',method:'bilinear',enabled:true,settings:{},extent:{relativeTo:'presentation',automatic:true},ownedBy:{id:'nr',role:'input'}},
  ...owner,{id:'auto-nr-fit-nr',kind:'upscale',method:'bilinear',enabled:true,settings:{},ownedBy:{id:'nr',role:'fit'}}];
 const off={id:'nr',kind:'neural',method:'mlx-dlss',enabled:false,settings:{modelPath:null,intensity:1,temporal:false}};
 for(const video of [helpers([off]),helpers([])]){
  const effects=require('../src/modules/shared/effects/edit-operations.mjs').migrateOwnership({schema:2,mode:'advanced',enabled:true,renderResolution:{multiplier:2,managedBy:'nr'},video:[...video,...f.entry.effects.video]});
  const entry={...f.entry,effects},before=structuredClone(entry);
  const result=await Effects.prepare(entry,{...f.options,ensureNeuralModel:()=>assert.fail('an Off owner needs no model')});
  assert.deepEqual(result.document.nodes.filter(node=>node.enabled).map(node=>node.id),['tone','scale','sharp']);
  assert.equal((result.preparationStatus.pending||[]).some(row=>row.id.startsWith('auto-nr-')),false,'retired helpers are not pending');
  assert.equal(result.preparationStatus.sourceResolution?.requested??null,null,'the owner\'s source request retires with it');assert.deepEqual(entry,before);
 }
});
test("one unreadable row is left out at launch and in the editor while the other rows run", async t => {
  const f = fixture(t), {reshade: _shader, ...base} = f.entry;
  const broken = {id: "broken", kind: "shader", enabled: true, shader: {preset: "cas"}, future: true};
  const entry = {...base, effects: {schema: 2, mode: "advanced", enabled: true, video: [f.entry.effects.video[0], broken]}}, before = structuredClone(entry);
  const info = Effects.info(entry, f.options);
  assert.deepEqual(info.plan.video.map(row => row.id), ["tone"]);assert.equal(info.graphicsPlanError, undefined);
  assert.equal(info.notices.length, 1);assert.match(info.notices[0].message, /^The saved effect “cas” is skipped\./);
  const result = await Effects.prepare(entry, {...f.options, fallback: true});
  assert.deepEqual(result.document.nodes.map(node => node.id), ["tone"]);
  assert.deepEqual(result.preparationStatus.skipped.map(row => row.id), ["broken"]);
  assert.deepEqual(entry, before, "the saved plan is kept until an edit");
});

