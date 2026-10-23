const fs = require("node:fs"), path = require("node:path");
const Native = require("../runtime/bundled-native");
const warnGraphics = require("../graphics-warning");

function createReader(file = path.join(__dirname, "distribution-supplementals.json"), logger = console) {
  let accepted, warnedIdentity;
  const roots = new Map();
  const rootIdentity = root => {
    const absolute = path.resolve(root);
    try { return fs.realpathSync(absolute); } catch { return absolute; }
  };
  const identity = () => {
    const stat = fs.lstatSync(file, {bigint: true});
    if (!stat.isFile() || stat.size > 2n * 1024n * 1024n)
      throw new Error("The graphics runtime declaration is unavailable.");
    return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
  };
  function current() {
    let stamp;
    try {
      stamp = identity();
      if (accepted?.identity === stamp) return accepted.manifest;
      const rows = JSON.parse(fs.readFileSync(file, "utf8")), manifest = rows?.[0];
      if (!Array.isArray(rows) || rows.length !== 1 || manifest?.id !== "reshade" ||
          typeof manifest.version !== "string" || !manifest.version ||
          !/^[a-f0-9]{64}$/.test(manifest.manifestSha256 || "") ||
          !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 20000)
        throw new Error("The graphics runtime declaration is invalid.");
      Native.relativeFile(manifest.directoryRelative); Native.relativeFile(manifest.manifestRelative);
      for (const row of manifest.files) {
        Native.relativeFile(row.path);
        if (!Number.isSafeInteger(row.size) || row.size < 0 || !/^[a-f0-9]{64}$/.test(row.sha256 || ""))
          throw new Error("The graphics runtime file declaration is invalid.");
        if (row.architectures) Object.freeze(row.architectures);
        Object.freeze(row);
      }
      if (identity() !== stamp) throw new Error("The graphics runtime declaration changed while being read.");
      Object.freeze(manifest.files); Object.freeze(manifest);
      accepted = {identity: stamp, manifest};
      return manifest;
    } catch (error) {
      if (accepted) {
        const failedIdentity = stamp || error.code || "unreadable";
        if (warnedIdentity !== failedIdentity) {
          warnedIdentity = failedIdentity;
          warnGraphics(logger, "The updated graphics runtime declaration could not be read. The previous verified declaration remains selected.", error.message);
        }
        return accepted.manifest;
      }
      throw error;
    }
  }
  function bind(root, manifest = current()) {
    const key = rootIdentity(root);
    // An admitted immutable directory keeps its declaration through later
    // publications. Retired directories can release their snapshots lazily.
    if (!roots.has(key)) {
      if (roots.size >= 32) for (const previous of roots.keys())
        if (!fs.existsSync(path.join(previous, "runtime.json"))) roots.delete(previous);
      roots.set(key, manifest);
    }
    return root;
  }
  function forRoot(root) {
    const key = rootIdentity(root);
    if (!roots.has(key)) bind(root);
    return roots.get(key);
  }
  function resolveRoot(resourceRoots) {
    const manifest = current();
    const candidates = resourceRoots.filter(Boolean).map(root => path.join(root, "native-runtimes", manifest.directoryRelative));
    const root = candidates.find(root => fs.existsSync(path.join(root, "runtime.json"))) || candidates[0];
    return bind(root, manifest);
  }
  return {current, forRoot, resolveRoot};
}

module.exports = {...createReader(), createReader};
