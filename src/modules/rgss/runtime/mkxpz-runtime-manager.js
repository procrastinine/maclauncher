const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { execFileSync } = require("node:child_process");
const GitHubCLI = require("../../shared/runtime/github-cli");
const Binary = require("./bundled-binary.json");
const Builds = require("./mkxpz-builds");
const {
  attachAbortSignal,
  createAbortError,
  throwIfAborted
} = require("../../shared/runtime/download-utils");

const DEFAULTS = {
  repo: "mkxp-z/mkxp-z",
  workflow: ".github/workflows/autobuild.yml",
  branch: "dev",
  artifactNeedle: "macos"
};
const LATEST_RUNS_PAGE_SIZE = 50;
const LATEST_RUNS_MAX_PAGES = 4;

const BUNDLED_VERSION = Binary.version;
const BUNDLED_APP_NAME = Binary.appName;
const Owned = require("./mkxpz-owned-builds");
const BINARY_PINS = [Binary, ...(Binary.retained || []), ...Owned.releases];
const DEFAULT_VERSION = Owned.defaultVersion(process.arch) || Binary.defaultVersion || BUNDLED_VERSION;
if (!BINARY_PINS.some(pin => pin.version === DEFAULT_VERSION)) throw new Error("The default MKXP-Z version must identify a supported runtime.");
const BINARY_CATALOG = Object.freeze(BINARY_PINS.map(pin => Object.freeze({ version: pin.version, upstreamRevision: pin.upstreamRevision,
  sourceUrl: pin.sourceUrl, localBuild: pin.sourceKind === "owned-source-adaptation",
  ...(pin.sourceKind === "owned-source-adaptation"
    ? { sourceArtifact: pin.sourceArtifact, adaptation: Object.freeze({ id: pin.adaptationId, executableSha256: pin.executableSha256 }) }
    : { publishedBinary: Object.freeze({ executableSha256: pin.executableSha256, treeSha256: pin.treeSha256 }) }) })));
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
  const owned = Owned.pin(version);
  if (owned?.label) return "MacLauncher " + owned.label;
  const head = String(version || "").split("_")[0];
  const m = head.match(/^(\d{4})-(\d{2})-(\d{2})T/);
  if (m) return `${m[1]}${m[2]}${m[3]}`;
  return String(version || "");
}

function compareVersions(a, b) {
  const da = parseVersionDate(a);
  const db = parseVersionDate(b);
  if (da !== null && db !== null && da !== db) return da - db;
  return String(a || "").localeCompare(String(b || ""));
}

function compareVersionsDesc(a, b) {
  return compareVersions(b, a);
}

function installRootDir(userDataDir) {
  return path.join(userDataDir, "runtimes", "mkxpz");
}

function getInstallDir({ userDataDir, version }) {
  const v = normalizeVersion(version);
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

async function canUseGh({ logger, runCommand: runner, required } = {}) {
  return GitHubCLI.available({ logger, runCommand: runner || runCommand, required });
}

function runGh(args) {
  return runCommand(GitHubCLI.executable(), args).then(
    res => String(res.stdout || "").trim(),
    err => {
      if (err?.code === "ENOENT") {
        throw new Error("Error: gh CLI not found in PATH.");
      }
      const msg = String(err?.stderr || "").trim() || "gh command failed.";
      const next = new Error(msg);
      next.code = err?.code;
      throw next;
    }
  );
}

function runGhToFile(args, outputPath, { signal } = {}) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const fd = fs.openSync(outputPath, "w");
    const child = spawn(GitHubCLI.executable(), args, { stdio: ["ignore", fd, "pipe"] });
    let stderr = "";
    let closed = false;
    const removeAbort = attachAbortSignal(signal, () => {
      try {
        child.kill("SIGTERM");
      } catch {}
      reject(createAbortError());
    });

    const closeFd = () => {
      if (closed) return;
      closed = true;
      try {
        fs.closeSync(fd);
      } catch {}
    };

    child.stderr.on("data", b => {
      stderr += b.toString("utf8");
    });
    child.on("error", err => {
      removeAbort();
      closeFd();
      if (err?.code === "ENOENT") {
        reject(new Error("Error: gh CLI not found in PATH."));
        return;
      }
      reject(err);
    });
    child.on("close", code => {
      removeAbort();
      closeFd();
      if (code === 0) return resolve(true);
      const err = new Error("gh command failed while downloading.");
      err.code = code;
      err.stderr = stderr;
      reject(err);
    });
  });
}

function workflowRef(workflow) {
  return encodeURIComponent(String(workflow || "").trim());
}

function getRunDate(run) {
  const date = run.run_started_at || run.created_at || run.updated_at || "unknown-date";
  const sortKey = new Date(date).getTime();
  return {
    date,
    sortKey: Number.isNaN(sortKey) ? 0 : sortKey
  };
}

