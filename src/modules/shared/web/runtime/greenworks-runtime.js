const fs = require("node:fs");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const Releases = require("../../runtime/github-releases");

const REPO_OWNER = "greenheartgames";
const REPO_NAME = "greenworks";
const INSTALL_META_FILE = ".maclauncher-greenworks.json";

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function safeRm(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {}
}

function normalizeNwVersion(input) {
  const v = String(input ?? "").trim().replace(/^v/i, "");
  if (!/^\d+\.\d+\.\d+$/.test(v)) {
    throw new Error(`Invalid NW.js version: ${String(input ?? "")}`);
  }
  return v;
}

function installRootDir(userDataDir) {
  return path.join(userDataDir, "runtimes", "greenworks");
}

function getInstallDir({ userDataDir, nwVersion }) {
  const v = normalizeNwVersion(nwVersion);
  return path.join(installRootDir(userDataDir), v);
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

function looksLikeGreenworks(dir) {
  const markers = ["greenworks.js", "greenworks.node"];
  return markers.some(name => fs.existsSync(path.join(dir, name)));
}

function findGreenworksRoot(extractedDir) {
  if (looksLikeGreenworks(extractedDir)) return extractedDir;
  let entries = [];
  try {
    entries = fs.readdirSync(extractedDir, { withFileTypes: true });
  } catch {
    return extractedDir;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(extractedDir, entry.name);
    if (looksLikeGreenworks(candidate)) return candidate;
  }
  return extractedDir;
}

function listInstalled(userDataDir) {
  const root = installRootDir(userDataDir);
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const version = entry.name;
    if (!/^\d+\.\d+\.\d+$/.test(version)) continue;
    const installDir = path.join(root, version);
    const meta = readInstallMeta(installDir);
    if (!looksLikeGreenworks(installDir) && !meta) continue;
    out.push({
      version,
      installDir,
      greenworksVersion: meta?.greenworksVersion || null,
      platformKey: meta?.greenworksVersion ? `gw ${meta.greenworksVersion}` : null
    });
  }

  out.sort((a, b) => Releases.compareSemverDesc(a.version, b.version));
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
  if (redirectDepth > 5) throw new Error("Too many redirects while downloading Greenworks");
  const res = await httpGet(url);
  const status = Number(res.statusCode || 0);

  if ([301, 302, 303, 307, 308].includes(status)) {
    const loc = res.headers.location;
    res.resume();
    if (!loc) throw new Error(`Redirect missing location: ${url}`);
    const nextUrl = new URL(loc, url).toString();
    return downloadToFile(nextUrl, destPath, onProgress, redirectDepth + 1);
  }

  if (status !== 200) throw new Error(`Greenworks download failed (${status})`);
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

async function extractZipDarwin(zipPath, destDir) {
  const ditto = "/usr/bin/ditto";
  await runCommand(ditto, ["-x", "-k", zipPath, destDir]);
}

async function fetchAvailableVersions({ logger } = {}) {
  const releases = await Releases.fetchGithubReleases({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    logger
  });
  const versions = Releases.collectGreenworksNwVersions(releases);
  return {
    versions,
    source: `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases`,
    releases
  };
}

async function installVersion({
  userDataDir,
  nwVersion,
  logger,
  onProgress,
  releases
} = {}) {
  const v = normalizeNwVersion(nwVersion);
  const releaseList = Array.isArray(releases)
    ? releases
    : await Releases.fetchGithubReleases({ owner: REPO_OWNER, repo: REPO_NAME, logger });
  const match = Releases.selectGreenworksAsset(releaseList, { nwVersion: v });
  if (!match?.asset?.browser_download_url) {
    throw new Error(`No Greenworks asset found for NW.js v${v}`);
  }

  const downloadUrl = match.asset.browser_download_url;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-greenworks-"));
  const zipName = match.asset.name || `greenworks-nw-v${v}-osx.zip`;
  const zipPath = path.join(tmpDir, zipName);
  const extractDir = path.join(tmpDir, "extract");
  const installDir = getInstallDir({ userDataDir, nwVersion: v });

  try {
    logger?.info?.(`[greenworks] downloading ${downloadUrl}`);
    await downloadToFile(downloadUrl, zipPath, onProgress);
    logger?.info?.(`[greenworks] extracting ${path.basename(zipPath)}`);
    ensureDir(extractDir);
    await extractZipDarwin(zipPath, extractDir);
    const root = findGreenworksRoot(extractDir);
    safeRm(installDir);
    ensureDir(path.dirname(installDir));
    fs.cpSync(root, installDir, { recursive: true });
  } finally {
    safeRm(tmpDir);
  }

  writeInstallMeta(installDir, {
    nwVersion: v,
    greenworksVersion: match.version || null,
    assetName: match.asset?.name || null,
    downloadUrl,
    installedAt: Date.now()
  });

  return {
    version: v,
    installDir,
    greenworksVersion: match.version || null,
    platformKey: match.version ? `gw ${match.version}` : null
  };
}

function uninstallVersion({ userDataDir, nwVersion, installDir } = {}) {
  const target = installDir || getInstallDir({ userDataDir, nwVersion });
  safeRm(target);
  return true;
}

module.exports = {
  installRootDir,
  getInstallDir,
  listInstalled,
  fetchAvailableVersions,
  installVersion,
  uninstallVersion,
  normalizeNwVersion
};
