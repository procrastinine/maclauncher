const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const Resources = require("../src/modules/shared/reshade/live-resources");

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "graphics-live-resources-"));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const userDataDir = path.join(directory, "profile");fs.mkdirSync(userDataDir);
  return {directory, userDataDir, root: path.join(directory, "provider")};
}

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
