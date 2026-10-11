const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const Native = require("../shared/runtime/local-native");
const { downloadToFile, throwIfAborted, createAbortError } = require("../shared/runtime/download-utils");
const { runDownloadTask } = require("../shared/runtime/download-manager");
const { readCubismArchive, LIMITS } = require("./live2d-archive");
const { requirements, validateCore } = require("./live2d-native");
const { readRpaIndex } = require("./script-config");
const Patcher = require("./runtime/patcher");
const GameData = require("../shared/game-data");

const LIBRARY_NAME = "libLive2DCubismCore.dylib";
const SOURCE_URL = "https://www.live2d.com/en/sdk/download/native/";
const CATALOG = Object.freeze([
  { version: "5-r.5", apiProfile: "Cubism 5.3", url: "https://cubism.live2d.com/sdk-native/bin/CubismSdkForNative-5-r.5.zip", sha256: "7ff3a4bbc19c0a8728965aa522ab77eb11b252916453e68a8a78d3b71188bb12" },
  { version: "5-r.4.1", apiProfile: "Cubism 4.2–5.2", url: "https://cubism.live2d.com/sdk-native/bin/CubismSdkForNative-5-r.4.1.zip", sha256: "b71ec6bafc6578cce3b4cbbaa42a1cb51ae6eb477557932b02d22af957e733c7" }
]);

function regular(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Live2D files must be regular files without symlinks.");
  return stat;
}
function secureDirectory(root, directory, create = false) {
  const base = fs.realpathSync(root), relative = path.relative(base, path.resolve(directory));
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) throw new Error("Live2D directory escapes its owned root.");
  let current = base;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    if (!fs.existsSync(current) && create) fs.mkdirSync(current);
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Live2D directories must not contain symlinks.");
  }
  return current;
}
function target({ rootDir, renpyVersion, metadataDir, metadataRoot }) {
  const policy = requirements(renpyVersion), root = fs.realpathSync(rootDir);
  const lib = Patcher.findMacLibDir(root, policy.major);
  if (!lib) throw new Error("No macOS Ren'Py library directory exists. Patch the game's runtime first.");
  const libDir = secureDirectory(root, lib.dir), executable = path.join(libDir, "renpy");
  regular(executable);
  const architectures = Native.readMachOArchitectures(executable);
  const ownedRoot = fs.realpathSync(metadataRoot || root);
  const recordDir = path.resolve(metadataDir || path.join(root, ".maclauncher-libraries", "live2d"));
  return { rootDir: root, libDir, renpyVersion, architectures, policy, metadataRoot: ownedRoot, metadataDir: recordDir, libraryPath: path.join(libDir, LIBRARY_NAME) };
}
function readRecord(t) {
  const file = path.join(t.metadataDir, "record.json");
  if (!fs.existsSync(file)) return null;
  secureDirectory(t.metadataRoot, t.metadataDir);
  if (regular(file).size > 65536) throw new Error("Live2D install record exceeds supported bounds.");
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  if (record.schema !== 1 || record.kind !== "live2d" || record.targetPath !== t.libraryPath || !/^[a-f0-9]{64}$/.test(record.binarySha256 || "")) throw new Error("Live2D install record does not match this runtime.");
  return record;
}
function status(t) {
  try {
    const record = readRecord(t);
    if (!fs.existsSync(t.libraryPath)) return { ready: false, owned: !!record, reason: "Live2D Core is not installed.", ...t.policy, symbols: undefined };
    regular(t.libraryPath);
    const native = validateCore(t.libraryPath, t.renpyVersion, t.architectures);
    if (record && native.sha256 !== record.binarySha256) throw new Error("Live2D library changed since installation; it will not be overwritten or removed.");
    return { ready: true, owned: !!record, version: record?.cubismVersion || "unmanaged", apiProfile: native.apiProfile, sha256: native.sha256, architectures: native.architectures,
      sourceUrl: record?.sourceUrl || null, officialArchive: record?.officialArchive || false, targetPath: t.libraryPath, renpyVersion: t.renpyVersion };
  } catch (error) { return { ready: false, owned: fs.existsSync(path.join(t.metadataDir, "record.json")), reason: String(error.message || error), renpyVersion: t.renpyVersion }; }
}
function withLock(t, work) {
  secureDirectory(t.metadataRoot, t.metadataDir, true);
  const lock = path.join(t.metadataDir, ".lock");
  let fd;
  try { fd = fs.openSync(lock, "wx"); } catch (error) { if (error.code === "EEXIST") throw new Error("Another Live2D library operation is in progress."); throw error; }
  try { return work(); } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}
