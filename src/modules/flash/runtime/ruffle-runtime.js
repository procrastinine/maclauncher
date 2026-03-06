const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const {
  attachAbortSignal,
  createAbortError,
  downloadToFile,
  throwIfAborted
} = require("../../shared/runtime/download-utils");

const Releases = require("../../shared/runtime/github-releases");

const REPO_OWNER = "ruffle-rs";
const REPO_NAME = "ruffle";
const SOURCE_LABEL = `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases`;
const INSTALL_META_FILE = ".maclauncher-ruffle.json";

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function safeRm(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {}
}

function normalizeVersion(input) {
  const value = String(input ?? "").trim();
  if (!value) throw new Error("Missing Ruffle version");
  if (/[^0-9A-Za-z._-]/.test(value) || value.includes("/") || value.includes("\\")) {
    throw new Error(`Invalid Ruffle version: ${String(input ?? "")}`);
  }
  return value;
}

function parseNightlyStamp(version) {
  const m = String(version || "").trim().match(/^nightly-(\d{4})[-_](\d{2})[-_](\d{2})$/i);
  if (!m) return null;
  const stamp = Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
  return Number.isFinite(stamp) ? stamp : null;
}

function compareSemver(a, b) {
  const pa = Releases.parseSemver(a);
  const pb = Releases.parseSemver(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

function compareVersions(a, b) {
  const nightlyA = parseNightlyStamp(a);
  const nightlyB = parseNightlyStamp(b);
  if (nightlyA !== null && nightlyB !== null && nightlyA !== nightlyB) {
    return nightlyA - nightlyB;
  }

  const semver = compareSemver(a, b);
  if (semver !== null && semver !== 0) return semver;

  return String(a || "").localeCompare(String(b || ""));
}

function compareVersionsDesc(a, b) {
  return compareVersions(b, a);
}

function installRootDir(userDataDir) {
  return path.join(userDataDir, "runtimes", "ruffle");
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

function runCommand(cmd, args, options) {
  const { signal, ...spawnOptions } = options || {};
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...spawnOptions, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    const removeAbort = attachAbortSignal(signal, () => {
      try {
        child.kill("SIGTERM");
      } catch {}
    });

    child.stdout.on("data", chunk => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", chunk => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", err => {
      removeAbort();
      reject(err);
    });

    child.on("close", code => {
      removeAbort();
      if (signal?.aborted) return reject(createAbortError());
      if (code === 0) return resolve({ stdout, stderr });
      const err = new Error(`${cmd} failed (exit ${code})`);
      err.code = code;
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    });
  });
}

async function extractArchive(archivePath, destDir, signal) {
  const lower = String(archivePath || "").toLowerCase();
  if (lower.endsWith(".zip")) {
    const ditto = fs.existsSync("/usr/bin/ditto") ? "/usr/bin/ditto" : "ditto";
    await runCommand(ditto, ["-x", "-k", archivePath, destDir], { signal });
    return;
  }
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) {
    await runCommand("/usr/bin/tar", ["-xzf", archivePath, "-C", destDir], { signal });
    return;
  }
  if (lower.endsWith(".tar")) {
    await runCommand("/usr/bin/tar", ["-xf", archivePath, "-C", destDir], { signal });
    return;
  }
  throw new Error(`Unsupported Ruffle archive format: ${path.basename(archivePath)}`);
}

async function copyBundle(src, dest, signal) {
  const ditto = fs.existsSync("/usr/bin/ditto") ? "/usr/bin/ditto" : "ditto";
  await runCommand(ditto, [src, dest], { signal });
}

function scoreAppName(name, preferredName) {
  const lower = String(name || "").toLowerCase();
  const preferred = String(preferredName || "").toLowerCase();
  let score = 0;
  if (preferred && lower === preferred) score += 100;
  if (lower.includes("ruffle")) score += 20;
  if (lower.endsWith(".app")) score += 5;
  return score;
}

function findAppBundle(rootDir, preferredName = "Ruffle.app") {
  const candidates = [];
  const stack = [{ dir: rootDir, depth: 0 }];

  while (stack.length) {
    const current = stack.pop();
    if (!current || current.depth > 2) continue;

    let entries = [];
    try {
      entries = fs.readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(current.dir, entry.name);
      if (entry.name.toLowerCase().endsWith(".app")) {
        candidates.push(full);
        continue;
      }
      if (current.depth < 2) {
        stack.push({ dir: full, depth: current.depth + 1 });
      }
    }
  }

  if (candidates.length === 0) return null;

  const scored = candidates.map(appPath => {
    const name = path.basename(appPath);
    return {
      path: appPath,
      name,
      score: scoreAppName(name, preferredName)
    };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.name.localeCompare(b.name);
  });

  return scored[0]?.path || null;
}

