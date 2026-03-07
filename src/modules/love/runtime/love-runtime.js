const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const {
  attachAbortSignal,
  createAbortError,
  downloadToFile,
  throwIfAborted
} = require("../../shared/runtime/download-utils");
const Releases = require("../../shared/runtime/github-releases");
const {
  normalizeLoveVersion,
  compareLoveVersions,
  compareLoveVersionsDesc,
  normalizeNightlyBuildKey,
  compareNightlyBuildKeysDesc,
  parseNightlyBuildTimestamp,
  shortSha
} = require("../version");

const REPO_OWNER = "love2d";
const REPO_NAME = "love";
const INSTALL_META_FILE = ".maclauncher-love.json";
const CHANNEL_STABLE = "stable";
const CHANNEL_NIGHTLY = "nightly";
const NIGHTLY_WORKFLOW = ".github/workflows/main.yml";
const NIGHTLY_ARTIFACT_NEEDLE = "love-macos";

function ensureDir(filePath) {
  fs.mkdirSync(filePath, { recursive: true });
}

function safeRm(filePath) {
  try {
    fs.rmSync(filePath, { recursive: true, force: true });
  } catch {}
}

function existsFile(filePath) {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function existsDir(filePath) {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function normalizeChannel(input) {
  const value = String(input || "").trim().toLowerCase();
  if (value === CHANNEL_NIGHTLY) return CHANNEL_NIGHTLY;
  return CHANNEL_STABLE;
}

function installRootDir(userDataDir, channel) {
  return path.join(userDataDir, "runtimes", "love", normalizeChannel(channel));
}

function getInstallDir({ userDataDir, channel, version }) {
  const installChannel = normalizeChannel(channel);
  const normalizedVersion =
    installChannel === CHANNEL_STABLE ? normalizeLoveVersion(version) : normalizeNightlyBuildKey(version);
  if (!normalizedVersion) {
    throw new Error(`Invalid LÖVE ${installChannel} version: ${String(version || "")}`);
  }
  return path.join(installRootDir(userDataDir, installChannel), normalizedVersion);
}

function metaPath(installDir) {
  return path.join(installDir, INSTALL_META_FILE);
}

function readInstallMeta(installDir) {
  try {
    const filePath = metaPath(installDir);
    if (!existsFile(filePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function writeInstallMeta(installDir, payload) {
  try {
    const filePath = metaPath(installDir);
    ensureDir(path.dirname(filePath));
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
  } catch {}
}

function parsePlistJsonSync(plistPath) {
  try {
    const result = spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", plistPath], {
      encoding: "utf8"
    });
    if (result.status !== 0 || !result.stdout) return null;
    const parsed = JSON.parse(result.stdout);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function readXmlPlistValue(plistPath, key) {
  try {
    const raw = fs.readFileSync(plistPath, "utf8");
    const escapedKey = String(key || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = raw.match(new RegExp(`<key>${escapedKey}</key>\\s*<string>([^<]+)</string>`));
    return match?.[1] ? match[1].trim() : null;
  } catch {
    return null;
  }
}

function readAppBundleInfo(appPath) {
  const plistPath = path.join(appPath, "Contents", "Info.plist");
  const plist = parsePlistJsonSync(plistPath) || null;
  return {
    executableName:
      typeof plist?.CFBundleExecutable === "string" && plist.CFBundleExecutable.trim()
        ? plist.CFBundleExecutable.trim()
        : readXmlPlistValue(plistPath, "CFBundleExecutable") || null,
    bundleVersionRaw:
      typeof plist?.CFBundleShortVersionString === "string" &&
      plist.CFBundleShortVersionString.trim()
        ? plist.CFBundleShortVersionString.trim()
        : readXmlPlistValue(plistPath, "CFBundleShortVersionString") || null
  };
}

function resolveExecutablePath(appPath) {
  if (!appPath) return null;
  const macosDir = path.join(appPath, "Contents", "MacOS");
  if (!existsDir(macosDir)) return null;
  const info = readAppBundleInfo(appPath);
  if (info.executableName) {
    const preferred = path.join(macosDir, info.executableName);
    if (existsFile(preferred)) return preferred;
  }
  const bundleName = path.basename(appPath, ".app");
  if (bundleName) {
    const bundleExecutable = path.join(macosDir, bundleName);
    if (existsFile(bundleExecutable)) return bundleExecutable;
  }
  try {
    const first = fs.readdirSync(macosDir, { withFileTypes: true }).find(entry => entry.isFile());
    return first ? path.join(macosDir, first.name) : null;
  } catch {
    return null;
  }
}

function detectArchitecture(executablePath) {
  if (!executablePath || !existsFile(executablePath)) {
    return { architecture: "unknown", requiresRosetta: false };
  }
  try {
    const result = spawnSync("/usr/bin/lipo", ["-archs", executablePath], { encoding: "utf8" });
    if (result.status === 0 && result.stdout) {
      const arches = result.stdout
        .trim()
        .split(/\s+/)
        .map(value => value.trim())
        .filter(Boolean);
      const hasArm64 = arches.includes("arm64");
      const hasX64 = arches.includes("x86_64");
      if (hasArm64 && hasX64) {
        return { architecture: "universal", requiresRosetta: false };
      }
      if (hasArm64) return { architecture: "arm64", requiresRosetta: false };
      if (hasX64) {
        return {
          architecture: "x64",
          requiresRosetta: process.platform === "darwin" && process.arch === "arm64"
        };
      }
    }
  } catch {}
  return { architecture: "unknown", requiresRosetta: false };
}

function readBundleInfo(appPath) {
  const plistInfo = readAppBundleInfo(appPath);
  const executablePath = resolveExecutablePath(appPath);
  const architectureInfo = detectArchitecture(executablePath);
  return {
    appPath,
    executablePath,
    bundleVersionRaw: plistInfo.bundleVersionRaw || null,
    bundleVersionNormalized: normalizeLoveVersion(plistInfo.bundleVersionRaw) || null,
    architecture: architectureInfo.architecture,
    requiresRosetta: architectureInfo.requiresRosetta
  };
}

function walkDirectories(rootDir, predicate, maxDepth = 5) {
  const matches = [];
  const queue = [{ dir: rootDir, depth: 0 }];
  while (queue.length) {
    const current = queue.shift();
    if (!current) break;
    let entries = [];
    try {
      entries = fs.readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(current.dir, entry.name);
      if (predicate(full, entry.name)) matches.push(full);
      if (current.depth < maxDepth) queue.push({ dir: full, depth: current.depth + 1 });
    }
  }
  return matches;
}

function findAppBundle(rootDir, preferredName = null) {
  const matches = walkDirectories(
    rootDir,
    (_full, name) => name.toLowerCase().endsWith(".app"),
    4
  );
  if (!matches.length) return null;
  if (preferredName) {
    const preferred = matches.find(item => path.basename(item).toLowerCase() === preferredName.toLowerCase());
    if (preferred) return preferred;
  }
  matches.sort((a, b) => a.localeCompare(b));
  return matches[0];
}

function listInstalledStable(userDataDir) {
  const root = installRootDir(userDataDir, CHANNEL_STABLE);
  const out = [];
  let versions = [];
  try {
    versions = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const versionDir of versions) {
    if (!versionDir.isDirectory()) continue;
    const version = normalizeLoveVersion(versionDir.name);
    if (!version) continue;
    const installDir = path.join(root, versionDir.name);
    const appPath = findAppBundle(installDir, "love.app");
    if (!appPath) continue;
    const meta = readInstallMeta(installDir) || {};
    const bundleInfo = readBundleInfo(appPath);
    out.push({
      channel: CHANNEL_STABLE,
      version,
      installDir,
      appPath,
      executablePath: bundleInfo.executablePath,
      source: meta.source || "GitHub Releases",
      browserDownloadUrl: meta.browserDownloadUrl || null,
      bundleVersionRaw: meta.bundleVersionRaw || bundleInfo.bundleVersionRaw,
      bundleVersionNormalized:
        meta.bundleVersionNormalized || bundleInfo.bundleVersionNormalized || version,
      architecture: meta.architecture || bundleInfo.architecture,
      requiresRosetta:
        typeof meta.requiresRosetta === "boolean"
          ? meta.requiresRosetta
          : bundleInfo.requiresRosetta === true
    });
  }
  out.sort((a, b) => compareLoveVersionsDesc(a.version, b.version));
  return out;
}

function listInstalledNightly(userDataDir) {
  const root = installRootDir(userDataDir, CHANNEL_NIGHTLY);
  const out = [];
  let versions = [];
  try {
    versions = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const versionDir of versions) {
    if (!versionDir.isDirectory()) continue;
    const buildKey = normalizeNightlyBuildKey(versionDir.name);
    if (!buildKey) continue;
    const installDir = path.join(root, versionDir.name);
    const appPath = findAppBundle(installDir, "love.app");
    if (!appPath) continue;
    const meta = readInstallMeta(installDir) || {};
    const bundleInfo = readBundleInfo(appPath);
    out.push({
      channel: CHANNEL_NIGHTLY,
      version: buildKey,
      buildKey,
      installDir,
      appPath,
      executablePath: bundleInfo.executablePath,
      source: meta.source || "GitHub Actions",
      bundleVersionRaw: meta.bundleVersionRaw || bundleInfo.bundleVersionRaw,
      bundleVersionNormalized:
        meta.bundleVersionNormalized || bundleInfo.bundleVersionNormalized || null,
      architecture: meta.architecture || bundleInfo.architecture,
      requiresRosetta:
        typeof meta.requiresRosetta === "boolean"
          ? meta.requiresRosetta
          : bundleInfo.requiresRosetta === true,
      runId: meta.runId || null,
      artifactId: meta.artifactId || null,
      artifactName: meta.artifactName || null,
      headSha: meta.headSha || null,
      runStartedAt: meta.runStartedAt || null
    });
  }
  out.sort((a, b) => compareNightlyBuildKeysDesc(a.buildKey, b.buildKey));
  return out;
}

function listInstalled(userDataDir, channel) {
  return normalizeChannel(channel) === CHANNEL_NIGHTLY
    ? listInstalledNightly(userDataDir)
    : listInstalledStable(userDataDir);
}

function resolveInstalled({ userDataDir, channel, version }) {
  const installChannel = normalizeChannel(channel);
  if (!version) return null;
  const normalizedVersion =
    installChannel === CHANNEL_NIGHTLY ? normalizeNightlyBuildKey(version) : normalizeLoveVersion(version);
  if (!normalizedVersion) return null;
  return (
    listInstalled(userDataDir, installChannel).find(entry => {
      if (installChannel === CHANNEL_NIGHTLY) return entry.buildKey === normalizedVersion;
      return entry.version === normalizedVersion;
    }) || null
  );
}

function resolveLatestInstalled(userDataDir, channel) {
  return listInstalled(userDataDir, channel)[0] || null;
}

function findNightlyByBundleVersion({ userDataDir, version }) {
  const normalized = normalizeLoveVersion(version);
  if (!normalized) return null;
  return (
    listInstalledNightly(userDataDir).find(entry => entry.bundleVersionNormalized === normalized) || null
  );
}

function normalizeReleaseVersion(release) {
  return normalizeLoveVersion(release?.tag_name || release?.name || "");
}

function isMacReleaseAsset(asset) {
  const lower = String(asset?.name || "").toLowerCase();
  if (!lower.endsWith(".zip")) return false;
  if (lower.includes("apple-libraries")) return false;
  if (lower.includes("ios")) return false;
  if (lower.includes("source")) return false;
  return lower.includes("macos") || lower.includes("macosx");
}

function scoreMacReleaseAsset(asset) {
  const lower = String(asset?.name || "").toLowerCase();
  let score = 0;
  if (lower.includes("-macos.zip")) score += 400;
  if (lower.includes("macosx-ub")) score += 300;
  if (lower.includes("macosx-x64")) score += 200;
  if (lower.includes("macosx")) score += 100;
  return score;
}

function pickStableReleaseAsset(release) {
  const assets = Array.isArray(release?.assets) ? release.assets.filter(isMacReleaseAsset) : [];
  if (!assets.length) return null;
  assets.sort((a, b) => {
    const scoreDiff = scoreMacReleaseAsset(b) - scoreMacReleaseAsset(a);
    if (scoreDiff !== 0) return scoreDiff;
    return String(a?.name || "").localeCompare(String(b?.name || ""));
  });
  return assets[0];
}

function sortStableReleases(releases) {
  const list = Array.isArray(releases) ? releases.slice() : [];
  list.sort((a, b) => {
    const va = normalizeReleaseVersion(a);
    const vb = normalizeReleaseVersion(b);
    if (va && vb && va !== vb) return compareLoveVersionsDesc(va, vb);
    const da = Date.parse(a?.published_at || a?.created_at || "") || 0;
    const db = Date.parse(b?.published_at || b?.created_at || "") || 0;
    return db - da;
  });
  return list;
}

async function fetchAvailableVersions({ logger, releases } = {}) {
  const releaseList = Array.isArray(releases)
    ? releases
    : await Releases.fetchGithubReleases({
        owner: REPO_OWNER,
        repo: REPO_NAME,
        logger,
        includePrerelease: false,
        maxPages: 20
      });
  const sorted = sortStableReleases(releaseList);
  const entries = [];
  const entriesByVersion = {};
  for (const release of sorted) {
    const version = normalizeReleaseVersion(release);
    const asset = pickStableReleaseAsset(release);
    if (!version || !asset?.browser_download_url) continue;
    if (entriesByVersion[version]) continue;
    const entry = {
      channel: CHANNEL_STABLE,
      version,
      releaseId: release.id || null,
      tagName: release.tag_name || release.name || version,
      browserDownloadUrl: asset.browser_download_url,
      assetName: asset.name || null,
      release
    };
    entries.push(entry);
    entriesByVersion[version] = entry;
  }
  return {
    versions: entries.map(entry => entry.version),
    entries,
    entriesByVersion,
    source: `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases`
  };
}

function runCommand(cmd, args, options = {}) {
  const { signal, ...spawnOptions } = options;
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
    child.on("error", error => {
      removeAbort();
      reject(error);
    });
    child.on("close", code => {
      removeAbort();
      if (signal?.aborted) return reject(createAbortError());
      if (code === 0) return resolve({ stdout, stderr });
      const error = new Error(`${cmd} failed (${code})`);
      error.code = code;
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
  });
}

async function canUseGh({ logger, runCommand: runner } = {}) {
  const exec = runner || runCommand;
  try {
    await exec("gh", ["auth", "status"]);
    return true;
  } catch (error) {
    const message = String(error?.message || error);
    if (error?.code === "ENOENT") {
      logger?.warn?.("[love] gh CLI not found");
    } else if (message) {
      logger?.warn?.("[love] gh auth unavailable", message);
    }
    return false;
  }
}

function runGh(args, { signal, runner } = {}) {
  const exec = runner || runCommand;
  return exec("gh", args, { signal }).then(
    result => String(result.stdout || "").trim(),
    error => {
      if (error?.code === "ENOENT") {
        throw new Error("GitHub CLI (gh) is not installed.");
      }
      const next = new Error(String(error?.stderr || error?.message || error).trim() || "gh command failed.");
      next.code = error?.code;
      throw next;
    }
  );
}

function runGhToFile(args, outputPath, { signal } = {}) {
  throwIfAborted(signal);
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
    const removeAbort = attachAbortSignal(signal, () => {
      try {
        child.kill("SIGTERM");
      } catch {}
      closeFd();
      reject(createAbortError());
    });

    child.stderr.on("data", chunk => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", error => {
      removeAbort();
      closeFd();
      if (error?.code === "ENOENT") {
        reject(new Error("GitHub CLI (gh) is not installed."));
        return;
      }
      reject(error);
    });
    child.on("close", code => {
      removeAbort();
      closeFd();
      if (code === 0) return resolve(true);
      const error = new Error("gh command failed while downloading.");
      error.code = code;
      error.stderr = stderr;
      reject(error);
    });
  });
}

function workflowRef(workflowPath) {
  return encodeURIComponent(String(workflowPath || "").trim());
}

function getRunDate(run) {
  const value = run?.run_started_at || run?.created_at || run?.updated_at || "unknown-date";
  const timestamp = Date.parse(value);
  return {
    value,
    timestamp: Number.isFinite(timestamp) ? timestamp : 0
  };
}

async function fetchRuns({ latestOnly, runner } = {}) {
  const jq = ".workflow_runs[] | @json";
  const perPage = 50;
  if (latestOnly) {
    const runs = [];
    for (let page = 1; page <= 4; page += 1) {
      const url =
        `/repos/${REPO_OWNER}/${REPO_NAME}/actions/workflows/${workflowRef(NIGHTLY_WORKFLOW)}/runs` +
        `?branch=main&per_page=${perPage}&page=${page}`;
      const output = await runGh(
        ["api", "-H", "Accept: application/vnd.github+json", url, "--jq", jq],
        { runner }
      );
      if (!output) break;
      const pageRuns = output
        .split("\n")
        .filter(Boolean)
        .map(line => JSON.parse(line));
      runs.push(...pageRuns);
      if (pageRuns.length < perPage) break;
    }
    return runs;
  }

  const url =
    `/repos/${REPO_OWNER}/${REPO_NAME}/actions/workflows/${workflowRef(NIGHTLY_WORKFLOW)}/runs` +
    "?branch=main&per_page=50";
  const output = await runGh(
    ["api", "--paginate", "-H", "Accept: application/vnd.github+json", url, "--jq", jq],
    { runner }
  );
  if (!output) return [];
  return output
    .split("\n")
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

async function fetchArtifacts(runId, { runner } = {}) {
  const jq = ".artifacts[] | @json";
  const url = `/repos/${REPO_OWNER}/${REPO_NAME}/actions/runs/${runId}/artifacts?per_page=100`;
  const output = await runGh(
    ["api", "--paginate", "-H", "Accept: application/vnd.github+json", url, "--jq", jq],
    { runner }
  );
  if (!output) return [];
  return output
    .split("\n")
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function buildNightlyKey(runStartedAt, headSha) {
  const datePart = String(runStartedAt || "unknown-date")
    .trim()
    .replace(/:/g, "-")
    .replace(/[^0-9A-Za-z._-]+/g, "_");
  const shaPart = String(headSha || "unknown-sha")
    .trim()
    .replace(/[^0-9A-Za-z._-]+/g, "_");
  return normalizeNightlyBuildKey(`${datePart}_${shaPart}`);
}

function buildNightlyVersionLabel(entry) {
  const bundle = entry?.bundleVersionNormalized || entry?.bundleVersionRaw || "main";
  const sha = shortSha(entry?.headSha || "");
  const date = String(entry?.runStartedAt || entry?.date || entry?.buildKey || "")
    .replace(/^(\d{4}-\d{2}-\d{2}).*$/, "$1")
    .trim();
  return [bundle, sha, date].filter(Boolean).join(" · ");
}

async function listNightlyBuilds({ latestOnly, runner } = {}) {
  const runs = await fetchRuns({ latestOnly, runner });
  runs.sort((a, b) => getRunDate(b).timestamp - getRunDate(a).timestamp);
  const matches = [];

  for (const run of runs) {
    if (run?.head_branch !== "main") continue;
    if (run?.conclusion !== "success") continue;
    const artifacts = await fetchArtifacts(run.id, { runner });
    const artifact = artifacts.find(item =>
      String(item?.name || "").toLowerCase().includes(NIGHTLY_ARTIFACT_NEEDLE)
    );
    if (!artifact) continue;
    const { value } = getRunDate(run);
    matches.push({
      channel: CHANNEL_NIGHTLY,
      version: buildNightlyKey(value, run.head_sha || ""),
      buildKey: buildNightlyKey(value, run.head_sha || ""),
      runId: run.id,
      artifactId: artifact.id,
      artifactName: artifact.name || null,
      headSha: run.head_sha || null,
      runStartedAt: value,
      label: buildNightlyVersionLabel({
        buildKey: buildNightlyKey(value, run.head_sha || ""),
        headSha: run.head_sha || null,
        runStartedAt: value
      })
    });
    if (latestOnly) break;
  }

  return {
    versions: matches.map(entry => entry.buildKey),
    entries: matches,
    entriesByVersion: Object.fromEntries(matches.map(entry => [entry.buildKey, entry])),
    source: `gh api /repos/${REPO_OWNER}/${REPO_NAME}/actions/workflows/main.yml/runs`
  };
}

async function extractZip(zipPath, destDir, signal) {
  ensureDir(destDir);
  await runCommand("/usr/bin/ditto", ["-x", "-k", zipPath, destDir], { signal });
}

function copyAppBundle(sourceAppPath, destAppPath) {
  safeRm(destAppPath);
  ensureDir(path.dirname(destAppPath));
  fs.cpSync(sourceAppPath, destAppPath, { recursive: true });
}

function findZipFiles(rootDir, maxDepth = 4) {
  const matches = [];
  const queue = [{ dir: rootDir, depth: 0 }];
  while (queue.length) {
    const current = queue.shift();
    if (!current) break;
    let entries = [];
    try {
      entries = fs.readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current.dir, entry.name);
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".zip")) {
        matches.push(full);
        continue;
      }
      if (entry.isDirectory() && current.depth < maxDepth) {
        queue.push({ dir: full, depth: current.depth + 1 });
      }
    }
  }
  matches.sort((a, b) => a.localeCompare(b));
  return matches;
}

async function resolveExtractedApp(rootDir, signal) {
  let appPath = findAppBundle(rootDir, "love.app");
  if (appPath) return appPath;
  const archives = findZipFiles(rootDir).filter(filePath =>
    filePath.toLowerCase().includes(".app.zip") || path.basename(filePath).toLowerCase().includes("love")
  );
  for (const archive of archives) {
    await extractZip(archive, path.dirname(archive), signal);
    appPath = findAppBundle(rootDir, "love.app");
    if (appPath) return appPath;
  }
  return findAppBundle(rootDir, "love.app");
}

async function installStableVersion({
  userDataDir,
  version,
  logger,
  onProgress,
  signal,
  entriesByVersion
} = {}) {
  const targetVersion = normalizeLoveVersion(version);
  if (!targetVersion) throw new Error(`Invalid LÖVE version: ${String(version || "")}`);
  const existing = resolveInstalled({ userDataDir, channel: CHANNEL_STABLE, version: targetVersion });
  if (existing?.appPath) return existing;

  let entry = entriesByVersion?.[targetVersion] || null;
  if (!entry) {
    const refreshed = await fetchAvailableVersions({ logger });
    entry = refreshed.entriesByVersion[targetVersion] || null;
  }
  if (!entry?.browserDownloadUrl) {
    throw new Error(`LÖVE release v${targetVersion} was not found.`);
  }

  const installDir = getInstallDir({ userDataDir, channel: CHANNEL_STABLE, version: targetVersion });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-love-stable-"));
  const archivePath = path.join(tmpDir, entry.assetName || `love-${targetVersion}.zip`);

  try {
    await downloadToFile(entry.browserDownloadUrl, archivePath, {
      headers: {
        "User-Agent": "maclauncher",
        "Accept": "application/octet-stream"
      },
      onProgress,
      signal
    });
    const unpackDir = path.join(tmpDir, "unpacked");
    await extractZip(archivePath, unpackDir, signal);
    const sourceAppPath = await resolveExtractedApp(unpackDir, signal);
    if (!sourceAppPath) {
      throw new Error(`Could not find love.app in ${entry.assetName || "downloaded archive"}.`);
    }
    const destAppPath = path.join(installDir, "love.app");
    copyAppBundle(sourceAppPath, destAppPath);
    const bundleInfo = readBundleInfo(destAppPath);
    writeInstallMeta(installDir, {
      channel: CHANNEL_STABLE,
      version: targetVersion,
      source: "GitHub Releases",
      installedAt: new Date().toISOString(),
      browserDownloadUrl: entry.browserDownloadUrl,
      assetName: entry.assetName || null,
      bundleVersionRaw: bundleInfo.bundleVersionRaw,
      bundleVersionNormalized: bundleInfo.bundleVersionNormalized || targetVersion,
      architecture: bundleInfo.architecture,
      requiresRosetta: bundleInfo.requiresRosetta
    });
    return resolveInstalled({ userDataDir, channel: CHANNEL_STABLE, version: targetVersion });
  } finally {
    safeRm(tmpDir);
  }
}

async function installNightlyVersion({
  userDataDir,
  entry,
  logger,
  signal
} = {}) {
  const buildKey = normalizeNightlyBuildKey(entry?.buildKey || entry?.version);
  if (!buildKey) throw new Error("Missing LÖVE nightly build key.");
  const existing = resolveInstalled({ userDataDir, channel: CHANNEL_NIGHTLY, version: buildKey });
  if (existing?.appPath) return existing;
  if (!entry?.artifactId) {
    throw new Error(`Nightly build ${buildKey} is missing an artifact id.`);
  }

  const installDir = getInstallDir({ userDataDir, channel: CHANNEL_NIGHTLY, version: buildKey });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-love-nightly-"));
  const archivePath = path.join(tmpDir, `${buildKey}.zip`);

  try {
    logger?.info?.(`[love] downloading nightly ${buildKey} with gh`);
    await runGhToFile(
      ["api", `/repos/${REPO_OWNER}/${REPO_NAME}/actions/artifacts/${entry.artifactId}/zip`],
      archivePath,
      { signal }
    );
    const unpackDir = path.join(tmpDir, "unpacked");
    await extractZip(archivePath, unpackDir, signal);
    const sourceAppPath = await resolveExtractedApp(unpackDir, signal);
    if (!sourceAppPath) {
      throw new Error(`Could not find love.app in nightly artifact ${buildKey}.`);
    }
    const destAppPath = path.join(installDir, "love.app");
    copyAppBundle(sourceAppPath, destAppPath);
    const bundleInfo = readBundleInfo(destAppPath);
    writeInstallMeta(installDir, {
      channel: CHANNEL_NIGHTLY,
      buildKey,
      version: buildKey,
      source: "GitHub Actions",
      installedAt: new Date().toISOString(),
      bundleVersionRaw: bundleInfo.bundleVersionRaw,
      bundleVersionNormalized: bundleInfo.bundleVersionNormalized,
      architecture: bundleInfo.architecture,
      requiresRosetta: bundleInfo.requiresRosetta,
      runId: entry.runId || null,
      artifactId: entry.artifactId || null,
      artifactName: entry.artifactName || null,
      headSha: entry.headSha || null,
      runStartedAt: entry.runStartedAt || null
    });
    return resolveInstalled({ userDataDir, channel: CHANNEL_NIGHTLY, version: buildKey });
  } finally {
    safeRm(tmpDir);
  }
}

function uninstallVersion({ userDataDir, channel, version, installDir } = {}) {
  const targetInstallDir =
    installDir ||
    (version
      ? getInstallDir({ userDataDir, channel, version })
      : null);
  if (!targetInstallDir) return false;
  safeRm(targetInstallDir);
  return true;
}

function formatNightlyDate(input) {
  const timestamp = parseNightlyBuildTimestamp(input);
  if (timestamp == null) return "";
  return new Date(timestamp).toISOString().slice(0, 10);
}

function isRosettaAvailable({ force = false } = {}) {
  if (process.platform !== "darwin" || process.arch !== "arm64") return true;
  if (!force && typeof isRosettaAvailable.cached === "boolean") return isRosettaAvailable.cached;
  try {
    const result = spawnSync("arch", ["-x86_64", "/usr/bin/true"], { stdio: "ignore" });
    isRosettaAvailable.cached = result.status === 0;
  } catch {
    isRosettaAvailable.cached = false;
  }
  return isRosettaAvailable.cached;
}

module.exports = {
  REPO_OWNER,
  REPO_NAME,
  INSTALL_META_FILE,
  CHANNEL_STABLE,
  CHANNEL_NIGHTLY,
  NIGHTLY_WORKFLOW,
  NIGHTLY_ARTIFACT_NEEDLE,
  normalizeChannel,
  normalizeVersion: normalizeLoveVersion,
  compareVersions: compareLoveVersions,
  compareVersionsDesc: compareLoveVersionsDesc,
  compareNightlyBuildKeysDesc,
  buildNightlyKey,
  buildNightlyVersionLabel,
  formatNightlyDate,
  installRootDir,
  getInstallDir,
  listInstalled,
  listInstalledStable,
  listInstalledNightly,
  resolveInstalled,
  resolveLatestInstalled,
  findNightlyByBundleVersion,
  readInstallMeta,
  writeInstallMeta,
  readBundleInfo,
  resolveExecutablePath,
  fetchAvailableVersions,
  canUseGh,
  listNightlyBuilds,
  installStableVersion,
  installNightlyVersion,
  uninstallVersion,
  isRosettaAvailable,
  __test: {
    pickStableReleaseAsset,
    sortStableReleases
  }
};