function atomicBytes(file, bytes, mode = 0o644) {
  const temporary = path.join(path.dirname(file), `.live2d-${randomUUID()}`);
  try { fs.writeFileSync(temporary, bytes, { flag: "wx", mode }); fs.renameSync(temporary, file); } finally { fs.rmSync(temporary, { force: true }); }
}

function importLibrary(t, archivePath, { signal, expectedVersion } = {}) {
  throwIfAborted(signal);
  const archive = readCubismArchive(archivePath), pin = CATALOG.find(item => item.version === archive.version);
  if (expectedVersion && (archive.version !== expectedVersion || !pin || archive.archiveSha256 !== pin.sha256)) throw new Error("Official Cubism archive identity/checksum does not match the selected version.");
  return withLock(t, () => {
    const candidate = path.join(t.metadataDir, `.core-${randomUUID()}.dylib`);
    let previous, changed = false, createdBackup = false;
    try {
      fs.writeFileSync(candidate, archive.bytes, { flag: "wx", mode: 0o644 });
      const native = validateCore(candidate, t.renpyVersion, t.architectures);
      const oldRecord = readRecord(t), backupPath = path.join(t.metadataDir, "original.dylib");
      if (fs.existsSync(t.libraryPath)) {
        const stat = regular(t.libraryPath);
        previous = { bytes: fs.readFileSync(t.libraryPath), mode: stat.mode & 0o777 };
        if (oldRecord && Native.hashFile(t.libraryPath) !== oldRecord.binarySha256) throw new Error("Live2D library changed since installation; refusing to overwrite it.");
      } else if (oldRecord) throw new Error("Managed Live2D library is missing. Restore it before changing this install.");
      if (oldRecord?.backup) {
        regular(backupPath);
        if (Native.hashFile(backupPath) !== oldRecord.backup.sha256) throw new Error("Live2D original-library backup changed; refusing to overwrite it.");
      } else if (!oldRecord && fs.existsSync(backupPath)) throw new Error("An unowned Live2D backup exists; refusing to replace it.");
      throwIfAborted(signal);
      let backup = oldRecord?.backup || null;
      if (!oldRecord && previous) {
        fs.writeFileSync(backupPath, previous.bytes, { flag: "wx", mode: previous.mode });
        createdBackup = true;
        backup = { sha256: Native.hashFile(backupPath), mode: previous.mode };
      }
      const record = { schema: 1, kind: "live2d", renpyVersion: t.renpyVersion, targetPath: t.libraryPath, cubismVersion: archive.version,
        apiProfile: native.apiProfile, binarySha256: native.sha256, architectures: native.architectures, archiveSha256: archive.archiveSha256,
        memberPath: archive.memberPath, sourceUrl: pin?.url || SOURCE_URL, officialArchive: !!pin && pin.sha256 === archive.archiveSha256,
        backup, installedAt: new Date().toISOString() };
      atomicBytes(t.libraryPath, archive.bytes); changed = true;
      atomicBytes(path.join(t.metadataDir, "LICENSE.md"), archive.license);
      atomicBytes(path.join(t.metadataDir, "record.json"), Buffer.from(JSON.stringify(record, null, 2)));
      return status(t);
    } catch (error) {
      if (changed) { if (previous) atomicBytes(t.libraryPath, previous.bytes, previous.mode); else fs.rmSync(t.libraryPath, { force: true }); }
      if (createdBackup) fs.unlinkSync(path.join(t.metadataDir, "original.dylib"));
      throw error;
    } finally { fs.rmSync(candidate, { force: true }); }
  });
}
function removeLibrary(t) {
  return withLock(t, () => {
    const record = readRecord(t);
    if (!record) throw new Error("No launcher-owned Live2D install exists; the game's original library is preserved.");
    regular(t.libraryPath);
    if (Native.hashFile(t.libraryPath) !== record.binarySha256) throw new Error("Live2D library changed since installation; refusing to remove it.");
    const backupPath = path.join(t.metadataDir, "original.dylib");
    if (record.backup) {
      regular(backupPath);
      if (Native.hashFile(backupPath) !== record.backup.sha256) throw new Error("Live2D original-library backup changed; refusing to restore it.");
      atomicBytes(t.libraryPath, fs.readFileSync(backupPath), record.backup.mode);
    } else fs.unlinkSync(t.libraryPath);
    for (const name of ["record.json", "LICENSE.md", ...(record.backup ? ["original.dylib"] : [])]) fs.unlinkSync(path.join(t.metadataDir, name));
    return { removed: true, restoredOriginal: !!record.backup, targetPath: t.libraryPath };
  });
}

