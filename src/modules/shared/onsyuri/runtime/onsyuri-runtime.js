const fs = require("node:fs");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const Releases = require("../../runtime/github-releases");

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
  const v = normalizeVersion(version);
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

function listInstalledMac(userDataDir) {
  const root = path.join(installRootDir(userDataDir), "mac");
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
      const meta = readInstallMeta(installDir);
      if (!meta && !fs.existsSync(path.join(installDir, "onsyuri"))) continue;
      out.push({ version, variant, installDir });
    }
  }

  out.sort((a, b) => Releases.compareOnsyuriVersionsDesc(a.version, b.version));
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

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, res => resolve(res));
    req.on("error", reject);
    req.end();
  });
}

async function downloadToFile(url, destPath, onProgress, redirectDepth = 0) {
  if (redirectDepth > 5) throw new Error("Too many redirects while downloading onsyuri");
  const res = await httpGet(url);
  const status = Number(res.statusCode || 0);

  if ([301, 302, 303, 307, 308].includes(status)) {
    const loc = res.headers.location;
    res.resume();
    if (!loc) throw new Error(`Redirect missing location: ${url}`);
    const nextUrl = new URL(loc, url).toString();
    return downloadToFile(nextUrl, destPath, onProgress, redirectDepth + 1);
  }

  if (status !== 200) throw new Error(`Onsyuri download failed (${status})`);
  const total = Number(res.headers["content-length"] || 0) || null;

  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(destPath);
    let downloaded = 0;
    res.on("data", chunk => {
      downloaded += chunk.length;
      onProgress?.({ downloaded, total });
    });
    res.on("error", err => {
      out.close();
      reject(err);
    });
    out.on("error", reject);
    out.on("finish", resolve);
    res.pipe(out);
  });
}

function runCommand(cmd, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", b => {
      stderr += b.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", code => {
      if (code === 0) return resolve(true);
      const err = new Error(`${cmd} failed (${code})`);
      err.stderr = stderr;
      reject(err);
    });
  });
}

async function extractZip(zipPath, destDir) {
  const ditto = "/usr/bin/ditto";
  await runCommand(ditto, ["-x", "-k", zipPath, destDir]);
}

async function extractTar(tarPath, destDir) {
  await runCommand("/usr/bin/tar", ["-xzf", tarPath, "-C", destDir]);
}

async function extract7z(archivePath, destDir) {
  await runCommand("/usr/bin/bsdtar", ["-xf", archivePath, "-C", destDir]);
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

async function fetchAvailableVersions({ logger } = {}) {
  const releases = await Releases.fetchGithubReleases({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    logger,
    includePrerelease: true
  });
  const macVersions = Releases.collectOnsyuriVersions(releases);
  const webVersions = Releases.collectOnsyuriVersions(releases, { variant: "web" });
  return {
    releases,
    macVersions,
    webVersions,
    source: `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases`
  };
}

async function installMacVersion({
  userDataDir,
  version,
  variant,
  logger,
  onProgress,
  releases
} = {}) {
  const v = normalizeVersion(version);
  const arch = normalizeVariant(variant) || "x64";
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
    await downloadToFile(downloadUrl, assetPath, onProgress);
    if (lower.endsWith(".zip")) {
      ensureDir(extractDir);
      await extractZip(assetPath, extractDir);
      binaryPath = findOnsyuriBinary(extractDir);
      safeRm(installDir);
      ensureDir(path.dirname(installDir));
      fs.cpSync(extractDir, installDir, { recursive: true });
    } else if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) {
      ensureDir(extractDir);
      await extractTar(assetPath, extractDir);
      binaryPath = findOnsyuriBinary(extractDir);
      safeRm(installDir);
      ensureDir(path.dirname(installDir));
      fs.cpSync(extractDir, installDir, { recursive: true });
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
  releases
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
    await downloadToFile(downloadUrl, assetPath, onProgress);
    safeRm(installDir);
    ensureDir(installDir);
    if (archiveType === "zip") {
      await extractZip(assetPath, installDir);
    } else if (archiveType === "7z") {
      await extract7z(assetPath, installDir);
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
  const target = installDir || getMacInstallDir({ userDataDir, version, variant });
  safeRm(target);
  return true;
}

function uninstallWebVersion({ userDataDir, version, installDir } = {}) {
  const target = installDir || getWebInstallDir({ userDataDir, version });
  safeRm(target);
  return true;
}

module.exports = {
  installRootDir,
  listInstalledMac,
  listInstalledWeb,
  fetchAvailableVersions,
  installMacVersion,
  installWebVersion,
  uninstallMacVersion,
  uninstallWebVersion,
  normalizeVersion,
  normalizeVariant,
  __test: {
    getWebArchiveType
  }
};
