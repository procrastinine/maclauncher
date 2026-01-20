const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const DEFAULTS = {
  repo: "mkxp-z/mkxp-z",
  workflow: ".github/workflows/autobuild.yml",
  branch: "dev",
  artifactNeedle: "macos"
};
const LATEST_RUNS_PAGE_SIZE = 50;
const LATEST_RUNS_MAX_PAGES = 4;

const BUNDLED_VERSION =
  "2026-01-12T18-22-32Z_794d1897abe529a23f3f2f9c4f72d711a3b18391";
const BUNDLED_APP_NAME = "Z-universal.app";
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
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", b => {
      stdout += b.toString("utf8");
    });
    child.stderr.on("data", b => {
      stderr += b.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", code => {
      if (code === 0) return resolve({ stdout, stderr });
      const err = new Error(`${cmd} failed (exit ${code})`);
      err.code = code;
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    });
  });
}

async function canUseGh({ logger, runCommand: runner } = {}) {
  const exec = runner || runCommand;
  try {
    await exec("gh", ["auth", "status"]);
    return true;
  } catch (e) {
    const msg = String(e?.message || e);
    if (e?.code === "ENOENT") {
      logger?.warn?.("[mkxpz] gh CLI not found");
    } else if (msg) {
      logger?.warn?.("[mkxpz] gh auth unavailable", msg);
    }
    return false;
  }
}

function runGh(args) {
  return runCommand("gh", args).then(
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

function runGhToFile(args, outputPath) {
  return new Promise((resolve, reject) => {
    const fd = fs.openSync(outputPath, "w");
    const child = spawn("gh", args, { stdio: ["ignore", fd, "pipe"] });
    let stderr = "";
    let closed = false;

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
      closeFd();
      if (err?.code === "ENOENT") {
        reject(new Error("Error: gh CLI not found in PATH."));
        return;
      }
      reject(err);
    });
    child.on("close", code => {
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

async function listMacosDevAutobuilds(opts, { latestOnly } = {}) {
  const needle = String(opts.artifactNeedle || "").toLowerCase();
  const matches = [];

  if (latestOnly) {
    for (let page = 1; page <= LATEST_RUNS_MAX_PAGES; page += 1) {
      const runs = sortRunsNewest(
        await fetchRuns(opts, { perPage: LATEST_RUNS_PAGE_SIZE, page })
      );
      if (!runs.length) break;
      for (const run of runs) {
        const { date, sortKey } = getRunDate(run);
        const artifacts = await fetchArtifacts(opts, run.id);
        const filtered = artifacts.filter(artifact =>
          String(artifact.name || "").toLowerCase().includes(needle)
        );

        const artifact = filtered[0];
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
      const { date, sortKey } = getRunDate(run);
      const artifacts = await fetchArtifacts(opts, run.id);
      const filtered = artifacts.filter(artifact =>
        String(artifact.name || "").toLowerCase().includes(needle)
      );

      for (const artifact of filtered) {
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

async function extractAppZips(targetDir) {
  const entries = fs.readdirSync(targetDir, { withFileTypes: true });
  const appZips = entries
    .filter(entry => entry.isFile())
    .map(entry => entry.name)
    .filter(name => name.toLowerCase().endsWith(".app.zip"));

  for (const name of appZips) {
    const zipPath = path.join(targetDir, name);
    await runCommand("unzip", ["-o", "-q", zipPath, "-d", targetDir]);
    fs.unlinkSync(zipPath);
  }
}

async function downloadMacosAutobuild(opts, entry) {
  if (!entry || !entry.artifactId) {
    throw new Error("Missing artifact details for download.");
  }

  const safeDate = sanitizeSegment(entry.date);
  const safeSha = sanitizeSegment(entry.sha);
  const targetDir = path.join(opts.outDir, `${safeDate}_${safeSha}`);
  ensureDir(targetDir);

  const zipName = `${sanitizeSegment(entry.name || "artifact")}.zip`;
  const zipPath = path.join(targetDir, zipName);

  await runGhToFile(["api", `/repos/${opts.repo}/actions/artifacts/${entry.artifactId}/zip`], zipPath);
  await runCommand("unzip", ["-o", "-q", zipPath, "-d", targetDir]);
  fs.unlinkSync(zipPath);
  await extractAppZips(targetDir);
  return targetDir;
}

function resolveBundledRuntime() {
  const root = path.resolve(__dirname, "..", "resources", "mkxpz", BUNDLED_VERSION);
  const appPath = findAppBundle(root, BUNDLED_APP_NAME);
  if (!appPath) return null;
  return { version: BUNDLED_VERSION, installDir: root, appPath, source: "Bundled" };
}

function installBundledRuntime({ userDataDir, bundled: bundledOverride } = {}) {
  const bundled = bundledOverride || resolveBundledRuntime();
  if (!bundled) throw new Error("Bundled MKXP-Z runtime not found");

  const installDir = getInstallDir({ userDataDir, version: bundled.version });
  const existing = findAppBundle(installDir, path.basename(bundled.appPath));
  if (existing) {
    const meta = readInstallMeta(installDir);
    if (!meta) {
      writeInstallMeta(installDir, {
        version: bundled.version,
        source: "Bundled",
        installedAt: new Date().toISOString()
      });
    }
    return { version: bundled.version, installDir, appPath: existing, source: meta?.source || "Bundled" };
  }

  safeRm(installDir);
  ensureDir(path.dirname(installDir));
  fs.cpSync(bundled.installDir, installDir, { recursive: true, force: true });

  const appPath = findAppBundle(installDir, path.basename(bundled.appPath));
  if (!appPath) throw new Error("Bundled MKXP-Z install missing app bundle");
  writeInstallMeta(installDir, {
    version: bundled.version,
    source: "Bundled",
    installedAt: new Date().toISOString()
  });
  return { version: bundled.version, installDir, appPath, source: "Bundled" };
}

async function installFromGh({ userDataDir, entry, logger }) {
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
      entry
    );
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
    const bundledRoot = path.resolve(__dirname, "..", "resources", "mkxpz");
    const resolved = path.resolve(installDir);
    if (resolved === bundledRoot || resolved.startsWith(`${bundledRoot}${path.sep}`)) {
      return false;
    }
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

function listInstalled(userDataDir) {
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
    const appPath = findAppBundle(installDir, BUNDLED_APP_NAME);
    if (!appPath) continue;
    const meta = readInstallMeta(installDir);
    out.push({ version, installDir, appPath, source: meta?.source || null });
    seen.add(version);
  }

  const bundled = resolveBundledRuntime();
  if (bundled && !seen.has(bundled.version)) {
    out.push(bundled);
  }

  out.sort((a, b) => {
    const byVersion = compareVersionsDesc(a.version, b.version);
    if (byVersion !== 0) return byVersion;
    return String(a.installDir || "").localeCompare(String(b.installDir || ""));
  });
  return out;
}

module.exports = {
  BUNDLED_VERSION,
  BUNDLED_APP_NAME,
  DEFAULTS,
  normalizeVersion,
  compareVersions,
  compareVersionsDesc,
  canUseGh,
  listMacosDevAutobuilds,
  fetchAvailableVersions,
  fetchLatestAvailableVersions,
  listInstalled,
  installFromGh,
  installBundledRuntime,
  uninstallVersion,
  resolveBundledRuntime,
  installRootDir,
  getInstallDir,
  formatVersionLabel
};
