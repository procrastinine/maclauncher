const test = require("node:test"), assert = require("node:assert/strict");
const Plan = require("../src/modules/shared/effects/plan");
test("a requested shader output follows its row size without assigning a semantic purpose",()=>{
  const Contracts=require("../src/modules/shared/effects/contracts.mjs");
  const rows=Plan.catalog({reshadeState:{available:true,presets:[{id:"arbitrary-name",label:"Arbitrary name",traits:{requestedOutputExtent:true,unresolvedGeometry:true}},{id:"authored-expression",label:"Authored expression",traits:{unresolvedGeometry:true}}]}});
  const arbitrary=rows.find(row=>row.template.shader?.preset==="arbitrary-name"),authored=rows.find(row=>row.template.shader?.preset==="authored-expression");
  // Display-dependent geometry renders at the presentation until a row size is chosen.
  assert.equal(arbitrary.outputContract.sizing,"stage");assert.deepEqual(Contracts.shaderGeometry(arbitrary),{kind:"target",directions:[],target:"presentation"});
  assert.equal(Contracts.graphicsType(arbitrary.template,arbitrary),"upscale");
  assert.equal(Contracts.graphicsType({...arbitrary.template,extent:{relativeTo:"input",factor:.5}},arbitrary),"downsample");
  assert.equal(Contracts.graphicsType({...arbitrary.template,extent:{relativeTo:"input",factor:1}},arbitrary),"image");
  for(const type of ["downsample","upscale"])assert.ok(Contracts.implementationsFor(type,rows,{contextual:true}).includes(arbitrary));
  assert.ok(!Contracts.implementationsFor("downsample",rows).includes(arbitrary),"no authored reduction is listed in ordinary menus");
  assert.equal(Contracts.shaderGeometry(authored).kind,"unknown");assert.equal(Contracts.graphicsType(authored.template,authored),"image");
  assert.ok(Contracts.implementationsFor("image",rows).includes(authored),"unknown geometry remains an ordinary image filter");
  for(const type of ["downsample","upscale"])assert.ok(!Contracts.implementationsFor(type,rows).includes(authored));
});
test("shader geometry controls grouping independently of semantic tags and preserves compiled image extents",()=>{
 const Contracts=require("../src/modules/shared/effects/contracts.mjs");
 const presets=[{id:"semantic",label:"Semantic tag",traits:{category:"downscaling",preservesCoordinates:true}},
  {id:"authored",label:"Authored size",traits:{category:"color",outputScale:{x:2,y:2}}},
  {id:"shader:native:depth-fog",label:"Depth fog",format:"native",traits:{category:"effects",preservesCoordinates:true}}];
 const rows=Plan.catalog({reshadeState:{available:true,presets}}),semantic=rows.find(row=>row.template.shader.preset==="semantic"),authored=rows.find(row=>row.template.shader.preset==="authored"),native=rows.find(row=>row.template.shader.preset==="shader:native:depth-fog");
 assert.equal(Contracts.graphicsType(semantic.template,semantic),"image");assert.equal(semantic.group,"Image filters");assert.equal(semantic.outputContract.direction,undefined);
 assert.equal(Contracts.graphicsType(authored.template,authored),"upscale");assert.equal(authored.group,"Resize");
 assert.equal(native.outputContract.sizing,"preserve");assert.equal(native.outputContract.extentEditable,false);
});
test("restoration and interpolation use shared data contracts with installation and scene inputs evaluated separately",()=>{
  const methods=["realesrgan","realcugan","nafnet","rife"],rows=Plan.catalog({neuralProvider:{supportedMethods:methods}});
  const byMethod=method=>rows.find(row=>row.template.method===method);
  assert.equal(byMethod("realesrgan").intrinsicScale,4);assert.equal(byMethod("realcugan").intrinsicScale,2);
  assert.equal(byMethod("nafnet").outputContract.sizing,"preserve");assert.equal(byMethod("nafnet").preservesCoordinates,true);
  assert.equal(byMethod("rife").inputContract.domain,"image-pair");assert.deepEqual(byMethod("rife").inputContract.requires,[]);
  for(const method of methods){const row=byMethod(method);assert.equal(row.available,true);assert.equal(row.runtimeManagerId,"graphics-neural-models");assert.equal(row.modelOperation,method);assert.doesNotThrow(()=>Plan.validate({schema:2,mode:"advanced",video:[{...row.template,id:method}]}));}
  const restore=byMethod("nafnet").template,temporal={id:"scene",kind:"temporal",enabled:true,method:"metalfx",settings:{}};
  assert.doesNotThrow(()=>Plan.validateOrdering({schema:2,mode:"advanced",video:[{...restore,id:"restore"},temporal]}),"same-size restoration retains the supplied scene coordinates");
  assert.throws(()=>Plan.validate({schema:2,mode:"advanced",video:[{...restore,id:"wrong",kind:"upscale"}]}),/input and output type/);
  const uninstalled=Plan.catalog();for(const method of methods)assert.equal(uninstalled.find(row=>row.template.method===method).available,false);
  // Curated sources download during preparation after consent; an operation without one needs an import first.
  for(const method of methods)assert.ok(byMethod(method).modelSource?.setupActionId,method);
  const imported=Plan.catalog({neuralProvider:{supportedMethods:["mlx-sr-image"]}}).find(row=>row.template.method==="mlx-sr-image");
  assert.equal(imported.available,false);assert.equal(imported.availableWithoutModel,true);assert.equal(imported.modelSource,undefined);assert.match(imported.reason,/Import a compatible model/);
  const ready=Plan.catalog({neuralProvider:{supportedMethods:["mlx-sr-image"]},reshadeState:{neuralModels:[{version:"local",method:"mlx-sr-image",modelPath:"/managed/local"}]}});
  assert.equal(ready.find(row=>row.template.method==="mlx-sr-image").available,true);
  const fog=Plan.catalog({reshadeState:{available:true,presets:[{id:"shader:native:estimated-depth-fog",label:"Fog",format:"native",traits:{preservesCoordinates:true}}]},
    neuralProvider:{supportedMethods:["depth-anything-v2-small"]}}).find(row=>row.modelOperation==="depth-anything-v2-small");
  assert.equal(fog.available,true,"an attachment model with a curated source downloads during preparation");assert.ok(fog.modelSource.setupActionId);
});
test("render requests and processing sizes stay independent and downsample chains preserve their stages", () => {
  const plan = {schema: 1, mode: "advanced", renderResolution: {height: 480}, video: [
    {id: "small", kind: "spatial", enabled: true, method: "downsample", settings: {spatialMultiplier: .5}, outputSize: {width: 854, height: 480}},
    {id: "nr", kind: "neural", enabled: false, method: "mlx-dlss", settings: {modelPath: null, temporal: false, intensity: .5}},
    {id: "large", kind: "spatial", enabled: true, method: "metalfx", settings: {spatialMultiplier: 2}}
  ]};
  const result = Plan.validate(plan);
  assert.deepEqual(result.renderResolution, {height: 480}); assert.deepEqual(result.video[0].outputSize, {width: 854, height: 480});
  assert.equal(result.video[0].settings.spatialMultiplier, .5); assert.equal(result.video[0].settings.spatialMethod, "bilinear");
  assert.deepEqual(Plan.validate(result), result);
  for (const renderResolution of [{height: 0}, {height: NaN}, {height: 480, multiplier: 2}, {multiplier: .5}])
    assert.throws(() => Plan.validate({...plan, renderResolution}), /render height/);
  for (const outputSize of [{width: 0, height: 480}, {width: 854.5, height: 480}, {width: 854, height: 20000}, {width: 854, height: 480, extra: true}])
    assert.throws(() => Plan.validate({...plan, video: [{...plan.video[0], outputSize}]}), /output dimensions/);
});
test("a plan's depth input keeps its non-default values and an invalid one is skipped alone", () => {
  const Model = require("../src/modules/shared/effects/plan.mjs"), StoredPlan = require("../src/modules/shared/effects/stored-plan");
  const base = {schema: 2, mode: "advanced", enabled: true, video: [{id: "depth", kind: "shader", enabled: true, shader: {enabled: true, preset: "crt"}}]};
  assert.deepEqual(Model.depthInput(undefined), {reversed: false, logarithmic: false, farPlane: 1000, multiplier: 1});
  assert.deepEqual(Plan.validate({...base, depthInput: {reversed: false, logarithmic: true, farPlane: 1000, multiplier: 2}}).depthInput, {logarithmic: true, multiplier: 2});
  assert.equal("depthInput" in Plan.validate({...base, depthInput: {reversed: false}}), false);
  for (const depthInput of [{reversed: 1}, {farPlane: 0}, {farPlane: 2e6}, {multiplier: 0}, {multiplier: Infinity}, {near: 1}, []])
    assert.throws(() => Plan.validate({...base, depthInput}), undefined, JSON.stringify(depthInput));
  assert.throws(() => Plan.validate({schema: 1, mode: "advanced", video: [], depthInput: {reversed: true}}));
  const salvaged = Plan.salvage({...base, depthInput: {farPlane: -1}});
  assert.equal(salvaged.plan.depthInput, undefined);assert.deepEqual(salvaged.plan.video, Plan.validate(base).video);
  assert.deepEqual(salvaged.dropped.map(row => row.part), ["depthInput"]);
  assert.match(StoredPlan.notices(salvaged)[0].message, /^The saved depth input setting is skipped\. .*far plane/);
});
test("legacy conversion preserves order, parameters and settings without activating or mutating a plan", async () => {
  const entry = { reshade: { enabled: true, preset: "shader:crt-royale:royale", parameters: { V__diffusion_weight: [.2] } },
    graphics: { temporalMethod: "fsr2", spatialMethod: "fsr1", effectPlacement: "after", frameGeneration: "lsfg", targetFps: 144 } };
  const before = structuredClone(entry), plan = Plan.fromLegacy(entry);
  assert.deepEqual(plan.video.map(row => row.id), ["legacy-temporal", "legacy-spatial", "legacy-shader", "legacy-frame-generation"]);
  assert.deepEqual(plan.video[2].shader.parameters, entry.reshade.parameters);
  assert.equal(plan.video[3].settings.targetFps, 144); assert.deepEqual(entry, before); assert.equal(entry.effects, undefined);
  entry.graphics.effectPlacement = "before"; assert.deepEqual(Plan.fromLegacy(entry).video.map(row => row.kind), ["temporal", "shader", "spatial", "frame-generation"]);
  assert.deepEqual(Plan.fromLegacy({}).video, []);
  const browser = await import("../src/modules/shared/effects/plan.mjs");
  assert.deepEqual(browser.fromLegacy(before).video.map(row => row.id), plan.video.map(row => row.id));
  const advanced = { ...plan, video: [...plan.video].reverse() }; entry.effects = advanced;
  assert.deepEqual(Plan.fromLegacy(entry), Plan.validate(advanced));
  const changed = Plan.fromLegacy(entry); changed.video[0].settings.targetFps = 30;
  assert.equal(entry.effects.video[0].settings.targetFps, 144);
});
test("ordered plans preserve independent shader controls, disabled nodes and stable identity", () => {
  const plan = { schema: 1, mode: "advanced", video: [
    { id: "shader-a", kind: "shader", enabled: true, shader: { preset: "crt", parameters: { V__Strength: [.2] } } },
    { id: "shader-b", kind: "shader", enabled: false, shader: { preset: "grayscale", parameters: { V__Strength: [.8] } } },
    { id: "scaler", kind: "spatial", enabled: true, method: "fsr1", settings: { spatialSharpness: .7 } }
  ] };
  const result = Plan.validate(plan);
  assert.deepEqual(result.video.map(row => row.id), ["shader-a", "shader-b", "scaler"]);
  assert.equal(result.video[1].enabled, false); assert.deepEqual(result.video[1].shader.parameters, { V__Strength: [.8] });
  assert.equal(result.video[2].settings.spatialMethod, "fsr1"); assert.equal(result.video[2].settings.spatialSharpness, .7);
  assert.deepEqual(Plan.validate(result), result);
  assert.throws(() => Plan.validate({ ...plan, video: [plan.video[0], plan.video[0]] }), /unique/);
  assert.throws(() => Plan.validate({ ...plan, video: [{ ...plan.video[2], settings: { depth: true } }] }), /graphics settings/);
  assert.throws(() => Plan.validate({ ...plan, video: [{ ...plan.video[0], graphicsInputs: { motionVectors: true } }] }), /unsupported fields/);
  assert.throws(() => Plan.validate({ ...plan, video: [{ ...plan.video[0], shader: { preset: "unknown" } }] }), /supported.*preset/);
  assert.throws(() => Plan.validate({ ...plan, video: [{ ...plan.video[0], shader: { parameters: { X: [Infinity] } } }] }), /finite/);
  // S5: a saved plan that fails validation is reported, never read as absent.
  assert.throws(() => Plan.normalize({ schema: 8, mode: "advanced", video: [] }), { code: Plan.PLAN_NEWER });
});
test("advanced parameter maps retain 4096 independent values beyond the simple live packet", () => {
  const parameters = Object.fromEntries(Array.from({ length: 4096 }, (_, i) => ["Parameter" + i, [i, .5]]));
  const plan = { schema: 1, mode: "advanced", video: [{ id: "large", kind: "shader", enabled: true, shader: { preset: "grayscale", parameters } }] };
  assert.deepEqual(Plan.validate(plan).video[0].shader.parameters, parameters);
  assert.equal(Object.keys(Plan.fromLegacy({ effects: plan }).video[0].shader.parameters).length, 4096);
  parameters.Extra = [0]; assert.throws(() => Plan.validate(plan), /4096/);
  const longName = "LongUniform".repeat(40);
  const row = { ...plan, video: [{ ...plan.video[0], shader: { preset: "grayscale", parameters: { [longName]: [3.4028234e38] } } }] };
  assert.equal(Plan.validate(row).video[0].shader.parameters[longName][0], 3.4028234e38);
  row.video[0].shader.parameters[longName] = [1e100];
  assert.throws(() => Plan.validate(row), /finite/);
});
test("ordering preserves original input coordinates and never enables unavailable or invented inputs", () => {
  const shader = { id: "colour", kind: "shader", enabled: true, shader: { preset: "grayscale" } };
  const temporal = { id: "temporal", kind: "temporal", enabled: true, method: "fsr2", settings: {} };
  const make = video => ({ schema: 1, mode: "advanced", video });
  assert.throws(() => Plan.validateOrdering(make([shader, temporal])), /matching coordinates/);
  assert.doesNotThrow(() => Plan.validateOrdering(make([shader, temporal]), { nodes: { colour: { preservesCoordinates: true } } }));
  assert.doesNotThrow(() => Plan.validateOrdering(make([temporal, shader])));
  assert.throws(() => Plan.validateOrdering(make([shader]), { nodes: { colour: { available: false, reason: "Missing depth" } } }), /Missing depth/);
  assert.doesNotThrow(() => Plan.validateOrdering(make([{ ...shader, enabled: false }]), { nodes: { colour: { available: false } } }));
  assert.throws(() => Plan.validateOrdering(make([temporal, shader]), { nodes: { colour: { requirements: { depth: true } } } }), /matching coordinates/);
});
test("the shared catalog uses actual presentation and game inputs without manufacturing temporal or depth support", () => {
  const reshadeState = { available: true, presets: [{ id: "crt", label: "CRT" }, { id: "chain", label: "Combine effects" }, { id: "custom", label: "Custom effect…" },
    { id: "shader:quint:mxao", label: "MXAO", available: true, depthHosts: ["explicit"] }], models: [] };
  const graphicsCapabilities = { spatial: true, spatialMethods: ["bilinear", "fsr1"], temporal: true,
    temporalMethods: ["metalfx"], cameraTemporalMethods: ["fsr2"], frameGeneration: true, frameGenerationMethods: ["lsfg"] };
  const make = extra => Plan.catalog({ reshadeState, graphicsCapabilities, graphicsHost: "explicit", ...extra });
  const find = (rows, id) => rows.find(row => row.id === id);
  const none = make(); assert.equal(find(none, "shader:crt").available, true); assert.equal(find(none, "shader:chain").available, true);
  assert.deepEqual(find(none, "shader:custom").template.shader, { enabled: true, preset: "custom", effectPath: null });
  assert.equal(find(none, "upscale:fsr1").available, true); assert.equal(find(none, "downsample:bilinear").available, true);
  assert.equal(find(none, "downsample:fsr1"), undefined);assert.equal(find(none, "temporal:metalfx").available, true);assert.deepEqual(find(none,"temporal:metalfx").pendingInputs,["depth","motion"]);
  assert.equal(find(none, "shader:quint:mxao").available, true);assert.deepEqual(find(none, "shader:quint:mxao").pendingInputs,["depth"]); assert.equal(find(none, "frame-generation:lsfg").available, false);
  const camera = make({ graphicsInputs: { cameraProjection: true, methods: ["fsr2"] } });
  assert.equal(find(camera, "temporal:fsr2").available, true); assert.equal(find(camera, "temporal:metalfx").available, true);assert.deepEqual(find(camera,"temporal:fsr2").pendingInputs,["depth","motion"]);
  assert.deepEqual(find(camera, "shader:quint:mxao").pendingInputs,["depth"], "Camera capability is not a shader depth texture");
  const direct = make({ graphicsInputs: { depth: true, motionVectors: true, methods: ["metalfx"] } });
  assert.equal(find(direct, "temporal:metalfx").available, true); assert.equal(find(direct, "shader:quint:mxao").available, true);
  assert.equal(find(direct,"shader:quint:mxao").pendingInputs,undefined);
  const rgb=make({graphicsInputs:{depth:false}});assert.equal(find(rgb,"shader:quint:mxao").available,true);
  assert.deepEqual(find(rgb,"shader:quint:mxao").pendingInputs,["depth"]);
  const withModel = make({ reshadeState: { ...reshadeState, models: [{ version: "sha256-" + "a".repeat(64), capabilities: ["lsfgFp16Quality"] }] } });
  const fg = find(withModel, "frame-generation:lsfg"); assert.equal(fg.available, true); assert.deepEqual(fg.requirements, ["models"]);
  assert.equal(fg.template.settings.modelVersion, "sha256-" + "a".repeat(64)); assert.equal(fg.template.settings.frameGeneration, "lsfg");
  assert.ok(none.every(row => row.template.kind === row.kind && typeof row.available === "boolean" && Array.isArray(row.requirements)));
});
test("new spatial rows do not inherit a Simple producer divisor as an extra processing upscale", () => {
  const rows = Plan.catalog({ graphicsSettings: { spatialMethod: "ls1", spatialMultiplier: 2, spatialSharpness: .7 },
    graphicsCapabilities: { spatial: true, spatialMethods: ["bilinear", "metalfx", "ls1", "libplacebo:ewa_lanczos"] } });
  for (const row of rows.filter(row => ["downsample", "upscale"].includes(row.kind) && !row.requirements.includes("neural-model"))) {
    assert.equal(row.template.settings.spatialMultiplier, null);
    assert.equal(row.template.settings.spatialSharpness, .7);
  }
});
test("schema 2 keeps explicit resize direction and bypass independent of saved effects and source allocation", () => {
  const Requirements = require("../src/modules/shared/effects/execution-requirements");
  const plan = Plan.validate({schema: 2, mode: "advanced", enabled: false, renderResolution: {height: 480}, video: [
    {id: "small", kind: "downsample", method: "area", enabled: true, extent: {relativeTo: "input", factor: .375}, settings: {}},
    {id: "large", kind: "upscale", method: "bicubic", enabled: true, extent: {width: 1200}, settings: {}}
  ]});
  assert.deepEqual(plan.video[0].extent, {relativeTo: "input", factor: .375});
  assert.equal(Requirements.analyze({effects: plan}).needed.processor, false);
  assert.equal(Requirements.analyze({effects: {...plan, enabled: true}}).needed.processor, true);
  const active = Plan.execution(plan);
  assert.equal(active.video.every(node => !node.enabled), true);assert.equal(active.renderResolution, undefined);
  assert.equal(plan.video.every(node => node.enabled), true);assert.deepEqual(plan.renderResolution, {height: 480});
  assert.throws(() => Plan.validate({...plan, video: [{...plan.video[0], extent: {relativeTo: "input", factor: 2}}]}), /Downsample reduces/);
  assert.throws(() => Plan.validate({...plan, video: [{...plan.video[1], extent: {relativeTo: "input", factor: .5}}]}), /Upscale enlarges/);
});
test("schema migration preserves legacy Auto and disabled resources without rewriting the original", () => {
  const original = {schema: 1, mode: "advanced", video: [
    {id: "fit", kind: "spatial", method: "metalfx", enabled: true, settings: {spatialMultiplier: null}},
    {id: "small", kind: "spatial", method: "downsample", enabled: false, outputSize: {height: 480}, settings: {}}
  ]}, before = structuredClone(original), migrated = Plan.migrate(original);
  assert.equal(migrated.schema, 2);assert.equal(migrated.enabled, true);
  assert.equal(migrated.video[0].kind, "spatial");assert.equal(migrated.video[0].settings.spatialMultiplier, null);
  assert.equal(migrated.video[1].kind, "downsample");assert.equal(migrated.video[1].enabled, false);
  assert.deepEqual(migrated.video[1].extent, {height: 480});assert.deepEqual(original, before);
  assert.deepEqual(Plan.migrate(migrated), migrated);
});
test("display output is an independent demand and master bypass retains its saved policy", () => {
  const Requirements=require("../src/modules/shared/effects/execution-requirements");
  const output={motionClarity:"beam",subframes:4,duty:.25,brightness:2};
  const plan=Plan.validate({schema:2,mode:"advanced",enabled:true,video:[],output});
  assert.deepEqual(plan.output,output);assert.equal(Requirements.analyze({effects:plan}).needed.motionClarity,true);
  assert.equal(Requirements.analyze({effects:plan}).needed.presentation,true);
  assert.equal(Requirements.analyze({effects:{...plan,enabled:false}}).needed.processor,false);
  assert.equal(Plan.execution({...plan,enabled:false}).output,undefined);assert.deepEqual(plan.output,output);
  for(const patch of [{subframes:9},{subframes:1.5},{duty:0},{brightness:Infinity},{motionClarity:"invented"}])
    assert.throws(()=>Plan.validate({...plan,output:{...output,...patch}}),/subframe|brightness/);
});
test("output pacing survives generator reordering and migration without changing automatic beam selection",()=>{
  const video=[{id:"fg",kind:"frame-generation",enabled:true,method:"lsfg",settings:{framePacing:"adaptive",targetFps:144,smoothCadence:true}}];
  const legacy={schema:1,mode:"advanced",video};const migrated=Plan.migrate(legacy);
  assert.deepEqual(migrated.output,{framePacing:"adaptive",targetFps:144,smoothCadence:true});
  assert.equal(migrated.output.motionClarity,undefined);assert.equal(migrated.video[0].settings.targetFps,undefined);
  assert.equal(legacy.video[0].settings.targetFps,144);
  const edited=Plan.validate({...migrated,output:{...migrated.output,targetFps:120},video:[...migrated.video].reverse()});
  assert.equal(edited.output.targetFps,120);assert.equal(edited.video[0].settings.targetFps,undefined);
  assert.throws(()=>Plan.validate({...migrated,output:{targetFps:0}}),/target/);
});
test("depth rows accept known affine resize and reconstruction lineage but scene reconstruction retains its original extent",()=>{
  const small={id:"small",kind:"downsample",method:"area",enabled:true,settings:{},extent:{relativeTo:"input",factor:.5}};
  const depth={id:"ao",kind:"shader",enabled:true,shader:{preset:"custom"}};
  const scene={id:"scene",kind:"temporal",method:"fsr2",enabled:true,settings:{}};
  const make=video=>({schema:2,mode:"advanced",video});
  const nodes={small:{preservesCoordinates:true,coordinateTransform:"scale",preservesSceneInputs:true},scene:{preservesCoordinates:true,coordinateTransform:"scale",preservesSceneInputs:true},ao:{requirements:{depth:true}}};
  assert.doesNotThrow(()=>Plan.validateOrdering(make([small,depth]),{nodes}));
  assert.doesNotThrow(()=>Plan.validateOrdering(make([scene,depth]),{nodes}));
  assert.throws(()=>Plan.validateOrdering(make([small,scene]),{nodes:{...nodes,small:{...nodes.small,preservesSceneInputs:false}}}),/original scene extent/);
  assert.doesNotThrow(()=>Plan.validateOrdering(make([small,scene,depth]),{nodes:{...nodes,small:{...nodes.small,preservesSceneInputs:true},scene:{...nodes.scene,preservesSceneInputs:true}}}),"a processor with scene-guide normalization admits known resize before temporal reconstruction");
  assert.throws(()=>Plan.validateOrdering(make([small,depth]),{nodes:{ao:nodes.ao}}),/Depth|coordinates/);
});
test("color generators compose without a row-count prohibition while scene providers keep their actual input contract",()=>{
  const a={id:"a",kind:"frame-generation",method:"lsfg",enabled:true,settings:{}};
  const b={...a,id:"b",method:"mlx-interpolation"};
  const plan={schema:2,mode:"advanced",video:[a,b]};
  assert.doesNotThrow(()=>Plan.validateOrdering(plan,{nodes:{a:{acceptsSynthetic:true},b:{acceptsSynthetic:true}}}));
  assert.doesNotThrow(()=>Plan.validateOrdering({...plan,video:[a,{id:"nr",kind:"neural",enabled:true,method:"mlx-dlss",settings:{temporal:true}}]}));
  for(const method of ["metalfx","fsr3","xess"])
    assert.doesNotThrow(()=>Plan.validateOrdering({...plan,video:[a,{...b,method}]},{nodes:{b:{acceptsSynthetic:false}}}));
  const depth={id:"ao",kind:"shader",enabled:true,shader:{preset:"custom",effectPath:"/Shaders/Depth.fx"}};
  assert.throws(()=>Plan.validateOrdering({...plan,video:[a,depth]},{nodes:{ao:{requirements:{depth:true}}}}),/Depth|coordinates/);
});
test("historical Automatic processing input becomes a fixed 540-pixel height and bypass never changes its request",()=>{
 const Requirements=require("../src/modules/shared/effects/execution-requirements");
 const auto={relativeTo:"presentation",automatic:true},fixed={height:540};
 const value={schema:2,mode:"advanced",video:[{id:"nr-input",kind:"downsample",enabled:true,method:"area",extent:auto,settings:{}}]};
 assert.equal(Plan.DEFAULT_PROCESSING_HEIGHT,540);
 assert.deepEqual(Plan.validate(value).video[0].extent,fixed);assert.deepEqual(Plan.migrate(value).video[0].extent,fixed);
 assert.deepEqual(Plan.validate({...value,enabled:false}).video[0].extent,fixed);
 assert.equal(Requirements.analyze({effects:value}).source,null,"a processing height is not a window-dependent source request");
 assert.equal(Requirements.analyze({effects:value}).needed.sourceResolution,false);
 assert.equal(Requirements.analyze({effects:{...value,enabled:false}}).needed.sourceResolution,false);
 assert.throws(()=>Plan.validate({...value,video:[{...value.video[0],kind:"upscale"}]}),/Downsample/);
 // S14: size fields saved beside Automatic are superseded by the fixed height.
 for(const extra of [{factor:.5},{relativeTo:"input"},{width:1280,height:720}])
  assert.deepEqual(Plan.validate({...value,video:[{...value.video[0],extent:{...auto,...extra}}]}).video[0].extent,fixed);
 for(const extent of [{...auto,automatic:false},{...auto,scale:2}])assert.throws(()=>Plan.validate({...value,video:[{...value.video[0],extent}]}),/Automatic/);
 assert.deepEqual(value.video[0].extent,auto);
});
test("a shader's stage extent is independent of its parameters and preserves explicit downscale geometry",()=>{
 const node={id:"ssim",kind:"shader",enabled:true,shader:{enabled:true,preset:"custom",effectPath:"/filters/downscale.hook",parameters:{strength:[.5]}},extent:{relativeTo:"input",factor:.5}};
 const plan={schema:2,mode:"advanced",video:[node]};assert.deepEqual(Plan.validate(plan).video[0],node);
 assert.deepEqual(Plan.migrate(plan).video[0],node);
 assert.deepEqual(Plan.validate({...plan,video:[{...node,extent:{height:540}}]}).video[0].extent,{height:540});
 assert.throws(()=>Plan.validate({...plan,schema:1}),/unsupported/);
});
test("AMD generation has its own scene and midpoint contract without Lossless Scaling model requirements",()=>{
 const rows=Plan.catalog({graphicsCapabilities:{providerGenerationMethods:["fsr3"]},graphicsSettings:{frameMultiplier:5}});
 const row=rows.find(row=>row.id==="frame-generation:fsr3");assert.ok(row);
 assert.equal(row.available,true);assert.deepEqual(row.pendingInputs,["depth","motion","camera"]);
 assert.equal(row.inputContract.domain,"scene");assert.equal(row.inputContract.acceptsSynthetic,false);
 assert.equal(row.outputContract.phases,"midpoint");assert.equal(row.outputContract.maximumMultiplier,2);
 assert.equal(row.template.settings.frameMultiplier,2);assert.equal(row.requirements.includes("models"),false);
 assert.equal(Plan.validate({schema:2,mode:"advanced",video:[{...row.template,id:"amd"}]}).video[0].method,"fsr3");
});
test("schema 2 sizing helpers name an existing, unowned owner with at most one helper per role", async () => {
  const owner = {id: "up", kind: "upscale", enabled: true, method: "fsr1", settings: {}};
  const helper = (extra = {}) => ({id: "small", kind: "downsample", enabled: true, method: "bilinear", settings: {},
    extent: {relativeTo: "presentation", factor: .5}, ownedBy: {id: "up", role: "input"}, ...extra});
  const make = video => ({schema: 2, mode: "advanced", video});
  const browser = await import("../src/modules/shared/effects/plan.mjs");
  for (const Model of [Plan, browser]) {
    const plan = Model.validate(make([helper(), owner, helper({id: "fit", kind: "spatial", extent: undefined, ownedBy: {id: "up", role: "fit"}})]));
    assert.deepEqual(plan.video.map(row => row.ownedBy), [{id: "up", role: "input"}, undefined, {id: "up", role: "fit"}]);
    assert.deepEqual(Model.validate(plan), plan);assert.deepEqual(Model.migrate(plan), plan);
    assert.deepEqual(Model.execution({...plan, enabled: false}).video.map(row => row.ownedBy), plan.video.map(row => row.ownedBy));
    for (const [video, message] of [
      [[helper({ownedBy: {id: "gone", role: "input"}}), owner], /not in the plan/],
      [[helper({ownedBy: {id: "small", role: "input"}})], /own itself/],
      [[helper(), {...owner, ownedBy: {id: "small", role: "fit"}}], /another helper/],
      [[helper(), helper({id: "second"}), owner], /at most one/],
      [[helper({ownedBy: {id: "up", role: "output"}}), owner], /input or fit role/],
      [[helper({ownedBy: {id: "up", role: "input", extra: true}}), owner], /unsupported fields/],
      [[helper({ownedBy: {id: "scene", role: "input"}}), {id: "scene", kind: "temporal", enabled: true, method: "fsr2", settings: {}}], /can own/],
      [[owner, {id: "look", kind: "shader", enabled: true, shader: {preset: "crt"}, ownedBy: {id: "up", role: "fit"}}], /Only resize rows/]
    ]) assert.throws(() => Model.validate(make(video)), message);
    const {extent: _extent, ...spatial} = helper({kind: "spatial"}), legacy = {schema: 1, mode: "advanced", video: [spatial, {...owner, kind: "spatial"}]};
    assert.throws(() => Model.validate(legacy), /unsupported fields/, "schema 1 has no ownership");
  }
});
test("reading a saved plan reports why it cannot be used and never substitutes another plan (S5)", async () => {
  const Requirements = require("../src/modules/shared/effects/execution-requirements");
  const browser = await import("../src/modules/shared/effects/plan.mjs"), valid = {schema: 2, mode: "advanced", video: []};
  const newer = {schema: 8, mode: "advanced", video: []}, unknown = {...valid, video: [{id: "a", kind: "shader", enabled: true, shader: {preset: "crt"}, extra: true}]};
  const legacy = {reshade: {enabled: true, preset: "crt"}, graphics: {spatialMethod: "fsr1"}};
  for (const Reader of [Plan, browser]) {
    for (const absent of [undefined, null]) {assert.deepEqual(Reader.inspect(absent), {plan: null});assert.equal(Reader.normalize(absent), null);}
    assert.deepEqual(Reader.inspect(valid), {plan: Reader.validate(valid)});assert.deepEqual(Reader.normalize(valid), Reader.validate(valid));
    assert.deepEqual(Reader.inspect(newer), {error: {code: "GRAPHICS_PLAN_NEWER", message: "This effects plan uses a newer schema."}});
    assert.equal(Reader.inspect(unknown).error.code, "GRAPHICS_PLAN_INVALID");assert.match(Reader.inspect(unknown).error.message, /unsupported fields/);
    assert.throws(() => Reader.normalize(newer), {code: "GRAPHICS_PLAN_NEWER"});
    assert.throws(() => Reader.normalize(unknown), {code: "GRAPHICS_PLAN_INVALID", message: /unsupported fields/});
    for (const read of [Reader.fromLegacy, Reader.composeSimple, Reader.reconstructionPreset])
      assert.throws(() => read({...legacy, effects: unknown}), {code: "GRAPHICS_PLAN_INVALID"}, "the legacy fields never replace an invalid saved plan");
  }
  const settings = {...valid, video: [{id: "s", kind: "upscale", enabled: true, method: "fsr1", settings: {depth: true}}]};
  assert.equal(browser.inspect(settings).plan.video.length, 1);
  assert.equal(Plan.inspect(settings).error.code, "GRAPHICS_PLAN_INVALID", "the Node reader's settings checks report through the same error");
  // Launch demand bypasses an invalid plan instead of running its legacy fields.
  for (const effects of [newer, unknown]) {
    const demand = Requirements.analyze({...legacy, effects});
    assert.equal(demand.needed.processor, false);assert.deepEqual(demand.methods.spatial, []);assert.deepEqual(demand.shaders, []);
  }
  // Only the saved plan is read: v0.4.0 fields run only as their upgraded plan.
  assert.equal(Requirements.analyze(legacy).needed.processor, false);
  assert.equal(Requirements.analyze(require("../src/modules/shared/effects/stored-plan").upgradeLegacy(legacy)).needed.processor, true);
});
test("row-level salvage leaves out only the parts that cannot be read", () => {
  const shader = {id: "gray", kind: "shader", enabled: true, shader: {enabled: true, preset: "grayscale"}};
  const scale = {id: "scale", kind: "spatial", enabled: true, method: "bilinear", settings: {}};
  const valid = {schema: 2, mode: "advanced", enabled: true, video: [shader, scale]};
  assert.deepEqual(Plan.salvage(valid), {plan: Plan.validate(valid), dropped: []});
  assert.deepEqual(Plan.salvage(null), {plan: null, dropped: []});
  const damaged = {...valid, video: [shader, {...shader, id: "bad", extra: true}, "row", {...scale, id: "gray"},
    {...scale, id: "fit", ownedBy: {id: "bad", role: "fit"}}, scale],
  renderResolution: {multiplier: 2, managedBy: "bad"}, output: {toneMapping: "auto", motionClarity: "sideways", adaptiveQuality: {nodeId: "bad"}}};
  const before = structuredClone(damaged), result = Plan.salvage(damaged);
  assert.deepEqual(result.plan, Plan.validate({...valid, output: {toneMapping: "auto"}}));
  assert.deepEqual(result.dropped.map(part => [part.part, part.id]), [["row", "bad"], ["row", "#3"], ["row", "gray"], ["row", "fit"],
    ["renderResolution", "renderResolution"], ["output", "output.motionClarity"], ["output", "output.adaptiveQuality"]]);
  assert.match(result.dropped[3].reason, /belongs to could not be read/);assert.equal(result.dropped[0].label, "grayscale");
  assert.deepEqual(damaged, before, "salvage never changes the saved value");
  assert.deepEqual(Plan.salvage(result.plan), {plan: result.plan, dropped: []}, "a salvaged plan reads as is");
  // Only a newer schema or a broken envelope makes the whole plan unreadable.
  assert.equal(Plan.salvage({schema: 3, mode: "advanced", video: []}).error.code, Plan.PLAN_NEWER);
  for (const envelope of [{schema: 2, mode: "advanced", video: "rows"}, {...valid, extra: true}, {...valid, enabled: "yes"}, [valid]])
    assert.equal(Plan.salvage(envelope).error.code, Plan.PLAN_INVALID);
});
test("ordering failures name each row against the rows before it that pass", () => {
  const colour = {id: "colour", kind: "shader", enabled: true, shader: {preset: "grayscale"}};
  const temporal = {id: "temporal", kind: "temporal", enabled: true, method: "fsr2", settings: {}};
  const plan = {schema: 2, mode: "advanced", video: [colour, temporal, {...colour, id: "later"}]};
  assert.deepEqual(Plan.orderingFailures(plan).map(row => row.id), ["temporal"]);
  assert.throws(() => Plan.validateOrdering(plan), /matching coordinates/);
  // An unavailable row is left out, so the scene row after it keeps its order.
  assert.deepEqual(Plan.orderingFailures(plan, {nodes: {colour: {available: false, reason: "Missing depth"}}}),
    [{id: "colour", reason: "Missing depth", unavailable: true}]);
  assert.deepEqual(Plan.orderingFailures({...plan, video: [temporal, colour]}), []);
});
