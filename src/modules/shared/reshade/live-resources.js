const fs = require("node:fs"), path = require("node:path");
const Writable = require("../writable-input");

const stores = Object.freeze({lossless: "lossless-models", neural: "graphics-neural-models"});
const within = (root, file) => file !== root && file.startsWith(root + path.sep);
const supportsHost = host => ["window", "remote", "explicit", "catalyst"].includes(host);
const supported = (root, host) => supportsHost(host) && require("../effects/runtime").supported(root);

// The process can read newly imported models from these two owned stores.
// Preparing a live switch still validates the selected model and its provider;
// granting read access does not load either of them or initialize GPU work.
function prepare({userDataDir, root, entry, launchId, neuralLibraryPath = require("./neural").libraryPath, ...options}) {
  if (!path.isAbsolute(userDataDir || "")) throw new Error("The graphics data directory is unavailable.");
  userDataDir = fs.realpathSync(userDataDir);
  const modelRoots = {};
  for (const [kind, name] of Object.entries(stores)) {
    const directory = path.join(userDataDir, "runtimes", name);
    // Reserve only owned path names. Model import creates these directories;
    // later live preparation revalidates their canonical identity and contents.
    Writable.assertOwnDirectory(userDataDir, directory, {create: false});
    modelRoots[kind] = directory;
  }
  const library = neuralLibraryPath(root, options);
  let temporal;
  try{
    const manifest=require("./runtime-record").read(root),methods=manifest.features?.graphics?.temporalMethods||[];
    const reserved=require("./temporal/providers").reserve(root,options,methods,manifest.files||[]);
    temporal={methods:[...methods.filter(method=>["metalfx","metalfx-denoised"].includes(method)),...Object.keys(reserved.providers)],providers:reserved.providers,environment:reserved.environment};
  }catch{} // Optional provider installation cannot disable independent images.
  const xess=entry?require("./xess").reserve({...options,userDataDir,root,launchId,directory:path.dirname(require("./live-controls").file(entry,userDataDir))}):null;
  const resources = {schema: 1, modelRoots, neuralLibrary: library,...(temporal?{temporal:{methods:temporal.methods,providers:temporal.providers}}:{}),...(xess?{xess}:{})};
  return {resources, environment: {
    RESHADE_EFFECT_MODEL_ROOTS: JSON.stringify(Object.values(modelRoots)),
    ...(temporal?.environment||{}),
    ...(xess?xess.environment:{}),
    ...(library ? {RESHADE_NEURAL_LIBRARY: library, RESHADE_NEURAL_ROOT: path.dirname(library)} : {})
  }};
}

function allowsModel(resources, file, kind) {
  if (resources?.schema !== 1 || !Object.hasOwn(stores, kind) || typeof file !== "string" || !path.isAbsolute(file) || /[\0\r\n]/.test(file)) return false;
  const root = resources.modelRoots?.[kind];
  if (typeof root !== "string" || !path.isAbsolute(root) || path.basename(root) !== stores[kind]) return false;
  try {
    if (fs.realpathSync(root) !== root || !within(root, file) || fs.realpathSync(file) !== file) return false;
    const stat = fs.lstatSync(file);
    if (kind === "neural" ? !stat.isDirectory() : !stat.isFile()) return false;
    Writable.assertOwnDirectory(root, kind === "neural" ? file : path.dirname(file), {create: false});
    return true;
  } catch { return false; }
}

module.exports = {prepare, allowsModel, supportsHost, supported};
