const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const Resources = require("../src/modules/shared/reshade/live-resources");

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "graphics-live-resources-"));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const userDataDir = path.join(directory, "profile");fs.mkdirSync(userDataDir);
  return {directory, userDataDir, root: path.join(directory, "provider")};
}
test("dormant temporal bindings permit later provider switches without provider initialization or engine restrictions",t=>{
  const f=fixture(t),Providers=require("../src/modules/shared/reshade/temporal/providers"),Binding=require("../src/modules/shared/reshade/launch-binding");
  fs.mkdirSync(f.root);fs.writeFileSync(path.join(f.root,"runtime.json"),JSON.stringify({features:{graphics:{temporalMethods:["metalfx","asr","sgsr2"]}}}));
  const library=path.join(f.root,"temporal/asr/libmaclauncher-asr.dylib"),directory=path.dirname(library);
  t.mock.method(Providers,"reserve",(_root,_options,methods)=>{assert.deepEqual(methods,["metalfx","asr","sgsr2"]);return {providers:{asr:{library,directory}},environment:{RESHADE_ASR_LIBRARY:library,RESHADE_ASR_SHADER_DIRECTORY:directory}};});
  t.mock.method(Providers,"prepare",()=>assert.fail("dormant admission must not prepare GPU resources"));
  const prepared=Resources.prepare({...f,neuralLibraryPath:()=>null});
  assert.equal(prepared.environment.RESHADE_ASR_LIBRARY,library);assert.deepEqual(prepared.resources.temporal.methods,["metalfx","asr"]);
  const launch={effectPlanAPI:1,effectPlanLiveResources:prepared.resources,effectPlanTemporalMethods:[]},node={id:"scene",kind:"temporal",enabled:true,method:"asr",settings:{}};
  assert.equal(Binding.nodeUnavailableReason(launch,node),null);assert.match(Binding.nodeUnavailableReason(launch,{...node,method:"sgsr2"}),/binding/);
  assert.equal(fs.existsSync(directory),false,"reserving metadata does not create or fetch a provider");
});
test("selected provider verification follows the same temporal registry and preserves bypass",()=>{
  const Verification=require("../src/modules/shared/reshade/payload-verification"),files=["libreshade-macos.dylib","temporal/asr/provider.json","temporal/asr/libmaclauncher-asr.dylib","temporal/sgsr2/provider.json","temporal/fsr/fsr2-build.json"].map(path=>({path}));
  const effects={schema:2,mode:"advanced",video:[{id:"scene",kind:"temporal",enabled:true,method:"asr",settings:{}}]};
  assert.deepEqual(Verification.selectedFiles({files},{effects}).map(row=>row.path),files.slice(0,3).map(row=>row.path));
  assert.deepEqual(Verification.selectedFiles({files},{effects:{...effects,enabled:false}}),[]);
});
test("dormant provider reservation uses only fixed manifest paths without optional discovery",t=>{
  const Providers=require("../src/modules/shared/reshade/temporal/providers"),FSR=require("../src/modules/shared/reshade/temporal/fsr"),ASR=require("../src/modules/shared/reshade/temporal/asr");
  t.mock.method(FSR,"resolve",()=>assert.fail("no dormant provider discovery"));t.mock.method(ASR,"resolve",()=>assert.fail("no dormant provider discovery"));
  const root="/immutable/processor",files=[{path:"temporal/asr/libmaclauncher-asr.dylib"}];
  const reserved=Providers.reserve(root,{},["asr","fsr2"],files);
  assert.deepEqual(Object.keys(reserved.providers),["asr"]);assert.equal(reserved.environment.RESHADE_ASR_LIBRARY,root+"/temporal/asr/libmaclauncher-asr.dylib");
  assert.deepEqual(Providers.reserve(root,{},["asr"],[]),{providers:{},environment:{}});
});

test("live resources grant only model stores and advertise the lazy provider without reading models", t => {
  const options = fixture(t), provider = {library: path.join(options.root, "neural", "libNeural.dylib"), directory: path.join(options.root, "neural")};
  let resolved = 0;
  const result = Resources.prepare({...options, graphicsArchitecture: "arm64", neuralLibraryPath: (root, request) => {
    resolved++;assert.equal(root, options.root);assert.equal(request.graphicsArchitecture, "arm64");return provider.library;
  }});
  assert.equal(resolved, 1);
  assert.deepEqual(JSON.parse(result.environment.RESHADE_EFFECT_MODEL_ROOTS), Object.values(result.resources.modelRoots));
  assert.equal(result.environment.RESHADE_NEURAL_LIBRARY, provider.library);
  assert.equal(result.resources.neuralLibrary, provider.library);
  assert.equal(fs.existsSync(path.join(options.userDataDir, "runtimes")), false, "activation grants do not create model stores");
});

