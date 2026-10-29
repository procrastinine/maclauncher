const assert = require("node:assert/strict"), path = require("node:path"), test = require("node:test"), Module = require("node:module");
const React = require("react"), { renderToStaticMarkup } = require("react-dom/server"), { build } = require("vite");
const { react, componentHarness: baseHarness } = require("./helpers/renderer-component");
// The chosen view persists for the session, so each harness selects the view it tests.
function viewHarness(view){return (Component,props)=>{const harness=baseHarness(Component,props);if(Component===EffectsControls){const tree=harness.render();elements(tree).find(node=>node.type==="button"&&node.props.children===view).props.onClick();}return harness;};}
const componentHarness=viewHarness("Advanced"),simpleHarness=viewHarness("Simple");
let EffectsControls, effectChoice, effectChooserRows, effectAvailability;
test.before(async () => {
  const result = await build({ configFile: false, logLevel: "silent", build: {
    ssr: path.join(__dirname, "../src/renderer/src/ui/components/EffectsControls.tsx"), write: false,
    rollupOptions: { external: id => /^react(?:-dom)?(?:\/|$)/.test(id), output: { format: "cjs", codeSplitting: false } }
  } });
  const compiled = new Module(path.join(__dirname, "effects-controls.cjs"), module);compiled.paths = module.paths;
  compiled.require = id => id === "react" ? react : Module.prototype.require.call(compiled, id);
  compiled._compile(result.output.find(chunk => chunk.type === "chunk").code, compiled.id);
  ({ EffectsControls, effectChoice, effectChooserRows, effectAvailability } = compiled.exports);
});
const shader = { id: "film", kind: "shader", enabled: true, shader: { enabled: true, preset: "crt", parameters: { Scanlines: [100] } } };
const spatial = { id: "scale", kind: "spatial", enabled: true, method: "metalfx", settings: { spatialMultiplier: 2 } };
const temporal = { id: "motion", kind: "temporal", enabled: false, method: "metalfx", settings: {} };
const plan = { schema: 1, mode: "advanced", video: [shader, spatial, temporal] };
test("GPU and payload availability takes precedence over scene inputs in both graphics views", () => {
  const pending = {id:"temporal:metalfx",kind:"temporal",label:"MetalFX",group:"Temporal",pendingInputs:["depth","motion"],
    template:{id:"scene",kind:"temporal",method:"metalfx",enabled:true,settings:{}}};
  assert.equal(effectAvailability({...pending,available:true,availableWithoutInputs:true}),"Needs depth / motion");
  for (const reason of ["Not supported by the detected GPUs.","The selected graphics processor does not include this MetalFX operation."]) {
    const row = {...pending,available:false,availableWithoutInputs:false,reason};
    assert.equal(effectAvailability(row),"Unavailable","labels carry the state word; the reason stays in title and help");
    const saved = {schema:2,mode:"advanced",enabled:true,video:[pending.template]};
    const h = componentHarness(EffectsControls,{game:{gamePath:"/Game",effects:saved},running:false,
      editor:{info:{plan:saved,catalog:[row],graphicsHardware:{state:"ready",device:{name:"Fixture GPU"}}},onChange(){assert.fail("Reading availability must not save.");}}});
    try {
      let markup=renderToStaticMarkup(h.render());assert.match(markup,/Unavailable/);assert.ok(markup.includes(reason));assert.doesNotMatch(markup,/Needs depth/);
      elements(h.render()).find(node=>node.type==="button"&&node.props.children==="Simple").props.onClick();
      markup=renderToStaticMarkup(h.render());assert.ok(markup.includes(reason));assert.doesNotMatch(markup,/Needs depth/);
    } finally {h.close();}
  }
});
function render(game={}) {const oldWindow=global.window;global.window ||= {};const harness=componentHarness(EffectsControls,{game:{gamePath:"/Games/Example",runtimeId:"native",...game},running:false,status:{available:true,presets:[]}});try{return renderToStaticMarkup(harness.render());}finally{harness.close();global.window=oldWindow;}}
test("Simple and Advanced are non-destructive presentations of one saved chain",()=>{
 const before=structuredClone(plan),markup=render({effects:plan});assert.match(markup,/aria-label="Graphics view"/);assert.match(markup,/>Simple<\/button>/);assert.match(markup,/>Advanced<\/button>/);assert.match(markup,/aria-label="Video effects"/);assert.match(markup,/Clear effects/);assert.doesNotMatch(markup,/Return to simple|clears this chain and turns off/);assert.deepEqual(plan,before);
});
test("opening graphics reads the catalog once and saving does not reload it", async t => {
  const previous = global.window; t.after(() => {global.window = previous;});
  let reads = 0, writes = 0, metadataSerializations = 0;
  const presets = [];presets.toJSON = () => {metadataSerializations++;return [];};
  global.window = {MacLauncher: {launcher: {
    getGameEffects: async () => {reads++;return {plan, catalog: [], live: true};},
    setGameEffects: async (_path, next, options) => {writes++;return {plan:next, desiredRevision:writes, clientRevision:options.clientRevision};}
  }}};
  const harness = componentHarness(EffectsControls, {game:{gamePath:"/Game",effects:plan},running:true,children:null,status:{available:true,presets}});
  try {
    harness.render();await harness.settle();
    const metadataBeforeEdit=metadataSerializations;
    const master = () => elements(harness.render()).find(node => node.type === "input" && node.props.type === "checkbox");
    master().props.onChange({target:{checked:false}});await harness.settle();
    assert.equal(reads,1);assert.equal(writes,1);assert.equal(master().props.checked,false);
    assert.equal(metadataSerializations,metadataBeforeEdit,"parameter and Off edits reuse unchanged catalog metadata");
    assert.doesNotMatch(renderToStaticMarkup(harness.render()), /fieldset[^>]*disabled/);
  } finally {harness.close();}
});
test("Off interrupts unresolved edits and late responses cannot restore them", async t => {
  const previous = global.window;t.after(() => {global.window=previous;});
  const before = {...plan,schema:2,enabled:false,video:[shader]}, writes=[];
  global.window = {MacLauncher:{launcher:{
    getGameEffects:async()=>({plan:before,catalog:[],live:true}),
    setGameEffects:(_path,next,options)=>new Promise(resolve=>writes.push({next,options,resolve}))
  }}};
  const harness=componentHarness(EffectsControls,{game:{gamePath:"/Game",effects:before},running:true,children:null});
  try {
    harness.render();await harness.settle();
    const master=()=>elements(harness.render()).find(node=>node.type==="input"&&node.props.type==="checkbox");
    master().props.onChange({target:{checked:true}});await harness.settle();
    master().props.onChange({target:{checked:false}});await harness.settle();
    assert.equal(writes.length,2);assert.equal(writes[1].next.enabled,false);
    assert.deepEqual(writes[1].next.video,[shader]);assert.equal(master().props.checked,false);
    writes[1].resolve({plan:writes[1].next,desiredRevision:2});await harness.settle();
    writes[0].resolve({plan:writes[0].next,desiredRevision:1});await harness.settle();
    assert.equal(master().props.checked,false);assert.doesNotMatch(renderToStaticMarkup(harness.render()),/role="alert"/);
  } finally {harness.close();}
});
test("opening a migrated chain never changes the saved record", async t => {
  const previous=global.window;t.after(()=>{global.window=previous;});const game={gamePath:"/Game",reshade:{enabled:true,preset:"crt"}},before=structuredClone(game);
  global.window={MacLauncher:{launcher:{getGameEffects:async()=>({plan,catalog:[]}),setGameEffects:()=>assert.fail("Opening must not save"),resetGameEffects:()=>assert.fail("Opening must not reset")}}};
  const harness=componentHarness(EffectsControls,{game,running:false,children:null});
  try {harness.render();await harness.settle();assert.deepEqual(game,before);}finally{harness.close();}
});
test("moving mixed backend nodes preserves each identity, settings, enabled state and parameter map", async () => {
  const before = structuredClone(plan), changes = [];
  const harness = componentHarness(EffectsControls, {game: {gamePath: "preset", effects: plan}, running: false, editor: {info: {plan, catalog: []}, onChange: next => changes.push(next)}});
  const row = id => elements(harness.render()).find(node => node.type === "li" && String(node.key).endsWith("$" + id));
  const control = (id, title) => elements(row(id)).find(node => node.type === "button" && node.props.title === title);
  const event = {preventDefault() {}, stopPropagation() {}};
  try {
    assert.equal(control("film", "Move up").props.disabled, true);assert.equal(control("motion", "Move down").props.disabled, true);
    control("scale", "Move up").props.onClick();await harness.settle();
    const moved = changes.at(-1);assert.deepEqual(moved.video.map(node => node.id), ["scale", "film", "motion"]);
    assert.deepEqual(moved.video[1].shader.parameters, { Scanlines: [100] });assert.equal(moved.video[2].enabled, false);
    elements(row("scale")).find(node => node.type === "summary").props.onKeyDown({...event, altKey: true, key: "ArrowDown"});await harness.settle();
    assert.deepEqual(changes.at(-1).video.map(node => node.id), ["film", "scale", "motion"]);
    row("film").props.onDrop({...event, dataTransfer: {getData: () => JSON.stringify({gamePath: "preset", id: "motion"})}});await harness.settle();
    assert.deepEqual(changes.at(-1).video.map(node => node.id), ["motion", "film", "scale"]);
    assert.deepEqual(changes.at(-1).video[1], moved.video[1]);assert.equal(changes.length, 3);assert.deepEqual(plan, before);
  } finally {harness.close();}
});
test("the chosen graphics view follows the user across editors for the session", () => {
  const before = {schema: 2, mode: "advanced", enabled: true, video: [shader]};
  const props = gamePath => ({game: {gamePath, effects: before}, running: false, editor: {info: {plan: before, catalog: []}, onChange: () => assert.fail("Switching views cannot save")}});
  componentHarness(EffectsControls, props("first")).close();
  const second = baseHarness(EffectsControls, props("second"));
  try {
    assert.match(renderToStaticMarkup(second.render()), /aria-label="Video effects"/);
    elements(second.render()).find(node => node.type === "button" && node.props.children === "Simple").props.onClick();
  } finally {second.close();}
  const third = baseHarness(EffectsControls, props("first"));
  try {assert.match(renderToStaticMarkup(third.render()), /aria-label="Simple graphics"/);} finally {third.close();}
});
test("catalog recommendations lead ordinary implementations only on a known GPU", () => {
  const Plan = require("../src/modules/shared/effects/plan"), {orderImplementations} = require("../src/modules/shared/effects/contracts.mjs");
  const metalfx = Object.fromEntries(["spatial", "temporal", "denoised", "interpolation"].map(key => [key, {supported: true}]));
  const caps = {spatial: true, spatialMethods: ["bilinear", "metalfx"], hardware: {state: "ready", metalfx, devices: [{registryID: "1", name: "GPU", metalfx}]}};
  const choices = Plan.catalog({graphicsCapabilities: caps});
  assert.equal(choices[0].id, "upscale:metalfx");assert.equal(choices[0].recommendationRank, 0);assert.equal(choices.find(row => row.id === "temporal:metalfx").inputContract.domain, "scene");
  const unknown = Plan.catalog({graphicsCapabilities: {...caps, hardware: {state: "unknown"}}});
  assert.ok(unknown.every(row => row.recommendationRank !== 0));assert.equal(unknown.find(row => row.id === "upscale:metalfx").available, true);
  const imported = {template: {kind: "shader", enabled: true, shader: {enabled: true, preset: "filter:custom"}}}, ordinary = {template: {kind: "upscale", method: "bilinear", enabled: true, settings: {}}};
  assert.deepEqual(orderImplementations([ordinary, choices[0], imported]), [choices[0], ordinary, imported]);
});
test("shared catalog ranks common choices first and specialised variants and absent scene inputs last", () => {
  const Plan = require("../src/modules/shared/effects/plan"), Presentation = require("../src/modules/shared/effects/presentation.mjs"), {implementationsFor} = require("../src/modules/shared/effects/contracts.mjs");
  const metalfx = Object.fromEntries(["spatial", "temporal", "denoised", "interpolation"].map(key => [key, {supported: true}]));
  const caps = {spatial: true, spatialMethods: ["bilinear", "metalfx", "fsr1", "nearest", "bicubic", "libplacebo:bilinear", "libplacebo:lanczos", "libplacebo:robidoux"],
    temporal: true, temporalMethods: ["metalfx", "fsr2", "fsr3"], hardware: {state: "ready", metalfx, devices: [{registryID: "1", name: "GPU", metalfx}]}};
  const reshadeState = {available: true, presets: [{id: "crt", label: "CRT"}, {id: "grayscale", label: "Grayscale"}, {id: "cas", label: "CAS Sharpen"},
    {id: "managed-pack:a", label: "Collection file", collection: "Pack collection"}, {id: "managed-pack:b", label: "Named entry", collection: "Pack collection", recommendationRank: 0}]};
  const menu = (catalog, type) => Presentation.orderImplementationGroups(implementationsFor(type, catalog.filter(row => row.available || row.availableWithoutInputs)), type);
  const unknown = Plan.catalog({graphicsCapabilities: caps, reshadeState});
  const upscale = menu(unknown, "upscale");
  assert.deepEqual(upscale.slice(0, 5).map(row => row.id), ["upscale:metalfx", "upscale:bilinear", "upscale:bicubic", "upscale:nearest", "upscale:fsr1"]);
  assert.ok(upscale.slice(0, 5).every(row => Presentation.implementationHeading(row, "upscale") === "Recommended"));
  assert.deepEqual(upscale.filter(Presentation.implementationMore).map(row => row.id), ["upscale:libplacebo:bilinear", "upscale:libplacebo:robidoux"]);
  assert.equal(upscale.at(-1).id, "upscale:libplacebo:robidoux");assert.equal(Presentation.implementationMore(unknown.find(row => row.id === "upscale:libplacebo:lanczos")), false);
  const image = menu(unknown, "image");
  assert.deepEqual(image.slice(0, 2).map(row => row.id), ["shader:crt", "shader:cas"]);
  assert.deepEqual(image.filter(Presentation.implementationMore).map(row => row.id), ["shader:managed-pack:a"]);
  // An undeclared frame source keeps scene rows pending in their groups.
  assert.ok(unknown.every(row => !row.inputsAbsent));assert.equal(unknown.find(row => row.id === "temporal:metalfx").recommendationRank, 0);
  assert.equal(Presentation.implementationHeading(unknown.find(row => row.id === "temporal:metalfx"), "temporal"), "Recommended");
  assert.deepEqual(unknown.slice(0, 2).map(row => row.id), ["upscale:metalfx", "temporal:metalfx"], "the catalog moves only suggested defaults");
  const declared = Plan.catalog({graphicsCapabilities: caps, reshadeState, graphicsInputs: {source: "mpv-video", cameraProjection: false, methods: ["fsr2"]}});
  const temporal = menu(declared, "temporal"), metalfxTemporal = temporal.find(row => row.id === "temporal:metalfx");
  assert.equal(metalfxTemporal.inputsAbsent, true);assert.match(metalfxTemporal.inputReason, /does not supply depth.* or /);
  assert.equal(Presentation.implementationHeading(metalfxTemporal, "temporal"), "Needs scene inputs");assert.equal(metalfxTemporal.availableWithoutInputs, true);
  assert.equal(temporal.find(row => row.id === "temporal:fsr2").inputsAbsent, undefined, "an engine-run method takes its inputs inside the engine");
  assert.equal(temporal.at(-1).inputsAbsent, true);
});
test("specialised variants join their group heading, so an expanded menu never repeats a heading", () => {
  const P = require("../src/modules/shared/effects/presentation.mjs");
  const row = (id, method, extra = {}) => ({id, template: {kind: "upscale", method}, ...extra});
  const rows = [row("absent", "fsr2", {inputsAbsent: true}), row("hermite", "libplacebo:hermite", {category: "Standard filters", recommendationRank: 3}),
    row("xbr", "xbr"), row("lanczos", "libplacebo:lanczos", {category: "Standard filters"}), row("fsr1", "fsr1", {recommendationRank: 1})];
  const menu = P.orderImplementationGroups(rows, "upscale"), headings = menu.map(item => P.implementationHeading(item, "upscale"));
  assert.deepEqual(menu.map(item => item.id), ["fsr1", "lanczos", "hermite", "xbr", "absent"]);
  assert.deepEqual(headings.filter((heading, index) => heading !== headings[index - 1]), ["Recommended", "Simple algorithms", "Native algorithms", "Needs scene inputs"]);
  assert.deepEqual(menu.filter(P.implementationMore).map(item => item.id), ["hermite"]);
});
test("shader menus head ordinary shaders by catalog purpose and show pack names without an evident family", () => {
  const Plan = require("../src/modules/shared/effects/plan"), P = require("../src/modules/shared/effects/presentation.mjs"), {implementationsFor} = require("../src/modules/shared/effects/contracts.mjs");
  const pack = (id, family, name, extra = {}) => ({id: `shader:${id}`, label: `${family} · ${name}`, group: family, ...extra});
  const presets = [{id: "grayscale", label: "Grayscale", purpose: "Colour and tone"}, pack("accessibility:daltonize", "Accessibility", "Daltonization", {purpose: "Accessibility"}),
    pack("native:xegtao", "Image", "XeGTAO"), pack("sweetfx:tonemap", "SweetFX", "Tonemap", {purpose: "Colour and tone"}), pack("image:color-balance", "Image", "Color balance", {purpose: "Colour and tone"}),
    {id: "filter:imported", label: "Imported look", group: "Imported filters"}];
  const menu = inputs => {const rows = Plan.catalog({reshadeState: {available: true, presets}, graphicsInputs: inputs});
    return P.orderImplementationGroups(implementationsFor("image", rows.filter(row => row.available || row.availableWithoutInputs)), "image");};
  const shown = rows => rows.map(row => `${P.implementationHeading(row, "image")}: ${P.implementationName(row, "image")}`);
  assert.deepEqual(shown(menu(null)), ["Colour and tone: Grayscale", "Colour and tone: SweetFX · Tonemap", "Colour and tone: Color balance", "Depth: XeGTAO",
    "Accessibility: Daltonization", "Shaders: Imported look"]);
  assert.deepEqual(shown(menu({source: "mpv-video"})).slice(-1), ["Needs scene inputs: XeGTAO"]);
  const row = menu(null).find(item => item.id === "shader:native:xegtao");
  assert.equal(row.label, "Image · XeGTAO", "the catalog keeps the full label");assert.equal(P.implementationName(row, "upscale"), "Image · XeGTAO");
});
test("catalog matching keeps same-named temporal and spatial methods separate", () => {
  const catalog = [shader, spatial, temporal].map(node => ({ id: node.id, kind: node.kind, label: node.id, template: node }));
  assert.equal(effectChoice(shader, catalog).id, "film");assert.equal(effectChoice(spatial, catalog).id, "scale");
  assert.equal(effectChoice(temporal, catalog).id, "motion");
  assert.equal(effectChoice({ ...shader, shader: { enabled: true, preset: "filter:other" } }, catalog), undefined);
});
test('both views list authored resamplers in their resize row and import into a legacy resize row',async t=>{
 const previous=global.window;t.after(()=>{global.window=previous;});
 for(const view of ['simple','advanced'])for(const sizing of [{outputSize:{width:640,height:360}},{presentationScale:1}]){
  const original={id:'resize-original',kind:'spatial',method:'bilinear',enabled:true,settings:{spatialMultiplier:1},...sizing};
  const independent={...shader,id:'independent'},before={schema:2,mode:'advanced',enabled:true,video:[original,independent]},saved=structuredClone(before),changes=[];
  const imported={id:'shader:filter:local',kind:'shader',label:'Local requested-size shader',group:'Resize',available:true,
   outputContract:{domain:'image',sizing:'stage',extentEditable:true,resizeDirections:['downsample','upscale']},template:{kind:'shader',enabled:true,shader:{enabled:true,preset:'filter:local',parameters:null}}};
  const smaller={...imported,id:'shader:filter:small',label:'Authored half-size shader',outputContract:{domain:'image',sizing:'intrinsic',scale:{x:.5,y:.5},extentEditable:false},template:{...imported.template,shader:{...imported.template.shader,preset:'filter:small'}}};
  const custom={id:'shader:custom',kind:'shader',label:'Custom shader',group:'Shaders',available:true,outputContract:{domain:'image',sizing:'shader',extentEditable:true},template:{kind:'shader',enabled:true,shader:{enabled:true,preset:'custom'}}};
  const catalog=[{id:'spatial:bilinear',kind:'spatial',label:'Bilinear',group:'Resize',available:true,template:original},imported,smaller,custom];
  global.window={MacLauncher:{launcher:{importReShadeFilters:async()=>[{id:'local',name:imported.label,path:'/Shaders/Local.hlsl',format:'magpie',available:true,outputContract:imported.outputContract}]}}};
  const h=simpleHarness(EffectsControls,{game:{gamePath:'/Game',effects:before},running:false,editor:{info:{plan:before,catalog},onChange:next=>changes.push(next),pickFile:async()=>'/Shaders/Local.hlsl'}});
  try{
   h.render();if(view==='advanced')elements(h.render()).find(n=>n.type==='button'&&n.props.children==='Advanced').props.onClick();
   const picker=elements(h.render()).find(n=>n.props.id===(view==='advanced'?'effect-choice-resize-original':'simple-effect-upscale'));
   assert.ok(picker.props.options.some(row=>row.value===imported.id),`${view} lists an authored resampler with ordinary scaling methods`);
   assert.ok(!picker.props.options.some(row=>row.value===smaller.id),'an authored reduction remains in its own data type');
   picker.props.onChange({target:{value:'__import'}});await h.settle();
   const next=changes.at(-1),replacement=next.video.find(row=>row.id===original.id);
   assert.equal(replacement.kind,'shader');assert.equal(replacement.shader.preset,'filter:local');assert.equal(replacement.enabled,true);
   // The chosen pixel size wins over automatic sizing; a window fit stays the window fit.
   const pixels=Boolean(sizing.outputSize);
   assert.deepEqual(replacement.extent,pixels?{width:640,height:360}:{relativeTo:'presentation',factor:1});
   assert.deepEqual(next.video.find(row=>row.id==='independent'),independent);
   if(view==='advanced'||pixels){assert.equal(next.video.length,2,'an explicit size or a method change keeps the row unowned');assert.equal(next.renderResolution,undefined);}
   else{
    // Simple placement sizes an Upscale at the window fit automatically: the row owns its input reduction and source request.
    assert.deepEqual(next.video.map(row=>row.ownedBy?.role||row.id),['input',original.id,'independent']);
    assert.deepEqual(next.video[0].ownedBy,{id:original.id,role:'input'});assert.deepEqual(next.renderResolution,{multiplier:2,managedBy:original.id});
   }
   assert.deepEqual(before,saved);
  }finally{h.close();}
 }
});
test("Advanced row model selection, removal and re-enable use the row's own mode and model", async () => {
  for (const kind of ["spatial", "frame-generation"]) {
    const method = kind === "spatial" ? "ls1" : "lsfg", good = "sha256-" + "a".repeat(64), missing = "sha256-" + "b".repeat(64);
    const required = kind === "spatial" ? "ls1Performance" : "lsfgFp32Performance";
    const settings = {modelVersion: good, ls1Mode: "performance", lsfgMode: "performance", lsfgFp16: false};
    const before = {schema: 1, mode: "advanced", video: [{id: "model", kind, method, enabled: false, settings}]};
    const catalog = [{id: `${kind}:${method}`, kind, label: method, group: "Scaling", available: false, availableWithoutModel: true,
      reason: "Compatible Lossless Scaling models are required.", template: {kind, method, enabled: true, settings: {}}}];
    const status = {available: true, presets: [], models: [{version: good, label: "Performance model", capabilities: [required]}], defaultModelVersion: missing};
    const changes = [], harness = componentHarness(EffectsControls, {game: {gamePath: "preset", effects: before, graphics: {modelVersion: missing}},
      running: false, status, children: null, editor: {info: {mode: "advanced", plan: before, catalog}, onChange: next => changes.push(next)}});
    const enable = () => elements(harness.render()).find(node => node.type === "input" && node.props.id === "effect-model-enabled");
    const modelSelect = () => {
      const component = elements(harness.render()).find(node => node.props.node?.id === "model" && node.props.onExtentChange);
      return elements(component.type(component.props)).find(node => node.props.id === "effect-model-models");
    };
    try {
      assert.equal(Boolean(enable().props.disabled), false, "a compatible Performance row is usable even when the Add Quality default is unavailable");
      assert.doesNotMatch(renderToStaticMarkup(harness.render()), /Compatible Lossless Scaling models are required/);
      modelSelect().props.onChange({target: {value: missing}});await harness.settle();
      assert.equal(Boolean(enable().props.disabled), false);assert.equal(modelSelect().props.value, missing);
      assert.match(renderToStaticMarkup(harness.render()), /Unavailable model/);
      modelSelect().props.onChange({target: {value: good}});await harness.settle();
      assert.equal(Boolean(enable().props.disabled), false);
      status.models = [];harness.render();assert.equal(Boolean(enable().props.disabled), false, "unavailable desired effects remain editable");
      status.models = [{version: good, label: "Performance model", capabilities: [required]}];
      assert.equal(Boolean(enable().props.disabled), false);
      enable().props.onChange({target: {checked: true}});await harness.settle();
      assert.equal(changes.at(-1).video[0].enabled, true);assert.equal(changes.at(-1).video[0].settings.modelVersion, good);
      catalog[0] = {...catalog[0], availableWithoutModel: false, reason: "This method is unavailable for the current graphics runtime."};
      const unavailable = effectChoice({...before.video[0]}, catalog, status);
      assert.equal(unavailable.available, false, "a compatible model cannot override missing runtime support");
    } finally {harness.close();}
  }
});
test("Advanced families stay compact while searches reveal specific filters", () => {
  const row = (method, category, kind = "upscale") => ({ id: `${kind}:${method}`, kind, label: method, group: kind === "upscale" ? "Upscaling" : "Downscaling", category,
    available: true, template: { kind, enabled: true, method, settings: {} } });
  const catalog = [row("bilinear", "Standard filters"), row("bicubic", "Standard filters"), row("nearest", "Standard filters"),
    row("mako", "Standard filters"), row("metalfx", "MetalFX"), row("ls1", "Lossless Scaling"), row("bilinear", "Standard filters", "downsample")];
  const compact = effectChooserRows(catalog, "");
  assert.deepEqual(new Set(compact.map(row => row.label)), new Set(["Upscale", "metalfx", "ls1", "Downsample"]));
  assert.equal(compact.find(row=>row.label==="Upscale").template.method, "bilinear");
  assert.deepEqual(effectChooserRows(catalog, "bicubic").map(row => row.id), ["upscale:bicubic"]);
  assert.equal(effectChooserRows(catalog, "standard filters").length, 5);
  assert.equal(effectChooserRows(catalog, "unknown").length, 0);
});
test("XeSS uses the shared temporal selector and retains unsupported saved backend choices", async () => {
  const node={id:"xess",kind:"temporal",method:"xess",enabled:true,settings:{xessBackend:"vulkan"}};
  const before={schema:2,mode:"advanced",video:[node]},changes=[];
  const choice={id:"temporal:xess",kind:"temporal",label:"Intel XeSS",group:"Temporal",available:false,availableWithoutRuntime:true,
    backends:["d3d12"],runtimeManagerId:"graphics-xess",reason:"Import the Intel XeSS runtime.",template:{...node}};
  const harness=componentHarness(EffectsControls,{game:{gamePath:"/Game",effects:before},running:false,status:{presets:[]},children:null,
    editor:{info:{mode:"advanced",plan:before,catalog:[choice]},onChange:next=>changes.push(next)}});
  try {
    const component=elements(harness.render()).find(n=>n.props.node?.id==="xess"&&n.props.onExtentChange);
    const tree=component.type(component.props),select=elements(tree).find(n=>n.props.id==="effect-xess-backend");
    assert.equal(select.props.value,"vulkan");
    const options=elements(select).filter(n=>n.type==="option");
    assert.equal(options.find(n=>n.props.value==="d3d12").props.disabled,false);
    assert.equal(options.find(n=>n.props.value==="vulkan").props.disabled,true);
    select.props.onChange({target:{value:"auto"}});await harness.settle();
    assert.equal(changes.at(-1).video[0].settings.xessBackend,"auto");
    assert.equal(changes.at(-1).video[0].id,"xess");
    assert.match(renderToStaticMarkup(harness.render()),/Get \/ manage XeSS/);
  } finally {harness.close();}
});
test("Advanced retains canonical traditional filters and saved alias IDs without raw alias duplicates", () => {
  const methods = ["bilinear", "libplacebo:bilinear", "libplacebo:triangle", "libplacebo:ewa_hann", "libplacebo:ewa_hanning", "libplacebo:lanczos", "libplacebo:hermite"];
  const catalog = methods.map(method => ({id: "spatial:" + method, kind: "spatial", group: "Upscaling", category: "Standard filters",
    label: method.replace(/^libplacebo:/, ""), available: true, template: {kind: "spatial", method, enabled: true, settings: {}}}));
  const choices = effectChooserRows(catalog, "standard filters");
  assert.equal(choices.length, 5);
  assert.ok(choices.some(row => row.id === "spatial:bilinear") && choices.some(row => row.id === "spatial:libplacebo:bilinear"),
    "different implementation IDs are not merged");
  assert.ok(choices.some(row => row.label === "EWA Hann · libplacebo"));
  assert.ok(!choices.some(row => /triangle|ewa_hanning/.test(row.id)));
  const before = {schema: 1, mode: "advanced", video: [{id: "filter", kind: "spatial", enabled: true, method: "libplacebo:ewa_hanning", settings: {}}]};
  const harness = componentHarness(EffectsControls, {game: {gamePath: "/Game", effects: before}, running: false, children: null,
    editor: {info: {mode: "advanced", plan: before, catalog}, onChange: () => assert.fail("render does not save")}});
  try {
    const markup = renderToStaticMarkup(harness.render()), menu = markup.match(/<select id="effect-choice-filter"[\s\S]*?<\/select>/)[0];
    assert.match(menu, /<optgroup label="[^"]+"/);
    assert.match(menu, /value="spatial:libplacebo:ewa_hanning" selected="">EWA Hann/);
    assert.doesNotMatch(menu, /value="spatial:libplacebo:ewa_hann"|value="spatial:libplacebo:triangle"/);
    assert.match(menu, /value="spatial:libplacebo:hermite">Hermite/);
    assert.match(menu, /value="spatial:libplacebo:bilinear">Bilinear · libplacebo/);
    assert.match(markup, /aria-label="Enable EWA Hann · libplacebo"/);
    assert.equal(before.video[0].method, "libplacebo:ewa_hanning");
  } finally {harness.close();}
});
test("Advanced spatial sizes are independent of game allocation capabilities", () => {
  const markup = render({ effects: { ...plan, renderResolution: { height: 480 }, video: [{ ...spatial,
    outputSize: { width: 854, height: 480 }, settings: { spatialMultiplier: null } }] } });
  assert.match(markup, /Game resolution/);assert.match(markup, /id="effects-game-height"[^>]*value="480"/);
  assert.match(markup, /Output size/);assert.match(markup, /Fraction of window \/ fullscreen/);
  assert.match(markup, /Scale of previous image/);assert.match(markup, /Fixed resolution/);
  assert.match(markup, /aria-label="Output width"[^>]*value="854"/);
  assert.match(markup, /aria-label="Output height"[^>]*value="480"/);
  assert.doesNotMatch(markup, /Render resolution/);
});
test("a saved Advanced source request remains editable and resets to Original without removing effects", async () => {
  const before = {...plan, renderResolution: {height: 480, method: "metalfx"}}, changes = [];
  const harness = componentHarness(EffectsControls, {game: {gamePath: "preset", effects: before}, running: false, children: null,
    editor: {info: {mode: "advanced", plan: before, catalog: [], sourceResolution: {heights: false, multipliers: []}}, onChange: next => changes.push(next)}});
  try {
    const selector = elements(harness.render()).find(node => node.props.id === "effects-game-rendering");
    assert.ok(selector);assert.equal(selector.props.value,"height");assert.match(renderToStaticMarkup(harness.render()), /id="effects-game-height"[^>]*value="480"/);
    await selector.props.onChange({target: {value: "original"}});
    assert.equal(changes[0].renderResolution, undefined);assert.deepEqual(changes[0].video, require("../src/modules/shared/effects/plan.mjs").migrate(before).video);
  } finally {harness.close();}
});
test("Advanced neural intensity exposes the useful blend range with full model output selected by default", () => {
  const markup = render({ effects: { ...plan, video: [{ id: "neural", kind: "neural", enabled: true, method: "mlx-dlss",
    settings: { modelPath: "/Models/Test.dlssmodel", intensity: 1, temporal: false } }] } });
  assert.match(markup, /id="effect-neural-intensity"[^>]*max="1"[^>]*value="1"/);
  assert.match(markup, /1 uses the full model output/);
});
test("draft editor honors source-resolution capabilities and edits without per-game API calls", async () => {
  const before = { ...plan, video: [] }, changes = [], info = { mode: "advanced", plan: before, catalog: [],
    sourceResolution: { heights: false, multipliers: [] } };
  const harness = componentHarness(EffectsControls, { game: { gamePath: "preset", runtimeId: "native", effects: before },
    running: false, children: null, editor: { info, onChange: value => changes.push(value), pickFile: async () => null } });
  try {
    harness.render();await harness.settle();assert.doesNotMatch(renderToStaticMarkup(harness.render()), /Game resolution|Return to simple/);
    info.sourceResolution = { heights: false, multipliers: [1, 2] };
    const selector = elements(harness.render()).find(node => node.props.id === "effects-game-rendering");
    const markup = renderToStaticMarkup(selector);assert.match(markup, /Percentage/);assert.match(markup, /Height/);assert.doesNotMatch(markup, /480p|720p/);
    await selector.props.onChange({ target: { value: "percentage" } });
    assert.deepEqual(changes[0].renderResolution, { multiplier: 2 });assert.deepEqual(before.video, []);
  } finally { harness.close(); }
});
test("Advanced source filters follow declared methods, preserve sizing and keep the original method available with temporal stages", async () => {
  const before = { schema: 1, mode: "advanced", video: [] }, changes = [];
  const sourceResolution = { heights: true, multipliers: [1, 2], methods: ["bilinear", "metalfx", "fsr1"],
    filterExclusiveWithTemporal: true, methodLabels: { bilinear: "Bilinear", metalfx: "Native MetalFX", fsr1: "FSR 1" } };
  const props = { game: { gamePath: "preset", effects: before }, running: false, children: null,
    editor: { info: { mode: "advanced", plan: before, catalog: [], sourceResolution }, onChange: value => changes.push(value) } };
  const harness = componentHarness(EffectsControls, props);
  try {
    assert.doesNotMatch(renderToStaticMarkup(harness.render()), /effects-source-filter/);
    await elements(harness.render()).find(node => node.props.id === "effects-game-rendering").props.onChange({ target: { value: "percentage" } });
    let selector = elements(harness.render()).find(node => node.props.id === "effects-source-filter");
    assert.match(renderToStaticMarkup(selector), /value="metalfx">Native MetalFX/);
    await selector.props.onChange({ target: { value: "metalfx" } });
    assert.deepEqual(changes.at(-1).renderResolution, { multiplier: 2, method: "metalfx" });
    await elements(harness.render()).find(node => node.props.id === "effects-game-rendering").props.onChange({ target: { value: "height" } });
    assert.deepEqual(changes.at(-1).renderResolution, { height: 720, method: "metalfx" });
    selector = elements(harness.render()).find(node => node.props.id === "effects-source-filter");
    await selector.props.onChange({ target: { value: "" } });
    assert.deepEqual(changes.at(-1).renderResolution, { height: 720 });
    await elements(harness.render()).find(node => node.props.id === "effects-game-rendering").props.onChange({ target: { value: "original" } });
    assert.doesNotMatch(renderToStaticMarkup(harness.render()), /effects-source-filter/);
    assert.deepEqual(before.video, []);
  } finally { harness.close(); }
  const temporalPlan = { ...before, renderResolution: { multiplier: 2 }, video: [{ ...temporal, enabled: true }] };
  const conflicting = componentHarness(EffectsControls, { ...props, game: { gamePath: "preset", effects: temporalPlan },
    editor: { ...props.editor, info: { ...props.editor.info, plan: temporalPlan } } });
  try {
    const selector = elements(conflicting.render()).find(node => node.props.id === "effects-source-filter");
    const markup = renderToStaticMarkup(selector);
    assert.match(markup, /value="" selected="">Game original/);
    for (const method of sourceResolution.methods) assert.match(markup, new RegExp(`value="${method}" disabled=""`));
  } finally { conflicting.close(); }
});
test("video live controls distinguish native shader bindings from shared live settings", async () => {
  const previousWindow = global.window, before = { ...plan, video: [] };
  global.window = { MacLauncher: { launcher: { getGameEffects: async () => ({ mode: "advanced", plan: before, catalog: [], live: true,
    shaderBindingsNextLaunch: true, sourceResolution: { heights: false, multipliers: [] } }) } } };
  const harness = componentHarness(EffectsControls, { game: { gamePath: "/Video/clip.mp4", runtimeId: "mpv", effects: before }, running: true, children: null });
  try {
    harness.render();await harness.settle();
    assert.match(renderToStaticMarkup(harness.render()), /Changes update during play when the loaded graphics adapter supports them\./);
  } finally { harness.close();global.window = previousWindow; }
});
// Hook-free graphics views render through their editor props.
const views=new Set(['SourceResolutionControls','SourcePolicyControls','SimpleEffectsView','AdvancedEffectsView','EffectRowControls','OutputPolicyControls','GraphicsStatusLabel']);
function elements(element) {
  if(!React.isValidElement(element))return [];
  const children=typeof element.type==='function'&&views.has(element.type.name)?element.type(element.props):element.props.children;
  return [element,...React.Children.toArray(children).flatMap(elements)];
}
test("changing a Downsample filter keeps its dimensions and shares one method menu", async () => {
  const before = { ...plan, video: [{ ...spatial, method: "downsample", outputSize: { width: 854, height: 480 }, settings: { spatialMultiplier: 0.5 } }] };
  const catalog = [{ id: "downsample:bilinear", kind: "downsample", label: "Downsample", group: "Downscaling", category: "Standard filters", available: true,
    template: { kind: "downsample", method: "bilinear", enabled: true, settings: { spatialMultiplier: 0.5 } } },
  { id: "downsample:nearest", kind: "downsample", label: "Nearest neighbour", group: "Upscaling", category: "Standard filters", available: true,
    template: { kind: "downsample", method: "nearest", enabled: true, settings: { spatialMultiplier: null } } },
  { id: "spatial:metalfx", kind: "spatial", label: "MetalFX Spatial", group: "Upscaling", category: "MetalFX", available: true,
    template: { kind: "spatial", method: "metalfx", enabled: true, settings: {} } }];
  const previousWindow = global.window;let stored = before;
  global.window = { MacLauncher: { launcher: { getGameEffects: async () => ({ mode: "advanced", plan: stored, catalog }),
    setGameEffects: async (_path, value) => { stored = value;return true; } } } };
  const harness = componentHarness(EffectsControls, { game: { gamePath: "/Games/Advanced", effects: before }, running: false, children: null });
  try {
    harness.render();await harness.settle();
    const markup = renderToStaticMarkup(harness.render());assert.match(markup, /value="downsample:bilinear"/);assert.doesNotMatch(markup, /value="spatial:metalfx"/);
    const selector = elements(harness.render()).find(node => node.props.id === "effect-choice-scale");
    await selector.props.onChange({ target: { value: "downsample:nearest" } });
    assert.equal(stored.video[0].method, "nearest");assert.equal(stored.video[0].settings.spatialMultiplier, null);
    assert.deepEqual(stored.video[0].extent, { width: 854, height: 480 });assert.equal(before.video[0].method, "downsample");
  } finally { harness.close();global.window = previousWindow; }
});
test("a migrated aspect-preserving cap becomes a canonical extent when its filter changes", async () => {
  const before = { ...plan, video: [{ ...spatial, method: "downsample", outputSize: { height: 480 }, settings: { spatialMultiplier: null } }] };
  const catalog = [{ id: "downsample:bilinear", kind: "downsample", label: "Downsample", group: "Downscaling", available: true,
    template: { kind: "downsample", method: "bilinear", enabled: true, settings: {} } },
    { id: "downsample:bicubic", kind: "downsample", label: "Bicubic", group: "Upscaling", available: true,
      template: { kind: "downsample", method: "bicubic", enabled: true, settings: {} } }];
  const changes=[],harness = componentHarness(EffectsControls, { game: { gamePath: "preset", runtimeId: "native", effects: before }, running: false, children: null,
    editor: { info: { mode: "advanced", plan: before, catalog }, onChange: next=>changes.push(next) } });
  try {
    const picker=elements(harness.render()).find(node=>node.props.id==='effect-choice-scale');assert.equal(Boolean(picker.props.options.find(row=>row.value==='downsample:bicubic').disabled),false);
    const markup=renderToStaticMarkup(harness.render());assert.match(markup,/aria-label="Output height"[^>]*value="480"/);assert.match(markup,/single width or height preserves aspect ratio/);assert.doesNotMatch(markup,/value="undefined"/);
    assert.equal(changes.length,0,'inspection preserves the legacy cap');await picker.props.onChange({target:{value:'downsample:bicubic'}});await harness.settle();
    assert.equal(changes.at(-1).video[0].method,'bicubic');assert.deepEqual(changes.at(-1).video[0].extent,{height:480});assert.equal(changes.at(-1).video[0].outputSize,undefined);assert.deepEqual(before.video[0].outputSize,{height:480});
  } finally { harness.close(); }
});
test("custom resize extents accept either valid size limit and reject invalid dimensions", async () => {
  for (const [method, width, height, expected] of [
    ["downsample", "", "480", {height: 480}], ["downsample", "854", "", {width: 854}],
    ["downsample", "854", "480", {width: 854, height: 480}], ["downsample", "0", "480", null],
    ["downsample", "", "", null], ["bilinear", "", "480", {height:480}], ["bilinear", "854", "480", {width: 854, height: 480}]
  ]) {
    const before = {...plan, video: [{...spatial, method, settings: {spatialMultiplier: .5}}]}, changes = [];
    const harness = componentHarness(EffectsControls, {game: {gamePath: "preset", effects: before}, running: false, children: null,
      editor: {info: {mode: "advanced", plan: before, catalog: []}, onChange: next => changes.push(next)}});
    let sizing;
    try {
      const graphics = elements(harness.render()).find(node => typeof node.props.onExtentChange === "function");
      const child = elements(graphics.type(graphics.props)).find(node => node.props.nodeId === "scale");
      sizing = componentHarness(child.type, child.props);
      elements(sizing.render()).find(node => node.props.id === "effect-scale-extent").props.onChange({target: {value: "custom"}});
      for (const [axis, value] of [["width", width], ["height", height]])
        elements(sizing.render()).find(node => node.props['aria-label'] === `Output ${axis}`).props.onChange({target: {value}});
      elements(sizing.render()).find(node => node.props['aria-label'] === "Output height").props.onBlur();
      await harness.settle();
      if (expected) {
        assert.deepEqual((changes.at(-1)?.video[0].extent || changes.at(-1)?.video[0].outputSize), expected, `${method}: ${width}×${height}`);
        assert.equal(changes.at(-1).video[0].settings.spatialMultiplier,undefined,'canonical extent owns sizing');
      } else assert.equal(changes.length, 0, `${method}: invalid or incomplete size must not replace the saved factor`);
      assert.equal(before.video[0].outputSize, undefined);
    } finally {sizing?.close();harness.close();}
  }
});
test("literal resize height presets round-trip without replacing custom widths or offering automatic sizing", async () => {
  for (const extent of [{height:540},{height:720},{height:1080},{width:960,height:540},{relativeTo:"presentation",factor:.5}]) {
    const node={id:"scale",kind:"downsample",method:"bilinear",enabled:true,extent,settings:{}},before={schema:2,mode:"advanced",enabled:true,video:[node]},changes=[];
    const h=componentHarness(EffectsControls,{game:{gamePath:"preset",effects:before},running:false,editor:{info:{plan:before,catalog:[]},onChange:next=>changes.push(next)}});let sizing;
    try {
      const graphics=elements(h.render()).find(n=>typeof n.props.onExtentChange==="function"),component=elements(graphics.type(graphics.props)).find(n=>n.props.nodeId==="scale");sizing=baseHarness(component.type,component.props);
      const selector=()=>elements(sizing.render()).find(n=>n.props.id==="effect-scale-extent");
      assert.equal(selector().props.value,extent.width||extent.height?"custom":"presentation:0.5");
      const options=elements(selector()).filter(n=>n.type==="option");assert.equal(options.length,3);
      if(extent.height&&!extent.width)assert.equal(elements(sizing.render()).find(n=>n.props.id==="effect-scale-pixel-preset").props.value,`height:${extent.height}`);
      const markup=renderToStaticMarkup(sizing.render());if(extent.height)for(const height of [540,720,1080])assert.match(markup,new RegExp(`value="height:${height}"`));
      assert.doesNotMatch(markup,/Auto input|Adaptive|value="auto"|value="default"/);assert.equal(changes.length,0);
      if(extent.width){assert.match(markup,/aria-label="Output width"[^>]*value="960"/);assert.deepEqual(before.video[0].extent,{width:960,height:540});}
      selector().props.onChange({target:{value:"custom"}});elements(sizing.render()).find(n=>n.props.id==="effect-scale-pixel-preset").props.onChange({target:{value:"height:540"}});await h.settle();
      // Choosing the saved size again is not an edit.
      assert.equal(changes.length,extent.height===540&&!extent.width?0:1);assert.deepEqual((changes.at(-1)||before).video[0].extent,{height:540});assert.equal(before.video[0].extent,extent);
    }finally{sizing?.close();h.close();}
  }
});
test("resize factor units convert exactly and Simple Off hides pixel controls while preserving the literal height", async () => {
  for(const [units,value]of[["percent",25],["factor",.25]]){
    const before={schema:2,mode:"advanced",enabled:true,video:[{id:"scale",kind:"downsample",method:"bilinear",enabled:true,extent:{relativeTo:"input",factor:.5},settings:{}}]},changes=[];
    const h=componentHarness(EffectsControls,{game:{gamePath:"preset",effects:before},running:false,editor:{info:{plan:before,catalog:[]},onChange:next=>changes.push(next)}});let sizing;
    try{const graphics=elements(h.render()).find(n=>typeof n.props.onExtentChange==="function"),component=elements(graphics.type(graphics.props)).find(n=>n.props.nodeId==="scale");sizing=baseHarness(component.type,component.props);
      elements(sizing.render()).find(n=>n.props["aria-label"]==="Scale units").props.onChange({target:{value:units}});
      const input=elements(sizing.render()).find(n=>n.props.id==="effect-scale-percentage");assert.equal(input.props.value,units==="percent"?50:.5);assert.equal(changes.length,0,"unit display does not save a different factor");
      input.props.onValue(value);await h.settle();assert.deepEqual(changes.at(-1).video[0].extent,{relativeTo:"input",factor:.25});
    }finally{sizing?.close();h.close();}
  }
  const node={id:"scale",kind:"downsample",method:"bilinear",enabled:true,extent:{height:540},settings:{}},before={schema:2,mode:"advanced",enabled:true,video:[node]},changes=[],catalog=[{id:"downsample:bilinear",kind:"downsample",label:"Bilinear",available:true,template:node}];
  const h=simpleHarness(EffectsControls,{game:{gamePath:"preset",effects:before},running:false,editor:{info:{plan:before,catalog},onChange:next=>changes.push(next)}});
  try{elements(h.render()).find(n=>n.type==="button"&&n.props.children==="Options…").props.onClick();assert.match(renderToStaticMarkup(h.render()),/effect-scale-extent/);
    elements(h.render()).find(n=>n.props.id==="simple-effect-downsample").props.onChange({target:{value:"off"}});await h.settle();assert.equal(changes.at(-1).video[0].enabled,false);assert.deepEqual(changes.at(-1).video[0].extent,{height:540});assert.doesNotMatch(renderToStaticMarkup(h.render()),/effect-scale-extent|Output width|Output height/);
  }finally{h.close();}
});
test("Downsample and Upscale share three size modes and legacy Upscale fits visibly as a 100 percent window fraction",async()=>{
  for(const kind of ["downsample","upscale"]){
    const node={id:"scale",kind,method:"bilinear",enabled:true,settings:{}},before={schema:2,mode:"advanced",enabled:true,video:[node]},changes=[];
    const h=componentHarness(EffectsControls,{game:{gamePath:"preset",effects:before},running:false,editor:{info:{plan:before,catalog:[]},onChange:next=>changes.push(next)}});let sizing;
    try{const graphics=elements(h.render()).find(n=>typeof n.props.onExtentChange==="function"),component=elements(graphics.type(graphics.props)).find(n=>n.props.nodeId==="scale");sizing=baseHarness(component.type,component.props);
      const selector=elements(sizing.render()).find(n=>n.props.id==="effect-scale-extent");assert.deepEqual(elements(selector).filter(n=>n.type==="option").map(n=>n.props.children),["Scale of previous image","Fraction of window / fullscreen","Fixed resolution"]);
      assert.equal(selector.props.value,kind==="upscale"?"presentation:1":"input:0.5");assert.equal(elements(sizing.render()).find(n=>n.props.id==="effect-scale-percentage").props.value,kind==="upscale"?100:50);assert.equal(changes.length,0);
      selector.props.onChange({target:{value:"presentation:1"}});await h.settle();assert.deepEqual(changes.at(-1).video[0].extent,{relativeTo:"presentation",factor:1});assert.equal(before.video[0].extent,undefined);
    }finally{sizing?.close();h.close();}
  }
});
test("independent resize extents preserve aspect and survive filter changes", async () => {
  const before={schema:2,mode:"advanced",enabled:true,video:[{id:"scale",kind:"downsample",method:"bilinear",enabled:true,extent:{height:480},settings:{}}]},changes=[];
  const catalog=["bilinear","bicubic"].map(method=>({id:"downsample:"+method,kind:"downsample",label:method,available:true,template:{kind:"downsample",method,enabled:true,settings:{}}}));
  const harness=componentHarness(EffectsControls,{game:{gamePath:"preset",effects:before},running:false,editor:{info:{plan:before,catalog},onChange:value=>changes.push(value)}});
  try {
    await elements(harness.render()).find(node=>node.props.id==="effect-choice-scale").props.onChange({target:{value:"downsample:bicubic"}});await harness.settle();
    assert.deepEqual(changes.at(-1).video[0].extent,{height:480});assert.equal(changes.at(-1).video[0].method,"bicubic");
    const settings=elements(harness.render()).find(node=>typeof node.props.onExtentChange==="function"),component=elements(settings.type(settings.props)).find(node=>node.props.nodeId==="scale");
    const sizing=componentHarness(component.type,component.props);
    try {elements(sizing.render()).find(node=>node.props.id==="effect-scale-extent").props.onChange({target:{value:"input:0.5"}});await harness.settle();}
    finally{sizing.close();}
    assert.deepEqual(changes.at(-1).video[0].extent,{relativeTo:"input",factor:.5});assert.deepEqual(before.video[0].extent,{height:480});
  }finally{harness.close();}
});
test("Advanced Custom shader selection and replacement pick before a single atomic plan save", async () => {
  const before = { ...plan, video: [{ ...shader, enabled: false, shader: { enabled: true, preset: "filter:existing", parameters: { Strength: [0.4] } } }, spatial] };
  const original = structuredClone(before), saved = [], picked = [];
  const custom = { id: "shader:custom", kind: "shader", label: "Custom shader…", group: "Shaders", available: true,
    template: { kind: "shader", enabled: true, shader: { enabled: true, preset: "custom", effectPath: null } } };
  const catalog = [custom, { id: "shader:existing", kind: "shader", label: "Imported shader", available: true, template: before.video[0] }];
  const previousWindow = global.window;
  let stored = before, complete;
  global.window = { MacLauncher: { launcher: {
    getGameEffects: async () => ({ mode: "advanced", plan: stored, catalog }),
    setGameEffects: async (path, value) => { saved.push([path, value]);stored = value;return true; },
    pickGameEffectFile: path => { picked.push(path);return new Promise(resolve => { complete = resolve; }); }
  } } };
  const harness = componentHarness(EffectsControls, { game: { gamePath: "/Games/Advanced", effects: before }, running: false, children: null });
  const selector = () => elements(harness.render()).find(node => node.props.id === "effect-choice-film");
  try {
    harness.render();await harness.settle();
    let pending = selector().props.onChange({ target: { value: custom.id } });
    assert.equal(Boolean(elements(harness.render()).find(node => node.type === "fieldset").props.disabled), false);
    assert.equal(selector().props.value, "shader:existing");assert.deepEqual(saved, []);
    complete(null);await pending;assert.deepEqual(saved, []);assert.equal(selector().props.value, "shader:existing");
    pending = selector().props.onChange({ target: { value: custom.id } });
    complete("/Shaders/First.hook");await pending;
    assert.equal(saved.length, 1);assert.equal(saved[0][0], "/Games/Advanced");
    assert.deepEqual(saved[0][1].video.map(node => node.id), ["film", "scale"]);
    assert.equal(saved[0][1].video[0].enabled, false);
    assert.equal(saved[0][1].video[0].shader.preset, "custom");
    assert.equal(saved[0][1].video[0].shader.effectPath, "/Shaders/First.hook");
    assert.equal(saved[0][1].video[0].shader.parameters, null);assert.deepEqual(before, original);
    const choose = () => elements(harness.render()).find(node => node.type === "button" && node.props.children === "Choose shader…");
    pending = choose().props.onClick();complete("/Shaders/Replacement.fx");await pending;
    assert.equal(saved.length, 2);assert.equal(saved[1][1].video[0].shader.effectPath, "/Shaders/Replacement.fx");
    assert.equal(saved[1][1].video[0].shader.parameters, null);
    pending = choose().props.onClick();complete(null);await pending;assert.equal(saved.length, 2);
    global.window.MacLauncher.launcher.pickGameEffectFile = async () => { throw new Error("The preset cannot be opened."); };
    await choose().props.onClick();
    assert.match(renderToStaticMarkup(harness.render()), /role="alert"><span class="errorMessage">The preset cannot be opened\./);
    assert.equal(saved.length, 2);assert.equal(stored.video[0].shader.effectPath, "/Shaders/Replacement.fx");
    assert.deepEqual(picked, Array(4).fill("/Games/Advanced"));
  } finally { harness.close();global.window = previousWindow; }
});

