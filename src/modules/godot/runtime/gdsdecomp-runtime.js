const fs = require("node:fs");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const Releases = require("../../shared/runtime/github-releases");

const REPO_OWNER = "GDRETools";
const REPO_NAME = "gdsdecomp";
const SOURCE_LABEL = `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases`;
const INSTALL_META_FILE = ".maclauncher-gdsdecomp.json";

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function safeRm(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {}
}

function normalizeVersion(input) {
  const v = Releases.normalizeSemver(input);
  if (!v) {
    throw new Error(`Invalid GDRE Tools version: ${String(input ?? "")}`);
  }
  return v;
}

function compareVersions(a, b) {
  return Releases.compareSemverDesc(b, a);
}

function compareVersionsDesc(a, b) {
  return Releases.compareSemverDesc(a, b);
}

function installRootDir(userDataDir) {
  return path.join(userDataDir, "runtimes", "gdsdecomp");
}

function getInstallDir({ userDataDir, version }) {
  const v = normalizeVersion(version);
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

function matchesMacAsset(name) {
  const lower = String(name || "").toLowerCase();
  if (!lower.endsWith(".zip")) return false;
  return (
    lower.includes("macos") ||
    lower.includes("osx") ||
    lower.includes("darwin") ||
    lower.includes("mac")
  );
}

function scoreAppName(name) {
  const lower = String(name || "").toLowerCase();
  let score = 0;
  if (lower.includes("gdre")) score += 3;
  if (lower.includes("godot")) score += 2;
  if (lower.includes("tool")) score += 1;
  return score;
}

function findAppBundle(root) {
  const candidates = [];
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.toLowerCase().endsWith(".app")) continue;
    candidates.push(path.join(root, entry.name));
  }

  if (candidates.length === 0) {
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const nestedRoot = path.join(root, entry.name);
      let nested = [];
      try {
        nested = fs.readdirSync(nestedRoot, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const nestedEntry of nested) {
        if (!nestedEntry.isDirectory()) continue;
        if (!nestedEntry.name.toLowerCase().endsWith(".app")) continue;
        candidates.push(path.join(nestedRoot, nestedEntry.name));
      }
    }
  }

  if (candidates.length === 0) return null;

  const scored = candidates.map(appPath => {
    const name = path.basename(appPath);
    return { path: appPath, score: scoreAppName(name), name };
  });
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.name.localeCompare(b.name);
  });
  return scored[0]?.path || null;
}

function findCliBinary(appPath) {
  const macosDir = path.join(appPath, "Contents", "MacOS");
  if (!fs.existsSync(macosDir)) return null;
  const preferred = ["gdre_tools", "gdre-tools", "Godot RE Tools"];
  for (const name of preferred) {
    const candidate = path.join(macosDir, name);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  let entries = [];
  try {
    entries = fs.readdirSync(macosDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const fallback = entries.find(entry => entry.isFile());
  return fallback ? path.join(macosDir, fallback.name) : null;
}

function listInstalled(userDataDir) {
  const root = installRootDir(userDataDir);
  const out = [];
  let versions = [];
  try {
    versions = fs.readdirSync(root, { withFileTypes: true }).filter(entry =>
      entry.isDirectory()
    );
  } catch {
    return out;
  }

  for (const versionDir of versions) {
    const versionRaw = versionDir.name;
    const version = Releases.normalizeSemver(versionRaw);
    if (!version) continue;
    const installDir = path.join(root, versionRaw);
    const meta = readInstallMeta(installDir);
    let appPath = null;
    if (meta?.appName) {
      const candidate = path.join(installDir, meta.appName);
      if (fs.existsSync(candidate)) appPath = candidate;
    }
    if (!appPath) appPath = findAppBundle(installDir);
    if (!meta && !appPath) continue;
    const cliPath = appPath ? findCliBinary(appPath) : null;
    out.push({
      version,
      installDir,
      appPath: appPath || null,
      cliPath: cliPath || null,
      platformKey: "macos",
      source: meta?.source || null
    });
  }

  out.sort((a, b) => compareVersionsDesc(a.version, b.version));
  return out;
}

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, res => resolve(res));
    req.on("error", reject);
    req.end();
  });
}

