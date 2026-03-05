const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const Releases = require("../../shared/runtime/github-releases");
const { downloadToFile, throwIfAborted } = require("../../shared/runtime/download-utils");

const REPO_OWNER = "Vineflower";
const REPO_NAME = "vineflower";
const INSTALL_META_FILE = ".maclauncher-vineflower.json";

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function safeRm(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {}
}

function parseSemver(input) {
  const raw = String(input || "").trim().replace(/^v/i, "");
  if (!raw) return null;
  const match = raw.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] || null,
    build: match[5] || null,
    normalized: `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}${match[4] ? `-${match[4]}` : ""}${match[5] ? `+${match[5]}` : ""}`
  };
}

function normalizeVersion(input) {
  const raw = String(input || "").trim().replace(/^v/i, "");
  if (!raw) throw new Error(`Invalid Vineflower version: ${String(input ?? "")}`);
  const parsed = parseSemver(raw);
  if (parsed) return parsed.normalized;

  const fallback = raw.match(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)/);
  if (fallback?.[1]) return fallback[1];
  throw new Error(`Invalid Vineflower version: ${String(input ?? "")}`);
}

function compareVersions(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return String(a || "").localeCompare(String(b || ""));
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;

  const aPre = pa.prerelease;
  const bPre = pb.prerelease;
  if (aPre && !bPre) return -1;
  if (!aPre && bPre) return 1;
  if (aPre && bPre) {
    const cmp = aPre.localeCompare(bPre, undefined, { numeric: true, sensitivity: "base" });
    if (cmp !== 0) return cmp;
  }

  return pa.normalized.localeCompare(pb.normalized);
}

function compareVersionsDesc(a, b) {
  return compareVersions(b, a);
}

function installRootDir(userDataDir) {
  return path.join(userDataDir, "runtimes", "vineflower");
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

function existsFile(p) {
  try {
    return fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
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

  for (const versionEntry of versions) {
    let version = null;
    try {
      version = normalizeVersion(versionEntry.name);
    } catch {
      continue;
    }
    const installDir = path.join(root, versionEntry.name);
    const meta = readInstallMeta(installDir);
    const jarPath = path.join(installDir, "vineflower.jar");
    if (!meta && !existsFile(jarPath)) continue;
    out.push({
      version,
      installDir,
      jarPath,
      source: meta?.source || null,
      downloadUrl: meta?.downloadUrl || null
    });
  }

  out.sort((a, b) => compareVersionsDesc(a.version, b.version));
  return out;
}

function normalizeReleaseVersion(release) {
  const candidates = [release?.tag_name, release?.name];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return normalizeVersion(candidate);
    } catch {}
  }
  return null;
}

function selectJarAsset(release) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const exact = assets.find(asset => {
    const name = String(asset?.name || "").toLowerCase();
    if (!name.endsWith(".jar")) return false;
    if (!name.includes("vineflower")) return false;
    if (name.includes("-slim") || name.includes("-sources") || name.includes("-javadoc")) {
      return false;
    }
    return Boolean(asset?.browser_download_url);
  });
  if (exact) return exact;

  return (
    assets.find(asset => {
      const name = String(asset?.name || "").toLowerCase();
      return name.endsWith(".jar") && Boolean(asset?.browser_download_url);
    }) || null
  );
}

async function fetchAvailableVersions({ logger } = {}) {
  const releases = await Releases.fetchGithubReleases({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    logger,
    includePrerelease: true
  });

  const byVersion = new Map();
  for (const release of releases) {
    const version = normalizeReleaseVersion(release);
    if (!version) continue;
    const asset = selectJarAsset(release);
    if (!asset) continue;
    if (!byVersion.has(version)) {
      byVersion.set(version, {
        version,
        release,
        asset,
        publishedAt: Date.parse(String(release?.published_at || release?.created_at || "")) || 0
      });
      continue;
    }
    const current = byVersion.get(version);
    const publishedAt = Date.parse(String(release?.published_at || release?.created_at || "")) || 0;
    if (publishedAt > (current?.publishedAt || 0)) {
      byVersion.set(version, { version, release, asset, publishedAt });
    }
  }

  const selected = Array.from(byVersion.values()).sort((a, b) => compareVersionsDesc(a.version, b.version));
  return {
    source: `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases`,
    versions: selected.map(item => item.version),
    releasesByVersion: Object.fromEntries(
      selected.map(item => [
        item.version,
        {
          release: item.release,
          asset: item.asset
        }
      ])
    )
  };
}

function resolveVersionEntry(version, releasesByVersion) {
  const requested = normalizeVersion(version);
  if (releasesByVersion && typeof releasesByVersion === "object") {
    const direct = releasesByVersion[requested];
    if (direct?.asset?.browser_download_url) {
      return {
        version: requested,
        release: direct.release,
        asset: direct.asset
      };
    }
  }
  return null;
}

async function installVersion({
  userDataDir,
  version,
  logger,
  onProgress,
  signal,
  releasesByVersion
} = {}) {
  const requestedVersion = normalizeVersion(version);
  let resolved = resolveVersionEntry(requestedVersion, releasesByVersion);
  if (!resolved) {
    const fetched = await fetchAvailableVersions({ logger });
    resolved = resolveVersionEntry(requestedVersion, fetched.releasesByVersion);
  }
  if (!resolved?.asset?.browser_download_url) {
    throw new Error(`Vineflower release ${requestedVersion} not found.`);
  }

  const installDir = getInstallDir({ userDataDir, version: requestedVersion });
  const jarPath = path.join(installDir, "vineflower.jar");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-vineflower-"));
  const tmpJar = path.join(tmpDir, "vineflower.jar");

  try {
    logger?.info?.(`[java] downloading Vineflower ${resolved.asset.browser_download_url}`);
    await downloadToFile(resolved.asset.browser_download_url, tmpJar, {
      headers: { "User-Agent": "MacLauncher" },
      onProgress,
      signal
    });
    throwIfAborted(signal);

    safeRm(installDir);
    ensureDir(installDir);
    fs.copyFileSync(tmpJar, jarPath);

    writeInstallMeta(installDir, {
      version: requestedVersion,
      source: "GitHub",
      downloadUrl: resolved.asset.browser_download_url,
      assetName: resolved.asset.name || null,
      installedAt: Date.now()
    });

    return {
      version: requestedVersion,
      installDir,
      jarPath
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
  INSTALL_META_FILE,
  normalizeVersion,
  compareVersions,
  compareVersionsDesc,
  installRootDir,
  getInstallDir,
  listInstalled,
  fetchAvailableVersions,
  installVersion,
  uninstallVersion
};