test('schema2 Add keeps Downsample and Upscale compact while search retains every canonical filter',()=>{
 const catalog=['downsample','upscale'].flatMap(kind=>['bilinear','nearest','libplacebo:bilinear','libplacebo:triangle','libplacebo:lanczos'].map(method=>({id:kind+':'+method,kind,label:method,group:kind,category:'Standard filters',available:true,template:{kind,method,enabled:true,settings:{}}})));
 assert.deepEqual(effectChooserRows(catalog,'').map(row=>row.label),['Downsample','Upscale']);
 const searched=effectChooserRows(catalog,'lanczos');assert.equal(searched.length,2);assert.ok(searched.every(row=>row.label==='Lanczos · libplacebo'));
 assert.equal(effectChooserRows(catalog,'standard filters').some(row=>row.id.endsWith(':triangle')),false);
});
test('adding neural without a model preserves other effects and never requests a picker or generation',async()=>{
 const before={schema:2,mode:'advanced',enabled:true,video:[shader]},changes=[],row={id:'neural:mlx-dlss',kind:'neural',label:'DLSS neural rendering',group:'Neural rendering',available:true,template:{kind:'neural',method:'mlx-dlss',enabled:true,settings:{modelPath:null,intensity:1,temporal:false}}};
 const harness=componentHarness(EffectsControls,{game:{gamePath:'preset',effects:before},running:false,editor:{info:{plan:before,catalog:[row]},onChange:next=>changes.push(next),pickFile:()=>assert.fail('Add must not open a picker')}});
 try {
  elements(harness.render()).find(n=>n.type==='button'&&n.props.children==='Add effect…').props.onClick();
  elements(harness.render()).find(n=>n.type==='button'&&n.props.children==='Image filter').props.onClick();
  elements(harness.render()).find(n=>n.type==='button'&&n.props.className==='effectChoice').props.onClick();await harness.settle();
  assert.equal(changes.length,1);assert.deepEqual(changes[0].video[0],shader);assert.equal(changes[0].video[1].method,'mlx-dlss');assert.equal(changes[0].video[1].settings.modelPath,null);assert.equal(changes[0].video.some(n=>n.kind==='frame-generation'),false);
  assert.match(renderToStaticMarkup(harness.render()),/Model needed/);
 }finally{harness.close();}
});
test('Advanced Add retains the shared Automatic model instead of binding the first installed copy',async()=>{
 const before={schema:2,mode:'advanced',enabled:true,video:[]},changes=[],row={id:'neural:mlx-dlss',kind:'neural',label:'DLSS neural rendering',available:true,template:{kind:'neural',method:'mlx-dlss',enabled:true,settings:{modelPath:null,intensity:1,temporal:false}}},models=[{version:'first',method:'mlx-dlss',modelPath:'/first.dlssmodel'},{version:'preferred',method:'mlx-dlss',modelPath:'/preferred.dlssmodel'}];
 const harness=componentHarness(EffectsControls,{game:{gamePath:'preset',effects:before},running:false,status:{neuralModels:models,defaultNeuralModelVersion:'preferred'},editor:{info:{plan:before,catalog:[row]},onChange:next=>changes.push(next),pickFile:()=>assert.fail('Automatic needs no picker')}});
 try{elements(harness.render()).find(n=>n.type==='button'&&n.props.children==='Add effect…').props.onClick();elements(harness.render()).find(n=>n.type==='button'&&n.props.children==='Image filter').props.onClick();elements(harness.render()).find(n=>n.type==='button'&&n.props.className==='effectChoice').props.onClick();await harness.settle();assert.equal(changes.at(-1).video[0].settings.modelPath,null);assert.match(renderToStaticMarkup(harness.render()),/Automatic/);}finally{harness.close();}
});
test('model management stays scoped and never acquires or changes the selected Automatic row',async t=>{
 const previous=global.window;t.after(()=>{global.window=previous;});
 for(const off of [false,true]){let finish;const writes=[],navigation=[],node={id:'restore',kind:'neural',method:'realesrgan',enabled:true,settings:{modelPath:null}},plan={schema:2,mode:'advanced',enabled:true,video:[node]};
  global.window={MacLauncher:{launcher:{runtimeAction:()=>assert.fail('Inspector model management must not acquire a model'),openUtilityWindow:value=>{navigation.push(value);return new Promise(resolve=>{finish=resolve;});}}}};
  const h=componentHarness(EffectsControls,{game:{gamePath:'preset',effects:plan},running:false,editor:{info:{plan,catalog:[{id:'neural:realesrgan',kind:'neural',label:'Real-ESRGAN',available:true,template:node}]},onChange:next=>writes.push(next)}});
  try{const controls=elements(h.render()).find(n=>n.props.nodeId==='restore'&&typeof n.props.onManage==='function');assert.ok(controls);assert.equal(elements(h.render()).some(n=>typeof n.props.onDownload==='function'),false);const job=controls.props.onManage();await h.settle();if(off){elements(h.render()).find(n=>n.type==='input'&&n.props.id==='effect-restore-enabled').props.onChange({target:{checked:false}});await h.settle();}finish(true);await job;await h.settle();assert.deepEqual(navigation,[{view:'runtimes',managerId:'graphics-neural-models'}]);assert.equal(writes.length,off?1:0);const actual=writes.at(-1)||plan;assert.equal(actual.enabled,true);assert.equal(actual.video[0].enabled,!off);assert.equal(actual.video[0].settings.modelPath,null);assert.deepEqual(plan.video,[node]);}finally{h.close();}
 }
});
test('image attachments share the operation-aware Model menu without changing shader parameters or independent effects',async()=>{
 const depth={id:'depth',kind:'shader',enabled:true,shader:{enabled:true,preset:'native:estimated-depth-fog',parameters:{InputSize:[252],Opacity:[.5]}},settings:{modelPath:null}},before={schema:2,mode:'advanced',enabled:true,video:[shader,depth]},changes=[];
 const method='depth-anything-v2-small',choice={id:'shader:native:estimated-depth-fog',kind:'shader',label:'Estimated depth fog',group:'Image filters',available:true,modelOperation:method,template:depth},models=[{version:'nr',method:'mlx-dlss',modelPath:'/nr.dlssmodel'},{version:'depth',versionLabel:'Small depth model',method,modelPath:'/small.depthmodel'}];
 const harness=componentHarness(EffectsControls,{game:{gamePath:'preset',effects:before},running:false,status:{neuralModels:models,defaultNeuralModelVersion:'nr',defaultNeuralModelVersions:{[method]:'depth'}},editor:{info:{plan:before,catalog:[choice]},onChange:next=>changes.push(next),pickFile:async(kind,operation)=>{assert.equal(kind,'neural-model');assert.equal(operation,method);return '/imported.depthmodel';}}});
 try{
  const controls=()=>elements(harness.render()).find(n=>n.props.nodeId==='depth'&&n.props.method===method&&typeof n.props.onImport==='function'),menu=()=>elements(controls().type(controls().props)).find(n=>n.props.id==='effect-depth-model');
  const markup=renderToStaticMarkup(harness.render());assert.match(markup,/Small depth model/);assert.doesNotMatch(markup,/\/nr\.dlssmodel|effect-depth-intensity|effect-depth-denoise/);assert.match(markup,/relative depth/);
  assert.equal(elements(menu()).find(n=>n.type==='option'&&n.props.value==='').props.title,'Small depth model');
  menu().props.onChange({target:{value:'/small.depthmodel'}});await harness.settle();assert.equal(changes.at(-1).video[1].settings.modelPath,'/small.depthmodel');assert.deepEqual(changes.at(-1).video[1].shader,depth.shader);assert.deepEqual(changes.at(-1).video[0],shader);
  await controls().props.onImport();await harness.settle();assert.equal(changes.at(-1).video[1].settings.modelPath,'/imported.depthmodel');assert.deepEqual(changes.at(-1).video[1].shader.parameters,depth.shader.parameters);
 }finally{harness.close();}
});
test('model imports retain a newer operation or Graphics off after the native picker returns',async t=>{
 const oldWindow=global.window;t.after(()=>{global.window=oldWindow;});
 for(const action of ['operation','off']){let finish;const node={id:'import',kind:'neural',method:'realesrgan',enabled:true,settings:{modelPath:null,intensity:1,temporal:false}},before={schema:2,mode:'advanced',enabled:true,video:[shader,node]},changes=[];
  const catalog=['realesrgan','mlx-dlss'].map(method=>({id:'neural:'+method,kind:'neural',label:method,group:'Image filters',available:true,modelOperation:method,template:{...node,method}}));
  global.window={MacLauncher:{launcher:{getGameEffects:async()=>({plan:before,catalog}),setGameEffects:async(_path,next)=>{changes.push(next);return {plan:next,desiredRevision:changes.length};},pickGameEffectFile:async(_path,kind,operation)=>{assert.equal(kind,'neural-model');assert.equal(operation,'realesrgan');return new Promise(resolve=>{finish=resolve;});}}}};
  const harness=componentHarness(EffectsControls,{game:{gamePath:'/Game',effects:before},running:false});
  try{harness.render();await harness.settle();const controls=elements(harness.render()).find(n=>n.props.nodeId==='import'&&typeof n.props.onImport==='function'),job=controls.props.onImport();await harness.settle();
   if(action==='operation')elements(harness.render()).find(n=>n.props.id==='effect-choice-import').props.onChange({target:{value:'neural:mlx-dlss'}});else elements(harness.render()).find(n=>n.type==='input'&&n.props['aria-label']==='Enable graphics chain').props.onChange({target:{checked:false}});await harness.settle();
   finish('/managed/general.restorationmodel');await job;await harness.settle();assert.deepEqual(changes.at(-1).video[0],shader);
   if(action==='operation'){assert.equal(changes.at(-1).video[1].method,'mlx-dlss');assert.equal(changes.at(-1).video[1].settings.modelPath,null);assert.equal(changes.length,1);}else{assert.equal(changes.at(-1).enabled,false);assert.equal(changes.at(-1).video[1].method,'realesrgan');}
  }finally{harness.close();}
 }
});
test('shader pickers preserve current rows, Off and independent edits and cancel cleared work',async t=>{
 const oldWindow=global.window;t.after(()=>{global.window=oldWindow;});global.window={};
 const custom={id:'shader:custom',kind:'shader',label:'Custom shader…',available:true,group:'Image filters',template:{kind:'shader',enabled:true,shader:{enabled:true,preset:'custom',effectPath:null}}};
 const other={id:'shader:other',kind:'shader',label:'Other filter',available:true,group:'Image filters',template:{kind:'shader',enabled:true,shader:{enabled:true,preset:'vibrance'}}};
 for(const action of ['operation','remove','off','clear-add','simple-replace'])await t.test(action,async()=>{
  let finish;const node={...shader,shader:{enabled:true,preset:'custom',effectPath:'/old.hook',parameters:{Strength:[.4]}}};
  const before={schema:2,mode:'advanced',enabled:true,video:[node,{...other.template,id:'independent'}]},changes=[];
  global.window={MacLauncher:{launcher:{getGameEffects:async()=>({plan:before,catalog:[custom,other]}),setGameEffects:async(_path,next)=>{changes.push(next);return {plan:next,desiredRevision:changes.length};},pickGameEffectFile:()=>new Promise(resolve=>{finish=resolve;})}}};
  const props={game:{gamePath:'/Shared',effects:before},running:false};
  const harness=componentHarness(EffectsControls,props),tree=()=>elements(harness.render());
  try{
   await harness.settle();let job;
   if(action==='clear-add'){
    tree().find(n=>n.type==='button'&&n.props.children==='Add effect…').props.onClick();
    tree().find(n=>n.type==='button'&&n.props.children==='Image filter').props.onClick();
    job=tree().find(n=>n.type==='button'&&n.props.children==='Import custom…').props.onClick();
    tree().find(n=>n.type==='button'&&n.props.children==='Clear effects').props.onClick();
   }else if(action==='simple-replace'){
    tree().find(n=>n.type==='button'&&n.props.children==='Simple').props.onClick();
    tree().find(n=>n.props.id==='simple-effect-image-film').props.onChange({target:{value:custom.id}});
   }else{
    job=tree().find(n=>n.type==='button'&&n.props.children==='Choose shader…').props.onClick();
    if(action==='operation')tree().find(n=>n.props.id==='effect-choice-film').props.onChange({target:{value:other.id}});
    if(action==='remove')tree().find(n=>n.type==='button'&&n.props.title==='Remove effect').props.onClick();
    if(action==='off'){
     tree().find(n=>n.type==='input'&&n.props['aria-label']==='Enable graphics chain').props.onChange({target:{checked:false}});
     tree().find(n=>n.props.id==='effect-independent-enabled').props.onChange({target:{checked:false}});
    }
   }
   await harness.settle();const priorWrites=changes.length;finish('/new.hook');await job;await harness.settle();
   const result=changes.at(-1);
   if(action==='operation'){assert.equal(changes.length,priorWrites);assert.equal(result.video[0].shader.preset,'vibrance');}
   if(action==='remove'){assert.equal(changes.length,priorWrites);assert.equal(result.video.some(n=>n.id==='film'),false);}
   if(action==='off'){assert.equal(result.enabled,false);assert.equal(result.video[1].enabled,false);assert.equal(result.video[0].shader.effectPath,'/new.hook');}
   if(action==='clear-add'){assert.equal(changes.length,priorWrites);assert.deepEqual(result.video,[]);}
   if(action==='simple-replace'){assert.equal(result.video[0].shader.effectPath,'/new.hook');assert.equal(result.video[0].shader.parameters,null);assert.deepEqual(result.video[1],before.video[1]);}
   assert.deepEqual(before.video[0].shader.effectPath,'/old.hook');
  }finally{harness.close();}
 });
});
test('node metadata follows exact source selection without adding methods and typed model changes refit only owned sizing',async()=>{
 const key=require('../src/modules/shared/effects/selection-key.mjs').effectSelectionKey;
 const first={id:'one',kind:'shader',enabled:true,shader:{enabled:true,preset:'custom',effectPath:'/one.glsl'}},second={...first,id:'two',shader:{...first.shader,effectPath:'/two.glsl'}};
 const generic={id:'shader:custom',kind:'shader',label:'Custom shader…',group:'Image filters',available:true,template:{kind:'shader',enabled:true,shader:{enabled:true,preset:'custom',effectPath:null}}};
 const metadata=[first,second].map((node,index)=>({...generic,nodeId:node.id,selectionKey:key(node),label:node.shader.effectPath,traits:{outputScale:{x:index+2,y:index+2}},template:node}));
 const catalog=[generic,...metadata];assert.equal(effectChoice(first,catalog).label,'/one.glsl');assert.equal(effectChoice(second,catalog).label,'/two.glsl');assert.equal(effectChoice({...first,shader:{...first.shader,effectPath:'/new.glsl'}},catalog),generic);assert.deepEqual(effectChooserRows(catalog,'',false),[generic]);
 for(const manual of [false,true]){
  const model={id:'model',kind:'upscale',method:'realcugan',enabled:true,settings:{modelPath:'/two.restorationmodel'}},input={id:'auto-scale-input-model',kind:'downsample',method:'bilinear',enabled:true,settings:{},extent:{relativeTo:'presentation',factor:.5}};
  const before={schema:2,mode:'advanced',enabled:true,renderResolution:manual?{height:720}:{multiplier:2,managedBy:model.id},video:[input,model,{...shader,id:'independent'}]},changes=[];
  const choice={id:'upscale:realcugan',kind:'upscale',label:'Real-CUGAN',group:'Resize',available:true,modelOperation:'realcugan',intrinsicScale:2,intrinsicScales:[2,3,4],outputContract:{domain:'image',sizing:'intrinsic',scale:2},template:model};
  const status={neuralModels:[{version:'two',method:'realcugan',modelPath:'/two.restorationmodel',intrinsicScale:2},{version:'four',method:'realcugan',modelPath:'/four.restorationmodel',intrinsicScale:4}]};
  const harness=componentHarness(EffectsControls,{game:{gamePath:'preset',effects:before},running:false,status,editor:{info:{plan:before,catalog:[choice]},onChange:next=>changes.push(next)}});
  try{
   const settings=elements(harness.render()).find(n=>n.props.nodeId==='model'&&typeof n.props.onImport==='function');await settings.props.onChange({modelPath:'/four.restorationmodel'});await harness.settle();
   const next=changes.at(-1),refit=next.video.find(row=>row.id===model.id);assert.equal(refit.settings.modelPath,'/four.restorationmodel');assert.deepEqual(next.video.at(-1),before.video[2]);
   assert.deepEqual(next.renderResolution,manual?before.renderResolution:{multiplier:4,managedBy:model.id});
   // A manual source request makes sizing manual, so the refit drops the owned reduction instead of keeping a stale factor.
   assert.deepEqual(next.video.map(row=>row.id),manual?[model.id,'independent']:[input.id,model.id,'independent']);if(!manual)assert.equal(next.video[0].extent.factor,.25);
   assert.equal(effectChoice(refit,[choice],status).intrinsicScale,4);
   const count=changes.length;elements(harness.render()).find(n=>n.props.id==='effect-choice-model').props.onChange({target:{value:choice.id}});await harness.settle();assert.equal(changes.length,count,'reselecting a method does not reset its model');
  }finally{harness.close();}
 }
});
test('Output pacing and Auto motion clarity preserve each other and per-row multipliers',async()=>{
 const before={schema:2,mode:'advanced',enabled:true,video:[{id:'a',kind:'frame-generation',method:'metalfx',enabled:true,settings:{frameMultiplier:3}}],output:{framePacing:'fixed',targetFps:90,smoothCadence:true,motionClarity:'beam',subframes:3,duty:.5,brightness:1}},changes=[];
 const harness=componentHarness(EffectsControls,{game:{gamePath:'preset',effects:before},running:false,status:{graphics:{motionClarity:true,adaptive:true}},editor:{info:{plan:before,catalog:[]},onChange:next=>changes.push(next)}});
 try{
  const pacing=elements(harness.render()).find(n=>typeof n.type==='function'&&n.props.idPrefix==='effects-output');
  elements(pacing.type(pacing.props)).find(n=>n.props.id==='effects-output-pacing').props.onChange({target:{value:'adaptive'}});await harness.settle();
  assert.equal(changes.at(-1).output.framePacing,'adaptive');assert.equal(changes.at(-1).output.motionClarity,'beam');assert.equal(changes.at(-1).video[0].settings.frameMultiplier,3);
  elements(harness.render()).find(n=>n.props.id==='effects-motion-clarity').props.onChange({target:{value:'auto'}});await harness.settle();
  assert.deepEqual(changes.at(-1).output,{framePacing:'adaptive',targetFps:90,smoothCadence:true});assert.equal(changes.at(-1).video[0].settings.frameMultiplier,3);assert.equal(before.output.motionClarity,'beam');
 }finally{harness.close();}
});

