const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const Architecture = require("../../shared/runtime/architecture");
const Upstream = require("../../shared/runtime/upstream");
const Builds = require("./mkxpz-builds");
const {
  attachAbortSignal,
  createAbortError,
  throwIfAborted
} = require("../../shared/runtime/download-utils");

const DEFAULTS = {
  repo: "mkxp-z/mkxp-z",
  workflow: "autobuild.yml",
  branch: "dev",
  artifactNeedle: "macos"
};

const INSTALL_META_FILE = ".maclauncher-mkxpz.json";

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function safeRm(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {}
}

function sanitizeSegment(value) {
  const cleaned = String(value || "")
    .trim()
    .replace(/[:/\\]/g, "-")
    .replace(/[^0-9A-Za-z._-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || "unknown";
}

function normalizeVersion(input) {
  const v = String(input ?? "").trim();
  if (!v) throw new Error("Missing MKXP-Z version");
  if (!/^[0-9A-Za-z._-]+$/.test(v)) {
    throw new Error(`Invalid MKXP-Z version: ${String(input ?? "")}`);
  }
  return v;
}

function parseVersionDate(version) {
  const head = String(version || "").split("_")[0];
  const m = head.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z$/);
  if (!m) return null;
  const ts = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`);
  return Number.isFinite(ts) ? ts : null;
}

function formatVersionLabel(version) {
  if (/^MCLv[1-9]\d*-\d{4}$/.test(String(version))) return String(version);
  const head = String(version || "").split("_")[0];
  const m = head.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-/);
  if (m) return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}`;
  return String(version || "");
}

const { compareVersions } = require("../../shared/runtime/version-order");

function compareVersionsDesc(a, b) {
  return compareVersions(b, a);
}

function installRootDir(userDataDir) {
  return path.join(userDataDir, "runtimes", "mkxpz");
}

function getInstallDir({ userDataDir, version, architecture }) {
  const v = normalizeVersion(version);
  const managed = Builds.manager.core.getInstallDir({ userDataDir, version: v, architecture });
  if (fs.existsSync(path.join(managed, "runtime.json"))) return managed;
  return path.join(installRootDir(userDataDir), v);
}

function findAppBundle(rootDir, preferredName) {
  let entries = [];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const apps = entries
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .filter(name => name.toLowerCase().endsWith(".app"));
  if (!apps.length) return null;
  if (preferredName && apps.includes(preferredName)) {
    return path.join(rootDir, preferredName);
  }
  apps.sort((a, b) => a.localeCompare(b));
  return path.join(rootDir, apps[0]);
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
    child.stdout.on("data", b => {
      stdout += b.toString("utf8");
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
      if (code === 0) return resolve({ stdout, stderr });
      const err = new Error(`${cmd} failed (exit ${code})`);
      err.code = code;
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    });
  });
}

function selectMacosArtifact(artifacts, { artifactNeedle = DEFAULTS.artifactNeedle, arch = Architecture.selectedArchitecture() } = {}) {
  const needle = String(artifactNeedle).toLowerCase();
  const ranked = (artifacts || []).flatMap((artifact, index) => {
    const name = String(artifact.name || "").toLowerCase();
    if (artifact.expired || !name.includes(needle) || /(?:^|[._-])standalone(?:[._-]|$)/.test(name)) return [];
    const architecture = Architecture.assetArchitecture(name);
    if (architecture && architecture !== "universal" && architecture !== arch) return [];
    // Older workflow names omit both packaging and CPU labels. Preserve
    // those entries after explicitly compatible app bundles from the same run.
    const app = /(?:^|[._-])app(?:[._-]|$)/.test(name);
    return [{ artifact, rank: app && architecture === "universal" ? 0 : app && architecture ? 1 : 2, index }];
  });
  ranked.sort((a, b) => a.rank - b.rank || a.index - b.index);
  return ranked[0]?.artifact || null;
}

