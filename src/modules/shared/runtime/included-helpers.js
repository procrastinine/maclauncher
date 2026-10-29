const path = require("node:path");
const B = require("./bundled-native");

// Included helpers resolve only from their packaging declarations and only
// inside the application's resource tree: Resources in the packaged app, or
// src/resources for an unpackaged launcher. Managed packages never resolve here.
const SOURCE_RESOURCES = path.resolve(__dirname, "../../../resources");

function isPackaged(file = __filename) {
  return file.split(path.sep).includes("app.asar");
}
function resourcesRoot({ packaged = isPackaged(), resourcesPath = process.resourcesPath } = {}) {
  if (!packaged) return SOURCE_RESOURCES;
  if (typeof resourcesPath !== "string" || !path.isAbsolute(resourcesPath)) throw new Error("The application resources are unavailable.");
  return resourcesPath;
}
function nativeRoot(root = resourcesRoot()) {
  if (typeof root !== "string" || !path.isAbsolute(root)) throw new Error("Included helpers need an absolute resource directory.");
  return path.join(root, "native-runtimes");
}
function launcherArch(arch = process.arch) {
  if (!["arm64", "x64"].includes(arch)) throw new Error("Included helpers support Apple Silicon and Intel Macs.");
  return arch;
}
function declared(declarations, { id, version, arch = process.arch } = {}) {
  if (!Array.isArray(declarations)) throw new Error("Included helper declarations are invalid.");
  const host = launcherArch(arch);
  return declarations.find(item => item?.id === id && (version === undefined || item.version === version) &&
    Array.isArray(item.launcherArchitectures) && item.launcherArchitectures.includes(host)) || null;
}
/** The declared directory and sealed manifest; "full" also verifies every declared file. */
function resolveIncluded(declarations, { id, version, arch, resourcesRoot: root, verification = "status" } = {}) {
  if (!["status", "full"].includes(verification)) throw new Error("Choose status or full included helper verification.");
  const item = declared(declarations, { id, version, arch });
  if (!item) return null;
  const directory = path.join(nativeRoot(root), B.relativeFile(item.directoryRelative));
  let stored;
  try { stored = B.readRegular(path.join(directory, B.relativeFile(item.manifestRelative)), B.LIMITS.manifestBytes); }
  catch (error) { throw new Error(`The included ${id} ${item.version} is missing. Reinstall MacLauncher.`, { cause: error }); }
  if (stored.sha256 !== item.manifestSha256) throw new Error(`The included ${id} ${item.version} manifest changed. Reinstall MacLauncher.`);
  if (verification === "full") B.verifyPayload(directory, item);
  return { item, directory, manifestPath: path.join(directory, item.manifestRelative), manifest: stored };
}

module.exports = { SOURCE_RESOURCES, isPackaged, resourcesRoot, nativeRoot, declared, resolveIncluded };