test('Simple dropdown edits preserve custom order and switching views never saves or resets',async()=>{
 const before={schema:2,mode:'advanced',enabled:true,video:[shader,{id:'up',kind:'upscale',enabled:true,method:'metalfx',extent:{height:480},settings:{}}]},changes=[];
 const catalog=[{id:'shader:crt',kind:'shader',label:'CRT',group:'Shaders',available:true,template:shader},...['metalfx','fsr1'].map(method=>({id:'upscale:'+method,kind:'upscale',label:method,group:'Upscale',available:true,template:{kind:'upscale',enabled:true,method,settings:{}}}))];
 const harness=simpleHarness(EffectsControls,{game:{gamePath:'preset',effects:before},running:false,editor:{info:{plan:before,catalog},onChange:next=>changes.push(next)}});
 try{
  assert.match(renderToStaticMarkup(harness.render()),/aria-label="Simple graphics"/);assert.doesNotMatch(renderToStaticMarkup(harness.render()),/class="effectNode"/);
  elements(harness.render()).find(n=>n.props.id==='simple-effect-upscale').props.onChange({target:{value:'upscale:fsr1'}});await harness.settle();assert.equal(changes.length,1);assert.deepEqual(changes[0].video.map(n=>n.id),['film','up']);assert.deepEqual(changes[0].video[0],shader);assert.deepEqual(changes[0].video[1].extent,{height:480});
  for(const label of ['Advanced','Simple']){elements(harness.render()).find(n=>n.type==='button'&&n.props.children===label).props.onClick();harness.render();}assert.equal(changes.length,1);assert.equal(before.video[1].method,'metalfx');
 }finally{harness.close();}
});