async function downloadLibrary(t, { userDataDir, downloads, signal, logger, confirmRuntimeInstall, dependencies = {} } = {}) {
  const pin = CATALOG.find(item => item.version === t.policy.recommendedVersion);
  fs.mkdirSync(userDataDir, { recursive: true });
  const userRoot = fs.realpathSync(userDataDir);
  const cache = secureDirectory(userRoot, path.join(userRoot, "runtimes", "live2d", pin.version), true);
  const archivePath = path.join(cache, `CubismSdkForNative-${pin.version}.zip`);
  return runDownloadTask(downloads, { label: `Live2D ${pin.version}`, managerId: "sdk", version: t.renpyVersion,
    kind: "runtime-library", detail: t.policy.apiProfile, dedupeKey: `live2d:${t.libraryPath}:${pin.version}` }, async task => {
    const controller = new AbortController(), signals = [signal, task.signal].filter(Boolean);
    const abort = () => controller.abort();
    for (const current of signals) { if (current.aborted) controller.abort(); else current.addEventListener("abort", abort, { once: true }); }
    try {
      throwIfAborted(controller.signal);
      if (!fs.existsSync(archivePath) || Native.hashFile(archivePath) !== pin.sha256) {
        if (typeof confirmRuntimeInstall === "function") {
          const confirmed = await confirmRuntimeInstall({ managerId: "sdk", version: t.renpyVersion, label: `Live2D ${pin.version} for Ren'Py`,
            libraryVersion: pin.version, sourceUrl: pin.url, installOptions: { major: t.policy.major, sectionId: t.policy.major === 7 ? "v7" : "v8" } });
          if (confirmed === false) throw createAbortError("Live2D download canceled.");
        }
        throwIfAborted(controller.signal);
        logger?.info?.(`[renpy] download Live2D ${pin.version} from ${pin.url}`);
        await (dependencies.downloadToFile || downloadToFile)(pin.url, archivePath, { signal: controller.signal, onProgress: progress => {
          if (progress.downloaded > LIMITS.archive || progress.total > LIMITS.archive) controller.abort();
          task.onProgress?.(progress);
        } });
      }
      throwIfAborted(controller.signal);
      return importLibrary(t, archivePath, { signal: controller.signal, expectedVersion: pin.version });
    } finally { for (const current of signals) current.removeEventListener("abort", abort); }
  });
}
function sdkTarget(install) { return target({ rootDir: install.installDir, renpyVersion: install.version }); }
function describeSdk(install) {
  try {
    const t = sdkTarget(install), info = status(t);
    return { libraries: { live2d: info }, actions: [
      { id: "installLive2D", label: `Install Live2D ${t.policy.apiProfile.replace("Cubism ", "")}`, available: true, sourceUrl: SOURCE_URL },
      { id: "importLive2D", label: "Import Live2D ZIP", available: true, inputKind: "file", extensions: ["zip"], sourceUrl: SOURCE_URL },
      { id: "removeLive2D", label: "Remove Live2D", available: info.owned, sourceUrl: SOURCE_URL }
    ] };
  } catch (error) { return { libraries: { live2d: { ready: false, reason: error.message } }, actions: [] }; }
}
async function performSdkAction(install, payload = {}) {
  const t = sdkTarget(install);
  if (payload.installedActionId === "installLive2D") return downloadLibrary(t, payload);
  if (payload.installedActionId === "importLive2D") {
    const archivePath = payload.archivePath || payload.filePaths?.[0];
    if (!archivePath) throw new Error("Choose a Cubism SDK for Native ZIP.");
    return importLibrary(t, archivePath, payload);
  }
  if (payload.installedActionId === "removeLive2D") return removeLibrary(t);
  throw new Error("Unknown Ren'Py installed SDK action.");
}
function gameTarget(entry, context) {
  if (String(entry.gamePath || "").toLowerCase().endsWith(".app")) throw new Error("Prepare a separate game directory before changing a signed app's libraries.");
  const rootDir = entry.contentRootDir || entry.gamePath;
  const patch = Patcher.readPatchMeta(context.userDataDir, entry.gameId);
  const version = patch && patch.preexistingMacLib === false ? patch.sdkVersion : entry.moduleData?.version;
  const renpyVersion = String(version || "").match(/^(\d+\.\d+\.\d+)/)?.[1];
  if (!renpyVersion) throw new Error("The game's actual macOS runtime version is unknown. Patch its runtime using an explicitly selected SDK first.");
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(entry.gameId || "")) throw new Error("A valid launcher game identity is required for reversible library patches.");
  fs.mkdirSync(context.userDataDir, { recursive: true });
  const userRoot = fs.realpathSync(context.userDataDir);
  const metadataRoot = secureDirectory(userRoot, GameData.resolveGameModuleDir(userRoot, entry.gameId, "renpy"), true);
  return target({ rootDir, renpyVersion, metadataRoot, metadataDir: path.join(metadataRoot, "libraries", "live2d") });
}
function gameStatus(entry, context) {
  try { return status(gameTarget(entry, context)); } catch (error) { return { ready: false, reason: error.message }; }
}
async function patchGame(entry, payload, context) {
  const t = gameTarget(entry, context);
  const archivePath = payload?.archivePath || payload?.filePaths?.[0];
  return archivePath ? importLibrary(t, archivePath, payload) : downloadLibrary(t, { ...context, ...payload });
}
function removeGame(entry, _payload, context) { return removeLibrary(gameTarget(entry, context)); }