function isMacArchiveAsset(name) {
  const lower = String(name || "").toLowerCase();
  if (lower.includes("source") || lower.includes("reproducible")) return false;
  const isMac =
    lower.includes("macos") ||
    lower.includes("darwin") ||
    lower.includes("osx") ||
    lower.includes("mac");
  if (!isMac) return false;
  return (
    lower.endsWith(".tar.gz") ||
    lower.endsWith(".tgz") ||
    lower.endsWith(".zip") ||
    lower.endsWith(".tar")
  );
}

function scoreMacArchiveAsset(name) {
  const lower = String(name || "").toLowerCase();
  let score = 0;
  if (lower.includes("macos-universal") || lower.includes("universal")) score += 100;
  if (lower.includes("desktop")) score += 20;
  if (lower.includes("aarch64") || lower.includes("arm64")) score += 10;
  if (lower.includes("x86_64") || lower.includes("x64")) score += 10;
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) score += 5;
  if (lower.includes("ruffle")) score += 2;
  return score;
}

function selectReleaseAsset(release) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const matches = [];

  for (const asset of assets) {
    const name = String(asset?.name || "");
    if (!name || !asset?.browser_download_url) continue;
    if (!isMacArchiveAsset(name)) continue;
    matches.push({ asset, score: scoreMacArchiveAsset(name) });
  }

  if (matches.length === 0) return null;

  matches.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return String(a.asset?.name || "").localeCompare(String(b.asset?.name || ""));
  });

  return matches[0].asset || null;
}

function normalizeReleaseVersion(release) {
  const raw = String(release?.tag_name || release?.name || "").trim();
  if (!raw) return null;

  const semver = Releases.normalizeSemver(raw);
  if (semver) {
    try {
      return normalizeVersion(semver);
    } catch {
      return null;
    }
  }

  const fallback = raw.replace(/^v/i, "");
  try {
    return normalizeVersion(fallback);
  } catch {
    return null;
  }
}

function collectCatalog(releases) {
  const sorted = Releases.sortReleases(releases || []);
  const versions = [];
  const releasesByVersion = {};

  for (const release of sorted) {
    const version = normalizeReleaseVersion(release);
    if (!version) continue;
    if (releasesByVersion[version]) continue;

    const asset = selectReleaseAsset(release);
    if (!asset) continue;

    releasesByVersion[version] = {
      version,
      releaseTag: String(release?.tag_name || release?.name || "") || null,
      publishedAt: release?.published_at || release?.created_at || null,
      assetName: String(asset.name || "") || null,
      downloadUrl: String(asset.browser_download_url || "") || null
    };
    versions.push(version);
  }

  versions.sort(compareVersionsDesc);

  return {
    versions,
    releasesByVersion
  };
}

async function fetchAvailableVersions({
  logger,
  latestOnly,
  maxPages,
  limit
} = {}) {
  const wantsLatest = latestOnly !== false;
  const pageCap = Number.isFinite(Number(maxPages)) ? Math.max(1, Number(maxPages)) : wantsLatest ? 1 : 20;

  const releases = await Releases.fetchGithubReleases({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    logger,
    includePrerelease: true,
    maxPages: pageCap
  });

  const catalog = collectCatalog(releases);
  if (!catalog.versions.length) {
    throw new Error("No macOS Ruffle releases were found.");
  }

  let versions = catalog.versions;
  if (wantsLatest) {
    const cap = Number.isFinite(Number(limit)) ? Math.max(1, Number(limit)) : 50;
    versions = versions.slice(0, cap);
  }

  const releasesByVersion = {};
  for (const version of versions) {
    const record = catalog.releasesByVersion[version];
    if (record) releasesByVersion[version] = { ...record };
  }

  return {
    versions,
    releasesByVersion,
    source: SOURCE_LABEL
  };
}