test('Simple composes image filters without node cards and Off hides dependent controls',async()=>{
 const second={...shader,id:'color',shader:{enabled:true,preset:'vibrance',parameters:{Strength:[.4]}}},before={schema:2,mode:'advanced',enabled:true,video:[shader,second]},changes=[],navigation=[];
 const catalog=[shader,second].map(node=>({id:'shader:'+node.shader.preset,kind:'shader',label:node.shader.preset,group:'Image filters',available:true,template:node}));
 const oldWindow=global.window;global.window={MacLauncher:{launcher:{openUtilityWindow:async value=>navigation.push(value)}}};
 const harness=simpleHarness(EffectsControls,{game:{gamePath:'preset',effects:before},running:false,editor:{info:{plan:before,catalog},onChange:next=>changes.push(next)}});
 try{
  let tree=harness.render(),markup=renderToStaticMarkup(tree);assert.match(markup,/aria-label="Image filters"/);assert.doesNotMatch(markup,/Custom · 2 effects|class="effectNode"/);
  elements(tree).find(n=>n.props.id==='simple-effect-image-film').props.onChange({target:{value:'off'}});await harness.settle();
  assert.equal(changes.at(-1).video[0].enabled,false);assert.equal(changes.at(-1).video[1].enabled,true);assert.deepEqual(changes.at(-1).video[1].shader,second.shader);
  const offRow=elements(harness.render()).find(n=>n.props.id==='simple-effect-image-film');assert.equal(offRow.props.value,'off');
  offRow.props.onChange({target:{value:'__manage'}});await harness.settle();assert.deepEqual(navigation,[{view:'runtimes',managerId:'graphics-shader-library',shaderCategory:'image'}]);
  assert.equal(changes.length,1);
 }finally{harness.close();global.window=oldWindow;}
});
test('Simple neural selection uses a literal 540p input and an installed Automatic model without frame generation',async()=>{
 const before={schema:2,mode:'advanced',enabled:true,video:[]},changes=[],catalog=[{id:'neural:mlx-dlss',kind:'neural',label:'DLSS neural rendering',group:'Image filters',available:true,intrinsicScale:1,template:{kind:'neural',method:'mlx-dlss',enabled:true,settings:{modelPath:null,intensity:1,temporal:false}}},{id:'upscale:metalfx',kind:'upscale',label:'MetalFX',group:'Resize',available:true,template:{kind:'upscale',method:'metalfx',enabled:true,settings:{}}}];
 const harness=simpleHarness(EffectsControls,{game:{gamePath:'preset',effects:before},running:false,status:{neuralModels:[{method:'mlx-dlss',modelPath:'/managed/model.dlssmodel',version:'installed'}]},editor:{info:{plan:before,catalog},onChange:next=>changes.push(next),pickFile:()=>assert.fail('Automatic installed model must not ask for a file')}});
 try{elements(harness.render()).find(n=>n.props.id==='simple-effect-image-new').props.onChange({target:{value:'neural:mlx-dlss'}});await harness.settle();
  const next=changes.at(-1);assert.deepEqual(next.video.map(n=>n.kind),['downsample','neural','upscale']);assert.deepEqual(next.video[0].extent,{height:540});assert.equal(next.video[1].settings.modelPath,null);assert.equal(next.video[1].settings.temporal,false);assert.equal(next.video[1].settings.intensity,1);
 }finally{harness.close();}
});
test('Advanced Add exposes fixed I/O types before a searchable method library',()=>{
 const before={schema:2,mode:'advanced',enabled:true,video:[]},catalog=['CRT A','CRT B'].map((label,index)=>({id:'shader:'+index,kind:'shader',label,group:'Image filters',available:true,template:{kind:'shader',enabled:true,shader:{enabled:true,preset:'filter:'+index}}}));
 const harness=componentHarness(EffectsControls,{game:{gamePath:'preset',effects:before},running:false,editor:{info:{plan:before,catalog},onChange:()=>assert.fail('Opening the chooser cannot save')}});
 try{elements(harness.render()).find(n=>n.type==='button'&&n.props.children==='Add effect…').props.onClick();let markup=renderToStaticMarkup(harness.render());assert.match(markup,/aria-label="Effect type"/);assert.doesNotMatch(markup,/CRT A|CRT B|Search methods/);
  elements(harness.render()).find(n=>n.type==='button'&&n.props.children==='Image filter').props.onClick();markup=renderToStaticMarkup(harness.render());assert.match(markup,/Search methods/);assert.match(markup,/CRT A/);assert.match(markup,/CRT B/);
 }finally{harness.close();}
});
test('native rejection explains the retained chain even when acceptance belongs to an older revision',async()=>{
 const before={schema:2,mode:'advanced',enabled:true,video:[shader]},previous=global.window;
 global.window={MacLauncher:{launcher:{getGameEffects:async()=>({plan:before,catalog:[],live:true,preparation:{state:'published',revision:'new'}})}}};
 const harness=simpleHarness(EffectsControls,{game:{gamePath:'/Game',effects:before},running:true,visible:true});
 try{harness.render();await harness.settle();const observer=elements(harness.render()).find(n=>typeof n.props.onStatus==='function');observer.props.onStatus({state:'prepared',contexts:[{identityState:'previous',historical:false,observedAt:Date.now(),reason:'Automatic size is unsupported by this loaded adapter.',stages:[]}]});
  const markup=renderToStaticMarkup(harness.render());assert.match(markup,/Using previous/);assert.match(markup,/About retained graphics/);assert.doesNotMatch(markup,/role="status">Applied/);
 }finally{harness.close();global.window=previous;}
});
test('published graphics becomes Active only after every enabled row completed in one matching current context',async()=>{
 const before={schema:2,mode:'advanced',enabled:true,video:[shader,{id:'up',kind:'upscale',method:'bilinear',enabled:true,settings:{}}]},previous=global.window;
 global.window={MacLauncher:{launcher:{getGameEffects:async()=>({plan:before,catalog:[],live:true,preparation:{state:'published',revision:'new'}})}}};
 const harness=simpleHarness(EffectsControls,{game:{gamePath:'/Game',effects:before},running:true,visible:true});
 try{harness.render();await harness.settle();const status=contexts=>elements(harness.render()).find(n=>typeof n.props.onStatus==='function').props.onStatus({state:'observed',contexts}),context={identityState:'matching',historical:false,observedAt:Date.now(),reason:'',stages:[{id:'film',completed:2}]};
  status([context]);assert.doesNotMatch(renderToStaticMarkup(harness.render()),/role="status">Active/);
  status([{...context,stages:[...context.stages,{id:'up',completed:2}],historical:true}]);assert.doesNotMatch(renderToStaticMarkup(harness.render()),/role="status">Active/);
  status([{...context,stages:[...context.stages,{id:'up',completed:2}]}]);assert.match(renderToStaticMarkup(harness.render()),/role="status">Active/);
 }finally{harness.close();global.window=previous;}
});
test('owned fit shows the actual matched method while preserving the saved choice and rejecting stale observations',async t=>{
 const previous=global.window;t.after(()=>{global.window=previous;});
 const model={id:'model',kind:'upscale',method:'realcugan',enabled:true,settings:{modelPath:'/Models/Three.restorationmodel'}},
  fit={id:'auto-scale-fit-model',kind:'spatial',method:'metalfx',enabled:true,settings:{spatialMultiplier:null}},
  before={schema:2,mode:'advanced',enabled:true,video:[model,fit]},saved=structuredClone(before),
  catalog=[{id:'upscale:realcugan',kind:'upscale',label:'Real-CUGAN',available:true,intrinsicScale:3,template:model},
   {id:'upscale:metalfx',kind:'upscale',label:'MetalFX',available:true,template:fit},
   {id:'upscale:bilinear',kind:'upscale',label:'Bilinear',available:true,template:{...fit,method:'bilinear'}}];
 global.window={MacLauncher:{launcher:{getGameEffects:async()=>({plan:before,catalog,live:true}),setGameEffects:()=>assert.fail('Status cannot save a method substitution.')}}};
 const harness=componentHarness(EffectsControls,{game:{gamePath:'/Game',effects:before},running:true,visible:true});
 try{harness.render();await harness.settle();
  const report=(identityState='matching',historical=false)=>elements(harness.render()).find(node=>typeof node.props.onStatus==='function').props.onStatus({state:'observed',preparation:{pending:[],applied:[{id:fit.id,kind:'spatial',method:'bilinear'}]},contexts:[{identityState,historical,observedAt:Date.now(),stages:[{id:model.id,completed:1,phase:'completed',requestedMethod:'realcugan',activeMethod:'realcugan'},
   {id:fit.id,completed:1,phase:'completed',requestedMethod:'bilinear',activeMethod:'bilinear',reason:''}].map(stage=>({input:{width:1920,height:1080},output:{width:1920,height:1080},...stage}))}]});
  report();let markup=renderToStaticMarkup(harness.render());assert.match(markup,/Active · Bilinear/);assert.match(markup,/This stage uses Bilinear\. MetalFX remains the saved choice/);
  assert.equal(elements(harness.render()).find(node=>node.props.id===`effect-choice-${fit.id}`).props.value,'upscale:metalfx');assert.match(markup,/role="status">Active/);
  report('previous');markup=renderToStaticMarkup(harness.render());assert.doesNotMatch(markup,/Active · Bilinear|This stage uses Bilinear|role="status">Active/);
  report('matching',true);assert.doesNotMatch(renderToStaticMarkup(harness.render()),/Active · Bilinear|This stage uses Bilinear|role="status">Active/);
  assert.deepEqual(before,saved);
 }finally{harness.close();}
});

