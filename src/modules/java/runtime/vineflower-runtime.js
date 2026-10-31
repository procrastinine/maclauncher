const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const Upstream = require("../../shared/runtime/upstream");
const { throwIfAborted } = require("../../shared/runtime/download-utils");

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
    return true;
  });
  if (exact) return exact;

  return (
    assets.find(asset => {
      const name = String(asset?.name || "").toLowerCase();
      return name.endsWith(".jar");
    }) || null
  );
}

// Vineflower publishes its decompiler JAR with each release, prereleases
// included; slim, source and documentation JARs are not the decompiler.
const source = Upstream.github({ repository: `${REPO_OWNER}/${REPO_NAME}`, prerelease: true, allArchitectures: true, recognize: release => {
  const version = normalizeReleaseVersion(release), asset = selectJarAsset(release);
  return version && asset ? { version, assets: [asset] } : null;
} });

// One row per version, from its newest release.
async function fetchAvailableVersions({ logger, signal } = {}) {
  const byVersion = new Map();
  for (const row of await source.discover({ logger, signal })) {
    const current = byVersion.get(row.version), publishedAt = Date.parse(String(row.publishedAt || "")) || 0;
    if (row.files[0] && (!current || publishedAt > current.publishedAt)) byVersion.set(row.version, { version: row.version, file: row.files[0], publishedAt });
  }
  const selected = Array.from(byVersion.values()).sort((a, b) => compareVersionsDesc(a.version, b.version));
  return {
    source: `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases`,
    versions: selected.map(item => item.version),
    releasesByVersion: Object.fromEntries(selected.map(item => [item.version, { file: item.file }]))
  };
}

function resolveVersionEntry(version, releasesByVersion) {
  const requested = normalizeVersion(version), direct = releasesByVersion?.[requested];
  return direct?.file ? { version: requested, file: direct.file } : null;
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
  if (!resolved?.file) {
    throw new Error(`Vineflower release ${requestedVersion} not found.`);
  }

  const installDir = getInstallDir({ userDataDir, version: requestedVersion });
  const jarPath = path.join(installDir, "vineflower.jar");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-vineflower-"));
  const tmpJar = path.join(tmpDir, "vineflower.jar");

  try {
    logger?.info?.(`[java] downloading Vineflower ${resolved.file.url}`);
    // The JAR matches the SHA-256 GitHub publishes. A file replaced since the
    // list was read is checked against the release's current digest.
    let downloaded;
    try { downloaded = await source.download(resolved.file, tmpJar, { onProgress, signal }); }
    catch (error) {
      throwIfAborted(signal);
      const current = resolveVersionEntry(requestedVersion, (await fetchAvailableVersions({ logger, signal })).releasesByVersion);
      if (!current?.file || current.file.digest?.value === resolved.file.digest?.value) throw error;
      downloaded = await source.download(current.file, tmpJar, { onProgress, signal });
    }
    throwIfAborted(signal);
    const { sha256, integrity } = downloaded;

    safeRm(installDir);
    ensureDir(installDir);
    fs.copyFileSync(tmpJar, jarPath);

    writeInstallMeta(installDir, {
      version: requestedVersion,
      source: "GitHub",
      downloadUrl: resolved.file.url,
      assetName: resolved.file.name,
      sha256,
      integrity,
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
  uninstallVersion,
  source
};