function listInstalled(userDataDir) {
  const root = installRootDir(userDataDir);
  const out = [];

  let versions = [];
  try {
    versions = fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory());
  } catch {
    return out;
  }

  for (const entry of versions) {
    const versionRaw = entry.name;
    let version = null;
    try {
      version = normalizeVersion(versionRaw);
    } catch {
      continue;
    }

    const installDir = path.join(root, versionRaw);
    const meta = readInstallMeta(installDir);
    let appPath = null;

    const appName =
      typeof meta?.appName === "string" && meta.appName.trim()
        ? meta.appName.trim()
        : null;
    if (appName) {
      const candidate = path.join(installDir, appName);
      if (fs.existsSync(candidate)) appPath = candidate;
    }
    if (!appPath) {
      appPath = findAppBundle(installDir, "Ruffle.app");
    }

    if (!meta && !appPath) continue;

    out.push({
      version,
      installDir,
      appPath: appPath || null,
      platformKey: "macos",
      source: meta?.source || null,
      assetName: meta?.assetName || null
    });
  }

  out.sort((a, b) => {
    const byVersion = compareVersionsDesc(a.version, b.version);
    if (byVersion !== 0) return byVersion;
    return String(a.installDir || "").localeCompare(String(b.installDir || ""));
  });

  return out;
}

function resolveInstalled({ userDataDir, version } = {}) {
  const installed = listInstalled(userDataDir);
  if (!installed.length) return null;

  if (typeof version === "string" && version.trim()) {
    let normalized = null;
    try {
      normalized = normalizeVersion(version.trim());
    } catch {
      normalized = null;
    }
    if (normalized) {
      const exact = installed.find(entry => entry.version === normalized);
      if (exact) return exact;
      return null;
    }
  }

  return installed[0] || null;
}

async function installVersion({
  userDataDir,
  version,
  logger,
  releasesByVersion,
  onProgress,
  signal
} = {}) {
  const v = normalizeVersion(version);

  let selected =
    releasesByVersion && typeof releasesByVersion === "object"
      ? releasesByVersion[v] || null
      : null;

  if (!selected?.downloadUrl) {
    const fetched = await fetchAvailableVersions({ logger, latestOnly: false, maxPages: 20 });
    selected = fetched.releasesByVersion?.[v] || null;
  }

  if (!selected?.downloadUrl) {
    throw new Error(`Ruffle version ${v} was not found in the remote catalog.`);
  }

  const installDir = getInstallDir({ userDataDir, version: v });
  const existing = findAppBundle(installDir, "Ruffle.app");
  if (existing) {
    const meta = readInstallMeta(installDir);
    return {
      version: v,
      installDir,
      appPath: existing,
      platformKey: "macos",
      source: meta?.source || SOURCE_LABEL
    };
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-ruffle-"));
  const archiveName = selected.assetName || `ruffle-${v}-macos.tar.gz`;
  const archivePath = path.join(tmpDir, archiveName);
  const extractDir = path.join(tmpDir, "extract");
  ensureDir(extractDir);

  try {
    logger?.info?.(`[ruffle] downloading ${selected.downloadUrl}`);
    await downloadToFile(selected.downloadUrl, archivePath, {
      headers: { "User-Agent": "MacLauncher" },
      onProgress,
      signal
    });

    throwIfAborted(signal);
    await extractArchive(archivePath, extractDir, signal);

    const appPath = findAppBundle(extractDir, "Ruffle.app");
    if (!appPath) {
      throw new Error("Ruffle app bundle was not found in the downloaded archive.");
    }

    safeRm(installDir);
    ensureDir(path.dirname(installDir));
    ensureDir(installDir);

    const destAppPath = path.join(installDir, path.basename(appPath));
    await copyBundle(appPath, destAppPath, signal);

    writeInstallMeta(installDir, {
      version: v,
      source: SOURCE_LABEL,
      releaseTag: selected.releaseTag || null,
      assetName: selected.assetName || archiveName,
      downloadUrl: selected.downloadUrl,
      appName: path.basename(destAppPath),
      installedAt: new Date().toISOString()
    });

    return {
      version: v,
      installDir,
      appPath: destAppPath,
      platformKey: "macos",
      source: SOURCE_LABEL
    };
  } finally {
    safeRm(tmpDir);
  }
}

function uninstallVersion({ userDataDir, version, installDir } = {}) {
  const target = installDir || getInstallDir({ userDataDir, version });
  safeRm(target);
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
  fetchAvailableVersions,
  listInstalled,
  resolveInstalled,
  installVersion,
  uninstallVersion,
  __test: {
    parseNightlyStamp,
    isMacArchiveAsset,
    scoreMacArchiveAsset,
    selectReleaseAsset,
    collectCatalog,
    findAppBundle,
    compareVersions
  }
};