test('a stage native code kept at its previous working version shows Using previous with the edit\'s reason',async t=>{
 const previous=global.window;t.after(()=>{global.window=previous;});
 const fit={id:'scale',kind:'spatial',method:'metalfx',enabled:true,settings:{spatialMultiplier:2}},before={schema:2,mode:'advanced',enabled:true,video:[fit]},
  catalog=[{id:'upscale:metalfx',kind:'upscale',label:'MetalFX',available:true,template:fit}],reason='The edited scaler could not be prepared.';
 global.window={MacLauncher:{launcher:{getGameEffects:async()=>({plan:before,catalog,live:true})}}};
 const harness=componentHarness(EffectsControls,{game:{gamePath:'/Game',effects:before},running:true,visible:true});
 try{harness.render();await harness.settle();
  elements(harness.render()).find(node=>typeof node.props.onStatus==='function').props.onStatus({state:'observed',preparation:{pending:[],applied:[]},contexts:[{identityState:'matching',historical:false,observedAt:Date.now(),
   stages:[{id:fit.id,completed:3,phase:'completed',requestedMethod:'metalfx',activeMethod:'retained',reason,input:{width:1920,height:1080},output:{width:3840,height:2160}}]}]});
  const markup=renderToStaticMarkup(harness.render());
  assert.match(markup,/Using previous/);assert.match(markup,/edited scaler could not be prepared/);assert.doesNotMatch(markup,/Active · retained/);
  assert.doesNotMatch(markup,/role="status">Active/,'a retained stage does not confirm the edit');
 }finally{harness.close();}
});
test('XeSS frame generation uses the shared backend control and its declared midpoint factor',()=>{
 const node={id:'intel-pair',kind:'frame-generation',enabled:true,method:'xess',settings:{frameMultiplier:2,xessBackend:'auto'}},before={schema:2,mode:'advanced',enabled:true,video:[node]},catalog=[{id:'frame-generation:xess',kind:'frame-generation',label:'Intel XeSS',group:'Temporal',available:true,backends:['d3d12'],runtimeManagerId:'graphics-xess',template:node,outputContract:{domain:'timeline',sizing:'preserve',phases:'midpoint',maximumMultiplier:2}}];
 const harness=componentHarness(EffectsControls,{game:{gamePath:'preset',effects:before},running:false,editor:{info:{plan:before,catalog},onChange:()=>assert.fail('Reading midpoint controls cannot change the plan')}});
 try{const markup=renderToStaticMarkup(harness.render());assert.match(markup,/Compute backend/);assert.match(markup,/Direct3D 12/);assert.match(markup,/manage XeSS/);assert.match(markup,/2× frame rate/);assert.doesNotMatch(markup,/3× frame rate|4× frame rate|5× frame rate|<option[^>]*value="vulkan"/);}finally{harness.close();}
});
test('motion clarity without image nodes becomes Active only after matching output completion',async()=>{
 const before={schema:2,mode:'advanced',enabled:true,video:[],output:{motionClarity:'bfi',subframes:2,duty:.5,brightness:1}},previous=global.window;
 global.window={MacLauncher:{launcher:{getGameEffects:async()=>({plan:before,catalog:[],live:true,preparation:{state:'published',revision:'output'}})}}};
 const harness=simpleHarness(EffectsControls,{game:{gamePath:'/Game',effects:before},running:true,visible:true});
 try{harness.render();await harness.settle();const status=context=>elements(harness.render()).find(n=>typeof n.props.onStatus==='function').props.onStatus({state:'observed',contexts:[context]}),context={identityState:'matching',historical:false,observedAt:Date.now(),reason:'',stages:[],completed:0};
  status(context);assert.doesNotMatch(renderToStaticMarkup(harness.render()),/role="status">Active/);
  status({...context,identityState:'previous',completed:1});assert.doesNotMatch(renderToStaticMarkup(harness.render()),/role="status">Active/);
  status({...context,completed:1});assert.match(renderToStaticMarkup(harness.render()),/role="status">Active/);
 }finally{harness.close();global.window=previous;}
});

