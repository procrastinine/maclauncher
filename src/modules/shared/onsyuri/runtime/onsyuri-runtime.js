const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const {
  attachAbortSignal,
  createAbortError,
  throwIfAborted
} = require("../../runtime/download-utils");

const Upstream = require("../../runtime/upstream");
const Release = require("../../runtime/release-files");
const Versions = require("./onsyuri-versions");
const { createOnsyuriBundled, RECOMMENDED_VERSION } = require("./onsyuri-bundled");
const Bundled = createOnsyuriBundled();
const Hosted = require("./onsyuri-hosted").manager;

const SOURCE_URL = "https://github.com/YuriSizuku/OnscripterYuri/releases";
const INSTALL_META_FILE = ".maclauncher-onsyuri.json";

// Stable releases and prereleases: one row per Mac CPU (section "mac") and one
// for the Web build (section "web"), with GitHub's size and digest.
const source = Upstream.github({ repository: "YuriSizuku/OnscripterYuri", prerelease: true, allArchitectures: true,
  recognize: release => Versions.recognizeRelease(release) });
// Rows from releases in GitHub's shape, as earlier catalog caches hold them.
function rowsFromReleases(releases) {
  return (Array.isArray(releases) ? releases : []).flatMap(release => Versions.recognizeRelease(release).map(row => ({
    version: row.version, details: row.details, ...(row.architecture ? { architecture: row.architecture } : {}),
    files: row.assets.map(asset => Upstream.listedFile({ filename: asset.name, url: asset.browser_download_url, bytes: asset.size,
      assetId: asset.id, digest: Upstream.githubDigest(asset) })).filter(Boolean) })));
}
const sectionRows = (rows, section) => (rows || []).filter(row => row?.details?.section === section && row.files?.length);
function versionsOf(rows, section) {
  return [...new Set(sectionRows(rows, section).map(row => row.version))].sort(Versions.compareOnsyuriVersionsDesc);
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function safeRm(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {}
}

function normalizeVersion(input) {
  const v = Versions.normalizeOnsyuriVersion(input);
  if (!v) {
    throw new Error(`Invalid onsyuri version: ${String(input ?? "")}`);
  }
  return v;
}

function normalizeMacVersion(input) {
  const version = Versions.normalizeOnsyuriMacVersion(input);
  if (!version) throw new Error(`Invalid Onsyuri Mac version: ${String(input ?? "")}`);
  return version;
}

function normalizeVariant(input) {
  const v = String(input ?? "").toLowerCase();
  if (v === "arm64") return "arm64";
  if (v === "x64") return "x64";
  if (!v) return "";
  return v;
}

function installRootDir(userDataDir) {
  return path.join(userDataDir, "runtimes", "onsyuri");
}

function getMacInstallDir({ userDataDir, version, variant }) {
  const v = normalizeMacVersion(version);
  const arch = normalizeVariant(variant) || "x64";
  return path.join(installRootDir(userDataDir), "mac", v, arch);
}

function getWebInstallDir({ userDataDir, version }) {
  const v = normalizeVersion(version);
  return path.join(installRootDir(userDataDir), "web", v);
}

function metaPath(installDir) {
  return path.join(installDir, INSTALL_META_FILE);
}

function readInstallMeta(installDir) {
  try {
    const p = metaPath(installDir);
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function writeInstallMeta(installDir, payload) {
  try {
    const p = metaPath(installDir);
    ensureDir(path.dirname(p));
    fs.writeFileSync(p, JSON.stringify(payload, null, 2));
  } catch {}
}

function listInstalledMac(userDataDir, { verification = "full" } = {}) {
  const root = path.join(installRootDir(userDataDir), "mac");
  const out = [];
  let versions = [];
  try {
    versions = fs.readdirSync(root, { withFileTypes: true });
  } catch {}

  for (const versionDir of versions) {
    if (!versionDir.isDirectory()) continue;
    const versionRaw = versionDir.name;
    const version = Versions.normalizeOnsyuriMacVersion(versionRaw);
    if (!version) continue;
    let archEntries = [];
    try {
      archEntries = fs.readdirSync(path.join(root, versionRaw), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const archDir of archEntries) {
      if (!archDir.isDirectory()) continue;
      const variant = archDir.name;
      const installDir = path.join(root, versionRaw, variant);
      if (Bundled.isBundle(installDir)) {
        try {
          const installed = Bundled.resolve({ userDataDir, version, variant, verification });
          out.push(installed ? { ...installed, ready: true } : { version, variant, installDir, source: "bundled", ready: false,
            error: "Onsyuri runtime package changed or is incomplete." });
        } catch (error) { out.push({ version, variant, installDir, source: "bundled", ready: false, error: error.message }); }
        continue;
      }
      const meta = readInstallMeta(installDir);
      if (!meta && !fs.existsSync(path.join(installDir, "onsyuri"))) continue;
      // The executable recorded at install, wherever the release placed it.
      const recorded = typeof meta?.binaryPath === "string" && !path.isAbsolute(meta.binaryPath) && !meta.binaryPath.split(/[\\/]/).includes("..")
        ? path.join(installDir, meta.binaryPath) : null;
      out.push({ version, variant, installDir, ...(recorded && fs.existsSync(recorded) ? { executablePath: recorded } : {}) });
    }
  }

  const hosted = Hosted.getState({ userDataDir });
  for (const row of hosted.installed) {
    const pin = Hosted.core.listCatalog({ userDataDir }).find(pin => pin.version === row.version);
    const variant = row.catalogEntry?.projectPackage?.arch || pin?.projectPackage?.arch;
    if (!["arm64", "x64"].includes(variant) || out.some(existing => existing.version === row.version && existing.variant === variant)) continue;
    const installed = verification === "full" && row.ready ? Hosted.core.resolveInstalled({ userDataDir, version: row.version, verification }) : row;
    out.push(installed ? { ...installed, variant, ready: row.ready } : { ...row, variant, ready: false,
      error: "Onsyuri runtime package changed or is incomplete." });
  }


  out.sort((a, b) => Versions.compareOnsyuriMacVersionsDesc(a.version, b.version));
  return out;
}

function listInstalledWeb(userDataDir) {
  const root = path.join(installRootDir(userDataDir), "web");
  const out = [];
  let versions = [];
  try {
    versions = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const versionDir of versions) {
    if (!versionDir.isDirectory()) continue;
    const versionRaw = versionDir.name;
    const version = Versions.normalizeOnsyuriVersion(versionRaw);
    if (!version) continue;
    const installDir = path.join(root, versionRaw);
    const meta = readInstallMeta(installDir);
    if (!meta && !fs.existsSync(path.join(installDir, "onsyuri-web.7z"))) continue;
    out.push({ version, installDir });
  }

  out.sort((a, b) => Versions.compareOnsyuriVersionsDesc(a.version, b.version));
  return out;
}

function runCommand(cmd, args, options) {
  const { signal, ...spawnOptions } = options || {};
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...spawnOptions, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    const removeAbort = attachAbortSignal(signal, () => {
      try {
        child.kill("SIGTERM");
      } catch {}
    });
    child.stderr.on("data", b => {
      stderr += b.toString("utf8");
    });
    child.on("error", err => {
      removeAbort();
      reject(err);
    });
    child.on("close", code => {
      removeAbort();
      if (signal?.aborted) return reject(createAbortError());
      if (code === 0) return resolve(true);
      const err = new Error(`${cmd} failed (${code})`);
      err.stderr = stderr;
      reject(err);
    });
  });
}

async function extractZip(zipPath, destDir, signal) {
  const ditto = "/usr/bin/ditto";
  await runCommand(ditto, ["-x", "-k", zipPath, destDir], { signal });
}

async function extract7z(archivePath, destDir, signal) {
  await runCommand("/usr/bin/bsdtar", ["-xf", archivePath, "-C", destDir], { signal });
}

// The executable may sit in a folder or app bundle, or carry the release name.
function findOnsyuriBinary(root) {
  return Release.locatePackaged(root, ["onsyuri", "onsyuri.app/Contents/MacOS/onsyuri", /^onsyuri(?:$|[_-])/i], { files: true });
}

function getWebArchiveType(name) {
  const lower = String(name || "").toLowerCase();
  if (lower.endsWith(".zip")) return "zip";
  if (lower.endsWith(".7z")) return "7z";
  if (/\.(?:tar\.gz|tgz|tar\.xz|txz|tar\.bz2|tbz2)$/.test(lower)) return "tar";
  return null;
}

// The listed row for a version, section and CPU. The release list is read
// again when the caller's list is empty or lacks the version.
async function listedRow({ rows, version, section, arch, logger, signal }) {
  const find = list => sectionRows(list, section).find(row => row.version === version && (!arch || row.architecture === arch)) || null;
  return (Array.isArray(rows) && find(rows)) || find(await source.discover({ logger, signal }));
}

async function fetchAvailableVersions({ logger, userDataDir, signal, sourceId } = {}) {
  if (sourceId != null && !["builds", "upstream"].includes(sourceId)) throw new Error("The ONScripter-Yuri download source is unavailable.");
  if (sourceId === "builds") {
    await Hosted.refreshCatalog({ userDataDir, logger, signal, force: true, sourceId: "builds" });
    return { rows: [], macVersions: [], webVersions: [], source: "https://github.com/procrastinine/maclauncher-builds" };
  }
  if (sourceId === "upstream") {
    const rows = await source.discover({ logger, signal });
    return { rows, macVersions: versionsOf(rows, "mac"), webVersions: versionsOf(rows, "web"), source: SOURCE_URL };
  }
  const [upstream, hosted] = await Promise.allSettled([source.discover({ logger, signal }),
    Hosted.refreshCatalog({ userDataDir, logger, signal, force: true })]);
  if (hosted.status === "rejected") throw hosted.reason;
  const rows = upstream.status === "fulfilled" ? upstream.value : [];
  return { rows, macVersions: versionsOf(rows, "mac"), webVersions: versionsOf(rows, "web"), source: SOURCE_URL,
    upstreamError: upstream.status === "rejected" ? upstream.reason.message || String(upstream.reason) : null };
}

async function installMacVersion({
  userDataDir,
  version,
  variant,
  logger,
  onProgress,
  rows,
  signal
} = {}) {
  const v = normalizeMacVersion(version);
  const arch = normalizeVariant(variant) || "x64";
  if (!["arm64", "x64"].includes(arch)) throw new Error("Unsupported Onsyuri Mac architecture.");
  if (/(?:-macos-v|-MCLv)\d+$/.test(v)) {
    let pin = Hosted.core.listCatalog({ userDataDir }).find(pin => pin.version === v && pin.projectPackage?.arch === arch);
    if (!pin) {
      await Hosted.refreshCatalog({ userDataDir, logger, signal, force: true });
      pin = Hosted.core.listCatalog({ userDataDir }).find(pin => pin.version === v && pin.projectPackage?.arch === arch);
    }
    if (!pin) throw new Error(`Onsyuri Mac ${v} is unavailable for this app and architecture.`);
    const installed = await Hosted.installRuntime({ userDataDir, version: v, logger, signal, onProgress });
    return { ...installed, variant: arch };
  }
  const row = await listedRow({ rows, version: v, section: "mac", arch, logger, signal });
  if (!row) throw new Error(`ONScripter-Yuri ${v} has no Mac download for this architecture.`);
  const file = row.files[0], downloadUrl = file.url;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-onsyuri-"));
  const name = file.name;
  const assetPath = path.join(tmpDir, name);
  const extractDir = path.join(tmpDir, "extract");
  const installDir = getMacInstallDir({ userDataDir, version: v, variant: arch });
  let binaryPath = null, downloaded = null;

  try {
    logger?.info?.(`[onsyuri] downloading ${downloadUrl}`);
    downloaded = await source.download(file, assetPath, { onProgress, signal });
    throwIfAborted(signal);
    if (Release.archiveFormat(name)) {
      ensureDir(extractDir);
      await Release.extractArchive(assetPath, extractDir, signal);
      const found = findOnsyuriBinary(extractDir);
      if (!found) throw new Error(`The ONScripter-Yuri ${v} download contains no Mac executable.`);
      safeRm(installDir);
      ensureDir(path.dirname(installDir));
      fs.cpSync(extractDir, installDir, { recursive: true, verbatimSymlinks: true });
      binaryPath = path.join(installDir, path.relative(extractDir, found));
    } else {
      safeRm(installDir);
      ensureDir(installDir);
      const dest = path.join(installDir, "onsyuri");
      fs.copyFileSync(assetPath, dest);
      binaryPath = dest;
    }
  } finally {
    safeRm(tmpDir);
  }

  if (binaryPath) {
    try {
      fs.chmodSync(binaryPath, 0o755);
    } catch {}
  }

  writeInstallMeta(installDir, {
    version: v,
    variant: arch,
    assetName: name,
    downloadUrl,
    sha256: downloaded.sha256,
    integrity: downloaded.integrity,
    binaryPath: binaryPath ? path.relative(installDir, binaryPath) : null,
    installedAt: Date.now()
  });

  return {
    version: v,
    variant: arch,
    installDir
  };
}

async function installWebVersion({
  userDataDir,
  version,
  logger,
  onProgress,
  rows,
  signal
} = {}) {
  const v = normalizeVersion(version);
  const row = await listedRow({ rows, version: v, section: "web", logger, signal });
  if (!row) throw new Error(`ONScripter-Yuri ${v} has no Web download.`);
  const file = row.files[0], downloadUrl = file.url;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-onsyuri-web-"));
  const name = file.name;
  const assetPath = path.join(tmpDir, name);
  const installDir = getWebInstallDir({ userDataDir, version: v });
  const archiveType = getWebArchiveType(name);
  let downloaded = null;

  try {
    logger?.info?.(`[onsyuri] downloading ${downloadUrl}`);
    downloaded = await source.download(file, assetPath, { onProgress, signal });
    throwIfAborted(signal);
    safeRm(installDir);
    ensureDir(installDir);
    if (archiveType === "zip") {
      await extractZip(assetPath, installDir, signal);
    } else if (archiveType) {
      await extract7z(assetPath, installDir, signal);
    } else {
      const dest = path.join(installDir, "onsyuri-web.7z");
      fs.copyFileSync(assetPath, dest);
    }
  } finally {
    safeRm(tmpDir);
  }

  writeInstallMeta(installDir, {
    version: v,
    assetName: name,
    downloadUrl,
    sha256: downloaded.sha256,
    integrity: downloaded.integrity,
    installedAt: Date.now()
  });

  return {
    version: v,
    installDir
  };
}

function uninstallMacVersion({ userDataDir, version, variant, installDir } = {}) {
  const hosted = Hosted.core.getInstallDir({ userDataDir, version });
  if (fs.existsSync(hosted) && (!installDir || path.resolve(installDir) === hosted))
    return Hosted.uninstallRuntime({ userDataDir, version });
  const target = installDir || getMacInstallDir({ userDataDir, version, variant });
  if (Bundled.isResourcePath(target)) throw new Error("Included app resources cannot be removed as runtime installations.");
  safeRm(target);
  return true;
}

function uninstallWebVersion({ userDataDir, version, installDir } = {}) {
  const target = installDir || getWebInstallDir({ userDataDir, version });
  safeRm(target);
  return true;
}

module.exports = {
  source,
  sourceUrl: SOURCE_URL,
  rowsFromReleases,
  versionsOf,
  recommendedVersion: RECOMMENDED_VERSION,
  bundled: Bundled,
  hosted: Hosted,
  installRootDir,
  listInstalledMac,
  listInstalledWeb,
  fetchAvailableVersions,
  installMacVersion,
  installWebVersion,
  uninstallMacVersion,
  uninstallWebVersion,
  normalizeVersion,
  normalizeMacVersion,
  normalizeVariant,
  __test: {
    getWebArchiveType
  }
};
