const fs = require("node:fs"), path = require("node:path");
const Source = require("./source.json"), Native = require("../../runtime/bundled-native");
const DEFAULTS = Object.freeze({ modelPath: null, temporal: false, intensity: 1 });
function settings(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !Object.hasOwn(DEFAULTS, key)))
    throw new Error("Choose supported neural rendering settings.");
  const result = { ...DEFAULTS, ...value };
  if (result.modelPath !== null && (typeof result.modelPath !== "string" || !path.isAbsolute(result.modelPath) || /[\0\r\n]/.test(result.modelPath)) ||
      typeof result.temporal !== "boolean" || typeof result.intensity !== "number" || !Number.isFinite(result.intensity) || result.intensity < 0 || result.intensity > 1)
    throw new Error("Choose a local model, temporal mode and an intensity from 0 to 1.");
  return result;
}
function model(file) {
  if (typeof file !== "string" || !path.isAbsolute(file) || /[\0\r\n]/.test(file)) throw new Error("Choose a local .dlssmodel package.");
  return require("./models").inspectPackage(fs.realpathSync(file)).canonical;
}
// A dormant process needs the immutable path for future live selections. This
// is an authorization candidate, not provider discovery or compatibility proof.
// Explicit preparation validates the provider and its complete closure.
function libraryPath(root, {platform = process.platform, graphicsArchitecture = process.arch} = {}) {
  return platform === "darwin" && graphicsArchitecture === "arm64" && path.isAbsolute(root || "") ?
    path.join(root, "neural", Source.library) : null;
}
function resolve(root, { platform = process.platform, macOSVersion, graphicsArchitecture = process.arch } = {}) {
  if (platform !== "darwin" || graphicsArchitecture !== "arm64" || !Native.versionAtLeast(macOSVersion || Native.systemVersionSync(), Source.minimumMacOS)) return null;
  try {
    const directory = fs.realpathSync(path.join(root, "neural")), descriptor = JSON.parse(fs.readFileSync(path.join(directory, "provider.json"), "utf8"));
    if (descriptor.providerABI !== Source.providerABI || descriptor.commit !== Source.commit || descriptor.library !== Source.library ||
        descriptor.minimumMacOS !== Source.minimumMacOS || descriptor.architectures?.join() !== "arm64" || !Array.isArray(descriptor.files)) return null;
    const library = path.join(directory, Source.library);
    if (!fs.statSync(library).isFile()) return null;
    return { directory, library, descriptor };
  } catch { return null; }
}
function prepare(value, { root, ...options }) {
  const selected = settings(value), installed = resolve(root, options);
  if (!installed) throw new Error("The experimental neural rendering provider is unavailable for this runtime and architecture.");
  if (!selected.modelPath) throw new Error("Choose a local neural rendering model.");
  // Verify the immutable provider closure only on explicit preparation.
  for (const row of installed.descriptor.files) {
    if (typeof row.path !== "string" || path.isAbsolute(row.path) || row.path.split(/[\\/]/).some(part => !part || part === "..") || !/^[a-f0-9]{64}$/.test(row.sha256 || ""))
      throw new Error("The neural rendering provider inventory is invalid.");
    if (row.path.startsWith("notices/") || row.path === "maclauncher-neural-video" && !options.offlineVideo) continue;
    try { require("../payload-verification").verifyFile(installed.directory, row); }
    catch { throw new Error("The neural rendering provider changed. Reinstall the selected provider."); }
  }
  if (!installed.descriptor.files.some(row => row.path === Source.library)) throw new Error("The neural provider library is missing from its inventory.");
  return { settings: { ...selected, modelPath: model(selected.modelPath) }, environment: { RESHADE_NEURAL_LIBRARY: installed.library, RESHADE_NEURAL_ROOT: installed.directory } };
}
module.exports = { DEFAULTS, settings, model, libraryPath, resolve, prepare,
  listModels: userDataDir => require("./models").listInstalled(userDataDir),
  modelIdentity: (userDataDir, modelPath) => require("./models").identityForPath(userDataDir, modelPath) };
