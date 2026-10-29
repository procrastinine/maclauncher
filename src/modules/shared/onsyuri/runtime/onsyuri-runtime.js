const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const {
  attachAbortSignal,
  createAbortError,
  downloadToFile,
  throwIfAborted
} = require("../../runtime/download-utils");

const Releases = require("../../runtime/github-releases");
const { createOnsyuriBundled, RECOMMENDED_VERSION, PREVIOUS_DEFAULT_VERSION } = require("./onsyuri-bundled");
const Bundled = createOnsyuriBundled();
const Hosted = require("./onsyuri-hosted").manager;

const REPO_OWNER = "YuriSizuku";
const REPO_NAME = "OnscripterYuri";
const INSTALL_META_FILE = ".maclauncher-onsyuri.json";

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function safeRm(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {}
}

function normalizeVersion(input) {
  const v = Releases.normalizeOnsyuriVersion(input);
  if (!v) {
    throw new Error(`Invalid onsyuri version: ${String(input ?? "")}`);
  }
  return v;
}

function normalizeMacVersion(input) {
  const version = Releases.normalizeOnsyuriMacVersion(input);
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
    const version = Releases.normalizeOnsyuriMacVersion(versionRaw);
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
      out.push({ version, variant, installDir });
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


  out.sort((a, b) => Releases.compareOnsyuriMacVersionsDesc(a.version, b.version));
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
    const version = Releases.normalizeOnsyuriVersion(versionRaw);
    if (!version) continue;
    const installDir = path.join(root, versionRaw);
    const meta = readInstallMeta(installDir);
    if (!meta && !fs.existsSync(path.join(installDir, "onsyuri-web.7z"))) continue;
    out.push({ version, installDir });
  }

  out.sort((a, b) => Releases.compareOnsyuriVersionsDesc(a.version, b.version));
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

async function extractTar(tarPath, destDir, signal) {
  await runCommand("/usr/bin/tar", ["-xzf", tarPath, "-C", destDir], { signal });
}

async function extract7z(archivePath, destDir, signal) {
  await runCommand("/usr/bin/bsdtar", ["-xf", archivePath, "-C", destDir], { signal });
}

function findOnsyuriBinary(root) {
  const direct = path.join(root, "onsyuri");
  if (fs.existsSync(direct)) return direct;
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isFile() && entry.name.toLowerCase().startsWith("onsyuri")) {
      return full;
    }
    if (entry.isDirectory()) {
      const nested = path.join(full, "onsyuri");
      if (fs.existsSync(nested)) return nested;
    }
  }
  return null;
}

function getWebArchiveType(name) {
  const lower = String(name || "").toLowerCase();
  if (lower.endsWith(".zip")) return "zip";
  if (lower.endsWith(".7z")) return "7z";
  return null;
}

function filterReleaseByVersion(releases, version) {
  const target = Releases.normalizeOnsyuriVersion(version);
  if (!target) return null;
  return (releases || []).find(rel => {
    const v = Releases.normalizeOnsyuriVersion(rel?.tag_name || rel?.name || "");
    return v === target;
  });
}

async function fetchAvailableVersions({ logger, userDataDir, signal, sourceId } = {}) {
  if (sourceId != null && !["builds", "upstream"].includes(sourceId)) throw new Error("The ONScripter-Yuri download source is unavailable.");
  if (sourceId === "builds") {
    await Hosted.refreshCatalog({ userDataDir, logger, signal, force: true, sourceId: "builds" });
    return { releases: [], macVersions: [], webVersions: [], source: "https://github.com/procrastinine/maclauncher-builds" };
  }
  if (sourceId === "upstream") {
    const releases = await Releases.fetchGithubReleases({ owner: REPO_OWNER, repo: REPO_NAME, logger, includePrerelease: true, signal });
    return { releases, macVersions: Releases.collectOnsyuriVersions(releases), webVersions: Releases.collectOnsyuriVersions(releases, { variant: "web" }),
      source: `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases` };
  }
  const [upstream, hosted] = await Promise.allSettled([Releases.fetchGithubReleases({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    logger,
    includePrerelease: true, signal
  }), Hosted.refreshCatalog({ userDataDir, logger, signal, force: true })]);
  if (hosted.status === "rejected") throw hosted.reason;
  const releases = upstream.status === "fulfilled" ? upstream.value : [];
  const macVersions = Releases.collectOnsyuriVersions(releases);
  const webVersions = Releases.collectOnsyuriVersions(releases, { variant: "web" });
  return {
    releases,
    macVersions,
    webVersions,
    source: `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases`,
    upstreamError: upstream.status === "rejected" ? upstream.reason.message || String(upstream.reason) : null
  };
}