test("models imported after launch are authorized without granting neighboring game data", t => {
  const options = fixture(t), {resources} = Resources.prepare({...options, neuralLibraryPath: () => null});
  const lossless = path.join(resources.modelRoots.lossless, "sha256-" + "a".repeat(64), "Lossless.dll");
  const neural = path.join(resources.modelRoots.neural, "sha256-" + "b".repeat(64), "model.dlssmodel");
  fs.mkdirSync(path.dirname(lossless), {recursive: true});fs.writeFileSync(lossless, "model");fs.mkdirSync(neural, {recursive: true});
  assert.equal(Resources.allowsModel(resources, lossless, "lossless"), true);
  assert.equal(Resources.allowsModel(resources, neural, "neural"), true);
  assert.equal(Resources.allowsModel(resources, lossless, "neural"), false);
  const neighbor = path.join(options.userDataDir, "runtimes", "private-data", "account.json");
  fs.mkdirSync(path.dirname(neighbor));fs.writeFileSync(neighbor, "private");
  assert.equal(Resources.allowsModel(resources, neighbor, "lossless"), false);
  assert.equal(Resources.allowsModel(resources, resources.modelRoots.neural, "neural"), false);
  assert.equal(Resources.allowsModel(null, lossless, "lossless"), false);
});

test("live model grants reject aliases at the store, model, and parent boundaries", t => {
  const options = fixture(t), {resources} = Resources.prepare({...options, neuralLibraryPath: () => null});
  for (const root of Object.values(resources.modelRoots)) fs.mkdirSync(root, {recursive: true});
  const outside = path.join(options.directory, "outside");fs.mkdirSync(outside);fs.writeFileSync(path.join(outside, "Lossless.dll"), "private");
  const alias = path.join(resources.modelRoots.lossless, "alias");fs.symlinkSync(outside, alias);
  assert.equal(Resources.allowsModel(resources, path.join(alias, "Lossless.dll"), "lossless"), false);
  const neuralAlias = path.join(resources.modelRoots.neural, "model.dlssmodel");fs.symlinkSync(outside, neuralAlias);
  assert.equal(Resources.allowsModel(resources, neuralAlias, "neural"), false);
  fs.rmSync(resources.modelRoots.neural, {recursive: true});fs.symlinkSync(outside, resources.modelRoots.neural);
  assert.throws(() => Resources.prepare({...options, neuralLibraryPath: () => null}), /must not be aliases/);
  assert.equal(Resources.allowsModel(resources, path.join(resources.modelRoots.neural, "Lossless.dll"), "neural"), false);
});

test("unavailable neural providers retain independent shader and frame-generation resources", t => {
  const options = fixture(t), result = Resources.prepare({...options, neuralLibraryPath: () => null});
  assert.equal(result.resources.neuralLibrary, null);
  assert.equal(Object.hasOwn(result.environment, "RESHADE_NEURAL_LIBRARY"), false);
  assert.equal(Object.hasOwn(result.environment, "RESHADE_NEURAL_ROOT"), false);
  assert.equal(JSON.parse(result.environment.RESHADE_EFFECT_MODEL_ROOTS).length, 2);
});

test("dormant neural library authorization resolves aliases only when a model is selected", t => {
  const options = fixture(t), Binding = require("../src/modules/shared/reshade/launch-binding");
  const directory = path.join(options.directory, "actual-provider"), library = path.join(directory, "provider.dylib");
  fs.mkdirSync(directory);fs.writeFileSync(library, "provider");fs.mkdirSync(options.root);
  fs.symlinkSync(directory, path.join(options.root, "neural"));
  const candidate = path.join(options.root, "neural", "provider.dylib");
  const {resources} = Resources.prepare({...options, neuralLibraryPath: () => candidate});
  const model = path.join(resources.modelRoots.neural, "model.dlssmodel");fs.mkdirSync(model, {recursive: true});
  const launch = {effectPlanLiveResources: resources};
  assert.equal(resources.neuralLibrary, candidate, "activation retains an uninspected layout path");
  assert.equal(Binding.allowsNeural(launch, model, library), true);
  const other = path.join(directory, "other.dylib");fs.writeFileSync(other, "different");
  assert.equal(Binding.allowsNeural(launch, model, other), false);
  assert.equal(Binding.allowsNeural(launch, model, null), false);
});
