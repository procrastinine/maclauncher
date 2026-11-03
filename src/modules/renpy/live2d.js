const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const Native = require("../shared/runtime/local-native");
const { throwIfAborted, createAbortError } = require("../shared/runtime/download-utils");
const Upstream = require("../shared/runtime/upstream");
const { compareVersions } = require("../shared/runtime/version-order");
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
      try { if (archive.license) {
        fs.mkdirSync(path.join(t.metadataDir, "licenses"), { recursive: true });
        atomicBytes(path.join(t.metadataDir, "licenses", "Cubism.txt"), archive.license);
      } }
      catch (error) { console.warn("The optional Cubism notice could not be copied:", error.message); }
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
    for (const name of ["record.json", ...(record.backup ? ["original.dylib"] : [])]) fs.unlinkSync(path.join(t.metadataDir, name));
    fs.rmSync(path.join(t.metadataDir, "licenses"), { recursive: true, force: true });
    return { removed: true, restoredOriginal: !!record.backup, targetPath: t.libraryPath };
  });
}

// A Cubism SDK for Native archive on one of Live2D's hosts, named after its version.
const SDK_FILE = /CubismSdkForNative-([0-9][0-9A-Za-z._-]*?)\.zip/;
function liveHost(url) {
  try { const { protocol, hostname } = new URL(url); return protocol === "https:" && (hostname === "live2d.com" || hostname.endsWith(".live2d.com")); }
  catch { return false; }
}
function supplierRow(row) {
  return Boolean(row && /^[0-9][0-9A-Za-z._-]*$/.test(row.version || "") && row.version.length <= 64 && liveHost(row.url) &&
    SDK_FILE.exec(new URL(row.url).pathname)?.[1] === row.version && (!row.sha256 || /^[a-f0-9]{64}$/.test(row.sha256)));
}
// Live2D's download page links each SDK archive directly or through a
// download script that names the archives below a base URL.
const source = Upstream.index({ locations: [SOURCE_URL], hosts: ["live2d.com"], parse: async ([page], { fetch: read }) => {
  const rows = new Map(), links = new RegExp(`https://[^"'\\s<>]+?/${SDK_FILE.source}`, "g");
  const add = (version, url) => { if (!rows.has(version) && rows.size < 64) rows.set(version, { version, sourceUrl: SOURCE_URL, files: [{ name: `CubismSdkForNative-${version}.zip`, url }] }); };
  for (const match of page.text.matchAll(links)) add(match[1], match[0]);
  const scripts = [...new Set([...page.text.matchAll(/<script[^>]+src\s*=\s*["']([^"']+)["']/gi)].map(match => { try { return new URL(match[1], page.url).href; } catch { return null; } })
    .filter(url => url && liveHost(url) && /sdk|download/i.test(url)))].slice(0, 8);
  for (const script of scripts) {
    const document = await read(script).catch(() => null);
    if (document?.status !== 200) continue;
    for (const match of document.text.matchAll(links)) add(match[1], match[0]);
    const base = /\bFILE_BASE_URL\s*=\s*["']([^"']+)["']/.exec(document.text)?.[1];
    if (base) for (const match of document.text.matchAll(new RegExp(`["'](${SDK_FILE.source})["']`, "g")))
      try { add(match[2], new URL(match[1], new URL(base, script)).href); } catch {}
  }
  return [...rows.values()];
} });
async function supplierCatalog({ signal, logger }) {
  const rows = (await source.discover({ signal, logger })).filter(row => row.files.length)
    .map(row => ({ version: row.version, url: row.files[0].url })).filter(supplierRow);
  if (!rows.length) throw new Error("The official Cubism page has no SDK for Native download links.");
  return rows;
}
// The SDK for an API: an exact choice stays exact. Otherwise the recommended
// version, or when Live2D no longer lists it, the newest listed version on its
// API's side of the recommendation.
function selectSupplierRows(rows, policy, libraryVersion) {
  if (libraryVersion) return rows.filter(row => row.version === libraryVersion);
  const recommended = rows.filter(row => row.version === policy.recommendedVersion);
  if (recommended.length) return recommended;
  const side = row => Math.sign(compareVersions(row.version, policy.recommendedVersion)) === (policy.newerCompatible ? 1 : -1);
  return rows.filter(side).sort((a, b) => compareVersions(b.version, a.version)).slice(0, 1);
}
async function downloadLibrary(t, { userDataDir, downloads, signal, logger, confirmRuntimeInstall, libraryVersion } = {}) {
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
    const candidates = rows => selectSupplierRows(rows, t.policy, libraryVersion);
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
        rows = await supplierCatalog({ signal: controller.signal, logger });
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
            // Live2D publishes no digest; the archive's SHA-256 is recorded.
            await source.download(Upstream.listedFile({ filename: `CubismSdkForNative-${row.version}.zip`, url: row.url }), temporary, { signal: controller.signal,
              onProgress: progress => { if (progress.downloaded > LIMITS.archive || progress.total > LIMITS.archive) controller.abort(); task.onProgress?.(progress); } });
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
  const version = context.runtimeVersion || (patch && patch.preexistingMacLib === false ? patch.sdkVersion : entry.moduleData?.version);
  const renpyVersion = String(version || "").match(/^(\d+\.\d+\.\d+)/)?.[1];
  if (!renpyVersion) throw new Error("The game's actual macOS runtime version is unknown. Patch its runtime using an explicitly selected SDK first.");
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(entry.gameId || "")) throw new Error("A valid launcher game identity is required for reversible library patches.");
  fs.mkdirSync(context.userDataDir, { recursive: true });
  const userRoot = fs.realpathSync(context.userDataDir);
  const metadataRoot = secureDirectory(userRoot, GameData.resolveGameModuleDir(userRoot, entry.gameId, "renpy"), true);
  const metadataDir = path.join(metadataRoot, "libraries", "live2d");
  return { ...target({ rootDir, renpyVersion, metadataRoot, metadataDir }), libraryPath: path.join(metadataDir, LIBRARY_NAME) };
}
function gameStatus(entry, context) {
  try { return status(gameTarget(entry, context)); } catch (error) { return { ready: false, reason: error.message }; }
}
async function patchGame(entry, payload, context) {
  const t = gameTarget(entry, context);
  const archivePath = payload?.archivePath || payload?.filePaths?.[0];
  const info = archivePath ? importLibrary(t, archivePath, payload) : await downloadLibrary(t, { ...context, ...payload });
  entry.moduleData = { ...entry.moduleData, live2dInstalled: true };
  return info;
}
function removeGame(entry, _payload, context) {
  const result = removeLibrary(gameTarget(entry, context));
  const { live2dInstalled, ...moduleData } = entry.moduleData || {};
  entry.moduleData = moduleData;
  return result;
}

