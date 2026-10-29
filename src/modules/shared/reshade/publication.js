const fs = require("node:fs"), path = require("node:path");
const Native = require("../runtime/bundled-native");
const warnGraphics = require("../graphics-warning");
const rawFs = (() => {
  try { return require("original-fs"); }
  catch (error) { if (error.code !== "MODULE_NOT_FOUND") throw error; return fs; }
})();
const metadata = stat => [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
function checkedManifest(value) {
  const manifest = structuredClone(value);
  if (manifest?.id !== "reshade" || typeof manifest.version !== "string" || !manifest.version ||
      !/^[a-f0-9]{64}$/.test(manifest.manifestSha256 || "") || !Array.isArray(manifest.files) ||
      !manifest.files.length || manifest.files.length > 20000) throw new Error("The graphics runtime declaration is invalid.");
  Native.relativeFile(manifest.directoryRelative);Native.relativeFile(manifest.manifestRelative);
  const names = new Set();
  for (const row of manifest.files) {
    Native.relativeFile(row.path);
    if (names.has(row.path) || !Number.isSafeInteger(row.size) || row.size < 0 || !/^[a-f0-9]{64}$/.test(row.sha256 || ""))
      throw new Error("The graphics runtime file declaration is invalid.");
    names.add(row.path);if (row.architectures) Object.freeze(row.architectures);Object.freeze(row);
  }
  Object.freeze(manifest.files);return Object.freeze(manifest);
}

function createReader(file = path.join(__dirname, "distribution-supplementals.json"), logger = console, trustedResourceRoots = []) {
  let accepted, warnedIdentity;
  const roots = new Map(), admitted = new Set(), resourceBases = new Set();
  const rootIdentity = root => {
    const absolute = path.resolve(root);
    try { return fs.realpathSync(absolute); } catch { return absolute; }
  };
  for (const base of trustedResourceRoots.filter(Boolean)) resourceBases.add(rootIdentity(base));
  const identity = () => {
    const stat = fs.lstatSync(file, {bigint: true});
    if (!stat.isFile() || stat.size > 2n * 1024n * 1024n)
      throw new Error("The graphics runtime declaration is unavailable.");
    // Electron creates a fresh virtual inode for each ASAR stat. Observe the
    // physical container (and an unpacked member, when present) instead.
    const absolute = path.resolve(file);
    for (let start = 0, end; (end = absolute.indexOf(".asar" + path.sep, start)) !== -1; start = end + 6) {
      const archive = absolute.slice(0, end + 5);
      let container;
      try { container = rawFs.lstatSync(archive, {bigint: true}); }
      catch (error) { if (["ENOENT", "ENOTDIR"].includes(error.code)) continue; throw error; }
      if (!container.isFile()) continue;
      const member = archive + ".unpacked" + path.sep + absolute.slice(end + 6);
      let unpacked = "";
      try {
        const physical = rawFs.lstatSync(member, {bigint: true});
        if (!physical.isFile()) throw new Error("The graphics runtime declaration is unavailable.");
        unpacked = metadata(physical);
      }
      catch (error) { if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error; }
      return [metadata(container), stat.size, unpacked].join(":");
    }
    return metadata(stat);
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
    if (!roots.has(key)) {
      if ([...resourceBases].some(base => key.startsWith(path.join(base, "native-runtimes", "reshade") + path.sep)))
        return restoreSealed(key).manifest;
      bind(root);
    }
    return roots.get(key);
  }
  function resolveRoot(resourceRoots) {
    const manifest = current();
    for (const base of resourceRoots.filter(Boolean)) resourceBases.add(rootIdentity(base));
    const candidates = resourceRoots.filter(Boolean).map(root => path.join(root, "native-runtimes", manifest.directoryRelative));
    const root = candidates.find(root => fs.existsSync(path.join(root, "runtime.json"))) || candidates[0];
    admitted.add(rootIdentity(root));return bind(root, manifest);
  }
  function snapshot(root) {
    const key = rootIdentity(root);
    return admitted.has(key) && roots.has(key) ? Object.freeze({root: key, manifest: roots.get(key)}) : null;
  }
  function restore(root, value) {
    const manifest = checkedManifest(value), key = rootIdentity(root);
    if (![...resourceBases].some(base => key.startsWith(path.join(base, "native-runtimes") + path.sep) && rootIdentity(path.join(base, "native-runtimes", manifest.directoryRelative)) === key))
      throw new Error("The running graphics payload is outside the trusted application resources.");
    const record = Native.readRegular(path.join(key, manifest.manifestRelative), 2 * 1024 * 1024);
    if (record.sha256 !== manifest.manifestSha256) throw new Error("The running graphics runtime declaration changed.");
    const core = manifest.files.find(row => row.path === "libreshade-macos.dylib");
    if (!core) throw new Error("The running graphics payload has no core library.");
    const bytes = Native.readRegular(path.join(key, core.path), core.size);
    if (bytes.size !== core.size || bytes.sha256 !== core.sha256) throw new Error("The running graphics core changed.");
    const previous = roots.get(key);
    if (admitted.has(key) && previous && JSON.stringify(previous) !== JSON.stringify(manifest))
      throw new Error("The running graphics payload declaration changed.");
    roots.set(key, admitted.has(key) && previous ? previous : manifest);admitted.add(key);return snapshot(key);
  }
  function restoreSealed(root) {
    const key = rootIdentity(root), existing = snapshot(key);if (existing) return existing;
    const base = [...resourceBases].find(base => key.startsWith(path.join(base, "native-runtimes", "reshade") + path.sep));
    if (!base) throw new Error("The mapped graphics payload is outside the trusted application resources.");
    const relative = path.relative(path.join(base, "native-runtimes"), key).split(path.sep).join("/");
    const parts = relative.split("/");
    if (parts.length !== 3 || parts[0] !== "reshade") throw new Error("The mapped graphics payload has an invalid location.");
    const file = path.join(key, "runtime.json"), bytes = Native.readRegular(file, 2 * 1024 * 1024), record = JSON.parse(bytes.bytes.toString("utf8"));
    if (record.schema !== 1 || record.version !== parts[1] || !Array.isArray(record.files)) throw new Error("The mapped graphics payload is not sealed.");
    return restore(key, {id: "reshade", version: record.version, directoryRelative: relative, manifestRelative: "runtime.json",
      manifestSha256: bytes.sha256, files: [{path: "runtime.json", size: bytes.size, sha256: bytes.sha256, mode: bytes.mode}, ...record.files]});
  }
  return {current, forRoot, resolveRoot, snapshot, restore, restoreSealed};
}

module.exports = {...createReader(undefined, console, [process.resourcesPath, path.resolve(__dirname, "../../../resources")]), createReader};
