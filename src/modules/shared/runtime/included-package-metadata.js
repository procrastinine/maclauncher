const path = require("node:path");
const resolvedValues = new WeakMap(), resolvedDeclarations = new WeakMap();

// The app lock is the sole included-package version authority. Source tools
// read it in build/; the packaged app reads the same lock from Resources.
function applicationLock() {
  const file = __filename.split(path.sep).includes("app.asar")
    ? path.join(process.resourcesPath, "runtime-packages.json")
    : path.resolve(__dirname, "../../../../build/runtime-packages.json");
  return require(file);
}

function record({ id, arch }, lock = applicationLock()) {
  const matches = lock.packages.filter(item => item.id === id &&
    (arch === undefined || item.arch === arch));
  const versions = new Set(matches.map(item => item.version));
  if (!matches.length || versions.size !== 1)
    throw new Error("An included package reference must select one locked version: " + id);
  return matches[0];
}

function version(id, options = {}) {
  return record({ id, ...options }).version;
}

// ABI facts remain module-owned; included release identities come from the lock.
function resolve(value, lock) {
  if (lock === undefined && value && typeof value === "object" && resolvedValues.has(value)) return resolvedValues.get(value);
  const result = resolveValue(value, lock);
  if (lock === undefined && value && typeof value === "object") resolvedValues.set(value, result);
  return result;
}

function resolveValue(value, lock) {
  if (Array.isArray(value)) return value.map(item => resolve(item, lock));
  if (!value || typeof value !== "object") return value;
  if (typeof value.includedPackage === "string")
    return record({ id: value.includedPackage, arch: value.arch }, lock).version;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolve(item, lock)]));
}

function declarations(items, lock) {
  if (lock === undefined && resolvedDeclarations.has(items)) return resolvedDeclarations.get(items);
  const result = items.map(item => {
    if (item.version !== undefined) return item;
    const selected = record(item, lock);
    if (lock === undefined) {
      const file = path.join(require("./included-helpers").nativeRoot(), ".declarations", selected.asset.sha256 + ".json");
      if (require("node:fs").existsSync(file)) {
        const declaration = JSON.parse(require("./bundled-native").readRegular(file,require("./bundled-native").LIMITS.manifestBytes).bytes);
        require("./package-dependencies").assertDeclaration(declaration,selected);
        return declaration;
      }
    }
    return { id: selected.id, version: selected.version, arch: selected.arch,
      launcherArchitectures: selected.launcherArchitectures, minimumMacOS: selected.minimumMacOS,
      manifestRelative: selected.manifestRelative, manifestSha256: selected.manifestSha256,
      sourceRelative: null, sourceSha256: selected.sourceSha256,
      directoryRelative: [selected.id, selected.version, selected.arch].join("/") };
  });
  if (lock === undefined && result.every(item => item.files)) resolvedDeclarations.set(items, result);
  return result;
}

module.exports = { applicationLock, record, version, resolve, declarations };
