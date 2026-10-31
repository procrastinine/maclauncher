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
// A version can offer both a Universal in-process package and a smaller native
// package. Include one compatible build per version, preferring the app's CPU.
function preferredIncludedBuilds(declarations, arch = process.arch) {
  if (!Array.isArray(declarations)) throw new Error("Included helper declarations are invalid.");
  const host = launcherArch(arch), selected = new Map();
  const rank = item => item.arch === host ? 0 : item.arch === "universal" ? 1 : 2;
  for (const item of declarations) {
    if (!Array.isArray(item?.launcherArchitectures) || !item.launcherArchitectures.includes(host)) continue;
    const key = JSON.stringify([item.id || item.managerId, item.version]), previous = selected.get(key);
    if (!previous || rank(item) < rank(previous)) selected.set(key, item);
  }
  return [...selected.values()];
}
function declared(declarations, { id, version, arch = process.arch } = {}) {
  if (!Array.isArray(declarations)) throw new Error("Included helper declarations are invalid.");
  const host = launcherArch(arch);
  return preferredIncludedBuilds(declarations, host).find(item => item.id === id &&
    (version === undefined || item.version === version)) || null;
}
const MAC_NAMES = Object.freeze({ arm64: "a Mac with Apple Silicon", x64: "an Intel Mac" });
// Helpers are published for specific launcher CPUs, and each app includes the
// builds for its own CPU. When a declared helper has no build for this Mac, the
// features that need it report the Mac they require instead of a missing file.
function hostRequirement(declarations, { id, arch = process.arch } = {}) {
  if (!Array.isArray(declarations)) throw new Error("Included helper declarations are invalid.");
  const host = launcherArch(arch), byId = new Map();
  for (const item of declarations) {
    if (!item || id !== undefined && item.id !== id) continue;
    const architectures = Array.isArray(item.launcherArchitectures) ? item.launcherArchitectures : [];
    byId.set(item.id, [...(byId.get(item.id) || []), ...architectures]);
  }
  const missing = [...byId].filter(([, architectures]) => !architectures.includes(host));
  if (!missing.length) return null;
  const supported = ["arm64", "x64"].filter(value => missing.every(([, architectures]) => architectures.includes(value)));
  const message = supported.length ? `Requires ${supported.map(value => MAC_NAMES[value]).join(" or ")}.` : "Unavailable on this Mac.";
  return { ids: missing.map(([name]) => name), architectures: supported, message };
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
/** resolveIncluded for a helper a feature cannot work without. */
function requireIncluded(declarations, options = {}) {
  const included = resolveIncluded(declarations, options);
  if (included) return included;
  const requirement = hostRequirement(declarations, options);
  if (requirement) throw Object.assign(new Error(requirement.message), { code: "HOST_ARCHITECTURE_UNSUPPORTED" });
  throw new Error(`The included ${options.id} is missing. Reinstall MacLauncher.`);
}

module.exports = { SOURCE_RESOURCES, isPackaged, resourcesRoot, nativeRoot, preferredIncludedBuilds, declared, hostRequirement, resolveIncluded, requireIncluded };
