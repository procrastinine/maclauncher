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

function record({ id, arch, manifestSha256 }, lock = applicationLock()) {
  const matches = lock.packages.filter(item => item.id === id &&
    (arch === undefined || item.arch === arch) &&
    (manifestSha256 === undefined || item.manifestSha256 === manifestSha256));
  const versions = new Set(matches.map(item => item.version));
  if (!matches.length || versions.size !== 1)
    throw new Error("An included package reference must select one locked version: " + id);
  return matches[0];
}

function version(id, options = {}) {
  return record({ id, ...options }).version;
}

// ABI/source facts remain module-owned. Version fields are references, rather
// than another release selection, and resolve before consumers see the data.
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
    return { ...item, version: selected.version,
      directoryRelative: [selected.id, selected.version, selected.arch].join("/") };
  });
  if (lock === undefined) resolvedDeclarations.set(items, result);
  return result;
}

module.exports = { applicationLock, record, version, resolve, declarations };