function launchEnvironment(entry, context, environment = process.env) {
  if (entry.moduleData?.live2dInstalled !== true) return environment;
  const t = gameTarget(entry, context), info = status(t);
  if (!info.ready || !info.owned) throw new Error(info.reason || "The selected game Live2D library is unavailable.");
  // Ren'Py's onetime_init calls this loader lazily with a Core basename or
  // executable-relative path. Redirect that one library without changing the
  // interpreter, its original base, project, cwd or other native libraries.
  const script = "# coding: utf-8\n# MacLauncher game Live2D library binding v1\n" +
    "init -1600 python in _maclauncher_live2d:\n" +
    "    import os\n    import renpy.gl2.live2dmodel\n" +
    "    original_load = renpy.gl2.live2dmodel.load\n" +
    "    def load(name, original_load=original_load):\n" +
    "        decoded = name.decode('utf-8') if isinstance(name, bytes) else name\n" +
    "        if os.path.basename(decoded) == 'libLive2DCubismCore.dylib':\n" +
    "            name = u" + JSON.stringify(t.libraryPath) + ".encode('utf-8')\n" +
    "        return original_load(name)\n" +
    "    renpy.gl2.live2dmodel.load = load\n";
  const bootstrap = path.join(t.metadataDir, "00_maclauncher_live2d.rpy");
  if (!fs.existsSync(bootstrap) || fs.readFileSync(bootstrap, "utf8") !== script) atomicBytes(bootstrap, Buffer.from(script));
  return { ...environment, RENPY_SEARCHPATH: [environment.RENPY_SEARCHPATH, t.metadataDir].filter(Boolean).join("::") };
}

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

module.exports = { SOURCE_URL, source, requirements, sdkTarget, describeSdk, performSdkAction, gameStatus, patchGame, removeGame, launchEnvironment,
  detectModels, ensureSdkLibrary, target, status, importLibrary, removeLibrary, downloadLibrary };