test('restoration denoising follows the selected paired model and the compatible Automatic default',()=>{
 const models=[{version:'plain',modelPath:'/models/plain',method:'realesrgan'},{version:'paired',modelPath:'/models/paired',method:'realesrgan',pairedDenoiser:true}];
 for(const [modelPath,defaultVersion,denoising]of[[null,'paired',true],[null,'plain',false],['/models/plain','paired',false],['/models/local','paired',false]]){
  const node={id:'restore',kind:'neural',enabled:true,method:'realesrgan',settings:{modelPath,denoiseStrength:.6}},before={schema:2,mode:'advanced',enabled:true,video:[node]},catalog=[{id:'neural:realesrgan',kind:'neural',label:'Real-ESRGAN',group:'Resize',available:true,intrinsicScale:4,template:node,outputContract:{domain:'image',sizing:'intrinsic',scale:4}}];
  const harness=componentHarness(EffectsControls,{game:{gamePath:'preset',effects:before},running:false,status:{available:true,presets:[],neuralModels:models,defaultNeuralModelVersion:defaultVersion},editor:{info:{plan:before,catalog},onChange:()=>assert.fail('Model details cannot alter the saved graph')}});
  try{const markup=renderToStaticMarkup(harness.render());assert.equal(markup.includes('effect-restore-denoise'),denoising);assert.doesNotMatch(markup,/effect-restore-intensity|Temporal reconstruction/);assert.match(markup,/4× input/);}finally{harness.close();}
 }
});

test('replacing a requested-size shader without a size keeps its image role and adds no automatic fitting defaults',async()=>{
 const node={id:'resize',kind:'shader',enabled:true,shader:{enabled:true,preset:'filter:original'}},before={schema:2,mode:'advanced',enabled:true,video:[node]},contract={domain:'image',sizing:'stage',extentEditable:true,resizeDirections:['downsample','upscale']},catalog=[{id:'filter:original',kind:'shader',label:'Original resize shader',group:'Shaders',available:true,template:node,outputContract:contract},{id:'filter:stage',kind:'shader',label:'Requested size shader',group:'Shaders',available:true,template:{kind:'shader',enabled:true,shader:{enabled:true,preset:'filter:stage'}},outputContract:contract}],writes=[];
 const harness=componentHarness(EffectsControls,{game:{gamePath:'preset',effects:before},running:false,editor:{info:{plan:before,catalog},onChange:value=>writes.push(value)}});
 try{const picker=elements(harness.render()).find(n=>n.props.id==='effect-choice-resize');assert.ok(picker.props.options.some(option=>option.value==='filter:stage'));await picker.props.onChange({target:{value:'filter:stage'}});await harness.settle();assert.equal(writes.at(-1).video[0].kind,'shader');assert.equal(writes.at(-1).video[0].extent,undefined);assert.equal(writes.at(-1).video[0].id,'resize');assert.equal(writes.at(-1).renderResolution,undefined);}finally{harness.close();}
});