async function downloadToFile(url, destPath, onProgress, redirectDepth = 0) {
  if (redirectDepth > 5) throw new Error("Too many redirects while downloading GDRE Tools");

  const res = await httpGet(url, { "User-Agent": "MacLauncher" });
  const status = Number(res.statusCode || 0);

  if ([301, 302, 303, 307, 308].includes(status)) {
    const loc = res.headers.location;
    res.resume();
    if (!loc) throw new Error(`Redirect missing location: ${url}`);
    const nextUrl = new URL(loc, url).toString();
    return downloadToFile(nextUrl, destPath, onProgress, redirectDepth + 1);
  }

  if (status !== 200) {
    res.resume();
    const err = new Error(`Download failed (${status})`);
    err.statusCode = status;
    throw err;
  }

  const total = Number(res.headers["content-length"] || 0) || null;
  ensureDir(path.dirname(destPath));
  const out = fs.createWriteStream(destPath);

  return new Promise((resolve, reject) => {
    let downloaded = 0;
    const cleanup = e => {
      try {
        out.close();
      } catch {}
      safeRm(destPath);
      reject(e);
    };

    res.on("data", chunk => {
      downloaded += chunk.length || 0;
      try {
        onProgress?.({ downloaded, total });
      } catch {}
    });
    res.on("error", cleanup);
    out.on("error", cleanup);
    out.on("finish", () => resolve({ downloaded, total }));
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
  const ditto = fs.existsSync("/usr/bin/ditto") ? "/usr/bin/ditto" : "ditto";
  await runCommand(ditto, ["-x", "-k", zipPath, destDir]);
}

async function copyBundle(src, dest) {
  const ditto = fs.existsSync("/usr/bin/ditto") ? "/usr/bin/ditto" : "ditto";
  await runCommand(ditto, [src, dest]);
}

function collectVersions(releases) {
  const versions = new Set();
  for (const rel of releases || []) {
    const releaseVersion = Releases.normalizeSemver(rel?.tag_name || rel?.name || "");
    for (const asset of rel?.assets || []) {
      const assetName = String(asset?.name || "");
      if (!matchesMacAsset(assetName)) continue;
      const assetVersion = Releases.normalizeSemver(assetName);
      const version = releaseVersion || assetVersion;
      if (version) versions.add(version);
    }
  }
  return Array.from(versions).sort(compareVersionsDesc);
}

function selectReleaseAsset(releases, version) {
  const target = normalizeVersion(version);
  const sorted = Releases.sortReleases(releases || []);
  for (const rel of sorted) {
    const releaseVersion = Releases.normalizeSemver(rel?.tag_name || rel?.name || "");
    for (const asset of rel?.assets || []) {
      const assetName = String(asset?.name || "");
      if (!matchesMacAsset(assetName)) continue;
      const assetVersion = Releases.normalizeSemver(assetName);
      const candidateVersion = releaseVersion || assetVersion;
      if (candidateVersion !== target) continue;
      return { release: rel, asset, version: candidateVersion };
    }
  }
  return null;
}

async function fetchAvailableVersions({ logger } = {}) {
  const releases = await Releases.fetchGithubReleases({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    logger
  });
  const versions = collectVersions(releases);
  if (!versions.length) throw new Error("No GDRE Tools releases with macOS assets found");
  return { releases, versions, source: SOURCE_LABEL };
}

async function installVersion({ userDataDir, version, logger, releases, onProgress } = {}) {
  const v = normalizeVersion(version);
  let sourceReleases = Array.isArray(releases) && releases.length ? releases : null;
  if (!sourceReleases) {
    const fetched = await fetchAvailableVersions({ logger });
    sourceReleases = fetched.releases || [];
  }

  const match = selectReleaseAsset(sourceReleases, v);
  if (!match) throw new Error(`GDRE Tools release v${v} not found`);
  const downloadUrl = match.asset?.browser_download_url;
  if (!downloadUrl) throw new Error("GDRE Tools download URL missing");

  const installDir = getInstallDir({ userDataDir, version: v });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-gdsdecomp-"));
  const zipName = match.asset?.name || `gdre_tools-${v}-macos.zip`;
  const zipPath = path.join(tmpDir, zipName);
  const extractDir = path.join(tmpDir, "extract");
  ensureDir(extractDir);

  try {
    logger?.info?.(`[gdsdecomp] downloading ${downloadUrl}`);
    await downloadToFile(downloadUrl, zipPath, onProgress);
    await extractZip(zipPath, extractDir);

    const appPath = findAppBundle(extractDir);
    if (!appPath) throw new Error("GDRE Tools app bundle not found in zip");

    safeRm(installDir);
    ensureDir(installDir);
    const destAppPath = path.join(installDir, path.basename(appPath));
    await copyBundle(appPath, destAppPath);

    const cliPath = findCliBinary(destAppPath);
    if (!cliPath) throw new Error("GDRE Tools CLI binary not found in app bundle");

    writeInstallMeta(installDir, {
      version: v,
      appName: path.basename(destAppPath),
      cliName: path.basename(cliPath),
      source: SOURCE_LABEL,
      downloadUrl,
      installedAt: new Date().toISOString()
    });

    return {
      version: v,
      installDir,
      appPath: destAppPath,
      cliPath,
      platformKey: "macos",
      source: SOURCE_LABEL
    };
  } finally {
    safeRm(zipPath);
    safeRm(tmpDir);
  }
}

function uninstallVersion({ userDataDir, version }) {
  const v = normalizeVersion(version);
  const installDir = getInstallDir({ userDataDir, version: v });
  safeRm(installDir);
  return true;
}

module.exports = {
  REPO_OWNER,
  REPO_NAME,
  SOURCE_LABEL,
  normalizeVersion,
  compareVersions,
  compareVersionsDesc,
  installRootDir,
  getInstallDir,
  listInstalled,
  fetchAvailableVersions,
  selectReleaseAsset,
  installVersion,
  uninstallVersion,
  __test: {
    matchesMacAsset,
    collectVersions,
    selectReleaseAsset,
    findAppBundle,
    findCliBinary
  }
};
