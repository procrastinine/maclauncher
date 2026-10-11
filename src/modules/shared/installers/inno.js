const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { probeInno, installerError } = require("./inno-header");
const { runHelper } = require("./process");
const GameData = require("../game-data");
const Bundled = require("../runtime/bundled-native");
const Build = require("./runtime/innoextract-build");
const { writeJsonAtomic } = require("../../../core/json-files");

const LIMITS = Object.freeze({ files: 100000, bytes: 128 * 1024 ** 3, fileBytes: 64 * 1024 ** 3, slices: 512, path: 4096 });
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const pending = new Map();
const EXTRACTION_ABI = "inno-app-files-v1";
const SHA256 = /^[a-f0-9]{64}$/;
function identity(file) {
  const stat = fs.lstatSync(file, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink()) throw installerError("Installer files must be regular files.");
  return [stat.dev, stat.ino, stat.size, stat.mode, stat.mtimeNs, stat.ctimeNs].join(":");
}
function relative(value) {
  if (typeof value !== "string" || !value || value.length > LIMITS.path || /[\x00-\x1f\x7f]/.test(value) ||
      /^(?:[/\\]|[A-Za-z]:)/.test(value) || value.replace(/\\/g, "/").split("/").some(part => !part || part === "." || part === ".."))
    throw installerError("The installer contains an unsafe file path.");
  return value.replace(/\\/g, "/");
}
function validateMetadata(value, probe, helper) {
  if (value?.schemaVersion !== 1 || value.format !== "inno" || value.helperVersion !== helper.version || value.sourceRevision !== helper.sourceRevision ||
      value.headerOffset !== probe.headerOffset || value.dataOffset !== probe.dataOffset || value.externalData !== probe.externalData ||
      !String(value.formatVersion).startsWith(probe.formatVersion) || !Array.isArray(value.files) || !value.files.length || value.files.length > LIMITS.files ||
      !Array.isArray(value.requiredSlices) || value.requiredSlices.length > LIMITS.slices || typeof value.encrypted !== "boolean")
    throw installerError("The installer metadata does not match its header or helper.");
  if (value.encrypted) throw installerError("This installer needs a password. Use an unencrypted offline installer.", "INSTALLER_ENCRYPTED");
  const names = new Set(), directories = new Set(); let bytes = 0;
  for (const item of value.files) {
    item.path = relative(item.path);
    relative(item.authoredPath); // Validate before constant expansion or sanitizing.
    const key = item.path.normalize("NFC").toLowerCase();
    if (names.has(key) || directories.has(key) || !Number.isSafeInteger(item.size) || item.size < 0 || item.size > LIMITS.fileBytes)
      throw installerError("The installer has conflicting or invalid output files.");
    names.add(key);
    for (let dir = path.posix.dirname(key); dir !== "."; dir = path.posix.dirname(dir)) {
      if (names.has(dir)) throw installerError("The installer has conflicting output directories.");
      directories.add(dir);
    }
    if ((bytes += item.size) > LIMITS.bytes) throw installerError("The installer exceeds the extraction size limit.");
  }
  const indexes = new Set();
  for (const item of value.requiredSlices) {
    if (!Number.isInteger(item.index) || item.index < 0 || indexes.has(item.index) || !Array.isArray(item.names) || !item.names.length || item.names.length > 2 ||
        item.names.some(name => relative(name).includes("/"))) throw installerError("The installer has invalid companion data names.");
    indexes.add(item.index);
  }
  if (!probe.externalData && value.requiredSlices.length) throw installerError("The installer has inconsistent external data.");
  return { ...value, extractedBytes: bytes };
}
function resolveHelper() {
  const bundle = Bundled.createBundledNativeRuntime({ managerId: "innoextract" }).resolveRuntime({ version: Build.VERSION, upstreamRevision: Build.REVISION });
  if (!bundle) throw installerError("The included installer reader is unavailable for this Mac.", "INSTALLER_TOOL_MISSING");
  const inspector = path.join(bundle.installDir, bundle.runtimeFiles.inspector);
  return { version: Build.VERSION, sourceRevision: Build.REVISION, executable: bundle.runtimePath, inspector,
    identity: bundle.bundledManifestSha256 };
}
async function inspectInstaller(file, { signal, helper, probe = probeInno(file), onSpawn } = {}) {
  if (!probe) return null;
  helper ||= resolveHelper();
  const sourceIdentity = identity(file);
  const result = await runHelper(helper.inspector, ["--inspect-json", file], { signal, onSpawn });
  if (identity(file) !== sourceIdentity) throw installerError("The installer changed during inspection.");
  let metadata;
  try { metadata = JSON.parse(result.stdout); } catch { throw installerError("The installer reader returned invalid metadata."); }
  const info = validateMetadata(metadata, probe, helper);
  const companions = [], missing = [];
  for (const slice of info.requiredSlices) {
    const matches = slice.names.map(name => path.join(path.dirname(file), name)).filter(candidate => {
      try { identity(candidate); return true; } catch (error) { if (["ENOENT", "ENOTDIR"].includes(error.code)) return false; throw error; }
    });
    if (!matches.length) missing.push(slice.names[0]);
    else companions.push({ path: matches[0], identity: identity(matches[0]) });
  }
  return { ...info, sourcePath: file, sourceIdentity, helperIdentity: helper.identity, companions, missing };
}
function ensureDirectory(directory) { Bundled.realDirectory(directory, { create: true }); }
function readReceipt(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024) return null;
    const bytes = fs.readFileSync(file, "utf8"), address = path.basename(file).match(/^receipt-([a-f0-9]{64})\.json$/);
    if (address && sha(bytes) !== address[1]) return null;
    return JSON.parse(bytes);
  } catch { return null; }
}
function sameSources(sources) {
  try { return sources.every(item => identity(item.path) === item.identity); } catch { return false; }
}
function cacheKey(helperIdentity, sources) { return sha(JSON.stringify(["inno-cache-v1", helperIdentity, sources])); }
function contentCacheKey(helperIdentity, sources) {
  return sha(JSON.stringify(["inno-cache-v2", helperIdentity, sources.map(item => [item.size, item.sha256])]));
}
async function hashFile(file, { signal, expectedIdentity } = {}) {
  signal?.throwIfAborted();
  const before = identity(file), stat = fs.lstatSync(file), digest = crypto.createHash("sha256");
  if (expectedIdentity && before !== expectedIdentity) throw installerError("Installer data changed before verification.");
  const stream = fs.createReadStream(file, { highWaterMark: 4 * 1024 * 1024, ...(signal ? { signal } : {}) });
  for await (const bytes of stream) { signal?.throwIfAborted(); digest.update(bytes); }
  if (identity(file) !== before) throw installerError("Installer data changed during verification.");
  return { identity: before, size: stat.size, sha256: digest.digest("hex") };
}
async function helperCacheIdentity(helper, { signal } = {}) {
  // Provenance manifests still authenticate the helper. Cache compatibility
  // depends on its actual readers/ABI, not an installation path or manifest
  // presentation metadata such as dates, labels or registration details.
  const executable = await hashFile(helper.executable, { signal });
  const inspector = helper.inspector === helper.executable ? executable : await hashFile(helper.inspector, { signal });
  return sha(JSON.stringify([EXTRACTION_ABI, helper.version, helper.sourceRevision, executable.sha256, inspector.sha256]));
}
function sourceList(value, file, { content = false } = {}) {
  if (!Array.isArray(value) || !value.length || value.length > LIMITS.slices + 1) return null;
  const seen = new Set();
  for (const item of value) {
    if (!item || Object.keys(item).sort().join(",") !== (content ? "identity,path,sha256,size" : "identity,path") || typeof item.path !== "string" || !path.isAbsolute(item.path) ||
        path.dirname(item.path) !== path.dirname(file) || typeof item.identity !== "string" || !item.identity || item.identity.length > 2048 || seen.has(item.path)) return null;
    if (content && (!Number.isSafeInteger(item.size) || item.size < 0 || item.size > LIMITS.bytes || !SHA256.test(item.sha256 || ""))) return null;
    seen.add(item.path);
  }
  return value[0].path === file ? value : null;
}
function validCachedFiles(files, { hashed = false } = {}) {
  if (!Array.isArray(files) || !files.length || files.length > LIMITS.files) return false;
  const names = new Set(); let bytes = 0;
  for (const item of files) {
    try {
      if (!item || relative(item.path) !== item.path || !Number.isSafeInteger(item.size) || item.size < 0 || item.size > LIMITS.fileBytes ||
          typeof item.identity !== "string" || !item.identity || item.identity.length > 2048 || hashed && !SHA256.test(item.sha256 || "")) return false;
      const name = item.path.normalize("NFC").toLowerCase();
      if (names.has(name) || (bytes += item.size) > LIMITS.bytes) return false;
      names.add(name);
    } catch { return false; }
  }
  return true;
}
function validateCacheReceipt(receipt, index, { file, probe, helper, sourceIdentity }) {
  if (index.schemaVersion === 2) {
    const sources = sourceList(index.sources, file, { content: true });
    const legacy = receipt?.legacyGeneration;
    const generationKey = legacy ? cacheKey(legacy.helperIdentity, sourceList(legacy.sources, file) || []) : index.contentKey;
    if (!sources || index.sourceIdentity !== sources[0].identity || !SHA256.test(index.helperCacheIdentity || "") || receipt?.schemaVersion !== 2 || receipt.format !== "inno" ||
        receipt.key !== index.key || generationKey !== index.key || receipt.contentKey !== index.contentKey ||
        contentCacheKey(index.helperCacheIdentity, sources) !== index.contentKey || receipt.helperCacheIdentity !== index.helperCacheIdentity ||
        receipt.helperIdentity !== index.helperIdentity || receipt.helperVersion !== helper.version || receipt.sourceRevision !== helper.sourceRevision ||
        typeof receipt.formatVersion !== "string" || receipt.formatVersion.split(" ")[0] !== probe.formatVersion ||
        /\(unicode\)/.test(receipt.formatVersion) !== probe.unicode || JSON.stringify(receipt.sources) !== JSON.stringify(sources) ||
        !validCachedFiles(receipt.files, { hashed: true }))
      throw installerError("The installer cache metadata changed. Remove this game and add its installer again.", "INSTALLER_CACHE_INVALID");
    return receipt;
  }
  const sources = sourceList(index.sources, file);
  if (!sources || !sameSources(sources) || sources[0].identity !== sourceIdentity || cacheKey(helper.identity, sources) !== index.key ||
      receipt?.schemaVersion !== 1 || receipt.format !== "inno" || receipt.key !== index.key || receipt.helperIdentity !== helper.identity ||
      receipt.helperVersion !== helper.version || typeof receipt.formatVersion !== "string" || receipt.formatVersion.split(" ")[0] !== probe.formatVersion ||
      /\(unicode\)/.test(receipt.formatVersion) !== probe.unicode || JSON.stringify(receipt.sources) !== JSON.stringify(sources) ||
      !validCachedFiles(receipt.files))
    throw installerError("The installer cache metadata changed. Remove this game and add its installer again.", "INSTALLER_CACHE_INVALID");
  return receipt;
}
async function validateOutput(directory, expected, { signal, onProgress, cached = false } = {}) {
  const files = new Map(expected.map(item => [item.path, item])), found = []; let size = 0;
  async function walk(root, base = "") {
    signal?.throwIfAborted();
    const stat = await fs.promises.lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw installerError("Extracted directories cannot be symlinks.");
    for (const item of await fs.promises.readdir(root, { withFileTypes: true })) {
      const name = base ? base + "/" + item.name : item.name;
      relative(name);
      if (item.isDirectory()) await walk(path.join(root, item.name), name);
      else {
        if (!item.isFile() || item.isSymbolicLink() || !files.has(name)) throw installerError("The installer produced an unexpected file.");
        const expected = files.get(name), actual = await fs.promises.lstat(path.join(root, item.name));
        if (!actual.isFile() || actual.isSymbolicLink() || actual.size !== expected.size) throw installerError("Extracted installer data is incomplete.");
        const file = path.join(root, item.name), currentIdentity = identity(file);
        let contentHash = expected.sha256;
        if (!cached || expected.identity !== currentIdentity) {
          if (cached && !SHA256.test(expected.sha256 || "")) throw installerError("Cached installer data changed.");
          const checked = await hashFile(file, { signal, expectedIdentity: currentIdentity });
          if (cached && checked.sha256 !== expected.sha256) throw installerError("Cached installer data changed.");
          contentHash = checked.sha256;
        }
        found.push({ path: name, size: actual.size, identity: currentIdentity, ...(contentHash ? { sha256: contentHash } : {}) });
        files.delete(name); size += actual.size;
        if (found.length > LIMITS.files || size > LIMITS.bytes) throw installerError("Extracted installer data exceeds its limits.");
      }
    }
  }
  await walk(directory);
  if (files.size) throw installerError("The installer did not extract all expected files.");
  onProgress?.({ phase: "verifying", completed: size, total: size });
  return found;
}
async function contentSources(sources, { signal, cached = false } = {}) {
  const result = [];
  for (const source of sources) {
    signal?.throwIfAborted();
    const current = identity(source.path);
    if (cached && current === source.identity) { result.push(source); continue; }
    const content = await hashFile(source.path, { signal, expectedIdentity: current });
    if (cached && (content.size !== source.size || content.sha256 !== source.sha256)) return null;
    result.push({ path: source.path, ...content });
  }
  return result;
}
function cacheResult(file, generation, index, receipt, helper) {
  return { inputPath: path.join(generation, "files"), containerData: { format: "inno", version: receipt.formatVersion, sourcePath: file,
    key: index.key, helperVersion: helper.version, helperIdentity: helper.identity, helperCacheIdentity: index.helperCacheIdentity,
    extractedRoot: path.join(generation, "files"), sources: receipt.sources, cached: true } };
}
function receiptPath(generation, index) {
  const name = index.receiptFile || "receipt.json";
  if (name !== "receipt.json" && !/^receipt-[a-f0-9]{64}\.json$/.test(name)) throw installerError("The installer cache receipt path is invalid.", "INSTALLER_CACHE_INVALID");
  return path.join(generation, name);
}
function publishCache(cacheRoot, generation, index, receipt) {
  // Publish a complete tiny receipt before atomically changing its pointer.
  // The original receipt remains evidence, and readers never see half of a
  // source-stat refresh or schema migration across two JSON replacements.
  const bytes = JSON.stringify(receipt) + "\n", receiptFile = "receipt-" + sha(bytes) + ".json";
  const file = path.join(generation, receiptFile);
  if (fs.existsSync(file)) {
    if (fs.readFileSync(file, "utf8") !== bytes) throw installerError("Installer receipt contents changed.", "INSTALLER_CACHE_INVALID");
  } else fs.writeFileSync(file, bytes, { flag: "wx", mode: 0o600 });
  writeJsonAtomic(path.join(cacheRoot, "current.json"), { ...index, receiptFile });
}
function upgradedRecords(receipt, helper, compatibility, sources, files, { legacy = false } = {}) {
  const contentKey = contentCacheKey(compatibility, sources);
  const next = { ...receipt, schemaVersion: 2, contentKey, helperCacheIdentity: compatibility, helperIdentity: helper.identity,
    helperVersion: helper.version, sourceRevision: helper.sourceRevision, sources, files };
  if (legacy) next.legacyGeneration = { helperIdentity: receipt.helperIdentity, sources: receipt.sources };
  return { receipt: next, index: { schemaVersion: 2, key: receipt.key, contentKey, sourceIdentity: sources[0].identity,
    helperIdentity: helper.identity, helperCacheIdentity: compatibility, sources } };
}
function sameSourceMetadataWithoutInodes(old, current) {
  const left = old.split(":"), right = current.split(":");
  return left.length === 6 && right.length === 6 && left.slice(2).join(":") === right.slice(2).join(":");
}
async function prepareInstaller(file, { userDataDir, gameId, helper, signal, onProgress, onSpawn, probe, readOnly = false } = {}) {
  if (!path.isAbsolute(userDataDir || "") || !/^[0-9A-Za-z_-]+$/.test(gameId || "")) throw new Error("Installer extraction requires an owned game data directory.");
  const pendingKey = userDataDir + ":" + gameId + ":" + file;
  if (pending.has(pendingKey)) return pending.get(pendingKey);
  const work = (async () => {
    signal?.throwIfAborted();
    helper ||= resolveHelper(); probe ||= probeInno(file);
    if (!probe) return { inputPath: file, containerData: null };
    const compatibility = await helperCacheIdentity(helper, { signal });
    const sourceIdentity = identity(file), cacheRoot = path.join(GameData.resolveGameDir(userDataDir, gameId), "containers", "inno");
    Bundled.realDirectory(cacheRoot);
    const index = readReceipt(path.join(cacheRoot, "current.json"));
    if (index?.schemaVersion === 2 && SHA256.test(index.key || "") && index.helperCacheIdentity === compatibility) {
      const generation = path.join(cacheRoot, index.key), receipt = readReceipt(receiptPath(generation, index));
      if (!receipt) throw installerError("The installer cache receipt changed or is missing.", "INSTALLER_CACHE_INVALID");
      if (receipt) {
        validateCacheReceipt(receipt, index, { file, probe, helper, sourceIdentity });
        const sources = await contentSources(index.sources, { signal, cached: true });
        if (sources) {
          const files = await validateOutput(path.join(generation, "files"), receipt.files, { signal, onProgress, cached: true });
          const next = upgradedRecords(receipt, helper, compatibility, sources, files);
          if (!readOnly && JSON.stringify(next.receipt) !== JSON.stringify(receipt)) publishCache(cacheRoot, generation, next.index, next.receipt);
          onProgress?.({ phase: "ready", cached: true });
          return cacheResult(file, generation, next.index, next.receipt, helper);
        }
      }
    }
    if (index?.schemaVersion === 1 && index.helperIdentity === helper.identity && index.sourceIdentity === sourceIdentity &&
        /^[a-f0-9]{64}$/.test(index.key || "") && Array.isArray(index.sources) && sameSources(index.sources)) {
      const generation = path.join(cacheRoot, index.key), receipt = readReceipt(receiptPath(generation, index));
      if (receipt) {
        validateCacheReceipt(receipt, index, { file, probe, helper, sourceIdentity });
        await validateOutput(path.join(generation, "files"), receipt.files, { signal, cached: true });
        if (!readOnly) {
          const sources = await contentSources(receipt.sources, { signal });
          const files = await validateOutput(path.join(generation, "files"), receipt.files, { signal, onProgress });
          const next = upgradedRecords(receipt, helper, compatibility, sources, files, { legacy: true });
          publishCache(cacheRoot, generation, next.index, next.receipt);
          onProgress?.({ phase: "ready", cached: true });
          return cacheResult(file, generation, next.index, next.receipt, helper);
        }
        onProgress?.({ phase: "ready", cached: true });
        return { inputPath: path.join(generation, "files"), containerData: { format: "inno", version: receipt.formatVersion, sourcePath: file,
          key: index.key, helperVersion: helper.version, helperIdentity: helper.identity, extractedRoot: path.join(generation, "files"), sources: receipt.sources, cached: true } };
      }
    }
    if (index?.schemaVersion === 1 && index.sources?.[0]?.path === file && index.sources.every(source => {
      try { return sameSourceMetadataWithoutInodes(source.identity, identity(source.path)); } catch { return false; }
    })) {
      // Legacy receipts have no trusted byte hashes. Do not silently create a
      // second large game after inode reassignment, or reuse unverifiable data.
      throw installerError("The existing installer cache needs content verification before it can be reused.", "INSTALLER_CACHE_RECHECK_REQUIRED");
    }
    if (readOnly) throw installerError("Add this installer to unpack its game before inspecting it.", "INSTALLER_IMPORT_REQUIRED");
    onProgress?.({ phase: "inspecting", completed: 0 });
    const info = await inspectInstaller(file, { helper, probe, signal, onSpawn });
    if (info.missing.length) throw installerError(`Missing installer data: ${info.missing.join(", ")}. Put it beside ${path.basename(file)} and add the installer again.`, "INSTALLER_MISSING_PARTS");
    const inspectedSources = [{ path: file, identity: info.sourceIdentity }, ...info.companions];
    const sources = await contentSources(inspectedSources, { signal });
    if (!sameSources(inspectedSources)) throw installerError("Installer files changed during verification.");
    const key = contentCacheKey(compatibility, sources);
    ensureDirectory(cacheRoot);
    const target = path.join(cacheRoot, key), stage = path.join(cacheRoot, ".extract-" + crypto.randomBytes(12).toString("hex"));
    if (fs.existsSync(target)) throw installerError("The existing installer cache is incomplete. Remove this game and add its installer again.", "INSTALLER_CACHE_INVALID");
    ensureDirectory(stage); const output = path.join(stage, "files"); ensureDirectory(output);
    let timer;
    try {
      // The fresh private stage contains no writable links or existing files.
      const report = async () => {
        let completed = 0;
        for (const item of info.files) {
          try { const stat = await fs.promises.lstat(path.join(output, item.path)); if (stat.isFile() && !stat.isSymbolicLink()) completed += stat.size; } catch {}
        }
        onProgress?.({ phase: "extracting", completed: Math.min(completed, info.extractedBytes), total: info.extractedBytes });
      };
      onProgress?.({ phase: "extracting", completed: 0, total: info.extractedBytes });
      timer = setInterval(() => { report().catch(() => {}); }, 1000); timer.unref();
      await runHelper(helper.executable, ["--extract", "--silent", "--progress=false", "--color=false", "--collisions=error", "--exclude-temp", "--output-dir", output, file],
        { signal, timeout: 60 * 60 * 1000, maximum: 65536, onSpawn });
      clearInterval(timer);
      if (!sameSources(sources)) throw installerError("Installer files changed during extraction.");
      const files = await validateOutput(output, info.files, { signal, onProgress });
      const receipt = { schemaVersion: 2, key, contentKey: key, format: "inno", formatVersion: info.formatVersion, helperVersion: helper.version,
        sourceRevision: helper.sourceRevision, helperIdentity: helper.identity, helperCacheIdentity: compatibility, sources, files, extractedBytes: info.extractedBytes };
      fs.writeFileSync(path.join(stage, "receipt.json"), JSON.stringify(receipt) + "\n", { flag: "wx", mode: 0o600 });
      signal?.throwIfAborted();
      if (fs.existsSync(target)) throw installerError("Another extraction already owns this cache.");
      fs.renameSync(stage, target);
      const indexStage = path.join(cacheRoot, ".current-" + crypto.randomBytes(8).toString("hex"));
      fs.writeFileSync(indexStage, JSON.stringify({ schemaVersion: 2, key, contentKey: key, sourceIdentity, helperIdentity: helper.identity,
        helperCacheIdentity: compatibility, sources }) + "\n", { flag: "wx", mode: 0o600 });
      fs.renameSync(indexStage, path.join(cacheRoot, "current.json"));
      onProgress?.({ phase: "ready", cached: false, completed: info.extractedBytes, total: info.extractedBytes });
      return { inputPath: path.join(target, "files"), containerData: { format: "inno", version: info.formatVersion, sourcePath: file, key,
        helperVersion: helper.version, helperIdentity: helper.identity, helperCacheIdentity: compatibility,
        extractedRoot: path.join(target, "files"), sources, cached: false } };
    } finally { clearInterval(timer); fs.rmSync(stage, { recursive: true, force: true }); }
  })();
  pending.set(pendingKey, work);
  try { return await work; } finally { pending.delete(pendingKey); }
}

module.exports = { LIMITS, identity, relative, validateMetadata, resolveHelper, inspectInstaller, validateOutput, prepareInstaller,
  cacheKey, contentCacheKey, helperCacheIdentity, hashFile, publishCache, upgradedRecords, validateCacheReceipt, EXTRACTION_ABI };