test('comparison controls use one output policy and hide mode-specific settings when Off',async()=>{
 const before={schema:2,mode:'advanced',enabled:true,video:[shader]},writes=[],harness=componentHarness(EffectsControls,{game:{gamePath:'preset',effects:before},running:false,status:{available:true,presets:[],graphics:{comparison:true,hosts:{window:{comparison:true}}}},editor:{info:{plan:before,catalog:[]},onChange:value=>writes.push(value)}});
 try{let tree=harness.render(),picker=elements(tree).find(n=>n.props.id==='effects-comparison');assert.ok(picker);assert.equal(picker.props.value,'off');assert.equal(elements(tree).filter(n=>n.props.id==='effects-comparison').length,1);assert.equal(elements(tree).some(n=>n.props.id==='effects-comparison-position'||n.props.id==='effects-comparison-gain'),false);await picker.props.onChange({target:{value:'wipe'}});await harness.settle();assert.deepEqual(writes.at(-1).video,before.video);assert.deepEqual(writes.at(-1).output,{comparison:{mode:'wipe',position:.5,gain:1}});assert.equal(writes.at(-1).output.motionClarity,undefined);tree=harness.render();assert.ok(elements(tree).find(n=>n.props.id==='effects-comparison-position'));assert.equal(elements(tree).some(n=>n.props.id==='effects-comparison-gain'),false);}finally{harness.close();}
});
test('output tone mapping is shared across views and unsupported saved choices remain recoverable',async()=>{
 for(const view of ['Simple','Advanced'])for(const supported of [true,false]){
  const output={toneMapping:'preserve',framePacing:'fixed',targetFps:90,smoothCadence:true,comparison:{mode:'wipe',position:.3,gain:1}},before={schema:2,mode:'advanced',enabled:true,video:[shader],output},writes=[];
  const harness=simpleHarness(EffectsControls,{game:{gamePath:'preset',effects:before},running:false,status:{graphics:{outputColor:supported}},editor:{info:{plan:before,catalog:[]},onChange:next=>writes.push(next)}});
  try{
   if(view==='Advanced')elements(harness.render()).find(n=>n.type==='button'&&n.props.children==='Advanced').props.onClick();
   const controls=()=>elements(harness.render()).filter(n=>n.props.id==='effects-tone-mapping');
   assert.equal(controls().length,1);assert.equal(controls()[0].props.value,'preserve');assert.equal(writes.length,0);
   assert.deepEqual(elements(controls()[0]).filter(n=>n.type==='option').map(n=>[n.props.value,n.props.children,Boolean(n.props.disabled)]),[['auto','Automatic',false],['preserve','None',!supported],['reinhard','Reinhard',!supported],['pbr-neutral','PBR Neutral',!supported]]);
   const markup=renderToStaticMarkup(harness.render());assert.match(markup,/<summary>Output<\/summary>/);assert.match(markup,/declared scene-referred source metadata/);assert.equal(markup.includes('Runtime update needed'),!supported);
   controls()[0].props.onChange({target:{value:supported?'pbr-neutral':'auto'}});await harness.settle();
   assert.deepEqual(writes.at(-1).video,before.video);assert.deepEqual(writes.at(-1).output,supported?{...output,toneMapping:'pbr-neutral'}:{framePacing:'fixed',targetFps:90,smoothCadence:true,comparison:output.comparison});
   assert.equal(before.output.toneMapping,'preserve');
   const count=writes.length;elements(harness.render()).find(n=>n.type==='button'&&n.props.children===(view==='Simple'?'Advanced':'Simple')).props.onClick();harness.render();assert.equal(writes.length,count);
  }finally{harness.close();}
 }
});
test('preparing a new method never labels the previously prepared same-id stage Active',async()=>{
 const previous=global.window,before={schema:2,mode:'advanced',enabled:true,video:[{id:'scale',kind:'upscale',method:'metalfx',enabled:true,settings:{}}]};global.window={MacLauncher:{launcher:{getGameEffects:async()=>({plan:before,catalog:[],live:true}),getGraphicsStatus:async gamePath=>({gamePath,desiredSeq:2,desiredRevision:'new',running:true,live:true,phase:'preparing',rows:{}})}}};const harness=componentHarness(EffectsControls,{game:{gamePath:'/Game',effects:before},running:true,visible:true});
 try{harness.render();await harness.settle();elements(harness.render()).find(n=>typeof n.props.onStatus==='function').props.onStatus({state:'observed',contexts:[{identityState:'matching',historical:false,completed:1,observedAt:Date.now(),stages:[{id:'scale',completed:1}]}]});const markup=renderToStaticMarkup(harness.render());assert.match(markup,/Preparing…/);assert.doesNotMatch(markup,/>Active</);}finally{harness.close();global.window=previous;}
});
test('adaptive quality edits the selected working extent policy without changing its baseline or output',async()=>{
 const node={id:'working',kind:'downsample',method:'area',enabled:true,extent:{height:480},settings:{}},before={schema:2,mode:'advanced',enabled:true,video:[node],output:{comparison:{mode:'wipe',position:.5,gain:1}}},writes=[],harness=componentHarness(EffectsControls,{game:{gamePath:'preset',effects:before},running:false,status:{available:true,presets:[],graphics:{adaptiveQuality:true}},editor:{info:{plan:before,catalog:[]},onChange:next=>writes.push(next)}});
 try{const settings=elements(harness.render()).find(n=>n.props.node?.id==='working'&&n.props.onExtentChange),adaptive=settings.props.processingOptions;assert.ok(adaptive);adaptive.props.onChange({enabled:true,nodeId:node.id,budgetMs:8,minScale:.5,maxScale:1});await harness.settle();assert.deepEqual(writes.at(-1).video,before.video);assert.deepEqual(writes.at(-1).output.comparison,before.output.comparison);assert.equal(writes.at(-1).output.adaptiveQuality.nodeId,'working');const markup=renderToStaticMarkup(harness.render());assert.match(markup,/GPU budget \(ms\)/);assert.doesNotMatch(markup,/inference time|0\.00 ms/);}finally{harness.close();}
});
test('adaptive status names the measured scope and never presents zero as a timing sample',async()=>{
 const previous=global.window,node={id:'working',kind:'downsample',method:'area',enabled:true,extent:{height:480},settings:{}},plan={schema:2,mode:'advanced',enabled:true,video:[node],output:{adaptiveQuality:{enabled:true,nodeId:'working',budgetMs:8,minScale:.5,maxScale:1}}};global.window={MacLauncher:{launcher:{getGameEffects:async()=>({plan,catalog:[],preparation:{state:'published',revision:'policy'},live:true})}}};const harness=componentHarness(EffectsControls,{game:{gamePath:'/Game',effects:plan},running:true,status:{available:true,presets:[],graphics:{adaptiveQuality:true}}});
 try{harness.render();await harness.settle();const observe=(quality,other=[])=>elements(harness.render()).find(n=>typeof n.props.onStatus==='function').props.onStatus({state:'observed',contexts:[{identityState:'matching',historical:false,observedAt:Date.now(),stages:[],adaptiveQuality:quality},...other]});observe({nodeId:'working',state:'pending',scale:1,meanMilliseconds:0,scope:'unknown',reason:'Waiting for a represented GPU job.'},[{identityState:'previous',historical:false,observedAt:Date.now()+100,stages:[],adaptiveQuality:{nodeId:'working',state:'active',scale:.25,meanMilliseconds:999,scope:'offline-frame',reason:''}}]);let markup=renderToStaticMarkup(harness.render());assert.match(markup,/Timing pending/);assert.doesNotMatch(markup,/0\.00 ms|999\.00 ms/);observe({nodeId:'working',state:'active',scale:.75,meanMilliseconds:4.5,scope:'image-processing',reason:''});markup=renderToStaticMarkup(harness.render());assert.match(markup,/75% · Image processing 4\.50 ms/);assert.doesNotMatch(markup,/inference time/);}finally{harness.close();global.window=previous;}
});
test('FSR4 profile options retain saved choices and disable only uninstalled profiles',()=>{
 const node={id:'scene',kind:'temporal',method:'fsr4',enabled:true,settings:{fsr4Profile:'lite2'}},plan={schema:2,mode:'advanced',enabled:true,video:[node]},catalog=[{id:'temporal:fsr4',kind:'temporal',label:'FSR 4',group:'Temporal',available:true,profiles:['exact-fast','lite'],template:node}],harness=componentHarness(EffectsControls,{game:{gamePath:'preset',effects:plan},running:false,editor:{info:{plan,catalog},onChange:()=>assert.fail('Reading profile choices cannot save')}});
 try{const settings=elements(harness.render()).find(n=>n.props.node?.id==='scene'&&n.props.onExtentChange),picker=elements(settings.type(settings.props)).find(n=>n.props.id==='effect-scene-fsr4-profile');assert.equal(picker.props.value,'lite2');const options=elements(picker).filter(n=>n.type==='option');assert.deepEqual(options.map(n=>[n.props.value,n.props.disabled]),[['exact-fast',false],['lite',false],['lite2',true]]);}finally{harness.close();}
});
test('ordinary implementation menus show installed capabilities and retain only the selected unavailable row',async t=>{
 const previous=global.window;t.after(()=>{global.window=previous;});global.window={};
 const native={id:'down:bilinear',kind:'downsample',label:'Bilinear',group:'Resize',available:true,template:{id:'down',kind:'downsample',method:'bilinear',enabled:true,settings:{}}},missing={id:'neural:nafnet',kind:'neural',label:'Restoration',group:'Image filters',available:false,availableWithoutModel:true,reason:'Compatible model required.',template:{id:'restore',kind:'neural',method:'nafnet',enabled:true,settings:{modelPath:null}}},runtime={id:'temporal:xess',kind:'temporal',label:'XeSS',group:'Temporal',available:false,availableWithoutRuntime:true,reason:'Runtime required.',template:{kind:'temporal',method:'xess',enabled:true,settings:{}}},scene={id:'temporal:metalfx',kind:'temporal',label:'MetalFX temporal',group:'Temporal',available:false,availableWithoutInputs:true,pendingInputs:['depth'],template:{kind:'temporal',method:'metalfx',enabled:true,settings:{}}};
 assert.deepEqual(effectChooserRows([native,missing,runtime,scene],'',false).map(row=>row.id),[native.id,scene.id]);
 const saved={schema:2,mode:'advanced',enabled:true,video:[missing.template]},h=componentHarness(EffectsControls,{game:{gamePath:'/Game',effects:saved},running:false,editor:{info:{plan:saved,catalog:[native,missing,runtime,scene]},onChange(){assert.fail('Browsing unavailable selections must not save.');},pickFile:async()=>null}});
 try{const picker=elements(h.render()).find(n=>n.props.id==='effect-choice-restore');assert.equal(picker.props.value,missing.id);assert.equal(picker.props.options.find(row=>row.value===missing.id).disabled,true);assert.ok(picker.props.options.some(row=>row.value==='__manage'));}finally{h.close();}
});
test('open Simple Options reports same-size dimensions and updates geometry through the existing observer',async t=>{
 const previous=global.window;t.after(()=>{global.window=previous;});const node={id:'same',kind:'shader',enabled:true,shader:{enabled:true,preset:'same-filter'}},before={schema:2,mode:'advanced',enabled:true,video:[node]},catalog=[{id:'shader:same-filter',kind:'shader',label:'Same-size filter',group:'Image filters',available:true,template:node,outputContract:{domain:'image',sizing:'preserve'}}];
 global.window={MacLauncher:{launcher:{getGameEffects:async()=>({plan:before,catalog,live:true,preparation:{state:'published',revision:'current'}})}}};
 const h=simpleHarness(EffectsControls,{game:{gamePath:'/Game',effects:before},running:true,visible:true});
 try{h.render();await h.settle();const observer=()=>elements(h.render()).find(n=>typeof n.props.onStatus==='function');assert.equal(observer().props.inspectDetails,false);
  elements(h.render()).find(n=>n.type==='button'&&n.props.children==='Options…').props.onClick();assert.equal(observer().props.inspectDetails,true);
  const report=(width,height,resolutionScope)=>observer().props.onStatus({state:'observed',contexts:[{identityState:'matching',historical:false,observedAt:Date.now(),stages:[{id:'same',phase:'encoded',encoded:1,completed:0,input:{width,height},output:{width,height},resolutionScope}]}]});
  report(64,48);let markup=renderToStaticMarkup(h.render());assert.match(markup,/64 × 48 → 64 × 48/);assert.doesNotMatch(markup,/role="status">Active/);
  report(80,60,{kind:'shader-group',members:['same','refinement']});markup=renderToStaticMarkup(h.render());assert.match(markup,/Group resolution/);assert.match(markup,/80 × 60 → 80 × 60/);
  report(96,64);markup=renderToStaticMarkup(h.render());assert.match(markup,/96 × 64 → 96 × 64/);assert.doesNotMatch(markup,/64 × 48 → 64 × 48/);assert.equal(observer().props.inspectDetails,true);
  assert.doesNotMatch(markup,/Group resolution/);
  elements(h.render()).find(n=>n.type==='button'&&n.props.children==='Options…').props.onClick();assert.equal(observer().props.inspectDetails,false);assert.doesNotMatch(renderToStaticMarkup(h.render()),/96 × 64 → 96 × 64/);
 }finally{h.close();}
});
test('Off and remove retire scale helpers and source reduction owned by a shader in any row',async()=>{
 const look={id:'look',kind:'shader',enabled:true,shader:{enabled:true,preset:'filter:double',parameters:null}};
 const input={id:'auto-scale-input-look',kind:'downsample',method:'bilinear',enabled:true,extent:{relativeTo:'presentation',factor:.5},settings:{}},fit={id:'auto-scale-fit-look',kind:'spatial',method:'bicubic',enabled:true,settings:{}};
 const before={schema:2,mode:'advanced',enabled:true,video:[input,look,fit],renderResolution:{multiplier:2,managedBy:'look'}};
 const catalog=[{id:'shader:filter:double',kind:'shader',label:'Double',group:'Resize',available:true,outputContract:{scale:2,sizing:'stage'},template:{kind:'shader',enabled:true,shader:{enabled:true,preset:'filter:double',parameters:null}}}];
 for(const view of ['Simple','Advanced']){
  const changes=[],h=(view==='Simple'?simpleHarness:componentHarness)(EffectsControls,{game:{gamePath:'preset',effects:before},running:false,editor:{info:{plan:before,catalog},onChange:next=>changes.push(next)}});
  try{
   if(view==='Simple')elements(h.render()).find(n=>n.props.id==='simple-effect-upscale').props.onChange({target:{value:'off'}});
   else elements(h.render()).find(n=>n.props['aria-label']==='Remove Double').props.onClick();
   await h.settle();const saved=changes.at(-1);assert.ok(saved,view);assert.equal(saved.renderResolution,undefined,view);
   if(view==='Simple')assert.deepEqual(saved.video.map(n=>[n.id,n.enabled]),[[input.id,false],['look',false],[fit.id,false]]);
   else assert.deepEqual(saved.video,[]);
  }finally{h.close();}
 }
 // The Advanced checkbox retires and restores the same owned sizing (U3).
 const changes=[],h=componentHarness(EffectsControls,{game:{gamePath:'preset',effects:before},running:false,editor:{info:{plan:before,catalog},onChange:next=>changes.push(next)}});
 try{
  const toggle=checked=>elements(h.render()).find(n=>n.props.id==='effect-look-enabled').props.onChange({target:{checked}});
  toggle(false);await h.settle();assert.deepEqual(changes.at(-1).video.map(n=>n.enabled),[false,false,false]);assert.equal(changes.at(-1).renderResolution,undefined);
  toggle(true);await h.settle();assert.deepEqual(changes.at(-1).video.map(n=>[n.id,n.enabled]),[[input.id,true],['look',true],[fit.id,true]]);assert.deepEqual(changes.at(-1).renderResolution,{multiplier:2,managedBy:'look'});
 }finally{h.close();}
});
test('Temporal and frame generation rows offer no shader import or filter-library dead ends',()=>{
 const before={schema:2,mode:'advanced',enabled:true,video:[]},h=simpleHarness(EffectsControls,{game:{gamePath:'preset',effects:before},running:false,editor:{info:{plan:before,catalog:[]},onChange:()=>{}}});
 try{const values=id=>elements(h.render()).find(n=>n.props.id===id).props.options.map(o=>o.value);
  for(const id of ['simple-effect-scene','simple-effect-generation']){assert.ok(!values(id).includes('__import'),id);assert.ok(!values(id).includes('__manage'),id);}
  assert.ok(values('simple-effect-image-new').includes('__manage'));
 }finally{h.close();}
});
test('resize menus list fixed-direction shaders before shaders that take the row size',()=>{
 const row=(id,outputContract)=>({id,kind:'shader',label:id,group:'Resize',available:true,outputContract,template:{kind:'shader',enabled:true,shader:{enabled:true,preset:id}}});
 const catalog=[row('filter:any',{domain:'image',sizing:'stage',extentEditable:true,resizeDirections:['downsample','upscale']}),row('filter:double',{domain:'image',sizing:'intrinsic',scale:{x:2,y:2},extentEditable:false}),
  {id:'upscale:bilinear',kind:'upscale',label:'Bilinear',group:'Resize',available:true,outputContract:{domain:'image',sizing:'stage',extentEditable:true,resizeDirections:['upscale']},template:{kind:'upscale',enabled:true,method:'bilinear',settings:{spatialMethod:'bilinear'}}}];
 const before={schema:2,mode:'advanced',enabled:true,video:[]},harness=simpleHarness(EffectsControls,{game:{gamePath:'preset',effects:before},running:false,editor:{info:{plan:before,catalog},onChange:()=>{}}});
 try{
  const tree=harness.render(),options=id=>elements(tree).find(n=>n.props.id===id).props.options.filter(option=>option.value.startsWith('filter:')).map(option=>[option.value,option.group,option.detail]);
  assert.deepEqual(options('simple-effect-upscale'),[['filter:double','Shaders','2×'],['filter:any','Any size','Size set in options']]);
  assert.deepEqual(options('simple-effect-downsample'),[['filter:any','Any size','Size set in options']]);
  assert.deepEqual(options('simple-effect-image-new'),[['filter:any','Shaders',undefined]],'an image filter omits the size every filter keeps');
  const builtIn=elements(tree).find(n=>n.props.id==='simple-effect-upscale').props.options.find(option=>option.value==='upscale:bilinear');
  assert.ok(builtIn);assert.equal(builtIn.detail,undefined,'a built-in method omits the size every method takes from its options');
 }finally{harness.close();}
});
test('the Graphics section collapses to a one-line summary, keeps its body mounted and remembers the choice', async t => {
  const previous = global.window; t.after(() => {global.window = previous;});
  global.window = {MacLauncher: {launcher: {getGameEffects: async () => ({plan: {schema: 2, mode: 'advanced', enabled: true, video: []}, catalog: []})}}};
  const props = {game: {gamePath: '/Game', effects: null}, running: false};
  const harness = baseHarness(EffectsControls, props), find = predicate => elements(harness.render()).find(predicate);
  const toggle = () => find(node => node.props.className === 'collapsibleToggle');
  const summary = () => {harness.render();return find(node => node.props.className === 'collapsibleSummary')?.props.children;};
  try {
    await harness.settle();
    assert.equal(toggle().props['aria-expanded'], true);assert.equal(summary(), undefined);
    toggle().props.onClick();
    const markup = renderToStaticMarkup(harness.render());
    assert.match(markup, /class="collapsibleToggle" aria-expanded="false"[^>]*>Graphics<\/button>/);
    assert.match(markup, /<span class="collapsibleSummary">No effects<\/span>/);
    assert.match(markup, /class="collapsibleBody" hidden="">/);assert.match(markup, /aria-label="Graphics view"/, 'the body stays mounted');
    assert.ok(find(node => node.props['aria-label'] === 'Enable graphics chain'), 'the master switch stays in the header');
    assert.ok(find(node => node.props.ariaLabel === 'Graphics actions'), 'one actions menu stays in the header');
    props.game = {...props.game, effects: {schema: 2, mode: 'advanced', enabled: false, video: []}};
    assert.equal(summary(), 'Off');
    props.running = true;assert.equal(summary(), 'Off · Next launch');
    props.live = true;assert.equal(summary(), 'Off · Running');
    props.warnings = ['Frame generation was unavailable.'];assert.equal(summary(), 'Off · Running · Needs attention');
    const next = baseHarness(EffectsControls, {game: {gamePath: '/Other', effects: null}, running: false});
    try {
      const reopened = () => elements(next.render()).find(node => node.props.className === 'collapsibleToggle');
      assert.equal(reopened().props['aria-expanded'], false, 'another game keeps the closed section');
      reopened().props.onClick();assert.equal(reopened().props['aria-expanded'], true);
    } finally {next.close();}
  } finally {harness.close();}
});
test('an unreadable saved plan offers Clear effects instead of an editor, and notices list the settings that were not kept', async t => {
  const previous = global.window, resets = [];t.after(() => {global.window = previous;});
  global.window = {MacLauncher: {launcher: {getGameEffects: async () => ({plan: {schema: 2, mode: 'advanced', enabled: true, video: []}, catalog: []}),
    resetGameEffects: async gamePath => {resets.push(gamePath);return true;}, setGameEffects: () => assert.fail('An unreadable plan is never replaced by an edit')}}};
  const message = 'The saved graphics settings cannot be read: Choose a valid row. Clear effects to edit them.';
  const props = {game: {gamePath: '/Game', effects: null, graphicsPlanError: {code: 'GRAPHICS_STORED_PLAN_INVALID', message}}, running: false};
  const harness = baseHarness(EffectsControls, props);
  try {
    await harness.settle();
    let markup = renderToStaticMarkup(harness.render());
    assert.match(markup, /class="error errorInline graphicsPlanError" role="alert"><span class="errorMessage">The saved graphics settings cannot be read: Choose a valid row\./);
    assert.doesNotMatch(markup, /aria-label="Graphics view"|Add effect…|Apply preset/);
    assert.equal(elements(harness.render()).find(node => node.props['aria-label'] === 'Enable graphics chain').props.disabled, true);
    const clear = elements(harness.render()).filter(node => node.type === 'button' && node.props.children === 'Clear effects');
    assert.equal(clear.length, 2, 'the menu and the error both offer Clear effects');
    clear[1].props.onClick();await harness.settle();
    assert.deepEqual(resets, ['/Game']);
    props.game = {gamePath: '/Game', effects: null, effectsNotices: [{rowId: 'retired', message: 'The saved shader “retired” is no longer available.'},
      {dropped: true, message: 'The saved source resolution could not be kept.'}, {rowId: 'blank', message: ''}]};
    markup = renderToStaticMarkup(harness.render());
    assert.doesNotMatch(markup, /graphicsPlanError/);assert.match(markup, /aria-label="Graphics view"/);
    assert.match(markup, /Some saved graphics settings were not kept\.<ul><li>The saved shader “retired” is no longer available\.<\/li><li>The saved source resolution could not be kept\.<\/li><\/ul>/);
  } finally {harness.close();}
});
test('row notices and bypassed rows mark their row in both views, and a save lists the parts it left out', async t => {
  const previous = global.window, listeners = [], before = {schema: 2, mode: 'advanced', enabled: true, video: [shader]};t.after(() => {global.window = previous;});
  const upgrade = 'The saved shader “film” stays off until it is chosen again.', bypass = 'CRT needs scene inputs that an earlier effect removes.';
  const left = 'The saved effect “broken” is skipped. A graphics row needs a supported method and settings.';
  global.window = {MacLauncher: {launcher: {getGameEffects: async () => ({plan: before, catalog: []}),
    getGraphicsStatus: async gamePath => ({gamePath, desiredSeq: 1, running: false, live: false, phase: 'saved', rows: {}}),
    onGraphicsStatus: listener => {listeners.push(listener);return () => listeners.splice(listeners.indexOf(listener), 1);},
    setGameEffects: async (_path, next) => ({plan: next, desiredRevision: '2', notices: [{dropped: true, message: left}]})}}};
  const props = {game: {gamePath: '/Game', effects: before, effectsNotices: [{rowId: 'film', message: upgrade}]}, running: false};
  const harness = baseHarness(EffectsControls, props), find = predicate => elements(harness.render()).find(predicate);
  const why = () => elements(harness.render()).filter(node => typeof node.props.label === 'string' && / needs attention$/.test(node.props.label)).map(node => node.props.children);
  try {
    await harness.settle();
    for (const view of ['Advanced', 'Simple']) {
      find(node => node.type === 'button' && node.props.children === view).props.onClick();
      assert.deepEqual(why(), [upgrade], `${view} marks the row its notice names`);
    }
    let markup = renderToStaticMarkup(harness.render());
    assert.match(markup, /Some saved effects need attention\.<ul><li>The saved shader “film” stays off/);
    for (const listener of [...listeners]) listener({gamePath: '/Game', status: {gamePath: '/Game', desiredSeq: 2, running: true, live: true, phase: 'partial', reason: bypass,
      rows: {film: {state: 'bypassed', reason: bypass}}}});
    await harness.settle();
    assert.deepEqual(why(), [`${upgrade} ${bypass}`], 'a row bypassed at preparation carries its reason');
    props.game = {...props.game, effectsNotices: undefined};
    find(node => node.props['aria-label'] === 'Enable graphics chain').props.onChange({target: {checked: false}});
    await harness.settle();
    markup = renderToStaticMarkup(harness.render());
    assert.match(markup, /role="alert"><span class="[^"]*">Needs attention<\/span> Some changes were not saved\.<ul><li>The saved effect “broken” is skipped\./);
    assert.doesNotMatch(markup, /Some saved effects need attention/);
  } finally {harness.close();}
});
test('the header status follows the status owner: the initial read, then pushed transitions and plans saved elsewhere', async t => {
  const previous = global.window, listeners = [], before = {schema: 2, mode: 'advanced', enabled: true, video: [shader]};t.after(() => {global.window = previous;});
  const reason = 'This game was started without live graphics editing. Changes apply on the next launch.';
  global.window = {MacLauncher: {launcher: {getGameEffects: async () => ({plan: before, catalog: []}),
    getGraphicsStatus: async gamePath => ({gamePath, desiredSeq: 1, running: true, live: false, phase: 'deferred', reason, rows: {}}),
    onGraphicsStatus: listener => {listeners.push(listener);return () => listeners.splice(listeners.indexOf(listener), 1);}}}};
  const harness = componentHarness(EffectsControls, {game: {gamePath: '/Game', runtimeId: 'native', effects: before}, running: true});
  try {
    await harness.settle();
    let markup = renderToStaticMarkup(harness.render());
    assert.match(markup, /role="status">Next launch</);assert.ok(markup.includes(reason));
    const replaced = {...before, video: []}, status = gamePath => ({gamePath, desiredSeq: 2, running: true, live: true, phase: 'applied', rows: {}});
    for (const listener of [...listeners]) listener({gamePath: '/Other', status: status('/Other'), plan: replaced});
    assert.ok(elements(harness.render()).some(node => node.props.id === 'effect-film-enabled'), 'another game leaves this editor unchanged');
    for (const listener of [...listeners]) listener({gamePath: '/Game', status: status('/Game'), plan: replaced, activeLaunch: {launchId: 'launch', pid: 7, runtimeId: 'managed'}});
    await harness.settle();markup = renderToStaticMarkup(harness.render());
    assert.match(markup, /role="status">Applied</);assert.match(markup, /Running: managed · Next launch: native/);
    assert.equal(elements(harness.render()).some(node => node.props.id === 'effect-film-enabled'), false, 'a plan saved in another window replaces the shown plan');
  } finally {harness.close();}
  assert.equal(listeners.length, 0);
});
test('Undo restores the chain a preset replaced until the next edit', async t => {
  const previous = global.window, writes = [], before = {schema: 2, mode: 'advanced', enabled: true, video: [shader]};t.after(() => {global.window = previous;});
  global.window = {MacLauncher: {launcher: {getGameEffects: async () => ({plan: before, catalog: []}),
    setGameEffects: async (_path, next) => {writes.push(next);return {plan: next, desiredRevision: String(writes.length)};}}}};
  const harness = baseHarness(EffectsControls, {game: {gamePath: '/Game', effects: before}, running: false}), find = predicate => elements(harness.render()).find(predicate);
  const menu = () => find(node => typeof node.props.onApply === 'function' && typeof node.props.onSave === 'function');
  const undo = () => find(node => node.type === 'button' && node.props.children === 'Undo');
  const empty = () => ({schema: 2, mode: 'advanced', enabled: true, video: []});
  try {
    await harness.settle();assert.equal(undo(), undefined);
    menu().props.onApply(empty());await harness.settle();
    assert.deepEqual(writes.at(-1).video, []);assert.ok(undo());
    undo().props.onClick();await harness.settle();
    assert.deepEqual(writes.at(-1).video, before.video);assert.equal(undo(), undefined);
    menu().props.onApply(empty());await harness.settle();assert.ok(undo());
    find(node => node.props['aria-label'] === 'Enable graphics chain').props.onChange({target: {checked: false}});await harness.settle();
    assert.equal(writes.at(-1).enabled, false);assert.equal(undo(), undefined, 'another edit ends Undo');
  } finally {harness.close();}
});
test("the depth input group appears only for shader rows whose compiled program reads depth and edits the game's definitions", async t => {
  const previous = global.window, writes = [], before = {schema: 2, mode: "advanced", enabled: true, video: [shader]};t.after(() => {global.window = previous;});
  global.window = {MacLauncher: {launcher: {getGameEffects: async () => ({plan: before, catalog: []}),
    getGameEffectParameters: async () => ({key: "k", parameters: [], requirements: {depth: true, motion: false}}),
    setGameEffects: async (_path, next) => {writes.push(next);return {plan: next, desiredRevision: String(writes.length)};}}}};
  const graphics = {spatial: false, frameGeneration: false, spatialMethods: [], frameGenerationMethods: [], depthInput: true};
  const props = {game: {gamePath: "/Game", effects: before}, running: false, status: {available: true, presets: [], shaderParameters: true, graphics}};
  const harness = componentHarness(EffectsControls, props), parameters = () => elements(harness.render()).find(node => node.props.idPrefix === "effect-film");
  try {
    await harness.settle();
    assert.equal(parameters().props.after({parameters: [], requirements: {depth: false, motion: false}}), null, "a shader without depth shows no group");
    assert.equal(parameters().props.after({parameters: []}), null);
    const group = parameters().props.after({parameters: [], requirements: {depth: true, motion: false}}), markup = renderToStaticMarkup(group);
    assert.match(markup, /<summary>Depth input/);assert.doesNotMatch(markup, /<details[^>]* open/, "default values stay collapsed");
    for (const label of [">Reversed<", ">Logarithmic<", ">Far plane<", ">Multiplier<"]) assert.ok(markup.includes(label), label);
    assert.doesNotMatch(markup, />Reset</);
    // The parameter panel renders the group once its compiled program is described.
    const panel = componentHarness(parameters().type, parameters().props);
    try {panel.render();await panel.settle();assert.match(renderToStaticMarkup(panel.render()), /Depth input/);} finally {panel.close();}
    // The group is hook-free, so its controls render through its props.
    elements(group.type(group.props)).find(node => node.type === "input" && node.props.type === "checkbox").props.onChange({target: {checked: true}});await harness.settle();
    assert.deepEqual(writes.at(-1).depthInput, {reversed: true});assert.deepEqual(writes.at(-1).video, before.video);
    const saved = parameters().props.after({parameters: [], requirements: {depth: true, motion: false}});
    assert.match(renderToStaticMarkup(saved), /<details[^>]* open/);
    elements(saved.type(saved.props)).find(node => node.type === "button" && node.props.children === "Reset").props.onClick();await harness.settle();
    assert.equal("depthInput" in writes.at(-1), false);
    props.status = {...props.status, graphics: {...graphics, depthInput: false}};
    assert.equal(parameters().props.after({parameters: [], requirements: {depth: true, motion: false}}), null, "a runtime without depth input definitions shows no group");
  } finally {harness.close();}
});
test("applying a preset keeps the game's depth input", async t => {
  const previous = global.window, writes = [], before = {schema: 2, mode: "advanced", enabled: true, video: [shader], depthInput: {farPlane: 300}};t.after(() => {global.window = previous;});
  global.window = {MacLauncher: {launcher: {getGameEffects: async () => ({plan: before, catalog: []}),
    setGameEffects: async (_path, next) => {writes.push(next);return {plan: next, desiredRevision: String(writes.length)};}}}};
  const harness = baseHarness(EffectsControls, {game: {gamePath: "/Game", effects: before}, running: false});
  try {
    await harness.settle();
    elements(harness.render()).find(node => typeof node.props.onApply === "function" && typeof node.props.onSave === "function")
      .props.onApply({schema: 2, mode: "advanced", enabled: true, video: [], depthInput: {reversed: true}});await harness.settle();
    assert.deepEqual(writes.at(-1).video, []);assert.deepEqual(writes.at(-1).depthInput, {farPlane: 300});
  } finally {harness.close();}
});