async function extractAppZips(targetDir, { signal } = {}) {
  const entries = fs.readdirSync(targetDir, { withFileTypes: true });
  const appZips = entries
    .filter(entry => entry.isFile())
    .map(entry => entry.name)
    .filter(name => name.toLowerCase().endsWith(".app.zip"));

  for (const name of appZips) {
    const zipPath = path.join(targetDir, name);
    await runCommand("unzip", ["-o", "-q", zipPath, "-d", targetDir], { signal });
    fs.unlinkSync(zipPath);
  }
}

// The build's version names its run start and commit, as the installed
// directories do.
function buildVersion(date, sha) {
  return `${sanitizeSegment(date)}_${sanitizeSegment(sha)}`;
}

// Successful dev-branch autobuilds publish public artifacts with GitHub's
// digest. Each run lists the one app artifact this Mac runs.
const source = Upstream.githubActions({ repository: DEFAULTS.repo, workflow: DEFAULTS.workflow, branch: DEFAULTS.branch, limit: 1, maxRuns: 20,
  recognize: (artifact, { run, artifacts, githubAssetDigest }) => {
    const usable = artifacts.filter(item => item?.expired === false && githubAssetDigest(item));
    if (selectMacosArtifact(usable) !== artifact) return null;
    const date = run.run_started_at || run.created_at;
    return { version: buildVersion(date, run.head_sha), publishedAt: date,
      details: { runId: run.id, artifactId: artifact.id, name: artifact.name || null, date, sha: run.head_sha } };
  } });

async function installFromActions({ userDataDir, entry, logger, signal, onProgress }) {
  if (!entry?.file?.url) throw new Error("Missing artifact details for download.");
  const v = normalizeVersion(buildVersion(entry.date, entry.sha));
  const installDir = getInstallDir({ userDataDir, version: v });
  const existing = findAppBundle(installDir);
  if (existing) {
    const meta = readInstallMeta(installDir);
    return { version: v, installDir, appPath: existing, source: meta?.source || null };
  }

  safeRm(installDir);
  ensureDir(installRootDir(userDataDir));
  const stagingDir = path.join(installRootDir(userDataDir), `.install-${v}-${process.pid}-${Date.now()}`);
  try {
    ensureDir(stagingDir);
    logger?.info?.(`[mkxpz] downloading ${entry.name || "artifact"}`);
    const zipPath = path.join(stagingDir, `${sanitizeSegment(entry.name || "artifact")}.zip`);
    const { sha256, integrity } = await source.download(entry.file, zipPath, { signal, onProgress });
    throwIfAborted(signal);
    await runCommand("unzip", ["-o", "-q", zipPath, "-d", stagingDir], { signal });
    fs.unlinkSync(zipPath);
    await extractAppZips(stagingDir, { signal });
    throwIfAborted(signal);
    if (!findAppBundle(stagingDir)) throw new Error("MKXP-Z extract missing app bundle");
    fs.renameSync(stagingDir, installDir);
    const appPath = findAppBundle(installDir);
    writeInstallMeta(installDir, {
      version: v,
      source: "GitHub Actions",
      installedAt: new Date().toISOString(),
      runId: entry.runId || null,
      artifactId: entry.artifactId || null,
      artifactName: entry.name || null,
      sha: entry.sha || null,
      date: entry.date || null,
      archiveSha256: sha256,
      integrity
    });
    return { version: v, installDir, appPath, source: "GitHub Actions" };
  } catch (e) {
    safeRm(stagingDir);
    throw e;
  }
}

function uninstallVersion({ userDataDir, version, installDir }) {
  if (installDir) {
    const resolved = path.resolve(installDir);
    const owned = path.resolve(installRootDir(userDataDir));
    if (!resolved.startsWith(owned + path.sep)) return false;
    safeRm(installDir);
    return true;
  }
  const v = normalizeVersion(version);
  const dir = getInstallDir({ userDataDir, version: v });
  safeRm(dir);
  return true;
}

async function fetchAvailableVersions({ logger, latestOnly, signal } = {}) {
  logger?.info?.(`[mkxpz] fetching GitHub Actions builds${latestOnly ? " (latest)" : ""}`);
  const rows = await source.discover({ logger, signal, latestOnly: Boolean(latestOnly) });
  const entries = rows.filter(row => row.files[0]).map(row => ({ version: row.version, ...row.details, file: row.files[0],
    sortKey: Date.parse(row.details.date) || 0 })).sort((a, b) => b.sortKey - a.sortKey);
  return {
    versions: entries.map(entry => entry.version),
    entries,
    source: "GitHub Actions",
    latestOnly: Boolean(latestOnly)
  };
}

