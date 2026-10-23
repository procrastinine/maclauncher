const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const Effects = require("../src/modules/shared/effects/runtime"), ReShade = require("../src/modules/shared/reshade");
const Sandbox = require("../src/modules/shared/runtime/macos-sandbox");
test("Auto editor conversion uses only the exact current source receipt and keeps non-Auto reads absent", t => {
  const f = fixture(t), Controls = require("../src/modules/shared/reshade/source-controls"), Neural = require("../src/modules/shared/reshade/neural");
  t.mock.method(Neural, "resolve", () => ({library: "/Neural.dylib"}));
  const entry = {...f.entry, effects: undefined, reshade: {enabled: false},
    graphics: {neuralMethod: "mlx-dlss", neuralModelPath: "/Models/Local.dlssmodel"}};
  const support = {control: "virtual", live: true, activationAPI: 1, automatic: true, heights: true, multipliers: [1, 2, 3]};
  const {binding} = Controls.prepare(entry, {userDataDir: f.userDataDir, support, launchId: "auto-draft", source: {automatic: true}});
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
  const ratio = (selected = entry, context = options) => Effects.info(selected, context).plan.video.find(row => row.id === "legacy-neural-input")?.presentationScale;
  acknowledge(960, 540, 3840, 2160);
  assert.equal(ratio(), .25);assert.equal(reads, 1);
  acknowledge(854, 480, 2560, 1440);
  assert.equal(ratio(), 1 / 3);assert.equal(reads, 2);
  acknowledge(1000, 563, 1000, 1400);
  assert.equal(ratio(), 1, "letterboxed content uses its fitted short edge, not the whole portrait window");
  for (const changed of [{epoch: command.epoch + 1}, {revision: "0".repeat(64)}, {launchId: "another-launch"}, {reason: "Waiting for a completed image."}]) {
    acknowledge(960, 540, 3840, 2160, changed);assert.equal(ratio(), .5, "an unverified receipt keeps the manual baseline");
  }
  fs.unlinkSync(binding.statusFile);assert.equal(ratio(), .5);
  acknowledge(960, 540, 3840, 2160);
  reads = 0;
  assert.equal(ratio(entry, {...options, runningPids: [72]}), .5, "another process cannot supply the editor's presentation");
  ratio({...entry, graphics: {neuralMethod: "off"}});
  ratio({...entry, reshade: {enabled: true, preset: "grayscale"}, graphics: {}});
  assert.equal(ratio({...entry, graphics: {...entry.graphics, neuralInputScale: .5}}), .5);
  assert.equal(ratio(entry, {...options, running: false}), .5);
  ratio({...entry, effects: {schema: 1, mode: "advanced", video: []}});
  ratio(entry, {...options, graphicsInputs: {nativeVideo: true}});
  assert.equal(reads, 0, "Off, shader-only, explicit scale, stopped, Advanced and default video do no receipt reads");
});
test("Simple Auto sizing is prepared metadata and ordinary Advanced sizing remains explicit", async t => {
  const f = fixture(t), row = {id: "legacy-neural-input", kind: "spatial", enabled: true, method: "downsample", presentationScale: .5, settings: {spatialMultiplier: null}};
  const entry = {...f.entry, effects: {...f.entry.effects, video: [row]}}, before = structuredClone(entry);
  const manual = await Effects.prepare(entry, f.options);assert.equal(manual.document.nodes[0].resolutionAuto, undefined);
  const automatic = await Effects.prepare(entry, {...f.options, automaticResolutionNode: row.id});
  assert.equal(automatic.document.nodes[0].resolutionAuto, true);assert.equal(automatic.document.nodes[0].presentationScale, .5);
  const height = {...entry, effects: {...entry.effects, video: [{...row, presentationScale: undefined, outputSize: {height: 480}}]}};
  const adaptiveHeight = await Effects.prepare(height, {...f.options, automaticResolutionNode: row.id});
  assert.equal(adaptiveHeight.document.nodes[0].resolutionAuto, true);assert.equal(adaptiveHeight.document.nodes[0].outputSize, undefined);
  assert.deepEqual((await Effects.prepare(height, f.options)).document.nodes[0].outputSize, {height: 480});
  assert.deepEqual(entry, before);
});
test("Simple neural Auto binds an adaptive source only to a compatible selected runtime", async t => {
  const f = fixture(t), Neural = require("../src/modules/shared/reshade/neural");
  t.mock.method(Neural, "resolve", () => ({library: "/Neural.dylib"}));
  t.mock.method(Neural, "prepare", settings => ({settings, environment: {RESHADE_NEURAL_LIBRARY: "/Neural.dylib"}}));
  Object.assign(f.record.features.graphics, {virtualWindowAPI: 1, virtualSourceControlAPI: 1, virtualSourceActivationAPI: 1, virtualSourceAutoAPI: 1});
  fs.writeFileSync(path.join(f.root, "runtime.json"), JSON.stringify(f.record));
  const entry = {...f.entry, effects: undefined, reshade: {enabled: false},
    graphics: {neuralMethod: "mlx-dlss", neuralModelPath: "/Models/Local.dlssmodel", spatialMethod: "bilinear"}};
  const options = {...f.options, graphicsInputs: {}};
  const environment = await ReShade.prepare(entry, options);
  assert.equal(environment.RESHADE_RENDER_AUTO, "1");assert.equal(environment.RESHADE_RENDER_MULTIPLIER, undefined);
  assert.equal(environment.RESHADE_RENDER_HEIGHT, undefined);assert.equal(environment.RESHADE_RENDER_SOURCE_CONTROL, "virtual");
  const launch = JSON.parse(fs.readFileSync(path.join(path.dirname(environment.RESHADE_EFFECT_PLAN), "launch.json")));
  assert.deepEqual(JSON.parse(fs.readFileSync(launch.sourceControl.file)).source, {automatic: true});
  assert.deepEqual(launch.graphicsPreparation.sourceResolution.requested, {automatic: true});
  assert.equal(launch.sourceControl.support.automatic, true);
  const document = JSON.parse(fs.readFileSync(environment.RESHADE_EFFECT_PLAN));
  assert.equal(document.nodes.filter(node => node.resolutionAuto).length, 1, "native fallback reuses the same adaptive reduction");
  assert.deepEqual(document.nodes.map(node => node.kind), ["spatial", "neural", "spatial"]);
  const draft = ReShade.automaticPlan(entry, {...options, draftPlan: true, presentationSize: {width: 3840, height: 2160}});
  assert.equal(draft.renderResolution, undefined);assert.equal(draft.video[0].presentationScale, .25);
  assert.doesNotThrow(() => require("../src/modules/shared/effects/plan").validate(draft));
  const thirds = ReShade.automaticPlan(entry, {...options, draftPlan: true, presentationSize: {width: 2560, height: 1440}});
  assert.equal(thirds.video[0].presentationScale, 1 / 3);assert.equal(thirds.video[0].outputSize, undefined);
  delete f.record.features.graphics.virtualSourceAutoAPI;
  fs.writeFileSync(path.join(f.root, "runtime.json"), JSON.stringify(f.record));
  const fallback = await ReShade.prepare(entry, options), fallbackLaunch = JSON.parse(fs.readFileSync(path.join(path.dirname(fallback.RESHADE_EFFECT_PLAN), "launch.json")));
  assert.equal(fallback.RESHADE_RENDER_AUTO, undefined);
  assert.equal(fallbackLaunch.graphicsPreparation.sourceResolution.strategy, "processing");
  assert.equal(JSON.parse(fs.readFileSync(fallback.RESHADE_EFFECT_PLAN)).nodes.filter(node => node.resolutionAuto).length, 1);
  assert.equal(JSON.parse(fs.readFileSync(fallbackLaunch.sourceControl.file)).source, null);
});
test("automatic source allocation disappears with unavailable reconstruction and stays out of video defaults", async t => {
  const f = fixture(t), entry = {...f.entry, effects: undefined, reshade: {enabled: false},
    graphics: {neuralMethod: "mlx-dlss", spatialMethod: "bilinear"}};
  Object.assign(f.record.features.graphics, {virtualWindowAPI: 1, virtualSourceControlAPI: 1, virtualSourceActivationAPI: 1, virtualSourceAutoAPI: 1});
  fs.writeFileSync(path.join(f.root, "runtime.json"), JSON.stringify(f.record));
  const environment = await ReShade.prepare(entry, {...f.options, graphicsInputs: {}});
  assert.equal(environment.RESHADE_RENDER_AUTO, undefined);
  assert.equal(JSON.parse(fs.readFileSync(environment.RESHADE_EFFECT_PLAN)).nodes.some(node => node.resolutionAuto), false);
  assert.equal(ReShade.automaticResolutionOptions(entry, {...f.options, graphicsInputs: {nativeVideo: true}}).automaticSourceResolution, undefined);
  assert.equal(ReShade.automaticResolutionOptions({...entry, graphics: {neuralMethod: "off"}}, f.options).automaticSourceResolution, undefined);
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
test("ordinary Advanced launch preserves requested settings and reports unavailable stages while retaining independent effects", async t => {
  const f=fixture(t),warnings=[];
  f.entry.effects.video[0]={id:"selected",kind:"neural",enabled:true,method:"mlx-dlss",settings:{modelPath:null}};
  const selected=structuredClone(f.entry);
  const environment=await ReShade.prepare(f.entry,{...f.options,logger:{warn:message=>warnings.push(message)}});
  const document=JSON.parse(fs.readFileSync(environment.RESHADE_EFFECT_PLAN));
  assert.deepEqual(document.nodes.map(node=>node.enabled),[false,true,true,false]);
  assert.deepEqual(f.entry,selected);
  const launch=JSON.parse(fs.readFileSync(path.join(path.dirname(environment.RESHADE_EFFECT_PLAN),"launch.json")));
  assert.equal(launch.effectPlanAutomatic,false);
  assert.equal(launch.graphicsPreparation.requested[0].method,"mlx-dlss");
  assert.equal(launch.graphicsPreparation.applied.some(node=>node.id==="selected"),false);
  assert.equal(launch.graphicsWarnings[0].id,"selected");
  assert.match(launch.graphicsWarnings[0].reason,/neural|model|provider/i);
  assert.ok(warnings.some(message=>/Skipping selected/.test(message)));
});
test("automatic Simple retains valid shader and scaler while reporting unavailable optional reconstruction", async t => {
  const f = fixture(t), entry = {...f.entry, effects: undefined,
    graphics: {neuralMethod: "mlx-dlss", neuralModelPath: null, spatialMethod: "bilinear"}};
  const environment = await ReShade.prepare(entry, f.options), document = JSON.parse(fs.readFileSync(environment.RESHADE_EFFECT_PLAN));
  assert.deepEqual(document.nodes.map(node => [node.id, node.enabled]), [["legacy-neural", false], ["legacy-spatial", true], ["legacy-shader", true]]);
  const launch = JSON.parse(fs.readFileSync(path.join(path.dirname(environment.RESHADE_EFFECT_PLAN), "launch.json")));
  assert.deepEqual(launch.graphicsPreparation.applied.map(node => node.kind), ["spatial", "shader"]);
  assert.deepEqual(launch.graphicsWarnings.map(node => node.method), ["mlx-dlss"]);
  assert.equal(launch.graphicsPreparation.sourceResolution.applied, null);
  assert.equal(entry.graphics.neuralMethod, "mlx-dlss");assert.equal(entry.effects, undefined);
});
test("automatic Simple bypasses failed shaders and incompatible stages while retaining independent effects", async t => {
  const f = fixture(t), working = await Effects.prepare(f.entry, f.options), before = fs.readFileSync(working.file);
  const entry = {...f.entry, effects: undefined, graphics: {spatialMethod: "bilinear", neuralMethod: "mlx-dlss"},
    reshade: {enabled: true, preset: "custom", effectPath: "/missing.fx"}};
  const missing = await ReShade.prepare(entry, f.options), partial = JSON.parse(fs.readFileSync(missing.RESHADE_EFFECT_PLAN));
  assert.equal(partial.nodes.find(node => node.kind === "shader").enabled, false);
  assert.equal(partial.nodes.find(node => node.method === "bilinear").enabled, true);
  const missingLaunch = JSON.parse(fs.readFileSync(path.join(path.dirname(missing.RESHADE_EFFECT_PLAN), "launch.json")));
  assert.ok(missingLaunch.graphicsWarnings.some(node => node.kind === "shader" && /shader|existing/i.test(node.reason)));
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
  const remainder = JSON.parse(fs.readFileSync(incompatible.RESHADE_EFFECT_PLAN));
  assert.equal(remainder.nodes.find(node => node.kind === "temporal").enabled, false);
  assert.equal(remainder.nodes.find(node => node.kind === "shader").enabled, true);
  assert.equal(remainder.nodes.find(node => node.method === "bilinear").enabled, true);
  const conflictLaunch = JSON.parse(fs.readFileSync(path.join(path.dirname(incompatible.RESHADE_EFFECT_PLAN), "launch.json")));
  assert.ok(conflictLaunch.graphicsWarnings.some(node => node.kind === "temporal" && /Depth and motion effects must precede/.test(node.reason)));
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
  assert.deepEqual(Effects.info(f.entry, explicit).sourceResolution, {heights: false, multipliers: [1, 1.5, 2]});
  const prepared = await Effects.prepare(f.entry, explicit);
  assert.equal(prepared.environment.RESHADE_RESOLUTION_MULTIPLIER, "2");
  assert.equal(prepared.environment.RESHADE_RENDER_MULTIPLIER, undefined);
  assert.deepEqual(prepared.appliedPlan.renderResolution, {multiplier: 2});
  const remote = {...f.options, graphicsHost: "remote", logger: {warn: message => warnings.push(message)}};
  assert.deepEqual(Effects.info(f.entry, remote).sourceResolution, {heights: false, multipliers: []});
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
  assert.deepEqual(Effects.info(f.entry, {...f.options, graphicsInputs: {nativeVideo: true}}).sourceResolution, {heights: false, multipliers: []});
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
  assert.equal(automatic.document.nodes[0].resolutionAuto, undefined, "fixed source target remains independent of Auto's current divisor");
  assert.equal(automatic.document.nodes[1].resolutionAuto, true);
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
test("Simple to Advanced keeps source divisors separate from automatic final stage size", t => {
  const f = fixture(t), entry = {...f.entry, effects: undefined, graphics: {spatialMethod: "bilinear", spatialMultiplier: 2}};
  const info = Effects.info(entry, f.options);
  assert.equal(info.mode, "simple");
  assert.deepEqual(info.plan.renderResolution, {multiplier: 2});
  assert.equal(info.plan.video.find(row => row.kind === "spatial").settings.spatialMultiplier, null);
  assert.deepEqual(ReShade.automaticPlan(entry, f.options).video.map(row => row.kind), ["spatial", "shader"], "mixed Simple places display effects after scaling");
  assert.deepEqual(ReShade.automaticPlan({...entry, reshade: {enabled: false}}, f.options).renderResolution,
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
    assert.equal(node.outputExtent, index > 0 && index < 4 ? "presentation" : undefined);
    const simple = { ...entry, effects: undefined, graphics: { spatialMethod: "off" }, reshade: entry.effects.video[0].shader };
    assert.equal(Boolean(ReShade.automaticPlan(simple, f.options)), index < 4);
    const selected = Effects.info(simple, f.options).selectedShaderTraits;
    assert.equal(Boolean(selected.outputScale || selected.unresolvedGeometry), index < 4);
  }
  assert.equal(ReShade.automaticPlan({ reshade: { enabled: true, preset: "crt" } }, f.options), null);
});
test("included virtual presentation enables generic source sizing without overriding engine control", async t => {
  const f = fixture(t);
  f.record.features.graphics.virtualWindowAPI = 1;
  fs.writeFileSync(path.join(f.root, "runtime.json"), JSON.stringify(f.record));
  const options = {...f.options, graphicsInputs: {}};
  f.entry.effects.renderResolution = {multiplier: 2};
  assert.deepEqual(Effects.info(f.entry, options).sourceResolution, {heights: true, multipliers: [1, 1.5, 2, 3]});
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
function acknowledgePlan(t, f, document) {
  return t.mock.method(require("../src/modules/shared/reshade/runtime-status"), "accepted", () => {
    const binding = require("../src/modules/shared/reshade/launch-binding").read(f.entry, f.options);
    return {launchId: binding?.launchId, launchPid: binding?.pid, revision: document.revision};
  });
}
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
test("Simple live enable, managed model switch, parameter edits and disable publish the complete chain", async t => {
  const f = await liveFixture(t), lossless = f.add("lossless", "a"), neural = f.add("neural", "b");
  let entry = {...f.entry, reshade: {enabled: true, preset: "grayscale"}, graphics: {frameGeneration: "lsfg", frameMultiplier: 5,
    neuralMethod: "mlx-dlss", neuralModelPath: neural.modelPath, neuralIntensity: .8, neuralTemporal: true, neuralInputScale: .5}};
  assert.notEqual(await ReShade.validateLiveGraphics(entry, f.options), false);
  await ReShade.updateLive(entry, f.options);
  let document = JSON.parse(fs.readFileSync(f.environment.RESHADE_EFFECT_PLAN));
  assert.equal(document.nodes.find(node => node.kind === "neural").modelPath, neural.modelPath);
  assert.equal(document.nodes.find(node => node.method === "lsfg").settings.frameMultiplier, 5);
  assert.equal(document.nodes.find(node => node.method === "lsfg").modelPath, lossless.modelPath);
  assert.ok(document.nodes.some(node => node.kind === "shader" && node.enabled));
  const replacement = f.add("lossless", "c"), nextNeural = f.add("neural", "d");
  entry = {...entry, graphics: {...entry.graphics, modelVersion: replacement.version, neuralModelPath: nextNeural.modelPath, neuralIntensity: .3, neuralTemporal: false, neuralInputScale: .25}};
  await ReShade.updateAutomaticEffects(entry, f.options);
  document = JSON.parse(fs.readFileSync(f.environment.RESHADE_EFFECT_PLAN));
  assert.equal(document.nodes.find(node => node.kind === "neural").modelPath, nextNeural.modelPath);
  assert.equal(document.nodes.find(node => node.kind === "neural").settings.intensity, .3);
  assert.equal(document.nodes.find(node => node.kind === "neural").settings.temporal, false);
  assert.equal(document.nodes.find(node => node.method === "lsfg").modelPath, replacement.modelPath);
  assert.ok(f.checked.some(([version, capability]) => version === nextNeural.version && capability === "neural"));
  assert.ok(f.leased.includes(replacement.version));assert.ok(f.leased.includes(nextNeural.version));
  await ReShade.updateAutomaticEffects(f.entry, f.options);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.environment.RESHADE_EFFECT_PLAN)).nodes, []);
});
test("Simple ordinary return prepares its bound root shader before publishing inactive ordered mode", async t => {
  const f = await liveFixture(t), Live = require("../src/modules/shared/reshade/live-controls"),
    heavy = {...f.entry, reshade: {enabled: true, preset: "grayscale"}, graphics: {spatialMethod: "bilinear"}};
  await ReShade.updateLive(heavy, f.options);
  const directory = path.dirname(f.environment.RESHADE_EFFECT_PLAN), launchFile = path.join(directory, "launch.json");
  fs.writeFileSync(launchFile, JSON.stringify({...f.launch, effectPlanAutomatic: true}));
  const before = fs.readFileSync(f.environment.RESHADE_EFFECT_PLAN), ordinary = {...heavy, graphics: {}}, publication = ReShade.createPublication();
  t.mock.method(Effects, "prepare", () => assert.fail("ordinary Simple must not recreate ordered processing"));
  assert.equal(ReShade.executionRequirements(ordinary).needed.presentation, false);
  assert.equal(await ReShade.updateAutomaticEffects(ordinary, {...f.options, publication}), true);
  Live.write(ordinary, f.userDataDir, {publication});
  assert.deepEqual(fs.readFileSync(f.environment.RESHADE_EFFECT_PLAN), before, "accepted plan remains active during compilation");
  const selection = JSON.parse(publication.read(path.join(directory, "live-selection.json"), "utf8"));
  assert.ok(fs.existsSync(path.join(f.environment.RESHADE_LIVE_EFFECTS, selection.revision, "effect.prepared.fx")), "selection uses the actual launch-bound root");
  assert.equal(publication.read(Live.file(ordinary, f.userDataDir)).toString("ascii", 88, 152), selection.revision);
  assert.equal(JSON.parse(publication.read(f.environment.RESHADE_EFFECT_PLAN, "utf8")).mode, "simple");
  assert.equal(publication.metadata.sourceResolutionCandidate, null);
  publication.commit();assert.equal(JSON.parse(fs.readFileSync(f.environment.RESHADE_EFFECT_PLAN)).mode, "simple");
});
test("Simple ordinary return keeps the accepted plan when root shader compilation fails", async t => {
  const f = await liveFixture(t), heavy = {...f.entry, reshade: {enabled: true, preset: "grayscale"}, graphics: {spatialMethod: "bilinear"}};
  await ReShade.updateLive(heavy, f.options);
  const before = fs.readFileSync(f.environment.RESHADE_EFFECT_PLAN), publication = ReShade.createPublication(), source = path.join(f.root, "effects", "invalid.fx");
  fs.writeFileSync(source, "rejected source");
  const ordinary = {...heavy, graphics: {}, reshade: {enabled: true, preset: "custom", effectPath: source}};
  await assert.rejects(ReShade.updateAutomaticEffects(ordinary, {...f.options, publication,
    execute: async () => {throw Error("ordinary compiler rejected source");}}), /ordinary compiler rejected source/);
  assert.deepEqual(fs.readFileSync(f.environment.RESHADE_EFFECT_PLAN), before);
  assert.deepEqual(publication.read(f.environment.RESHADE_EFFECT_PLAN), before);publication.rollback();
});
test("Simple ordinary return cannot activate a root selection after launch replacement", async t => {
  const f = await liveFixture(t), heavy = {...f.entry, reshade: {enabled: true, preset: "grayscale"}, graphics: {spatialMethod: "bilinear"}};
  await ReShade.updateLive(heavy, f.options);
  const publication = ReShade.createPublication(), gate = pauseShaderPreparation(t, {after: true}), directory = path.dirname(f.environment.RESHADE_EFFECT_PLAN);
  const pending = ReShade.updateAutomaticEffects({...heavy, graphics: {}}, {...f.options, publication});
  await gate.started;
  fs.writeFileSync(path.join(directory, "launch.json"), JSON.stringify({...f.launch, pid: 21, launchId: "replacement"}));
  const replacement = JSON.stringify({schema: 1, mode: "advanced", revision: "e".repeat(64), nodes: []});fs.writeFileSync(f.environment.RESHADE_EFFECT_PLAN, replacement);
  gate.release();await pending;
  assert.equal(publication.deferred, true);assert.equal(fs.readFileSync(f.environment.RESHADE_EFFECT_PLAN, "utf8"), replacement);
  assert.equal(fs.existsSync(path.join(directory, "live-selection.json")), false);publication.rollback();
});
test("Simple ordinary return to all-off compiles nothing and restores Simple mode", async t => {
  const f = await liveFixture(t), entry = {...f.entry, reshade: {enabled: true, preset: "grayscale"}, graphics: {spatialMethod: "bilinear"}};
  await ReShade.updateLive(entry, f.options);
  const publication = ReShade.createPublication();
  await ReShade.updateAutomaticEffects(f.entry, {...f.options, publication, execute: () => assert.fail("all-off must not compile a shader")});
  assert.deepEqual(JSON.parse(publication.read(f.environment.RESHADE_EFFECT_PLAN, "utf8")).nodes, []);
  assert.equal(JSON.parse(publication.read(f.environment.RESHADE_EFFECT_PLAN, "utf8")).mode, "simple");
  publication.commit();
});
for (const method of ["ls1", "lsfg"]) test(`Simple standalone models retain ordered live ${method} setup from all-off`, async t => {
  const f = await liveFixture(t), model = f.add("lossless", method === "ls1" ? "a" : "b");
  assert.equal(f.environment.RESHADE_LOSSLESS_MODEL, undefined, "the initial legacy environment has no model binding");
  const entry = {...f.entry, graphics: {...(method === "ls1" ? {spatialMethod: method} : {frameGeneration: method}), modelVersion: model.version}};
  assert.notEqual(await ReShade.validateLiveGraphics(entry, f.options), false);
  await ReShade.updateAutomaticEffects(entry, f.options);
  const document = JSON.parse(fs.readFileSync(f.environment.RESHADE_EFFECT_PLAN));
  assert.equal(document.mode, "advanced");assert.equal(document.nodes.find(node => node.method === method).modelPath, model.modelPath);
  assert.ok(f.checked.some(([version]) => version === model.version));assert.ok(f.leased.includes(model.version));
});
test("Simple ordinary return keeps an unbound legacy shader channel and explicit Advanced plans ordered", async t => {
  const f = await liveFixture(t), directory = path.dirname(f.environment.RESHADE_EFFECT_PLAN), launchFile = path.join(directory, "launch.json");
  fs.writeFileSync(launchFile, JSON.stringify({...f.launch, live: false, effectPlanAutomatic: true}));
  const ordinary = {...f.entry, reshade: {enabled: true, preset: "grayscale"}};
  await ReShade.updateAutomaticEffects(ordinary, f.options);
  assert.equal(JSON.parse(fs.readFileSync(f.environment.RESHADE_EFFECT_PLAN)).mode, "advanced");
  fs.writeFileSync(launchFile, JSON.stringify({...f.launch, live: true, effectPlanAutomatic: true}));
  const advanced = {...ordinary, effects: {schema: 1, mode: "advanced", video: [{id: "manual", kind: "shader", enabled: true, shader: {preset: "grayscale"}}]}};
  await ReShade.updateAutomaticEffects(advanced, f.options);
  assert.equal(JSON.parse(fs.readFileSync(f.environment.RESHADE_EFFECT_PLAN)).mode, "advanced");
  assert.deepEqual(JSON.parse(fs.readFileSync(f.environment.RESHADE_EFFECT_PLAN)).nodes.map(node => node.id), ["manual"]);
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
test("Simple keeps compatible CRT processing live when a newly requested generator has no installed models", async t => {
  const f = await liveFixture(t), entry = {...f.entry, reshade: {enabled: true, preset: "grayscale"}, graphics: {frameGeneration: "lsfg"}};
  acknowledgePlan(t, f, JSON.parse(fs.readFileSync(f.environment.RESHADE_EFFECT_PLAN)));
  const publication = ReShade.createPublication();
  assert.notEqual(await ReShade.validateLiveGraphics(entry, {...f.options, publication}), false);
  await ReShade.updateAutomaticEffects(entry, {...f.options, publication});
  const prepared = JSON.parse(publication.read(f.environment.RESHADE_EFFECT_PLAN, "utf8"));
  assert.equal(prepared.nodes.find(row => row.kind === "shader").enabled, true);
  assert.equal(prepared.nodes.find(row => row.kind === "frame-generation").enabled, false);
  publication.commit();
  const launch = JSON.parse(fs.readFileSync(path.join(path.dirname(f.environment.RESHADE_EFFECT_PLAN), "launch.json")));
  assert.equal(launch.graphicsLivePreparation.preparationStatus.pending[0].kind, "frame-generation");
  assert.equal(entry.graphics.frameGeneration, "lsfg");
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
  fs.writeFileSync(path.join(neural.modelPath, "weights"), "changed");
  await assert.rejects(Effects.prepare(entry, {...f.options, deferRenderResolution: true}), /changed neural weights/);
  assert.deepEqual(fs.readFileSync(result.file), before);
  fs.writeFileSync(path.join(neural.modelPath, "weights"), neural.version);
  fs.writeFileSync(lossless.modelPath, "changed");
  await assert.rejects(Effects.prepare(entry, {...f.options, deferRenderResolution: true}), /changed model/);
  assert.deepEqual(fs.readFileSync(result.file), before);
  const external = path.join(f.temporary, "external.dlssmodel");fs.mkdirSync(external);
  const escaped = {...entry, effects: {...entry.effects, video: [{...entry.effects.video[0], settings: {modelPath: external}}]}};
  assert.equal((await Effects.prepare(escaped, f.options)).deferred, true);
  assert.deepEqual(fs.readFileSync(result.file), before);
  fs.writeFileSync(lossless.modelPath, lossless.version);
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
  assert.equal(Effects.info(f.entry, {...f.options, running: true, runningPids: [111]}).live, true);
  const working = fs.readFileSync(initial.file), calls = f.calls.length;
  const deferred = await Effects.prepare(f.entry, {...f.options, live: true, runningPids: [222],
    execute: () => assert.fail("an uninjected process cannot compile a live edit")});
  assert.equal(deferred.deferred, true);assert.deepEqual(deferred.plan.video.map(row => row.id), f.entry.effects.video.map(row => row.id));
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
for (const after of [false, true]) test(`stale Simple shader preparation ${after ? "return" : "selection"} cannot overwrite a relaunch`, async t => {
  const f = fixture(t), entry = {...f.entry, effects: undefined}, environment = await ReShade.prepare(entry, f.options);
  const directory = path.dirname(environment.RESHADE_EFFECT_PLAN), launchFile = path.join(directory, "launch.json"), record = JSON.parse(fs.readFileSync(launchFile));
  delete record.effectPlanAPI;delete record.effectPlanLiveResources;
  Object.assign(record, {pid: 20, launchId: "original", phase: "spawned"});fs.writeFileSync(launchFile, JSON.stringify(record));
  const gate = pauseShaderPreparation(t, {after});
  const pending = ReShade.updateLive({...entry, reshade: {...entry.reshade, parameters: {V__Strength: [.9]}}}, {...f.options, runningPids: [20], force: true});
  await gate.started;
  fs.writeFileSync(launchFile, JSON.stringify({...record, pid: 21, launchId: "replacement"}));
  const replacement = {
    "effect-plan.json": Buffer.from(JSON.stringify({schema: 1, mode: "simple", revision: "new-owner", nodes: []})),
    "controls.bin": Buffer.from("new owner controls"),
    "live-selection.json": Buffer.from(JSON.stringify({key: "new-owner", revision: "b".repeat(64)}))
  };
  for (const [name, bytes] of Object.entries(replacement)) fs.writeFileSync(path.join(directory, name), bytes);
  gate.release();assert.equal(await pending, false);
  for (const [name, bytes] of Object.entries(replacement)) assert.deepEqual(fs.readFileSync(path.join(directory, name)), bytes, name);
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
test("staged legacy shaders build controls from the unpublished candidate revision", async t => {
  const f = fixture(t), entry = {...f.entry, effects: undefined}, environment = await ReShade.prepare(entry, f.options);
  const directory = path.dirname(environment.RESHADE_EFFECT_PLAN), launchFile = path.join(directory, "launch.json"), launch = JSON.parse(fs.readFileSync(launchFile));
  delete launch.effectPlanAPI;delete launch.effectPlanLiveResources;
  fs.writeFileSync(launchFile, JSON.stringify({...launch, pid: 20, launchId: "original", phase: "spawned"}));
  const files = ["effect-plan.json", "live-selection.json", "controls.bin"].map(name => path.join(directory, name)), before = files.map(file => fs.readFileSync(file));
  const publication = ReShade.createPublication();
  await ReShade.updateLive({...entry, reshade: {...entry.reshade, parameters: {V__Strength: [.9]}}}, {...f.options, runningPids: [20], force: true, publication});
  for (let i = 0; i < files.length; i++) assert.deepEqual(fs.readFileSync(files[i]), before[i]);
  const revision = JSON.parse(publication.read(files[1], "utf8")).revision;
  assert.notEqual(revision, JSON.parse(before[1]).revision);
  assert.equal(publication.read(files[2]).toString("ascii", 88, 152), revision);
  publication.commit();assert.equal(fs.readFileSync(files[2]).toString("ascii", 88, 152), revision);
});
test("a failed later shader leaves every accepted staged selection and plan intact", async t => {
  const f = fixture(t);await Effects.prepare(f.entry, f.options);
  const live = stagedLiveFixture(t, f, f.entry), publication = ReShade.createPublication(), execute = f.options.execute;
  await assert.rejects(Effects.prepare(f.entry, {...live.options, publication, execute: async (command, args, options) => {
    if (args[0] === "--prepare" && args[1].endsWith("cas.fx")) throw Error("unsupported later shader");
    return execute(command, args, options);
  }}), /unsupported later shader/);
  assert.ok(publication.pending > 0, "the first row completed immutable preparation before the later row failed");
  publication.rollback();
  for (let i = 0; i < live.files.length; i++) assert.deepEqual(fs.readFileSync(live.files[i]), live.before[i]);
});
test("renderer-declared live source channels bind actual launch settings and stage Simple changes", async t => {
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
  await ReShade.validateLiveGraphics({...entry, graphics: {...entry.graphics, spatialMultiplier: 3}}, {...options, runningPids: [20], publication});
  assert.deepEqual(publication.metadata.sourceResolutionCandidate, {multiplier: 3, method: "bilinear"});
  assert.deepEqual(fs.readFileSync(source.file), before, "validation has not changed renderer allocation");
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
  assert.equal(warnings.length, 2);assert.deepEqual(f.entry, before);
  const snapshot = fs.readFileSync(prepared.file);
  const throwing = await Effects.prepare(f.entry, {...f.options, fallback: true,
    logger: {warn: () => { throw new Error("Warning sink unavailable"); }}});
  assert.deepEqual(throwing.document, prepared.document, "warning delivery cannot disable compatible remaining stages");
  await assert.rejects(Effects.prepare(f.entry, f.options), /neural rendering provider/);
  assert.deepEqual(fs.readFileSync(prepared.file), snapshot);
});
test("Advanced model choices and Add defaults do not inherit an unrelated Simple model selection", t => {
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
  for (const id of ["spatial:ls1", "frame-generation:lsfg"]) {
    const row = info.catalog.find(row => row.id === id);
    assert.equal(row.available, true, "Add uses compatible library defaults rather than a stale Simple model");
    assert.equal(row.availableWithoutModel, true);assert.equal(row.template.settings.modelVersion, quality);
  }
  assert.equal(info.plan.video[0].settings.modelVersion, performance);
  assert.equal(info.plan.video[1].settings.modelVersion, missing, "an explicit unavailable row model remains visible");
  const simple = Effects.info({...entry, effects: undefined, graphics: {modelVersion: missing, spatialMethod: "ls1"}}, options);
  assert.equal(simple.catalog.find(row => row.id === "spatial:ls1").available, false);
  assert.equal(simple.plan.video[0].settings.modelVersion, missing);assert.deepEqual(entry, before);
  f.record.features.graphics.effectPlanAPI = 0;fs.writeFileSync(path.join(f.root, "runtime.json"), JSON.stringify(f.record));
  assert.equal(Effects.info(entry, options).catalog.find(row => row.id === "spatial:ls1").availableWithoutModel, false,
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
  await assert.rejects(Effects.describe(entry, "tone", { ...f.entry.effects, schema: 9 }, f.options), /valid ordered/);
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
    resolveModel: async (_directory, version, capability) => { resolved.push({ version, capability });return { modelPath: "/models/" + version }; } };
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
  await assert.rejects(Effects.prepare({ ...entry, effects: unavailable }, options), /Compatible Lossless Scaling models/);
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
test("compiled shader requirements reject invalid depth ordering before replacing a working plan", async t => {
  const f = fixture(t), working = await Effects.prepare(f.entry, f.options), before = fs.readFileSync(working.file);
  const source = path.join(f.root, "Depth.fx");fs.writeFileSync(source, "depth fixture");
  f.record.features.shaders.depth = { hosts: ["window"] };fs.writeFileSync(path.join(f.root, "runtime.json"), JSON.stringify(f.record));
  f.entry.effects.video[2].shader = { enabled: true, preset: "custom", effectPath: source };
  const execute = f.options.execute;
  await assert.rejects(Effects.prepare(f.entry, { ...f.options, execute: async (...args) => {
    const result = await execute(...args);
    if (args[1][0] !== "--prepare" && fs.readFileSync(args[1][0], "utf8") === "depth fixture")
      fs.writeFileSync(path.join(args[1][1], "requirements.json"), JSON.stringify({ depth: true, motion: false }));
    return result;
  } }), /Depth and motion effects must precede resizing/);
  assert.deepEqual(fs.readFileSync(working.file), before);
  f.entry.effects.video = [f.entry.effects.video[2]];
  await Effects.prepare(f.entry, f.options);
  assert.equal(JSON.parse(fs.readFileSync(working.file)).nodes[0].requirements.depth, true);
});
test("automatic Simple uses original compiled depth requirements before publishing its final order", async t => {
  const f = fixture(t), source = path.join(f.root, "Depth.fx");fs.writeFileSync(source, "depth fixture");
  f.record.features.shaders.depth = {hosts: ["window"]};fs.writeFileSync(path.join(f.root, "runtime.json"), JSON.stringify(f.record));
  const entry = {...f.entry, effects: {schema: 1, mode: "advanced", video: [
    {id: "fit", kind: "spatial", enabled: true, method: "bilinear", settings: {}},
    {id: "depth", kind: "shader", enabled: true, shader: {preset: "custom", effectPath: source}}
  ]}}, execute = f.options.execute;
  const result = await Effects.prepare(entry, {...f.options, automaticSimple: true, execute: async (...args) => {
    const result = await execute(...args);
    if (args[1][0] !== "--prepare" && fs.readFileSync(args[1][0], "utf8") === "depth fixture")
      fs.writeFileSync(path.join(args[1][1], "requirements.json"), JSON.stringify({depth: true, motion: false}));
    return result;
  }});
  assert.deepEqual(result.document.nodes.map(node => node.id), ["depth", "fit"]);
  assert.equal(result.document.nodes[0].requirements.depth, true);
  assert.deepEqual(entry.effects.video.map(node => node.id), ["fit", "depth"], "automatic composition never mutates saved input");
});
test("automatic Simple removes dependent reduction after model or scaler preparation fails", async t => {
  const f = fixture(t), Neural = require("../src/modules/shared/reshade/neural");
  t.mock.method(Neural, "resolve", () => ({library: "/Neural.dylib"}));
  let failModel = false;
  t.mock.method(Neural, "prepare", settings => {
    if (failModel) throw new Error("The selected model cannot be loaded.");
    return {settings, environment: {RESHADE_NEURAL_LIBRARY: "/Neural.dylib"}};
  });
  const before = {schema: 1, mode: "advanced", renderResolution: {multiplier: 2}, video: [
    {id: "legacy-neural-input", kind: "spatial", enabled: true, method: "downsample", presentationScale: .5, settings: {}},
    {id: "legacy-neural", kind: "neural", enabled: true, method: "mlx-dlss", settings: {modelPath: "/Models/Local.dlssmodel"}},
    {id: "fit", kind: "spatial", enabled: true, method: "metalfx", settings: {}},
    {id: "display", kind: "shader", enabled: true, shader: {preset: "cas"}}
  ]};
  const entry = {...f.entry, effects: before}, options = {...f.options, automaticSimple: true, fallback: true};
  const missingScaler = await Effects.prepare(entry, options);
  assert.deepEqual(missingScaler.document.nodes.map(node => [node.id, node.enabled]), [["legacy-neural", true], ["fit", false], ["display", true]]);
  assert.equal(missingScaler.plan.renderResolution, undefined);assert.equal(missingScaler.environment.RESHADE_RENDER_MULTIPLIER, undefined);
  failModel = true;entry.effects = {...before, video: before.video.map(row => row.id === "fit" ? {...row, method: "bilinear"} : row)};
  const missingModel = await Effects.prepare(entry, options);
  assert.deepEqual(missingModel.document.nodes.map(node => [node.id, node.enabled]), [["legacy-neural", false], ["fit", true], ["display", true]]);
  assert.equal(missingModel.plan.renderResolution, undefined);
  const routed = await Effects.prepare(entry, {...options, prepareEffectsEntry: async value => value});
  assert.deepEqual(routed.plan.renderResolution, {multiplier: 2});assert.equal(routed.appliedPlan.renderResolution, undefined);
  assert.equal(routed.appliedPlan.video.some(row => row.id === "legacy-neural-input"), false);
  const advanced = await Effects.prepare(entry, {...options, automaticSimple: false});
  assert.equal(advanced.document.nodes[0].id, "legacy-neural-input");assert.equal(advanced.document.nodes[0].enabled, true);
});
test("automatic source reduction follows surviving processing contracts after a scaler is unavailable", async t => {
  const f = fixture(t), source = path.join(f.temporary, "reconstruction.hook");
  const text = "//!DESC Neural reconstruction\n//!HOOK MAIN\n//!WIDTH HOOKED.w 2 *\n//!HEIGHT HOOKED.h 2 *\nvec4 hook(){return vec4(1);}";
  fs.writeFileSync(source, text);f.record.features.shaders.formats.push("libplacebo");
  fs.writeFileSync(path.join(f.root, "runtime.json"), JSON.stringify(f.record));
  const video = [
    {id: "scale", kind: "spatial", enabled: true, method: "metalfx", settings: {}},
    {id: "display", kind: "shader", enabled: true, shader: {preset: "cas"}}
  ], entry = {...f.entry, effects: {schema: 1, mode: "advanced", renderResolution: {multiplier: 2}, video}},
    options = {...f.options, automaticSimple: true, fallback: true};
  const result = await Effects.prepare(entry, options);
  assert.deepEqual(result.document.nodes.map(node => [node.id, node.enabled]), [["scale", false], ["display", true]]);
  assert.equal(result.appliedPlan.renderResolution, undefined);assert.equal(result.environment.RESHADE_RENDER_MULTIPLIER, undefined);
  const advanced = await Effects.prepare(entry, {...options, automaticSimple: false});
  assert.deepEqual(advanced.plan.renderResolution, {multiplier: 2});assert.equal(advanced.environment.RESHADE_RENDER_MULTIPLIER, "2");
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
  const entry = {...f.entry, effects: undefined, graphics: {spatialMethod: "metalfx"}}, template = Effects.info(entry, f.options).templates[0];
  assert.equal(template.available, true);assert.equal(template.id, "reconstruction-4x");
  assert.equal(template.plan.video.find(row => row.kind === "neural").settings.modelPath, modelPath);
  assert.equal(template.plan.video.find(row => row.kind === "frame-generation").settings.modelVersion, version);
  assert.equal(template.plan.video.find(row => row.id === "legacy-neural-input").settings.spatialMultiplier, .25);
  assert.equal(fs.existsSync(Effects.file(entry, f.userDataDir)), false);
  models.mock.restore();t.mock.method(Models, "listInstalled", () => []);
  const unavailable = Effects.info(entry, f.options).templates[0];
  assert.equal(unavailable.available, false);assert.match(unavailable.reason, /Lossless Scaling models/);
});
test("simple reset and live updates distinguish inactive legacy from an empty advanced chain", async t => {
  const f = fixture(t), empty = { ...f.entry, effects: { schema: 1, mode: "advanced", video: [] } };
  const prepared = await Effects.prepare(empty, f.options);
  assert.equal(prepared.document.mode, "advanced"); assert.deepEqual(prepared.document.nodes, []);
  const target = Effects.publishSimple(empty, f.userDataDir);
  assert.equal(target, prepared.file); assert.equal(JSON.parse(fs.readFileSync(target)).mode, "simple");
  assert.equal(fs.existsSync(path.join(path.dirname(target), "plan-nodes")), true);
  await assert.rejects(Effects.prepare(empty, { ...f.options, live: true }), /Restart the game/);
  fs.writeFileSync(path.join(path.dirname(target), "launch.json"), JSON.stringify({ effectPlanAPI: 1, effectPlanModels: [] }));
  await Effects.prepare(empty, { ...f.options, live: true });
  f.record.features.graphics.effectPlanAPI = 0;fs.writeFileSync(path.join(f.root, "runtime.json"), JSON.stringify(f.record));
  await assert.rejects(Effects.prepare(empty, f.options), /unavailable/);
  assert.ok(Effects.info(empty, f.options).catalog.every(row => !row.available));
});
test("ordered temporal availability requires the exact producer lineage in addition to scene inputs", t => {
  const f = fixture(t), graphics = f.record.features.graphics;
  graphics.effectPlanKinds = ["shader", "spatial", "temporal", "frame-generation"];
  graphics.temporalMethods = ["metalfx"];graphics.presentation.hosts.window.temporal = true;
  graphics.effectPlanTemporal = { source: "original-metalfx", output: "acquired-drawable", commandBuffer: "classic", hosts: ["window"] };
  fs.writeFileSync(path.join(f.root, "runtime.json"), JSON.stringify(f.record));
  const input = { depth: true, motionVectors: true, methods: ["metalfx"] };
  const row = graphicsInputs => Effects.info(f.entry, { ...f.options, graphicsInputs }).catalog.find(row => row.id === "temporal:metalfx");
  assert.equal(row(input).available, false);assert.match(row(input).reason, /matching scene inputs and output/);
  const exact = { ...input, temporalSource: "original-metalfx", temporalOutput: "acquired-drawable", commandBuffer: "classic" };
  assert.equal(row(exact).available, true);
  for (const changed of [{ temporalOutput: "offscreen" }, { commandBuffer: "metal4" }, { temporalSource: "camera" }, { motionVectors: false }])
    assert.equal(row({ ...exact, ...changed }).available, false);
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
    {graphics: {}, readable: [], readableDirectories: []});
});