async function installMacVersion({
  userDataDir,
  version,
  variant,
  logger,
  onProgress,
  releases,
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
  const releaseList = Array.isArray(releases)
    ? releases
    : await Releases.fetchGithubReleases({ owner: REPO_OWNER, repo: REPO_NAME, logger });
  const release = filterReleaseByVersion(releaseList, v);
  if (!release) throw new Error(`Onsyuri release v${v} not found`);
  const match = Releases.selectOnsyuriAsset([release], { arch });
  if (!match?.asset?.browser_download_url) {
    throw new Error(`No onsyuri mac asset found for v${v} (${arch})`);
  }

  const downloadUrl = match.asset.browser_download_url;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-onsyuri-"));
  const name = match.asset.name || `onsyuri-${v}-${arch}`;
  const assetPath = path.join(tmpDir, name);
  const extractDir = path.join(tmpDir, "extract");
  const installDir = getMacInstallDir({ userDataDir, version: v, variant: arch });
  const lower = name.toLowerCase();
  let binaryPath = null;

  try {
    logger?.info?.(`[onsyuri] downloading ${downloadUrl}`);
    await downloadToFile(downloadUrl, assetPath, { onProgress, signal });
    throwIfAborted(signal);
    if (lower.endsWith(".zip")) {
      ensureDir(extractDir);
      await extractZip(assetPath, extractDir, signal);
      binaryPath = findOnsyuriBinary(extractDir);
      safeRm(installDir);
      ensureDir(path.dirname(installDir));
      fs.cpSync(extractDir, installDir, { recursive: true, verbatimSymlinks: true });
    } else if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) {
      ensureDir(extractDir);
      await extractTar(assetPath, extractDir, signal);
      binaryPath = findOnsyuriBinary(extractDir);
      safeRm(installDir);
      ensureDir(path.dirname(installDir));
      fs.cpSync(extractDir, installDir, { recursive: true, verbatimSymlinks: true });
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
    assetName: match.asset?.name || null,
    downloadUrl,
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
  releases,
  signal
} = {}) {
  const v = normalizeVersion(version);
  const releaseList = Array.isArray(releases)
    ? releases
    : await Releases.fetchGithubReleases({ owner: REPO_OWNER, repo: REPO_NAME, logger });
  const release = filterReleaseByVersion(releaseList, v);
  if (!release) throw new Error(`Onsyuri release v${v} not found`);
  const match = Releases.selectOnsyuriAsset([release], { variant: "web" });
  if (!match?.asset?.browser_download_url) {
    throw new Error(`No onsyuri web asset found for v${v}`);
  }

  const downloadUrl = match.asset.browser_download_url;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-onsyuri-web-"));
  const name = match.asset.name || `onsyuri-web-${v}`;
  const assetPath = path.join(tmpDir, name);
  const installDir = getWebInstallDir({ userDataDir, version: v });
  const archiveType = getWebArchiveType(name);

  try {
    logger?.info?.(`[onsyuri] downloading ${downloadUrl}`);
    await downloadToFile(downloadUrl, assetPath, { onProgress, signal });
    throwIfAborted(signal);
    safeRm(installDir);
    ensureDir(installDir);
    if (archiveType === "zip") {
      await extractZip(assetPath, installDir, signal);
    } else if (archiveType === "7z") {
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
    assetName: match.asset?.name || null,
    downloadUrl,
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
  recommendedVersion: RECOMMENDED_VERSION,
  previousDefaultVersion: PREVIOUS_DEFAULT_VERSION,
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
