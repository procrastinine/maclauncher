const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const Graphics = require("../src/modules/shared/reshade/graphics-settings");
function fixture(t, graphics) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "graphics-settings-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "runtime.json"), JSON.stringify({ features: { graphics } }));return root;
}
test("HDR LSFG policy follows the selected processor while LS1 and older payloads retain their color contract",t=>{
 const Plan=require("../src/modules/shared/effects/plan");
 const common={colorPipelineAPI:1,spatialMethods:["ls1"],frameGenerationMethods:["lsfg"],presentation:{spatial:true,frameGeneration:true}};
 const old=Graphics.capabilities(fixture(t,common)),current=Graphics.capabilities(fixture(t,{...common,lsfgHDRAPI:1}));
 assert.equal(old.lsfgHDR,false);assert.equal(current.lsfgHDR,true);
 const row=(support,id)=>Plan.catalog({graphicsCapabilities:support}).find(value=>value.id===id);
 assert.equal(row(old,"frame-generation:lsfg").colorPolicy.provider,"srgb-sdr");
 assert.equal(row(current,"frame-generation:lsfg").colorPolicy.provider,"scrgb-linear");
 assert.equal(row(current,"frame-generation:lsfg").colorPolicy.hdrToneMap,undefined);
 assert.equal(row(current,"upscale:ls1").colorPolicy.provider,"srgb-sdr");
});
test("selected launch methods discover their provider while the UI retains its full registry", t => {
  const root = fixture(t, {spatialMethods: ["bilinear"], temporalMethods: ["fsr2", "fsr3", "fsr4"], virtualWindowAPI: 1,
    presentation: {hosts: {window: {spatial: true, temporal: true}}}});
  const Fsr = require("../src/modules/shared/reshade/temporal/fsr"), Fsr4 = require("../src/modules/shared/reshade/temporal/fsr4");
  const fsr = t.mock.method(Fsr, "resolve", () => ({methods: ["fsr2", "fsr3"]})), fsr4 = t.mock.method(Fsr4, "resolve", () => ({}));
  fs.mkdirSync(path.join(root, "libplacebo"));
  fs.writeFileSync(path.join(root, "libplacebo/provider.json"), JSON.stringify({filters: [{name: "lanczos", label: "Lanczos"}, {name: "triangle", label: "triangle"},
    {name: "ewa_hanning", label: "ewa_hanning"}, {name: "ewa_robidouxsharp", label: "EWA RobidouxSharp"}]}));
  const record = JSON.parse(fs.readFileSync(path.join(root, "runtime.json"), "utf8"));
  record.features.shaders = {formats: ["libplacebo"]};fs.writeFileSync(path.join(root, "runtime.json"), JSON.stringify(record));
  const selected = Graphics.capabilities(root, "window", {selectedMethods: {spatial: ["bilinear"], temporal: ["fsr3"]}});
  assert.deepEqual(selected.temporalMethods, ["fsr3"]);
  assert.deepEqual(selected.spatialMethods, ["bilinear"]);
  assert.equal(selected.virtualWindow, true);assert.deepEqual(selected.resolutionMultipliers, [1, 1.5, 2, 3]);
  assert.equal(fsr.mock.callCount(), 1);assert.equal(fsr4.mock.callCount(), 0);
  const full = Graphics.capabilities(root, "window");
  assert.deepEqual(full.temporalMethods, ["fsr2", "fsr3", "fsr4"]);
  assert.ok(full.spatialMethods.includes("libplacebo:lanczos"));
  assert.deepEqual(full.spatialMethodLabels, {"libplacebo:lanczos": "Lanczos", "libplacebo:triangle": "Triangle", "libplacebo:ewa_hanning": "EWA Hanning",
    "libplacebo:ewa_robidouxsharp": "EWA Robidoux Sharp"}, "filters the provider names by identifier or joined words get readable labels");
  assert.equal(fsr.mock.callCount(), 2);assert.equal(fsr4.mock.callCount(), 1);
});
test("common graphics settings stay off without inspecting files and reject invalid updates", async () => {
  assert.deepEqual(await Graphics.prepare({}, { root: "/missing" }), {});
  for (const patch of [{ spatialMethod: "dlss" }, { spatialFactor: 0.5 }, { spatialFactor: Infinity }, { frameMultiplier: 2.5 },
    { frameMultiplier: 6 }, { effectPlacement: "middle" }, { lsfgFlowScale: 0 }, { lsfgFp16: "true" }, { spatialSharpness: 1.1 }, { ls1Mode: "auto" }, { modelVersion: "relative.dll" }, { command: "arbitrary" }])
    assert.throws(() => Graphics.updateSettings({}, patch));
  const selected = Graphics.updateSettings({}, { spatialMethod: "metalfx", spatialSharpness: 0.75 });
  assert.equal(Graphics.updateSettings(selected, { frameGeneration: "lsfg" }).spatialSharpness, 0.75);
  assert.throws(() => Graphics.updateSettings({}, { spatialFactor: 2 }));
  assert.equal(Graphics.normalizeSettings({ spatialFactor: 2 }).spatialFactor, undefined);
});
test("provider scaling directions populate the shared downsample and upscale selectors",async t=>{
  const root=fixture(t,{resizeAPI:2,spatialMethods:['bilinear'],presentation:{hosts:{window:{spatial:true}}}});
  fs.mkdirSync(path.join(root,'libplacebo'));fs.writeFileSync(path.join(root,'libplacebo/provider.json'),JSON.stringify({filters:[
    {name:'lanczos',label:'Lanczos',upscale:true,downscale:true},
    {name:'nearest',label:'Nearest',upscale:true,downscale:false},
    {name:'ewa_hann',label:'EWA Hann',upscale:false,downscale:true}]}));
  const record=JSON.parse(fs.readFileSync(path.join(root,'runtime.json'),'utf8'));record.features.shaders={formats:['libplacebo']};fs.writeFileSync(path.join(root,'runtime.json'),JSON.stringify(record));
  t.mock.method(globalThis,'fetch',()=>assert.fail('Local filter selection stays offline'));
  const capabilities=Graphics.capabilities(root,'window');
  assert.deepEqual(capabilities.downsampleMethods,['libplacebo:lanczos','libplacebo:ewa_hann']);
  assert(capabilities.spatialMethods.includes('libplacebo:lanczos'));assert(!capabilities.spatialMethods.includes('libplacebo:ewa_hann'));
  const catalog=require('../src/modules/shared/effects/plan').catalog({graphicsCapabilities:capabilities});
  assert(catalog.find(row=>row.id==='downsample:libplacebo:lanczos').available);
  assert(catalog.find(row=>row.id==='downsample:libplacebo:ewa_hann').available);
  assert(!catalog.some(row=>row.id==='downsample:libplacebo:nearest'));
  assert.equal(Graphics.supportsSpatialMethod(capabilities,'libplacebo:nearest','downsample'),false);
  await assert.rejects(Graphics.prepare({spatialMethod:'libplacebo:nearest'},{root,graphicsHost:'window',stageDirection:'downsample'}),{code:'GRAPHICS_OPTIONAL_UNAVAILABLE'});
});
test("spatial shader selection preserves its complete settings independently of post effects", () => {
  const ShaderSettings = require("../src/modules/shared/reshade/shader-settings"), ReShade = require("../src/modules/shared/reshade");
  for (const key of ["PRESETS", "normalizeSettings", "updateSettings"]) assert.equal(ReShade[key], ShaderSettings[key]);
  const shader = {enabled: true, preset: "custom", effectPath: "/filters/resize.slangp", parameters: {Sharpness: [.7], Offset: [1, 2]}};
  const selected = Graphics.updateSettings({spatialMethod: "fsr1", frameGeneration: "lsfg"}, {spatialShader: shader});
  assert.equal(selected.spatialMethod, "off");
  assert.equal(selected.frameGeneration, "lsfg");
  assert.deepEqual(selected.spatialShader, {...shader, enabled: true});
  assert.notEqual(selected.spatialShader.parameters, shader.parameters);
  assert.equal(Graphics.enabled(Graphics.normalizeSettings({spatialShader: shader})), true);
  const edited = Graphics.updateSettings(selected, {spatialMultiplier: 2, spatialSharpness: .2});
  assert.deepEqual(edited.spatialShader, selected.spatialShader);
  const chain = {preset: "chain", effects: ["grayscale", "cas"], parameters: {Amount: [.5]}};
  assert.deepEqual(Graphics.normalizeSettings({spatialShader: chain}).spatialShader,
    {enabled: true, effectPath: null, ...chain});
});
test("spatial method and shader setters replace only the selected scaling choice", () => {
  const shader = {preset: "custom", effectPath: "/filters/resize.glsl", parameters: {Strength: [.4]}};
  const selected = Graphics.updateSettings({}, {spatialShader: shader});
  for (const spatialMethod of ["off", "metalfx", "libplacebo:lanczos"]) {
    const next = Graphics.updateSettings(selected, {spatialMethod});
    assert.equal(next.spatialMethod, spatialMethod);
    assert.equal(next.spatialShader, null);
  }
  assert.deepEqual(Graphics.updateSettings(selected, {spatialMethod: "off", spatialShader: shader}).spatialShader,
    selected.spatialShader);
  const methodWins = Graphics.updateSettings(selected, {spatialMethod: "fsr1", spatialShader: shader});
  assert.equal(methodWins.spatialMethod, "fsr1");assert.equal(methodWins.spatialShader, null);
  assert.equal(Graphics.enabled(Graphics.updateSettings(selected, {spatialShader: null})), false);
});
test("invalid stored spatial shaders normalize off without silently selecting CRT", () => {
  for (const spatialShader of [{}, [], "crt", {preset: "unknown"}, {preset: "custom", effectPath: "relative.fx"},
    {preset: "crt", parameters: {Amount: [Infinity]}}, {preset: "crt", command: "invalid"}]) {
    const settings = Graphics.normalizeSettings({spatialShader});
    assert.equal(settings.spatialShader, null);assert.equal(Graphics.enabled(settings), false);
    assert.throws(() => Graphics.updateSettings({}, {spatialShader}), /supported graphics settings/);
  }
  assert.equal(Graphics.normalizeSettings({spatialMethod: "fsr1", spatialShader: {preset: "crt"}}).spatialMethod, "off");
});
test("dormant graphics settings do not load shader discovery or parameter helpers", () => {
  const {execFileSync} = require("node:child_process");
  execFileSync(process.execPath, ["-e", `
    const Module = require('node:module'), load = Module._load;
    Module._load = function(request, ...args) {
      if (/^\\.\\/(live-controls|filter-library|managed-shaders|shader-packs)$/.test(request)) throw Error('Unexpected dormant shader dependency: ' + request);
      return load.call(this, request, ...args);
    };
    const Graphics = require('./src/modules/shared/reshade/graphics-settings');
    const settings = Graphics.normalizeSettings({spatialShader: null});
    if (Graphics.enabled(settings) || settings.spatialShader !== null) throw Error('Dormant settings enabled graphics');
    Graphics.prepare({}, {root:'/missing'}).then(value => {
      if (Object.keys(value).length) throw Error('Dormant preparation produced an environment');
    });
  `], {cwd: path.resolve(__dirname, ".."), stdio: "pipe", timeout: 10000});
});
test("virtual source control requires the selected native API and never implies an initially active session", t => {
  const old = fixture(t, {virtualWindowAPI: 1, presentation: {hosts: {window: {spatial: true}, remote: {spatial: true}}}});
  assert.equal(Graphics.capabilities(old, "window").virtualSourceControl, undefined);
  const root = fixture(t, {virtualWindowAPI: 1, virtualSourceControlAPI: 1, presentation: {hosts: {window: {spatial: true}, remote: {spatial: true}}}});
  assert.equal(Graphics.capabilities(root, "window").virtualSourceControl, true);
  assert.equal(Graphics.capabilities(root, "remote").virtualSourceControl, undefined);
  const Source = require("../src/modules/shared/reshade/source-resolution");
  assert.equal(Source.capabilities("window", {}, [], true).live, undefined);
  const activation = fixture(t, {virtualWindowAPI: 1, virtualSourceControlAPI: 1, virtualSourceActivationAPI: 1,
    presentation: {hosts: {window: {spatial: true}, remote: {spatial: true}}}});
  const support = Graphics.capabilities(activation, "window");
  assert.deepEqual(support.virtualWindow, {activationAPI: 1});
  assert.equal(Source.capabilities("window", {}, [], support.virtualWindow).live, true);
  assert.equal(Graphics.capabilities(activation, "remote").virtualWindow, undefined);
  const incomplete = fixture(t, {virtualWindowAPI: 1, virtualSourceActivationAPI: 1,
    presentation: {hosts: {window: {spatial: true}}}});
  assert.equal(Graphics.capabilities(incomplete, "window").virtualWindow, true,
    "activation cannot bypass the exact native source control prerequisite");
});
test("automatic virtual allocation is gated by the complete selected activation API", t => {
  const Source = require("../src/modules/shared/reshade/source-resolution");
  const base = {virtualWindowAPI: 1, virtualSourceControlAPI: 1, virtualSourceActivationAPI: 1,
    presentation: {hosts: {window: {spatial: true}, remote: {spatial: true}}}};
  const old = Graphics.capabilities(fixture(t, base), "window");
  assert.equal(Source.capabilities("window", {}, [], old.virtualWindow).automatic, undefined);
  const selected = fixture(t, {...base, virtualSourceAutoAPI: 1});
  assert.deepEqual(Graphics.capabilities(selected, "window").virtualWindow, {activationAPI: 1, autoAPI: 1});
  assert.equal(Source.capabilities("window", {}, [], Graphics.capabilities(selected, "window").virtualWindow).automatic, true);
  assert.equal(Graphics.capabilities(selected, "remote").virtualWindow, undefined);
  assert.equal(Graphics.capabilities(fixture(t, {...base, virtualSourceActivationAPI: undefined, virtualSourceAutoAPI: 1}), "window").virtualWindow, true);
});
test("effect placement preserves the default and requires a host that can reorder spatial processing", async t => {
  assert.equal(Graphics.normalizeSettings({}).effectPlacement, "before");
  assert.equal(Graphics.enabled(Graphics.normalizeSettings({ effectPlacement: "after" })), false, "placement alone does not enable processing");
  const root = fixture(t, { spatialMethods: ["fsr1"], presentation: { hosts: {
    window: { spatial: true, effectPlacement: true }, remote: { spatial: true }
  } } });
  assert.deepEqual(await Graphics.prepare({ effectPlacement: "after" }, { root, graphicsHost: "window" }), { RESHADE_EFFECT_PLACEMENT: "after" });
  const env = await Graphics.prepare({ spatialMethod: "fsr1", effectPlacement: "before" }, { root, graphicsHost: "window" });
  assert.equal(env.RESHADE_EFFECT_PLACEMENT, "before");
  await assert.rejects(Graphics.prepare({ effectPlacement: "after" }, { root, graphicsHost: "remote" }), /Before spatial scaling/);
});
test("encoding support and model compatibility cannot bypass presentation capability", async t => {
  const root = fixture(t, { sharedFrameEncoder: true, spatialMethods: ["metalfx"], frameGenerationMethods: ["lsfg"], presentation: { spatial: false, frameGeneration: false } });
  const resolveModel = () => assert.fail("no resource resolution before presentation support");
  await assert.rejects(Graphics.prepare({ spatialMethod: "metalfx" }, { root, resolveModel }), /cannot be presented/);
  await assert.rejects(Graphics.prepare({ frameGeneration: "lsfg" }, { root, resolveModel }), /cannot be presented/);
});
test("fixed render resolution requires an actual producer capability and preserves Auto for existing settings", async t => {
  const old = fixture(t, { spatialMethods: ["metalfx"], presentation: { spatial: true } });
  assert.equal(Graphics.normalizeSettings({ spatialMethod: "metalfx" }).spatialMultiplier, null);
  assert.equal((await Graphics.prepare({ spatialMethod: "metalfx" }, { root: old })).RESHADE_RESOLUTION_MULTIPLIER, undefined);
  const warnings = [], fallback = await Graphics.prepare({ spatialMethod: "metalfx", spatialMultiplier: 2 }, { root: old,
    logger: {warn: message => {warnings.push(message);throw Error("Warning sink unavailable");}} });
  assert.equal(fallback.RESHADE_RESOLUTION_MULTIPLIER, undefined);assert.equal(fallback.RESHADE_SPATIAL_METHOD, "metalfx");assert.equal(warnings.length, 1);
  const root = fixture(t, { spatialMethods: ["metalfx"], presentation: { hosts: { explicit: { spatial: true, resolutionMultipliers: [1, 1.5, 2] } } } });
  for (const factor of [1, 1.5, 2]) {
    const settings = Graphics.updateSettings({}, { spatialMethod: "metalfx", spatialMultiplier: factor });
    const env = await Graphics.prepare(settings, { root, graphicsHost: "explicit" });
    assert.equal(env.RESHADE_RESOLUTION_MULTIPLIER, String(factor));
    assert.equal(env.RESHADE_SPATIAL_METHOD, "metalfx");
    assert.deepEqual(await Graphics.prepare({ ...settings, spatialMethod: "off" }, { root: "/missing" }), {});
  }
  await assert.rejects(Graphics.prepare({ spatialMethod: "metalfx", spatialMultiplier: 3 }, { root, graphicsHost: "explicit" }), /render resolution/);
  assert.equal(Graphics.updateSettings({}, {spatialMultiplier: 4}).spatialMultiplier, 4);
  for (const spatialMultiplier of [0, 0.5, 1.25, 5, Infinity, "2"]) assert.throws(() => Graphics.updateSettings({}, { spatialMultiplier }));
});
test("graphics presentation is available only to the selected runtime host", async t => {
  const root = fixture(t, { spatialMethods: ["bilinear", "metalfx"], frameGenerationMethods: ["lsfg"],
    presentation: { spatial: false, frameGeneration: false,
      hosts: { window: { spatial: true, frameGeneration: false } } } });
  assert.equal(Graphics.capabilities(root).hosts.window.spatial, true);
  assert.equal(Graphics.capabilities(root).hosts.remote.spatial, false);
  for (const graphicsHost of [undefined, null, "remote", "explicit", "unknown"]) {
    await assert.rejects(Graphics.prepare({ spatialMethod: "metalfx" }, { root, graphicsHost }), /cannot be presented/);
  }
  const environment = await Graphics.prepare({ spatialMethod: "metalfx" }, { root, graphicsHost: "window" });
  assert.equal(environment.RESHADE_SPATIAL_METHOD, "metalfx");
  await assert.rejects(Graphics.prepare({ frameGeneration: "lsfg" }, { root, graphicsHost: "window" }), /cannot be presented/);
});
test("web engines and hosted web runtimes prepare graphics through the shared remote presenter", async t => {
  const root = fixture(t, { spatialMethods: ["metalfx"], frameGenerationMethods: ["lsfg"],
    presentation: { hosts: { remote: { spatial: true, frameGeneration: false } } } });
  const registry = require("../src/modules/registry");
  const choices = [
    ...["construct", "gamemaker-html5", "mv", "mz", "tyrano", "web"].flatMap(id =>
      Object.keys(registry.getModuleInfo(id).runtime.entries).filter(runtime => ["nwjs", "nwjs-patched", "electron"].includes(runtime))
        .map(runtime => [id, runtime])),
    ["nscripter", "onsyuri_web"], ["wolfrpg", "browser-woditor"]
  ];
  for (const [id, runtime] of choices) {
    const graphicsHost = registry.getModuleInfo(id).runtime.entries[runtime].graphicsHost;
    const environment = await Graphics.prepare({ spatialMethod: "metalfx" }, { root, graphicsHost });
    assert.equal(environment.RESHADE_SPATIAL_METHOD, "metalfx", id + ":" + runtime);
    await assert.rejects(Graphics.prepare({ frameGeneration: "lsfg" }, { root, graphicsHost }), /cannot be presented/);
  }
});
test("Catalyst retains publisher allocation unless a cooperating source capability is declared", async t => {
  const root = fixture(t, require("../src/modules/shared/reshade/features.json").graphics);
  const graphicsHost = require("../src/modules/registry").getModuleInfo("ios").runtime.entries.playcover.graphicsHost;
  assert.equal(graphicsHost, "catalyst");
  const capabilities = Graphics.capabilities(root).hosts.catalyst;
  assert.equal(capabilities.spatial, true); assert.equal(capabilities.frameGeneration, true);
  assert.deepEqual(capabilities.resolutionMultipliers, []);
  assert.deepEqual(await Graphics.prepare({}, { root, graphicsHost }), {});
  const scaled = await Graphics.prepare({ spatialMethod: "metalfx", spatialMultiplier: 2 }, { root, graphicsHost });
  assert.equal(scaled.RESHADE_RESOLUTION_MULTIPLIER, undefined);
  assert.equal(scaled.RESHADE_SPATIAL_METHOD, "metalfx");
  const graphicsInputs = {sourceResolution: {heights: true, multipliers: [1, 1.5, 2], control: "drawable"}};
  const cooperative = await Graphics.prepare({spatialMethod: "metalfx", spatialMultiplier: 2}, {root, graphicsHost, graphicsInputs});
  assert.equal(cooperative.RESHADE_RESOLUTION_MULTIPLIER, "2");assert.equal(cooperative.RESHADE_RENDER_SOURCE_CONTROL, "drawable");
  await assert.rejects(Graphics.prepare({ spatialMethod: "metalfx", spatialMultiplier: 3 }, { root, graphicsHost, graphicsInputs }), /render resolution/);
  const Packs = require("../src/modules/shared/reshade/shader-packs");
  const features = require("../src/modules/shared/reshade/features.json").shaders;
  assert.equal(Packs.requirements({ requires: ["depth"] }, features, graphicsHost), null,
    "the shared host supports depth; matching frame inputs determine whether a row can run");
  const Plan = require("../src/modules/shared/effects/plan"), preset = {id: "frame-depth", available: true, traits: {sceneInputs: ["depth"]}};
  const catalog = graphicsInputs => Plan.catalog({reshadeState: {available: true, presets: [preset]},
    graphicsHost, graphicsCapabilities: capabilities, graphicsInputs}).find(row => row.id === "shader:frame-depth");
  assert.deepEqual(catalog(null).pendingInputs, ["depth"]);
  assert.equal(catalog(null).availableWithoutInputs, true, "missing frame data remains pending without disabling independent effects");
  assert.equal(Packs.requirements({ requires: [] }, features, graphicsHost), null);
});
test("native GPU runtime entries share window scaling while tools and unadapted publishers stay excluded", async t => {
  const root = fixture(t, { spatialMethods: ["metalfx"], frameGenerationMethods: ["lsfg"],
    presentation: { hosts: { window: { spatial: true, frameGeneration: false } } } });
  const registry = require("../src/modules/registry");
  for (const [id, runtime] of [["fna", "native"], ["unity", "unity"], ["unity", "native"],
    ["godot", "godot"], ["godot", "native"], ["love", "love"], ["love", "native"], ["rgss", "mkxpz"], ["gamemaker", "opengmk"],
    ["scummvm", "scummvm"], ["java", "java"], ["easyrpg", "easyrpg"], ["renpy", "sdk"], ["renpy", "patched"], ["renpy", "native"],
    ["flash", "ruffle"], ["flash", "projector"], ["hashlink", "hashlink"], ["gemrb", "gemrb"], ["ikemen", "ikemen"], ["generic-app", "native"],
    ["ai5", "ai5"], ["alicesoft", "system3"], ["alicesoft", "xsystem35"], ["alicesoft", "xsystem4"], ["fvp", "rfvp"], ["fna", "fna"],
    ["gamemaker", "butterscotch"], ["gamemaker", "official-studio"], ["gamemaker", "native"], ["kirikiri", "krkrsdl2"],
    ["mages", "impacto"], ["minori", "reminori"], ["nitroplus", "npengine"], ["nscripter", "onsyuri_mac"], ["nscripter", "onscripter_en"],
    ["nscripter", "external"], ["siglus", "siglus"], ["siglus", "rlvm"], ["vnds", "vnds_love"],
    ...["construct", "gamemaker-html5", "mv", "mz", "tyrano", "web"].map(id => [id, "native"])]) {
    const graphicsHost = registry.getModuleInfo(id).runtime.entries[runtime].graphicsHost;
    const environment = await Graphics.prepare({ spatialMethod: "metalfx" }, { root, graphicsHost });
    assert.equal(environment.RESHADE_SPATIAL_METHOD, "metalfx", id + ":" + runtime);
    await assert.rejects(Graphics.prepare({ frameGeneration: "lsfg" }, { root, graphicsHost }), /cannot be presented/);
  }
  for (const [id, runtime] of [["gamemaker", "inspection"], ["haxe", "inspection"],
    ["bgi", "bgi-tools"], ["catsystem2", "catsystem2-tools"]]) {
    const graphicsHost = registry.getModuleInfo(id).runtime.entries[runtime].graphicsHost;
    await assert.rejects(Graphics.prepare({ spatialMethod: "metalfx" }, { root, graphicsHost }), /cannot be presented/);
  }
});
test("native window metadata does not supply scene depth or temporal inputs", t => {
  const registry = require("../src/modules/registry"), Plan = require("../src/modules/shared/effects/plan");
  const root = fixture(t, { spatialMethods: ["metalfx"], temporalMethods: ["metalfx"], presentation: { hosts: {
    window: { spatial: true, temporal: true, temporalMethods: ["metalfx"] }
  } } });
  for (const [id, runtime] of [["java", "java"], ["scummvm", "scummvm"], ["renpy", "sdk"], ["generic-app", "native"]]) {
    const graphicsHost = registry.getModuleInfo(id).runtime.entries[runtime].graphicsHost;
    const catalog = Plan.catalog({ reshadeState: { available: true, presets: [{ id: "depth-filter", label: "Depth effect", depthHosts: ["window"] }] },
      graphicsCapabilities: Graphics.capabilities(root, graphicsHost), graphicsHost, graphicsInputs: null });
    const depth = catalog.find(row => row.label === "Depth effect"), temporal = catalog.find(row => row.kind === "temporal" && row.template.method === "metalfx");
    assert.equal(depth.available, true);assert.deepEqual(depth.pendingInputs,["depth"]);assert.match(depth.inputReason,/depth/);
    assert.equal(temporal.available, true);assert.deepEqual(temporal.pendingInputs,["depth","motion"]);assert.match(temporal.inputReason,/inputs/);
  }
});
test("shared graphics configuration requires the exact scaler and resource capabilities", async t => {
  const root = fixture(t, { spatialMethods: ["bilinear", "metalfx", "ls1"], frameGenerationMethods: ["lsfg"], presentation: { spatial: true, frameGeneration: true } });
  await assert.rejects(Graphics.prepare({ spatialMethod: "mako" }, { root }), /cannot be presented/);
  const calls = [], modelVersion = "sha256-" + "a".repeat(64);
  let leased = false;
  const result = await Graphics.prepare({ spatialMethod: "ls1", frameGeneration: "lsfg", frameMultiplier: 5,
    lsfgMode: "performance", lsfgFp16: false, lsfgFlowScale: 0.5, modelVersion }, { root, userDataDir: "/profile",
    useModel: async version => { assert.equal(version, modelVersion); leased = true; },
    resolveModel: async (profile, version, capability) => { assert.equal(leased, true);assert.equal(profile, "/profile");assert.equal(version, modelVersion);calls.push(capability);return { modelPath: "/profile/owned/Model.dll" }; } });
  assert.deepEqual(calls, ["ls1Quality", "lsfgFp32Performance"]);
  assert.equal(result.RESHADE_LOSSLESS_MODEL, "/profile/owned/Model.dll");assert.equal(result.RESHADE_SPATIAL_FACTOR, undefined);
  assert.equal(result.RESHADE_FRAME_MULTIPLIER, "5");assert.equal(result.RESHADE_LSFG_FP16, "0");assert.equal(result.RESHADE_LSFG_FLOW_SCALE, "0.5");
  assert.equal(result.RESHADE_LS1_MODE, "quality");assert.equal(result.RESHADE_SPATIAL_SHARPNESS, "0.5");
  await Graphics.prepare({ spatialMethod: "ls1", ls1Mode: "performance", modelVersion }, { root,
    resolveModel: async (_profile, _version, capability) => { assert.equal(capability, "ls1Performance");return { modelPath: "/owned.dll" }; } });
  await assert.rejects(Graphics.prepare({ frameGeneration: "lsfg", modelVersion }, { root, resolveModel: async () => { throw Error("corrupt resource"); } }), /corrupt resource/);
});
test("FSR1 uses installed shared graphics without resolving models and stays gated by payload support", async t => {
  const old = fixture(t, { spatialMethods: ["metalfx"], presentation: { spatial: true } });
  await assert.rejects(Graphics.prepare({ spatialMethod: "fsr1" }, { root: old }), /cannot be presented/);
  const root = fixture(t, { spatialMethods: ["fsr1"], presentation: {
    hosts: { window: { spatial: true }, remote: { spatial: true }, explicit: { spatial: false } }
  } });
  for (const graphicsHost of ["window", "remote"]) {
    const selected = Graphics.updateSettings({}, { spatialMethod: "fsr1", spatialSharpness: 0 });
    const environment = await Graphics.prepare(selected, { root, graphicsHost,
      resolveModel: () => assert.fail("FSR1 needs no external model"), useModel: () => assert.fail("FSR1 needs no model lease") });
    assert.equal(environment.RESHADE_SPATIAL_METHOD, "fsr1");
    assert.equal(environment.RESHADE_SPATIAL_SHARPNESS, "0");
    assert.equal(environment.RESHADE_LOSSLESS_MODEL, undefined);
  }
  await assert.rejects(Graphics.prepare({ spatialMethod: "fsr1" }, { root, graphicsHost: "explicit" }), /cannot be presented/);
});
test("installed shared LSFG capabilities prepare native and Chromium hosts without Wine", async t => {
  const features = require("../src/modules/shared/reshade/features.json");
  const root = fixture(t, features.graphics), registry = require("../src/modules/registry");
  const modelVersion = "sha256-" + "b".repeat(64);
  for (const [id, runtime] of [["love", "love"], ["web", "electron"]]) {
    const info = registry.getModuleInfo(id).runtime.entries;
    const graphicsHost = info[runtime].graphicsHost;
    let leased = false, resolved = 0;
    const environment = await Graphics.prepare({ frameGeneration: "lsfg", frameMultiplier: 3,
      lsfgMode: "performance", lsfgFp16: false, lsfgFlowScale: 0.5, modelVersion }, { root, graphicsHost,
      useModel: async version => { assert.equal(version, modelVersion); leased = true; },
      resolveModel: async (_dir, version, capability) => { assert.equal(leased, true); assert.equal(version, modelVersion);
        assert.equal(capability, "lsfgFp32Performance"); resolved++; return { modelPath: "/owned/Model.dll" }; } });
    assert.equal(environment.RESHADE_FRAME_GENERATION, "lsfg", id); assert.equal(resolved, 1);
    assert.equal(environment.RESHADE_SPATIAL_METHOD, "off"); assert.equal(environment.RESHADE_FRAME_MULTIPLIER, "3");
    assert.equal(environment.RESHADE_LSFG_FP16, "0"); assert.equal(environment.RESHADE_LSFG_FLOW_SCALE, "0.5");
    assert.equal(environment.DYLD_LIBRARY_PATH, undefined);
  }
  await assert.rejects(Graphics.prepare({ frameGeneration: "lsfg", modelVersion }, { root, graphicsHost: "unknown" }), /cannot be presented/);
  const explicit = await Graphics.prepare({ spatialMethod: "metalfx" }, { root, graphicsHost: "explicit", resolveModel:()=>assert.fail("MetalFX requires no imported model") });
  assert.equal(explicit.RESHADE_SPATIAL_METHOD, "metalfx");
  assert.equal(Graphics.DEFAULTS.frameGeneration, "off");
});
