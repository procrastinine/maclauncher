const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const Native = require("../shared/runtime/local-native");
const { downloadToFile, fetchUrlBuffer, throwIfAborted, createAbortError } = require("../shared/runtime/download-utils");
const { runDownloadTask } = require("../shared/runtime/download-manager");
const { downloadApproved, approveDownloads } = require("../shared/runtime/tool-install");
const { readCubismArchive, LIMITS } = require("./live2d-archive");
const { requirements, validateCore } = require("./live2d-native");
const { readRpaIndex } = require("./script-config");
const Patcher = require("./runtime/patcher");
const GameData = require("../shared/game-data");
const { readRuntimeCatalog, writeRuntimeCatalog } = require("../shared/runtime/runtime-catalog");

const LIBRARY_NAME = "libLive2DCubismCore.dylib";
const SOURCE_URL = "https://www.live2d.com/en/sdk/download/native/";

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

function importLibrary(t, archivePath, { signal, expectedVersion, expectedSha256 } = {}, supplier) {
  throwIfAborted(signal);
  const archive = readCubismArchive(archivePath);
  if (expectedVersion && archive.version !== expectedVersion || expectedSha256 && archive.archiveSha256 !== expectedSha256) throw new Error("Official Cubism archive identity/checksum does not match the selected version.");
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
        memberPath: archive.memberPath, sourceUrl: supplier?.url || SOURCE_URL, officialArchive: !!supplier,
        publisherDigestVerified: !!supplier?.sha256 && supplier.sha256 === archive.archiveSha256,
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

function supplierRow(row) {
  return row && /^[0-9]+-r\.[0-9]+(?:\.[0-9]+)*$/.test(row.version || "") &&
    row.url === `https://cubism.live2d.com/sdk-native/bin/CubismSdkForNative-${row.version}.zip` &&
    (!row.sha256 || /^[a-f0-9]{64}$/.test(row.sha256));
}
async function supplierCatalog({ signal, dependencies }) {
  const fetch = async url => {
    const response = await (dependencies.fetchUrlBuffer || fetchUrlBuffer)(url, { signal, maxBytes: 2 * 1024 ** 2 });
    throwIfAborted(signal);
    if (response.status !== 200 || !Buffer.isBuffer(response.body) || response.body.length > 2 * 1024 ** 2)
      throw new Error("The official Cubism SDK download catalog is unavailable.");
    return response.body.toString("utf8");
  };
  const page = await fetch(SOURCE_URL), rows = new Map();
  const add = (version, url) => {
    const row = { version, url };
    if (!supplierRow(row)) return;
    rows.set(version, row);
    if (rows.size > 64) throw new Error("The Cubism SDK supplier catalog exceeds its limit.");
  };
  for (const match of page.matchAll(/https:\/\/cubism\.live2d\.com\/sdk-native\/bin\/CubismSdkForNative-([0-9]+-r\.[0-9]+(?:\.[0-9]+)*)\.zip/g)) add(match[1], match[0]);
  const scriptUrl = "https://cubism.live2d.com/sdk-native/js/download.js";
  if (page.includes(scriptUrl)) {
    const script = await fetch(scriptUrl);
    if (!/\bFILE_BASE_URL\s*=\s*["']https:\/\/cubism\.live2d\.com\/sdk-native\/bin\/["']/.test(script))
      throw new Error("The Cubism SDK supplier catalog has an unknown download origin.");
    for (const match of script.matchAll(/\burl\s*:\s*["'](CubismSdkForNative-([0-9]+-r\.[0-9]+(?:\.[0-9]+)*)\.zip)["']/g))
      add(match[2], "https://cubism.live2d.com/sdk-native/bin/" + match[1]);
  }
  if (!rows.size) throw new Error("The official Cubism page has no SDK for Native download links.");
  return [...rows.values()];
}
async function downloadLibrary(t, { userDataDir, downloads, signal, logger, confirmRuntimeInstall, libraryVersion, dependencies = {} } = {}) {
  throwIfAborted(signal);
  return runDownloadTask(downloads, { label: `Live2D ${t.policy.apiProfile}`, managerId: "sdk", version: t.renpyVersion,
    kind: "runtime-library", detail: t.policy.apiProfile, dedupeKey: `live2d:${t.libraryPath}:${libraryVersion || t.policy.apiProfile}` }, async task => {
    const controller = new AbortController(), signals = [signal, task.signal].filter(Boolean), abort = () => controller.abort();
    for (const current of signals) { if (current.aborted) controller.abort(); else current.addEventListener("abort", abort, { once: true }); }
    const plan = row => ({ managerId: "sdk", version: t.renpyVersion, label: `Live2D ${row?.version || t.policy.apiProfile} for Ren'Py`,
      libraryVersion: row?.version || libraryVersion || null, sourceUrl: row?.url || SOURCE_URL, requiresDownload: true,
      recommendedVersion: t.policy.recommendedVersion,
      licenseRequired: true, detail: `Required Core API: ${t.policy.apiProfile}. Live2D license terms apply.`,
      installOptions: { major: t.policy.major, sectionId: t.policy.major === 7 ? "v7" : "v8" } });
    const candidates = rows => rows.filter(row => row.version === (libraryVersion || t.policy.recommendedVersion));
    function cachedArchive(row) {
      const directory = path.join(userDataDir, "runtimes", "live2d", row.version), archivePath = path.join(directory, `CubismSdkForNative-${row.version}.zip`);
      try {
        const receiptPath = path.join(directory, "archive.json");
        if (regular(receiptPath).size > 65536) return null;
        const receipt = JSON.parse(fs.readFileSync(receiptPath));
        regular(archivePath); secureDirectory(fs.realpathSync(userDataDir), directory);
        if (receipt.version !== row.version || receipt.url !== row.url || !/^[a-f0-9]{64}$/.test(receipt.sha256 || "") ||
            row.sha256 && row.sha256 !== receipt.sha256 || Native.hashFile(archivePath) !== receipt.sha256) return null;
        return { archivePath, sha256: receipt.sha256 };
      } catch { return null; }
    }
    try {
      throwIfAborted(controller.signal);
      let rows = readRuntimeCatalog({ userDataDir, managerId: "live2d", maxEntries: 64, validateEntry: supplierRow })?.entries || [];
      rows = candidates(rows);
      for (const row of rows) {
        const cached = cachedArchive(row); if (!cached) continue;
        return importLibrary(t, cached.archivePath, { signal: controller.signal, expectedVersion: row.version, expectedSha256: cached.sha256 }, row);
      }
      let approved = false;
      if (!rows.length) {
        if (!await downloadApproved({ confirmRuntimeInstall }, plan())) throw createAbortError("Live2D download canceled.");
        approved = true; throwIfAborted(controller.signal);
        rows = await supplierCatalog({ signal: controller.signal, dependencies });
        fs.mkdirSync(userDataDir, { recursive: true }); secureDirectory(fs.realpathSync(userDataDir), path.join(fs.realpathSync(userDataDir), "runtimes", "live2d"), true);
        writeRuntimeCatalog({ userDataDir, managerId: "live2d", source: SOURCE_URL, entries: rows, maxEntries: 64 });
        rows = candidates(rows);
      }
      if (!rows.length) throw new Error("The requested Cubism SDK is absent from the official supplier catalog.");
      for (const row of rows) {
        throwIfAborted(controller.signal);
        let cached = cachedArchive(row);
        if (!cached) {
          if (!approved && !await downloadApproved({ confirmRuntimeInstall }, plan(row))) throw createAbortError("Live2D download canceled.");
          approved = false; throwIfAborted(controller.signal);
          fs.mkdirSync(userDataDir, { recursive: true }); const userRoot = fs.realpathSync(userDataDir);
          const directory = secureDirectory(userRoot, path.join(userRoot, "runtimes", "live2d", row.version), true);
          const archivePath = path.join(directory, `CubismSdkForNative-${row.version}.zip`), temporary = path.join(directory, `.download-${randomUUID()}.zip`);
          try {
            logger?.info?.(`[renpy] download Live2D ${row.version} from ${row.url}`);
            await (dependencies.downloadToFile || downloadToFile)(row.url, temporary, { signal: controller.signal, onProgress: progress => {
              if (progress.downloaded > LIMITS.archive || progress.total > LIMITS.archive) controller.abort(); task.onProgress?.(progress);
            } });
            throwIfAborted(controller.signal); const archive = readCubismArchive(temporary);
            if (archive.version !== row.version || row.sha256 && row.sha256 !== archive.archiveSha256) throw new Error("Official Cubism archive identity/checksum does not match the selected version.");
            fs.renameSync(temporary, archivePath);
            atomicBytes(path.join(directory, "archive.json"), Buffer.from(JSON.stringify({ version: row.version, url: row.url, sha256: archive.archiveSha256 })));
            cached = { archivePath, sha256: archive.archiveSha256 };
          } finally { fs.rmSync(temporary, { force: true }); }
        }
        return importLibrary(t, cached.archivePath, { signal: controller.signal, expectedVersion: row.version, expectedSha256: cached.sha256 }, row);
      }
    } finally { for (const current of signals) current.removeEventListener("abort", abort); }
  });
}
function sdkTarget(install) { return target({ rootDir: install.installDir, renpyVersion: install.runtimeVersion || install.version }); }
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
  // Selecting Install Live2D authorizes its download.
  if (payload.installedActionId === "installLive2D") return downloadLibrary(t, { ...payload, confirmRuntimeInstall: approveDownloads });
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

module.exports = { SOURCE_URL, requirements, sdkTarget, describeSdk, performSdkAction, gameStatus, patchGame, removeGame,
  detectModels, ensureSdkLibrary, target, status, importLibrary, removeLibrary, downloadLibrary };