// Bounded metadata-only discovery; packed games remain unknown rather than being
// treated as definitively free of Live2D. No scripts or game code are evaluated.
function detectModels(rootDir) {
  if (!rootDir) return { detected: false, confidence: "unknown", reason: "Game content directory is unavailable." };
  const pending = [rootDir]; let count = 0, archives = 0;
  while (pending.length && count < 10000) {
    const directory = pending.pop();
    let items; try { items = fs.readdirSync(directory, { withFileTypes: true }); } catch { continue; }
    for (const item of items) {
      if (++count > 10000) return { detected: false, confidence: "unknown", reason: "Asset inspection limit reached." };
      if (item.isSymbolicLink()) continue;
      if (item.isFile() && /\.(moc3|model3\.json)$/i.test(item.name)) return { detected: true, confidence: "exact asset name", source: path.join(directory, item.name) };
      if (item.isFile() && /\.rpa$/i.test(item.name) && ++archives <= 16) {
        const file = path.join(directory, item.name);
        try {
          for (const name of readRpaIndex(file).members.keys()) if (/\.(moc3|model3\.json)$/i.test(name)) return { detected: true, confidence: "exact archive asset name", source: `${file}!/${name}` };
        } catch { /* Protected, unsupported or oversized indexes remain unknown. */ }
      }
      if (item.isDirectory() && !["lib", "renpy", ".git", "cache", "saves"].includes(item.name) && path.relative(rootDir, directory).split(path.sep).length < 12) pending.push(path.join(directory, item.name));
    }
  }
  return { detected: false, confidence: "unknown", reason: "No model asset found in bounded loose/RPA metadata inspection." };
}
async function ensureSdkLibrary(install, options = {}) {
  const t = sdkTarget(install), info = status(t);
  if (info.ready) return info;
  if (info.owned) throw new Error(info.reason);
  const publish = typeof options.dependencies?.downloadSdkLibrary === "function"
    ? options.dependencies.downloadSdkLibrary : downloadLibrary;
  const download = () => {
    const current = status(t);
    if (current.ready) return current;
    if (current.owned) throw new Error(current.reason);
    return publish(t, options);
  };
  if (typeof options.withRuntimeMutation !== "function") return download();
  try {
    return await options.withRuntimeMutation({ managerId: "sdk", version: install.version }, download);
  } catch (error) {
    // Another game's first Play may have completed the same library while we
    // waited. Reuse its verified result without attempting another mutation.
    if (error.code === "RUNTIME_IN_USE") {
      const current = status(t);
      if (current.ready) return current;
    }
    throw error;
  }
}

module.exports = { CATALOG, SOURCE_URL, requirements, sdkTarget, describeSdk, performSdkAction, gameStatus, patchGame, removeGame,
  detectModels, ensureSdkLibrary, target, status, importLibrary, removeLibrary, downloadLibrary };