async function fetchLatestAvailableVersions({ logger, signal } = {}) {
  return fetchAvailableVersions({ logger, signal, latestOnly: true });
}

function listInstalled(userDataDir, bundledOptions) {
  const out = [];
  const seen = new Set();
  for (const row of Builds.manager.getState({userDataDir}).installed || []) {
    if (!row.installDir || !fs.existsSync(path.join(row.installDir, "runtime.json"))) continue;
    seen.add(row.installDir);
    if (row.ready === false) { out.push({...row, source: "MacLauncher Builds", projectPackage: true}); continue; }
    try {
      const architecture = Architecture.requestedArchitecture(row);
      const hosted = Builds.resolveOwned({userDataDir, version: row.version, architecture, verification: "status"});
      if (hosted) out.push(hosted);
    } catch (error) { out.push({...row, source: "MacLauncher Builds", status: "damaged", error: error.message}); }
  }
  const root = installRootDir(userDataDir);
  let versions = [];
  try {
    versions = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory());
  } catch {
    versions = [];
  }

  for (const versionDir of versions) {
    const version = versionDir.name;
    // Staging directories start with a dot and are never installations.
    if (version.startsWith(".")) continue;
    try {
      normalizeVersion(version);
    } catch {
      continue;
    }
    const installDir = path.join(root, version);
    if (seen.has(installDir)) continue;
    if (fs.existsSync(path.join(installDir, "runtime.json"))) {
      seen.add(version);
      try {
        const hosted = Builds.resolveOwned({ userDataDir, version, verification: "status" });
        if (hosted) out.push(hosted);
      } catch (error) { out.push({ version, installDir, source: "MacLauncher Builds", status: "damaged", error: error.message }); }
      continue;
    }
    const appPath = findAppBundle(installDir);
    if (!appPath) continue;
    const meta = readInstallMeta(installDir);
    out.push({ version, installDir, appPath, source: meta?.source || null });
    seen.add(version);
  }


  out.sort((a, b) => {
    const byVersion = compareVersionsDesc(a.version, b.version);
    if (byVersion !== 0) return byVersion;
    return String(a.installDir || "").localeCompare(String(b.installDir || ""));
  });
  return out;
}

function resolveOwnedRuntime({ userDataDir, version, architecture }) {
  const installDir = getInstallDir({ userDataDir, version, architecture });
  let stat;
  try { stat = fs.lstatSync(installDir); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("The selected MKXP-Z installation directory is damaged.");
  const hosted = Builds.resolveOwned({ userDataDir, version, architecture });
  if (hosted) return hosted;
  const appPath = findAppBundle(installDir);
  if (!appPath) throw new Error("The selected MKXP-Z installation is missing its app bundle.");
  let recordStat = null;
  try { recordStat = fs.lstatSync(path.join(installDir, INSTALL_META_FILE)); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (recordStat && (!recordStat.isFile() || recordStat.isSymbolicLink() || recordStat.size > 1024 * 1024)) {
    throw new Error("The selected MKXP-Z installation record is damaged.");
  }
  const meta = recordStat && readInstallMeta(installDir);
  if (recordStat && (!meta || Array.isArray(meta) || meta.version != null && meta.version !== version)) {
    throw new Error("The selected MKXP-Z installation record is damaged or identifies another version.");
  }
  return { version, installDir, resourceRoot: installDir, appPath, source: meta?.source || null };
}

module.exports = {
  DEFAULTS,
  normalizeVersion,
  compareVersions,
  compareVersionsDesc,
  source,
  selectMacosArtifact,
  fetchAvailableVersions,
  fetchLatestAvailableVersions,
  listInstalled,
  resolveOwnedRuntime,
  installFromActions,
  uninstallVersion,
  installRootDir,
  getInstallDir,
  formatVersionLabel
};
