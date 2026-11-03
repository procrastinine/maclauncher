const fs = require("node:fs");
const { cloneOrCopy } = require("../../shared/copy-file");
const os = require("node:os");
const path = require("node:path");
const { throwIfAborted } = require("../../shared/runtime/download-utils");
const Upstream = require("../../shared/runtime/upstream");
const { macDownloads, extractArchive } = require("../../shared/runtime/release-files");

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

function semver(input) {
  return /(\d+\.\d+\.\d+)/.exec(String(input || "").trim().replace(/^v/i, ""))?.[1] || null;
}

function normalizeVersion(input) {
  const v = semver(input);
  if (!v) {
    throw new Error(`Invalid GDRE Tools version: ${String(input ?? "")}`);
  }
  return v;
}

function compareVersions(a, b) {
  const pa = String(semver(a) || "").split(".").map(Number), pb = String(semver(b) || "").split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

function compareVersionsDesc(a, b) {
  return compareVersions(b, a);
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

// GDRE Tools publishes a Mac app archive with each release; its version is
// the release's, or the one its file name states.
const source = Upstream.github({ repository: "GDRETools/gdsdecomp", allArchitectures: true, recognize: release => {
  const [download] = macDownloads(release.assets);
  const version = semver(release.tag_name || release.name) || semver(download?.asset.name);
  return download && version ? { version, assets: [download.asset] } : null;
} });

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
    const version = semver(versionRaw);
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

async function copyBundle(src, dest, signal) {
  await cloneOrCopy(src, dest, { signal });
}

// One row per version, from its newest release.
async function fetchAvailableVersions({ logger, signal } = {}) {
  const rows = [], seen = new Set();
  for (const row of await source.discover({ logger, signal })) if (!seen.has(row.version) && row.files.length) { seen.add(row.version); rows.push(row); }
  rows.sort((a, b) => compareVersionsDesc(a.version, b.version));
  if (!rows.length) throw new Error("No GDRE Tools releases with macOS assets found");
  return { rows, versions: rows.map(row => row.version), source: SOURCE_LABEL };
}

async function installVersion({
  userDataDir,
  version,
  logger,
  rows,
  onProgress,
  signal
} = {}) {
  const v = normalizeVersion(version);
  const listed = (Array.isArray(rows) && rows.some(row => row.version === v) ? rows : (await fetchAvailableVersions({ logger, signal })).rows)
    .find(row => row.version === v);
  const file = listed?.files?.[0];
  if (!file) throw new Error(`GDRE Tools release v${v} not found`);
  const downloadUrl = file.url;

  const installDir = getInstallDir({ userDataDir, version: v });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-gdsdecomp-"));
  const zipPath = path.join(tmpDir, file.name);
  const extractDir = path.join(tmpDir, "extract");
  ensureDir(extractDir);

  try {
    logger?.info?.(`[gdsdecomp] downloading ${downloadUrl}`);
    const { sha256, integrity } = await source.download(file, zipPath, { onProgress, signal });
    throwIfAborted(signal);
    await extractArchive(zipPath, extractDir, signal);

    const appPath = findAppBundle(extractDir);
    if (!appPath) throw new Error("GDRE Tools app bundle not found in zip");

    safeRm(installDir);
    ensureDir(installDir);
    const destAppPath = path.join(installDir, path.basename(appPath));
    await copyBundle(appPath, destAppPath, signal);

    const cliPath = findCliBinary(destAppPath);
    if (!cliPath) throw new Error("GDRE Tools CLI binary not found in app bundle");

    writeInstallMeta(installDir, {
      version: v,
      appName: path.basename(destAppPath),
      cliName: path.basename(cliPath),
      source: SOURCE_LABEL,
      downloadUrl,
      archiveSha256: sha256,
      integrity,
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
  installVersion,
  uninstallVersion,
  source,
  __test: {
    findAppBundle,
    findCliBinary
  }
};
