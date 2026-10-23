const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { inspectManagedAssembly } = require("./managed-assembly");
const { writeJsonAtomic } = require("../../core/json-files");

const ABI = "fna-game-inputs-v2";
const ASSET_DIRECTORY = /^(Content|Assets|Images|Audio|Fonts|Resources)$/i;
const LIMITS = { files: 50000, bytes: 4 * 1024 ** 3, depth: 32, cacheBytes: 32 * 1024 ** 2, chunkBytes: 256 * 1024 };
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
function changedError() {
  return Object.assign(new Error("Game files changed during preparation. Try again."), { code: "SOURCE_CHANGED" });
}
function checkSignal(signal) {
  if (signal?.aborted) throw Object.assign(new Error("Game preparation cancelled."), { name: "AbortError", code: "ABORT_ERR" });
}
function identity(stat) {
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}
function regularStat(file) {
  const stat = fs.lstatSync(file, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink()) throw changedError();
  return stat;
}
function shouldCopy(file, name, options = {}) {
  if (file === options.assemblyPath || /\.(json|ini|cfg|config|xml|sav|save|dat|log|txt)$/i.test(name)) return true;
  if (options.converted && (name.toLowerCase() === "fna.dll" || /^Microsoft\.Xna\.Framework(?:\.|$)/.test(name))) return true;
  if (options.retargeted && /\.(exe|dll)$/i.test(name)) {
    try {
      const info = inspectManagedAssembly(file);
      return info.peMachine === 0x8664 && info.ilOnly && !info.requires32Bit && !info.nativeEntryPoint && !info.hasNativeManagedCode;
    } catch {}
  }
  return false;
}
function hashRegularFile(file, expected, signal) {
  checkSignal(signal);
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (identity(opened) !== expected) throw changedError();
    const size = Number(opened.size);
    if (!Number.isSafeInteger(size) || size > LIMITS.bytes) throw new Error("FNA game preparation exceeds supported bounds.");
    const hash = crypto.createHash("sha256"), buffer = Buffer.allocUnsafe(LIMITS.chunkBytes);
    let offset = 0;
    while (offset < size) {
      checkSignal(signal);
      const read = fs.readSync(descriptor, buffer, 0, Math.min(buffer.length, size - offset), offset);
      if (!read) throw changedError();
      hash.update(buffer.subarray(0, read)); offset += read;
    }
    if (identity(fs.fstatSync(descriptor, { bigint: true })) !== expected || identity(regularStat(file)) !== expected) throw changedError();
    return hash.digest("hex");
  } finally { fs.closeSync(descriptor); }
}
function cacheRecords(file, source, policy) {
  if (!file) return null;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > LIMITS.cacheBytes) return null;
    const cache = JSON.parse(fs.readFileSync(file, "utf8"));
    if (cache.abi !== ABI || cache.source !== source || cache.policy !== policy || !Array.isArray(cache.files) || cache.files.length > LIMITS.files) return null;
    const records = new Map();
    for (const item of cache.files) {
      if (!item || typeof item.path !== "string" || item.path.length > 4096 || records.has(item.path) ||
          typeof item.identity !== "string" || item.identity.length > 2048 || typeof item.copied !== "boolean" || !/^[a-f0-9]{64}$/.test(item.sha256 || "")) return null;
      records.set(item.path, item);
    }
    return { records, cache };
  } catch { return null; }
}

// Byte identity governs copied inputs; filesystem identity only decides whether
// their checksums/classification need refreshing. Linked content stays live.
function inspectSources(source, options = {}) {
  source = fs.realpathSync(source);
  if (options.assemblyPath) options = { ...options, assemblyPath: fs.realpathSync(options.assemblyPath) };
  const policy = sha(JSON.stringify([options.assemblyPath ? path.relative(source, options.assemblyPath) : null, Boolean(options.converted), Boolean(options.retargeted)]));
  const previous = cacheRecords(options.cacheFile, source, policy);
  const records = new Map(), files = new Map(), directories = new Map(), layout = [];
  const budget = { files: 0, bytes: 0 }, statistics = { hashedFiles: 0, reusedFiles: 0 };
  function visit(root, relative = "", depth = 0) {
    checkSignal(options.signal);
    if (depth > LIMITS.depth) throw new Error("FNA game directory nesting exceeds supported bounds.");
    const rootStat = fs.lstatSync(root, { bigint: true });
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw changedError();
    directories.set(root, identity(rootStat));
    for (const item of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      if (item.name === ".git" || item.name === ".DS_Store") continue;
      const file = path.join(root, item.name), name = path.join(relative, item.name);
      if (item.isSymbolicLink()) throw new Error("FNA preparation requires regular files and directories; unpack symbolic links first.");
      if (item.isDirectory()) {
        const linked = depth === 0 && ASSET_DIRECTORY.test(item.name);
        layout.push([name, linked ? "linked-directory" : "directory"]);
        if (!linked) visit(file, name, depth + 1);
      } else if (item.isFile()) {
        const stat = regularStat(file), observed = identity(stat);
        if (++budget.files > LIMITS.files || (budget.bytes += Number(stat.size)) > LIMITS.bytes) throw new Error("FNA game preparation exceeds supported bounds.");
        // Assemblies may become portable IL after an update, so classification
        // is refreshed with their bytes even when the previous file was linked.
        const inspected = file === options.assemblyPath || /\.(json|ini|cfg|config|xml|sav|save|dat|log|txt)$/i.test(item.name) ||
          options.converted && (item.name.toLowerCase() === "fna.dll" || /^Microsoft\.Xna\.Framework(?:\.|$)/.test(item.name)) ||
          options.retargeted && /\.(exe|dll)$/i.test(item.name);
        let copied = false, digest;
        if (inspected) {
          const cached = previous?.records.get(name);
          if (cached?.identity === observed) {
            copied = cached.copied; digest = cached.sha256; statistics.reusedFiles++;
          } else {
            copied = shouldCopy(file, item.name, options);
            digest = hashRegularFile(file, observed, options.signal); statistics.hashedFiles++;
          }
          const record = { path: name, identity: observed, copied, sha256: digest };
          records.set(name, record); files.set(file, record);
        }
        layout.push([name, copied ? "copied-file" : "linked-file", copied ? digest : null]);
      }
    }
  }
  visit(source);
  const result = { digest: sha(JSON.stringify([ABI, policy, layout])), records, files, directories, statistics, signal: options.signal };
  assertUnchanged(result);
  const cache = { abi: ABI, source, policy, files: [...records.values()] };
  if (options.cacheFile && JSON.stringify(previous?.cache) !== JSON.stringify(cache)) {
    if (Buffer.byteLength(JSON.stringify(cache)) > LIMITS.cacheBytes) throw new Error("FNA source inventory exceeds supported bounds.");
    checkSignal(options.signal); writeJsonAtomic(options.cacheFile, cache);
  }
  return result;
}
function assertUnchanged(inventory) {
  checkSignal(inventory.signal);
  try {
    for (const [directory, expected] of inventory.directories) {
      const stat = fs.lstatSync(directory, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink() || identity(stat) !== expected) throw changedError();
    }
    for (const [file, record] of inventory.files) if (identity(regularStat(file)) !== record.identity) throw changedError();
  } catch (error) {
    if (error.code === "ABORT_ERR") throw error;
    throw changedError();
  }
}

module.exports = { ABI, ASSET_DIRECTORY, LIMITS, shouldCopy, inspectSources, assertUnchanged, hashRegularFile, identity };
