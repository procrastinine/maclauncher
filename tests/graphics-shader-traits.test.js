const test = require("node:test"), assert = require("node:assert/strict");
const Traits = require("../src/modules/shared/reshade/shader-traits");
test("MPV network layers use declared output geometry and descriptions rather than filenames", () => {
  const shader = `//!DESC Example CNN x2
//!HOOK MAIN
//!BIND HOOKED
//!SAVE features
//!WIDTH HOOKED.w
//!HEIGHT HOOKED.h
vec4 hook() { return vec4(0); }
//!HOOK MAIN
//!BIND features
//!WIDTH MAIN.w 2 *
//!HEIGHT MAIN.h 2 *
vec4 hook() { return vec4(1); }`;
  const traits = Traits.inspect(shader, "libplacebo");
  assert.equal(traits.category, "upscaling"); assert.equal(traits.neural, true);
  assert.deepEqual(traits.outputScale, {x: 2, y: 2}); assert.equal(traits.rgbCompatible, true);
  assert.equal(Traits.group(traits), "Imported upscalers");
  const dynamic = Traits.inspect(shader.replace("MAIN.w 2 *", "OUTPUT.w").replace("MAIN.h 2 *", "OUTPUT.h"), "libplacebo");
  assert.equal(dynamic.outputScale, undefined); assert.equal(dynamic.geometryKnown, false);
});
test("MPV luma requirements are computable while unresolved geometry stays explicit", () => {
  const traits = Traits.inspect("//!DESC Neural denoise\n//!HOOK LUMA\n//!WIDTH HOOKED.w\n//!HEIGHT HOOKED.h\nvec4 hook() { return vec4(1); }", "libplacebo");
  assert.equal(traits.rgbCompatible, true);assert.equal(traits.requiresDerivedPlanes, true);assert.equal(traits.requiresVideoPlanes, false);
  assert.equal(traits.neural, true); assert.equal(traits.category, "restoration");
  assert.equal(traits.outputScale, undefined);
  // The FX canvas keeps the input size; a requested output is a separate fit.
  assert.deepEqual(Traits.inspect("vec4 x;", "fx"), {category:"effects",neural:false,inputPolicy:"srgb-sdr",
    rgbCompatible:true,inputPlanes:["rgb"],geometryKnown:true,requestedOutputExtent:true,outputExtentEditable:true,preservesSize:true,resizeDirections:[]});
  const bad = Traits.inspect("//!HOOK MAIN\n//!WIDTH HOOKED.w 0 /\n//!HEIGHT HOOKED.h\nvec4 hook() { return vec4(1); }", "libplacebo");
  assert.equal(bad.geometryKnown, false); assert.equal(bad.outputScale, undefined);
});
test("absolute pixel expressions and dimensionless ratios are not mistaken for input-relative upscales", () => {
  for (const expression of ["2", "1", "HOOKED.w HOOKED.w / 2 *", "HOOKED.w HOOKED.w *"]) {
    const traits = Traits.inspect(`//!HOOK MAIN\n//!WIDTH ${expression}\n//!HEIGHT HOOKED.h 2 *\nvec4 hook(){return vec4(1);}`, "libplacebo");
    assert.equal(traits.outputScale, undefined);assert.equal(traits.geometryKnown, false);assert.equal(traits.unresolvedGeometry, true);
  }
  const fixed = Traits.inspect("//!HOOK MAIN\n//!WIDTH 1280\n//!HEIGHT 720\nvec4 hook(){return vec4(1);}", "libplacebo"), Contracts = require("../src/modules/shared/effects/contracts.mjs");
  assert.deepEqual(fixed.outputSize, {width: 1280, height: 720});assert.equal(fixed.unresolvedGeometry, true);
  const row = {template: {kind: "shader"}, traits: fixed, outputContract: Traits.outputContract(fixed)};
  assert.deepEqual(Contracts.shaderGeometry(row), {kind: "size", size: {width: 1280, height: 720}, directions: []});assert.equal(Contracts.graphicsType(row.template, row), "downsample");
  assert.deepEqual(Contracts.shaderDefaultOutput(row), {outputSize: {width: 1280, height: 720}});assert.equal(Contracts.shaderResizes(row), true);
  assert.equal(require("../src/modules/shared/effects/presentation.mjs").implementationOutputSummary(row), "1280 × 720");
  const proportional = Traits.inspect("//!HOOK MAIN\n//!WIDTH 2 HOOKED.w *\n//!HEIGHT HOOKED.h 4 * 2 /\nvec4 hook(){return vec4(1);}", "libplacebo");
  assert.deepEqual(proportional.outputScale, { x: 2, y: 2 });
});
test("conditional or display-dependent resize directives defer output dimensions to the original renderer", () => {
  const conditional = Traits.inspect("//!DESC Example CNN x2\n//!HOOK MAIN\n//!WIDTH HOOKED.w 2 *\n//!HEIGHT HOOKED.h 2 *\n//!WHEN OUTPUT.w HOOKED.w >\nvec4 hook(){return vec4(1);}", "libplacebo");
  assert.equal(conditional.outputScale, undefined);assert.equal(conditional.geometryKnown, false);
  assert.equal(conditional.conditionalGeometry, true);assert.equal(conditional.displayDependentGeometry, true);
  assert.equal(conditional.category, "upscaling");
  const display = Traits.inspect("//!HOOK MAIN\n//!WIDTH OUTPUT.w\n//!HEIGHT OUTPUT.h\nvec4 hook(){return vec4(1);}", "libplacebo");
  assert.equal(display.outputScale, undefined);assert.equal(display.displayDependentGeometry, true);
  const color = Traits.inspect("//!HOOK MAIN\n//!WHEN OUTPUT.w HOOKED.w >\nvec4 hook(){return vec4(1);}", "libplacebo");
  assert.equal(color.conditionalGeometry, undefined);assert.equal(color.displayDependentGeometry, undefined);
  assert.equal(color.unresolvedGeometry, undefined);
  const crossStage = Traits.inspect("//!HOOK MAIN\n//!WIDTH HOOKED.w 2 *\n//!HEIGHT HOOKED.h 2 *\nvec4 hook(){return vec4(1);}\n//!HOOK PREKERNEL\n//!WIDTH HOOKED.w 2 *\n//!HEIGHT HOOKED.h 2 *\nvec4 hook(){return vec4(1);}", "libplacebo");
  assert.equal(crossStage.outputScale, undefined);assert.equal(crossStage.unresolvedGeometry, true);
});
test("a published hook sized from an output-sized saved texture inherits its proven direction", () => {
  const easu = "//!HOOK LUMA\n//!BIND HOOKED\n//!SAVE EASUTEX\n//!WHEN OUTPUT.w OUTPUT.h * LUMA.w LUMA.h * / 1.0 >\n//!WIDTH OUTPUT.w OUTPUT.w LUMA.w 2 * < * LUMA.w 2 * OUTPUT.w LUMA.w 2 * > * +\n//!HEIGHT OUTPUT.h OUTPUT.h LUMA.h 2 * < * LUMA.h 2 * OUTPUT.h LUMA.h 2 * > * +\nvec4 hook(){return vec4(1);}\n//!HOOK LUMA\n//!BIND EASUTEX\n//!WIDTH EASUTEX.w\n//!HEIGHT EASUTEX.h\nvec4 hook(){return vec4(1);}";
  const traits = Traits.inspect(easu, "libplacebo"), Contracts = require("../src/modules/shared/effects/contracts.mjs");
  assert.equal(traits.requestedResize, true);assert.equal(traits.displayDependentGeometry, true);assert.deepEqual(traits.resizeDirections, ["upscale"]);
  const row = {template:{kind:"shader"},traits,outputContract:Traits.outputContract(traits)};
  assert.deepEqual(Contracts.shaderGeometry(row), {kind:"target",directions:["upscale"],target:"presentation"});
  assert.equal(Contracts.graphicsType(row.template,row), "upscale");
});
test("neural names with underscore suffixes and saved hook outputs retain their declared resizing", () => {
  for (const name of ["ArtCNN_C4F32", "FSRCNNX_x2", "NNEDI3_nns32"]) {
    const traits = Traits.inspect(`//!DESC ${name}\n//!HOOK MAIN\n//!SAVE features\nvec4 hook(){return vec4(1);}\n//!HOOK MAIN\n//!SAVE MAIN\n//!WIDTH features.w 2 *\n//!HEIGHT features.h 2 *\nvec4 hook(){return vec4(1);}`, "libplacebo");
    assert.equal(traits.neural, true);assert.equal(traits.category, "upscaling");assert.deepEqual(traits.outputScale, {x: 2, y: 2});
  }
  const dynamic = Traits.inspect("//!HOOK MAIN\n//!SAVE MAIN\n//!WIDTH OUTPUT.w\n//!HEIGHT OUTPUT.h\nvec4 hook(){return vec4(1);}", "libplacebo");
  assert.equal(dynamic.geometryKnown, false);assert.equal(dynamic.outputScale, undefined);
});
test("scratch feature geometry and chroma reconstruction do not become frame upscalers", () => {
  const scratch = Traits.inspect("//!DESC Neural restoration\n//!HOOK MAIN\n//!SAVE features\n//!WIDTH OUTPUT.w\n//!HEIGHT OUTPUT.h\n//!WHEN OUTPUT.w HOOKED.w >\nvec4 hook(){return vec4(1);}\n//!HOOK MAIN\nvec4 hook(){return vec4(1);}", "libplacebo");
  assert.equal(scratch.neural, true);assert.equal(scratch.category, "restoration");
  assert.equal(scratch.unresolvedGeometry, undefined);assert.equal(scratch.outputScale, undefined);
  const chroma = Traits.inspect("//!DESC CNN chroma\n//!HOOK CHROMA\n//!WIDTH LUMA.w\n//!HEIGHT LUMA.h\nvec4 hook(){return vec4(1);}", "libplacebo");
  assert.equal(chroma.category, "chroma");assert.equal(chroma.outputScale, undefined);assert.equal(chroma.requiresDerivedPlanes, true);assert.equal(chroma.requiresVideoPlanes, false);
  assert.equal(Traits.inspect("//!HOOK CHROMA_SCALED\nvec4 hook(){return vec4(1);}", "libplacebo").category, "chroma");
  const luma = Traits.inspect("//!DESC Neural resize\n//!HOOK LUMA\n//!WIDTH HOOKED.w 2 *\n//!HEIGHT HOOKED.h 2 *\nvec4 hook(){return vec4(1);}", "libplacebo");
  assert.equal(luma.category, "upscaling");assert.deepEqual(luma.outputScale, {x: 2, y: 2});assert.equal(luma.requiresDerivedPlanes, true);assert.equal(luma.requiresVideoPlanes, false);
  const dynamic = Traits.inspect("//!HOOK MAIN\n//!WIDTH OUTPUT.w\n//!HEIGHT OUTPUT.h\nvec4 hook(){return vec4(1);}", "libplacebo");
  assert.equal(dynamic.category, "scaling");assert.equal(dynamic.outputScale, undefined);
});
test("Advanced catalog separates declared scaling from appearance without activating a provider", () => {
  const Plan = require("../src/modules/shared/effects/plan");
  const rows = Plan.catalog({reshadeState: {available: true, presets: [
    {id: "filter:up", label: "Upscale", traits: {category: "upscaling", neural: true,outputScale:{x:2,y:2}}},
    {id: "filter:down", label: "Downscale", traits: {category: "downscaling",outputScale:{x:.5,y:.5}}},
    {id: "filter:restore", label: "Restore", traits: {category: "restoration", neural: true}},
    {id: "filter:chroma", label: "Chroma", traits: {category: "chroma", requiresVideoPlanes: true}},
    {id: "crt", label: "CRT", traits: {category: "crt"}}]}});
  const row = id => rows.find(value => value.id === id);
  const type=id=>{const value=row(id);return require("../src/modules/shared/effects/contracts.mjs").graphicsType(value.template,value);};
  assert.equal(row("filter:up").group, "Resize");assert.equal(row("filter:up").category, "Neural shaders");assert.equal(type("filter:up"),"upscale");
  assert.equal(row("filter:down").group, "Resize");assert.equal(type("filter:down"),"downsample");assert.equal(row("filter:restore").group, "Image filters");assert.equal(type("filter:restore"),"image");
  assert.equal(row("shader:crt").category, "CRT");assert.equal(row("filter:chroma").available, false);
  assert.match(row("filter:chroma").reason, /luma and chroma/);
});
test("FX input policy is explicit data metadata and rejects conflicting declarations",()=>{
 assert.equal(Traits.inspect("//!INPUT_POLICY source\nfloat4 pass(){return 1;}","fx").inputPolicy,"source");
 assert.equal(Traits.inspect("//!INPUT_POLICY srgb-sdr\nfloat4 pass(){return 1;}","fx").inputPolicy,"srgb-sdr");
 assert.match(Traits.inspect("//!INPUT_POLICY source\n//!INPUT_POLICY srgb-sdr\n","fx").sourceError,/input policy/);
 assert.match(Traits.inspect("//!INPUT_POLICY guessed-hdr\n","fx").sourceError,/input policy/);
 for(const declaration of ["//!INPUT_POLICY", "//!INPUT_POLICY linear-source extra", "//!INPUT_POLICY source\n//!INPUT_POLICY srgb-sdr extra"])
  assert.match(Traits.inspect(declaration,"fx").sourceError,/input policy/);
 assert.equal(Traits.inspect("//!HOOK MAIN\nvec4 hook(){return HOOKED_tex(HOOKED_pos);}","libplacebo").inputPolicy,undefined);
 const Plan=require("../src/modules/shared/effects/plan"),presets=[{id:"example",label:"Example",format:"fx",traits:Traits.inspect("float4 pass(){return 1;}","fx")}];
 const current=Plan.catalog({reshadeState:{available:true,presets},graphicsCapabilities:{colorPipeline:true,shaderInputPolicy:true}})[0];
 const previous=Plan.catalog({reshadeState:{available:true,presets},graphicsCapabilities:{colorPipeline:true}})[0];
 assert.equal(current.colorPolicy.provider,"srgb-sdr");assert.equal(previous.colorPolicy,undefined);
});
test("linear source conversion is the same authored color contract across shader formats",()=>{
 const Providers=require("../src/modules/shared/reshade/shader-providers");
 for(const format of ["fx","libplacebo"]){
  const traits=Traits.inspect("//!INPUT_POLICY linear-source\n//!HOOK MAIN\nvec4 hook(){return vec4(1);}",format);
  assert.equal(traits.inputPolicy,"linear-source");assert.equal(traits.sharedOnly,true);
  assert.match(Providers.traitsAvailability(format,traits,{features:{}}),/linear-color/);
  assert.equal(Providers.traitsAvailability(format,traits,{features:{linearInputPolicyAPI:1}}),null);
 }
});
test("catalog uses the same compiled color and real-history requirements as preparation",()=>{
 const Plan=require("../src/modules/shared/effects/plan"),Providers=require("../src/modules/shared/reshade/shader-providers");
 const traits=Traits.inspect('//!INPUT_POLICY linear-source\n//!SCENE_HISTORY real\n//!SCENE_INPUT Guide depth\ntexture Guide;\n',"fx");
 const preset={id:"arbitrary",label:"Arbitrary shader",format:"fx",available:true,traits};
 const features={sceneInputsAPI:1,providers:{fx:{sceneInputsAPI:1,sceneInputRoles:["depth"]}}};
 const row=()=>Plan.catalog({reshadeState:{available:true,presets:[preset],shaderFeatures:features},graphicsInputs:{depth:true}}).find(r=>r.id==="shader:arbitrary");
 assert.equal(row().available,false);assert.equal(row().reason,Providers.traitsAvailability("fx",traits,{features}));
 features.linearInputPolicyAPI=1;assert.match(row().reason,/real-frame scene history/);
 features.sceneHistoryAPI=1;features.providers.fx.sceneHistoryAPI=1;
 assert.equal(row().available,true);
});
test('Slang global sizing overrides axis fields exactly like the pinned preset parser',()=>{
 const Retroarch=require('../src/modules/shared/reshade/retroarch-traits');
 const traits=Retroarch.inspect('shaders = 1\nscale_type0 = source\nscale_type_x0 = viewport\nscale_type_y0 = absolute\nscale0 = 2\nscale_x0 = 3\nscale_y0 = 5\n','slangp');
 assert.deepEqual(traits.outputScale,{x:2,y:2});assert.equal(traits.geometryKnown,true);
});
test('Slang preset, selected program and include edits share exact dependency identity and authored annotations',t=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'slang-source-metadata-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.mkdirSync(path.join(root,'sub'));const preset=path.join(root,'root.slangp'),reference=path.join(root,'sub/reference.slangp'),program=path.join(root,'sub/program.slang'),include=path.join(root,'sub/inputs.inc');
 fs.writeFileSync(preset,'#reference "sub/reference.slangp"\n');fs.writeFileSync(reference,'shaders = 1\nshader0 = "program.slang"\nscale_type0 = source\nscale0 = 1\n');
 fs.writeFileSync(program,'#version 450\n#include "inputs.inc"\n#pragma stage vertex\nvoid main(){}\n#pragma stage fragment\nvoid main(){}\n');fs.writeFileSync(include,'//!SCENE_INPUT Guide depth\n');
 const first=Traits.analyzeFile(preset,'slangp');assert.deepEqual(first.traits.sceneInputs,['depth']);assert.ok(first.dependencies.some(row=>row.file===program));assert.ok(first.dependencies.some(row=>row.file===include));
 fs.writeFileSync(include,'//!SCENE_INPUT Surface normal\n');const second=Traits.analyzeFile(preset,'slangp');assert.notEqual(second.sourceRevision,first.sourceRevision);assert.deepEqual(second.traits.sceneInputs,['normal']);
 fs.appendFileSync(program,'\n// program edit\n');const third=Traits.analyzeFile(preset,'slangp');assert.notEqual(third.sourceRevision,second.sourceRevision);
 const direct=Traits.analyzeFile(program,'slang');assert.deepEqual(direct.traits.sceneInputs,['normal']);assert.ok(direct.dependencies.some(row=>row.file===include));
});
test("conditional and analyzed-unresolved shaders count as resizing; unanalyzed and identity shaders do not", () => {
  const Contracts = require("../src/modules/shared/effects/contracts.mjs");
  const cases = [[undefined, false], [{}, false], [{preservesSize: true}, false], [{conditionalGeometry: true, resizeDirections: ["upscale"]}, true],
    [{unresolvedGeometry: true}, true], [{displayDependentGeometry: true}, true], [{outputScale: {x: 2, y: 2}}, true]];
  for (const [traits, resizes] of cases) assert.equal(Contracts.shaderResizes({traits}), resizes, JSON.stringify(traits));
});