async function fetchRuns(opts, { limit, paginate, page, perPage } = {}) {
  const jq = ".workflow_runs[] | @json";
  const pageSize =
    perPage && perPage > 0 ? Math.min(perPage, 100) : limit && limit > 0 ? Math.min(limit, 100) : 100;
  const url =
    `/repos/${opts.repo}/actions/workflows/${workflowRef(opts.workflow)}/runs` +
    `?branch=${encodeURIComponent(opts.branch)}&per_page=${pageSize}` +
    (page && page > 1 ? `&page=${page}` : "");
  const args = ["api", "-H", "Accept: application/vnd.github+json", url, "--jq", jq];
  if (paginate) args.splice(1, 0, "--paginate");
  const output = await runGh(args);

  if (!output) return [];

  return output
    .split("\n")
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function sortRunsNewest(runs) {
  return runs.sort((a, b) => {
    const aKey = getRunDate(a).sortKey;
    const bKey = getRunDate(b).sortKey;
    return bKey - aKey;
  });
}

async function fetchArtifacts(opts, runId) {
  const jq = ".artifacts[] | @json";
  const url = `/repos/${opts.repo}/actions/runs/${runId}/artifacts?per_page=100`;
  const output = await runGh([
    "api",
    "--paginate",
    "-H",
    "Accept: application/vnd.github+json",
    url,
    "--jq",
    jq
  ]);

  if (!output) return [];

  return output
    .split("\n")
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function selectMacosArtifact(artifacts, { artifactNeedle = DEFAULTS.artifactNeedle, arch = process.arch } = {}) {
  const needle = String(artifactNeedle).toLowerCase();
  const ranked = (artifacts || []).flatMap((artifact, index) => {
    const name = String(artifact.name || "").toLowerCase();
    if (artifact.expired || !name.includes(needle) || /(?:^|[._-])standalone(?:[._-]|$)/.test(name)) return [];
    const universal = /(?:^|[._-])universal(?:[._-]|$)/.test(name);
    const arm = /(?:^|[._-])(?:arm64|aarch64)(?:[._-]|$)/.test(name);
    const intel = /(?:^|[._-])(?:x86_64|x64|amd64)(?:[._-]|$)/.test(name);
    if (!universal && (arch === "arm64" && intel || arch === "x64" && arm)) return [];
    // Older workflow names omit both packaging and CPU labels. Preserve
    // those entries after explicitly compatible app bundles from the same run.
    const app = /(?:^|[._-])app(?:[._-]|$)/.test(name);
    return [{ artifact, rank: app && universal ? 0 : app && (arm || intel) ? 1 : 2, index }];
  });
  ranked.sort((a, b) => a.rank - b.rank || a.index - b.index);
  return ranked[0]?.artifact || null;
}

async function listMacosDevAutobuilds(opts, { latestOnly } = {}) {
  const matches = [];

  if (latestOnly) {
    for (let page = 1; page <= LATEST_RUNS_MAX_PAGES; page += 1) {
      const runs = sortRunsNewest(
        await fetchRuns(opts, { perPage: LATEST_RUNS_PAGE_SIZE, page })
      );
      if (!runs.length) break;
      for (const run of runs) {
        if (run.conclusion !== "success") continue;
        const { date, sortKey } = getRunDate(run);
        const artifacts = await fetchArtifacts(opts, run.id);
        const artifact = selectMacosArtifact(artifacts, opts);
        if (artifact) {
          matches.push({
            runId: run.id,
            artifactId: artifact.id,
            name: artifact.name || "unknown-artifact",
            date,
            sha: run.head_sha || "unknown-sha",
            sortKey
          });
          break;
        }
      }
      if (matches.length) break;
    }
  } else {
    let runs = sortRunsNewest(
      await fetchRuns(opts, { limit: opts.limit, paginate: !opts.limit })
    );
    if (opts.limit && opts.limit > 0) {
      runs = runs.slice(0, opts.limit);
    }

    for (const run of runs) {
      if (run.conclusion !== "success") continue;
      const { date, sortKey } = getRunDate(run);
      const artifacts = await fetchArtifacts(opts, run.id);
      const artifact = selectMacosArtifact(artifacts, opts);
      if (artifact) {
        matches.push({
          runId: run.id,
          artifactId: artifact.id,
          name: artifact.name || "unknown-artifact",
          date,
          sha: run.head_sha || "unknown-sha",
          sortKey
        });
      }
    }
  }

  return matches.sort((a, b) => b.sortKey - a.sortKey);
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

async function downloadMacosAutobuild(opts, entry, { signal } = {}) {
  if (!entry || !entry.artifactId) {
    throw new Error("Missing artifact details for download.");
  }

  const safeDate = sanitizeSegment(entry.date);
  const safeSha = sanitizeSegment(entry.sha);
  const targetDir = path.join(opts.outDir, `${safeDate}_${safeSha}`);
  ensureDir(targetDir);

  const zipName = `${sanitizeSegment(entry.name || "artifact")}.zip`;
  const zipPath = path.join(targetDir, zipName);

  await runGhToFile(
    ["api", `/repos/${opts.repo}/actions/artifacts/${entry.artifactId}/zip`],
    zipPath,
    { signal }
  );
  throwIfAborted(signal);
  await runCommand("unzip", ["-o", "-q", zipPath, "-d", targetDir], { signal });
  fs.unlinkSync(zipPath);
  await extractAppZips(targetDir, { signal });
  return targetDir;
}

async function installFromGh({ userDataDir, entry, logger, signal }) {
  const safeDate = sanitizeSegment(entry?.date);
  const safeSha = sanitizeSegment(entry?.sha);
  const v = normalizeVersion(`${safeDate}_${safeSha}`);
  const installDir = getInstallDir({ userDataDir, version: v });
  const existing = findAppBundle(installDir, BUNDLED_APP_NAME);
  if (existing) {
    const meta = readInstallMeta(installDir);
    return { version: v, installDir, appPath: existing, source: meta?.source || null };
  }

  safeRm(installDir);
  ensureDir(installRootDir(userDataDir));

  try {
    logger?.info?.(`[mkxpz] downloading ${entry?.name || "artifact"}`);
    const targetDir = await downloadMacosAutobuild(
      { ...DEFAULTS, outDir: installRootDir(userDataDir) },
      entry,
      { signal }
    );
    throwIfAborted(signal);
    if (targetDir !== installDir) {
      safeRm(installDir);
      fs.renameSync(targetDir, installDir);
    }
    const appPath = findAppBundle(installDir, BUNDLED_APP_NAME);
    if (!appPath) throw new Error("MKXP-Z extract missing app bundle");
    writeInstallMeta(installDir, {
      version: v,
      source: "GitHub Actions",
      installedAt: new Date().toISOString(),
      runId: entry?.runId || null,
      artifactId: entry?.artifactId || null,
      artifactName: entry?.name || null,
      sha: entry?.sha || null,
      date: entry?.date || null
    });
    return { version: v, installDir, appPath, source: "GitHub Actions" };
  } catch (e) {
    safeRm(installDir);
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

async function fetchAvailableVersions({ logger, latestOnly } = {}) {
  const opts = { ...DEFAULTS };
  logger?.info?.(
    `[mkxpz] fetching GitHub Actions builds${latestOnly ? " (latest)" : ""}`
  );
  const entries = await listMacosDevAutobuilds(opts, { latestOnly });
  const versions = entries.map(entry => {
    const safeDate = sanitizeSegment(entry.date);
    const safeSha = sanitizeSegment(entry.sha);
    const version = `${safeDate}_${safeSha}`;
    entry.version = version;
    return version;
  });
  return {
    versions,
    entries,
    source: "GitHub Actions",
    latestOnly: Boolean(latestOnly)
  };
}

async function fetchLatestAvailableVersions({ logger } = {}) {
  return fetchAvailableVersions({ logger, latestOnly: true });
}

function listInstalled(userDataDir, bundledOptions) {
  const out = [];
  const seen = new Set();
  const root = installRootDir(userDataDir);
  let versions = [];
  try {
    versions = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory());
  } catch {
    versions = [];
  }

  for (const versionDir of versions) {
    const version = versionDir.name;
    try {
      normalizeVersion(version);
    } catch {
      continue;
    }
    const installDir = path.join(root, version);
    if (fs.existsSync(path.join(installDir, "runtime.json"))) {
      seen.add(version);
      try {
        const hosted = Builds.resolveOwned({ userDataDir, version, verification: "status" });
        if (hosted) out.push(hosted);
      } catch (error) { out.push({ version, installDir, source: "MacLauncher Builds", status: "damaged", error: error.message }); }
      continue;
    }
    const appPath = findAppBundle(installDir, BUNDLED_APP_NAME);
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

function resolveOwnedRuntime({ userDataDir, version }) {
  const installDir = getInstallDir({ userDataDir, version });
  let stat;
  try { stat = fs.lstatSync(installDir); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("The selected MKXP-Z installation directory is damaged.");
  const hosted = Builds.resolveOwned({ userDataDir, version });
  if (hosted) return hosted;
  const appPath = findAppBundle(installDir, BUNDLED_APP_NAME);
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
  catalog: BINARY_CATALOG,
  BUNDLED_VERSION,
  DEFAULT_VERSION,
  BUNDLED_APP_NAME,
  DEFAULTS,
  normalizeVersion,
  compareVersions,
  compareVersionsDesc,
  canUseGh,
  selectMacosArtifact,
  listMacosDevAutobuilds,
  fetchAvailableVersions,
  fetchLatestAvailableVersions,
  listInstalled,
  resolveOwnedRuntime,
  installFromGh,
  uninstallVersion,
  installRootDir,
  getInstallDir,
  formatVersionLabel
};
