const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const Rosetta = require("../../shared/runtime/rosetta");
const AppBundle = require("../../shared/runtime/app-bundle");
const { hasFineChangeTime } = require("../../shared/file-time");
const { createVerifiedIdentityCache } = require("../../shared/runtime/verified-identity");
const { readMachOLoadCommands } = require("../../shared/runtime/macho-load-commands");
const Upstream = require("../../shared/runtime/upstream");
const Archive = require("../../shared/runtime/archive");
const ReleaseFiles = require("../../shared/runtime/release-files");
const {
  normalizeLoveVersion,
  compareLoveVersions,
  compareLoveVersionsDesc,
  normalizeNightlyBuildKey,
  compareNightlyBuildKeysDesc,
  shortSha
} = require("../version");

const REPO_OWNER = "love2d";
const REPO_NAME = "love";
const INSTALL_META_FILE = ".maclauncher-love.json";
const CHANNEL_STABLE = "stable";
const CHANNEL_NIGHTLY = "nightly";
const NIGHTLY_WORKFLOW = "main.yml";
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
  if (existsFile(appPath)) return appPath;
  return AppBundle.resolveAppBundleExecutablePath(appPath);
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
          requiresRosetta: require("../../shared/runtime/architecture").requiresRosetta("x64")
        };
      }
    }
  } catch {}
  return { architecture: "unknown", requiresRosetta: false };
}

function validateDownloadedBundle(appPath, { arch = require("../../shared/runtime/architecture").selectedArchitecture() } = {}) {
  const executable = resolveExecutablePath(appPath);
  const info = readMachOLoadCommands(executable);
  const nativeArch = arch === "x64" ? "x86_64" : arch;
  if (!info.architectures.includes(nativeArch) && !(nativeArch === "arm64" && info.architectures.includes("x86_64"))) {
    throw new Error("The LÖVE download has no supported 64-bit executable for this Mac.");
  }
  return info.architectures;
}

const listingFacts = createVerifiedIdentityCache({ maximum: 64 });
function listingIdentity(appPath, executablePath) {
  try {
    return JSON.stringify([appPath, path.join(appPath, "Contents/Info.plist"), executablePath].map((file, index) => {
      const stat = fs.statSync(file, { bigint: true }), link = fs.lstatSync(file, { bigint: true });
      if (index && !hasFineChangeTime(stat)) throw new Error("Coarse bundle facts cannot be reused.");
      const facts = value => [value.dev, value.ino, value.mode, value.size, value.mtimeNs, value.ctimeNs].map(String);
      return [fs.realpathSync(file), facts(stat), facts(link)];
    }));
  } catch { return null; }
}

function readBundleInfo(appPath, { listing = false } = {}) {
  if (!listing) return readBundleInfoUncached(appPath, false);
  const executablePath = resolveExecutablePath(appPath);
  const status = AppBundle.appBundleStatus(appPath, { executablePath });
  if (!status.ready) return { ...readBundleInfoUncached(appPath, true), ...status };
  let unavailable;
  const info = listingFacts.verify(appPath, {
    identity: () => listingIdentity(appPath, resolveExecutablePath(appPath)),
    verify: () => {
      const value = readBundleInfoUncached(appPath, true);
      if (!value.ready) { unavailable = value; return false; }
      return value;
    }
  });
  return { ...(info || unavailable) };
}

function readBundleInfoUncached(appPath, listing) {
  const plistInfo = readAppBundleInfo(appPath);
  const executablePath = resolveExecutablePath(appPath);
  const status = AppBundle.appBundleStatus(appPath, { executablePath });
  const architectureInfo = status.ready
    ? detectArchitecture(executablePath)
    : { architecture: "unknown", requiresRosetta: false };
  const info = {
    appPath,
    executablePath,
    ...status,
    bundleVersionRaw: plistInfo.bundleVersionRaw || null,
    bundleVersionNormalized: normalizeLoveVersion(plistInfo.bundleVersionRaw) || null,
    architecture: architectureInfo.architecture,
    requiresRosetta: architectureInfo.requiresRosetta
  };
  return info;
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
  return structuredClone(require("../../../core/coordinated-runtime-managers").memoizeRuntimeResolution(module.exports,
    JSON.stringify(["listInstalledStable", userDataDir]), () => listInstalledStableUncached(userDataDir)));
}

function listInstalledStableUncached(userDataDir) {
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
    const bundleInfo = readBundleInfo(appPath, { listing: true });
    out.push({
      channel: CHANNEL_STABLE,
      version,
      installDir,
      appPath,
      executablePath: bundleInfo.executablePath,
      ready: bundleInfo.ready,
      reason: bundleInfo.reason,
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
  return structuredClone(require("../../../core/coordinated-runtime-managers").memoizeRuntimeResolution(module.exports,
    JSON.stringify(["listInstalledNightly", userDataDir]), () => listInstalledNightlyUncached(userDataDir)));
}

function listInstalledNightlyUncached(userDataDir) {
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
    const bundleInfo = readBundleInfo(appPath, { listing: true });
    out.push({
      channel: CHANNEL_NIGHTLY,
      version: buildKey,
      buildKey,
      installDir,
      appPath,
      executablePath: bundleInfo.executablePath,
      ready: bundleInfo.ready,
      reason: bundleInfo.reason,
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
      if (!entry.ready) return false;
      const matches = installChannel === CHANNEL_NIGHTLY ? entry.buildKey === normalizedVersion : entry.version === normalizedVersion;
      return matches && AppBundle.appBundleStatus(entry.appPath, { executablePath: entry.executablePath }).ready;
    }) || null
  );
}

function findNightlyByBundleVersion({ userDataDir, version }) {
  const normalized = normalizeLoveVersion(version);
  if (!normalized) return null;
  return (
    listInstalledNightly(userDataDir).find(entry => entry.ready && entry.bundleVersionNormalized === normalized) || null
  );
}

function normalizeReleaseVersion(release) {
  return normalizeLoveVersion(release?.tag_name || release?.name || "");
}

// Any archive format the publisher switches to; libraries, iOS and source
// packages are not the Mac application.
function isMacReleaseAsset(asset) {
  const lower = String(asset?.name || "").toLowerCase();
  if (!Archive.archiveKind(lower) || /apple-libraries|ios|source|debug|symbols/.test(lower)) return false;
  return lower.includes("macos") || lower.includes("macosx");
}

function scoreMacReleaseAsset(asset) {
  const lower = String(asset?.name || "").toLowerCase();
  let score = 0;
  if (/-macos\.[a-z0-9.]+$/.test(lower)) score += 400;
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

// Stable releases from 0.7.0, the first with a 64-bit Mac build, with the Mac
// archive under its current name or a renamed or reformatted one.
const stableSource = Upstream.github({ repository: `${REPO_OWNER}/${REPO_NAME}`, allArchitectures: true, recognize: release => {
  const version = normalizeReleaseVersion(release), asset = pickStableReleaseAsset(release);
  return version && asset && compareLoveVersions(version, "0.7.0") >= 0 ? { version, assets: [asset] } : null;
} });

// One row per version, from its newest release.
async function fetchAvailableVersions({ logger, signal } = {}) {
  const entries = [], entriesByVersion = {};
  for (const row of (await stableSource.discover({ logger, signal })).slice().sort((a, b) => compareLoveVersionsDesc(a.version, b.version))) {
    if (entriesByVersion[row.version] || !row.files[0]) continue;
    const file = row.files[0];
    entriesByVersion[row.version] = { channel: CHANNEL_STABLE, version: row.version, file,
      browserDownloadUrl: file.url, assetName: file.name, sha256: file.digest?.algorithm === "sha256" ? file.digest.value : null };
    entries.push(entriesByVersion[row.version]);
  }
  return { versions: entries.map(entry => entry.version), entries, entriesByVersion, source: `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases` };
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
  const bundle = entry?.bundleVersionNormalized || entry?.bundleVersionRaw || entry?.sourceVersion || "Version unknown";
  const sha = shortSha(entry?.headSha || "");
  const date = String(entry?.runStartedAt || entry?.date || entry?.buildKey || "")
    .replace(/^(\d{4}-\d{2}-\d{2}).*$/, "$1")
    .trim();
  return [bundle, sha, date].filter(Boolean).join(" · ");
}

// The upstream version in src/common/version.h at a workflow commit.
async function fetchNightlySourceVersion(headSha, { logger, signal } = {}) {
  if (!/^[a-f0-9]{40}$/i.test(headSha || "")) return null;
  const header = Upstream.index({ locations: [`https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${headSha.toLowerCase()}/src/common/version.h`],
    parse: ([document]) => { const version = /^\s*#define\s+LOVE_VERSION_STRING\s+"([0-9]+(?:\.[0-9]+)+)"/m.exec(document.text)?.[1]; return version ? [{ version }] : []; } });
  try { return (await header.discover({ logger, signal }))[0]?.version || null; }
  catch { if (signal?.aborted) throw signal.reason; return null; }
}

// Successful main-branch builds publish a Mac artifact; GitHub's digest
// verifies each one. The short scan lists the newest build.
const nightlySource = Upstream.githubActions({ repository: `${REPO_OWNER}/${REPO_NAME}`, workflow: NIGHTLY_WORKFLOW, branch: "main", limit: 1, maxRuns: 20,
  recognize: async (artifact, { run, signal }) => {
    if (!String(artifact?.name || "").toLowerCase().includes(NIGHTLY_ARTIFACT_NEEDLE)) return null;
    const runStartedAt = run.run_started_at || run.created_at, headSha = run.head_sha.toLowerCase(), buildKey = buildNightlyKey(runStartedAt, headSha);
    const sourceVersion = await fetchNightlySourceVersion(headSha, { signal });
    const details = { runId: run.id, artifactId: artifact.id, artifactName: artifact.name || null, headSha, sourceVersion,
      sourceVersionSource: sourceVersion ? "src/common/version.h at the workflow commit" : null, runStartedAt };
    return buildKey ? { version: buildKey, label: buildNightlyVersionLabel({ buildKey, ...details }), details } : null;
  } });

async function listNightlyBuilds({ latestOnly, logger, signal } = {}) {
  const matches = (await nightlySource.discover({ logger, signal, latestOnly: latestOnly !== false })).filter(row => row.files[0])
    .map(row => ({ channel: CHANNEL_NIGHTLY, version: row.version, buildKey: row.version, label: row.label, file: row.files[0], ...row.details }));
  return {
    versions: matches.map(entry => entry.buildKey),
    entries: matches,
    entriesByVersion: Object.fromEntries(matches.map(entry => [entry.buildKey, entry])),
    source: `https://github.com/${REPO_OWNER}/${REPO_NAME}/actions/workflows/${NIGHTLY_WORKFLOW}`
  };
}

async function extractZip(zipPath, destDir, signal) {
  ensureDir(destDir);
  await ReleaseFiles.extractArchive(zipPath, destDir, signal);
}

function copyAppBundle(sourceAppPath, destAppPath) {
  return AppBundle.copyAppBundle(sourceAppPath, destAppPath);
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
  if (compareLoveVersions(targetVersion, "0.7.0") < 0) throw new Error("LÖVE releases before 0.7 have no 64-bit macOS download.");
  const existing = resolveInstalled({ userDataDir, channel: CHANNEL_STABLE, version: targetVersion });
  if (existing?.appPath) return existing;

  let entry = entriesByVersion?.[targetVersion] || null;
  if (!entry) {
    const refreshed = await fetchAvailableVersions({ logger });
    entry = refreshed.entriesByVersion[targetVersion] || null;
  }
  if (!entry?.file && !entry?.browserDownloadUrl) {
    throw new Error(`LÖVE release v${targetVersion} was not found.`);
  }

  const installDir = getInstallDir({ userDataDir, channel: CHANNEL_STABLE, version: targetVersion });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-love-stable-"));
  const file = entry.file || Upstream.listedFile({ filename: entry.assetName, url: entry.browserDownloadUrl, sha256: entry.sha256 });
  const archivePath = path.join(tmpDir, file.name);

  try {
    // GitHub's published digest verifies the file behind the release URL.
    const { sha256, integrity } = await stableSource.download(file, archivePath, { onProgress, signal });
    const unpackDir = path.join(tmpDir, "unpacked");
    await extractZip(archivePath, unpackDir, signal);
    const sourceAppPath = await resolveExtractedApp(unpackDir, signal);
    if (!sourceAppPath) {
      throw new Error(`Could not find love.app in ${entry.assetName || "downloaded archive"}.`);
    }
    validateDownloadedBundle(sourceAppPath);
    const destAppPath = path.join(installDir, "love.app");
    copyAppBundle(sourceAppPath, destAppPath);
    const bundleInfo = readBundleInfo(destAppPath);
    writeInstallMeta(installDir, {
      channel: CHANNEL_STABLE,
      version: targetVersion,
      source: "GitHub Releases",
      installedAt: new Date().toISOString(),
      browserDownloadUrl: file.url,
      assetName: file.name,
      archiveSha256: sha256,
      integrity,
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
  onProgress,
  signal
} = {}) {
  const buildKey = normalizeNightlyBuildKey(entry?.buildKey || entry?.version);
  if (!buildKey) throw new Error("Missing LÖVE nightly build key.");
  const existing = resolveInstalled({ userDataDir, channel: CHANNEL_NIGHTLY, version: buildKey });
  if (existing?.appPath) return existing;
  if (!entry?.file) {
    throw new Error(`Nightly build ${buildKey} is no longer available for download.`);
  }

  const installDir = getInstallDir({ userDataDir, channel: CHANNEL_NIGHTLY, version: buildKey });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-love-nightly-"));
  const archivePath = path.join(tmpDir, `${buildKey}.zip`);

  try {
    logger?.info?.(`[love] downloading nightly ${buildKey}`);
    const { sha256, integrity } = await nightlySource.download(entry.file, archivePath, { onProgress, signal });
    const unpackDir = path.join(tmpDir, "unpacked");
    await extractZip(archivePath, unpackDir, signal);
    const sourceAppPath = await resolveExtractedApp(unpackDir, signal);
    if (!sourceAppPath) {
      throw new Error(`Could not find love.app in nightly artifact ${buildKey}.`);
    }
    validateDownloadedBundle(sourceAppPath);
    const destAppPath = path.join(installDir, "love.app");
    copyAppBundle(sourceAppPath, destAppPath);
    const bundleInfo = readBundleInfo(destAppPath);
    writeInstallMeta(installDir, {
      channel: CHANNEL_NIGHTLY,
      buildKey,
      version: buildKey,
      source: "GitHub Actions",
      installedAt: new Date().toISOString(),
      archiveSha256: sha256,
      integrity,
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

function isRosettaAvailable({ force = false } = {}) {
  return Rosetta.isAvailable({ force });
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
  installRootDir,
  getInstallDir,
  listInstalled,
  listInstalledStable,
  listInstalledNightly,
  resolveInstalled,
  findNightlyByBundleVersion,
  readInstallMeta,
  writeInstallMeta,
  readBundleInfo,
  resolveExecutablePath,
  fetchAvailableVersions,
  listNightlyBuilds,
  installStableVersion,
  installNightlyVersion,
  uninstallVersion,
  isRosettaAvailable,
  upstream: [stableSource, nightlySource],
  __test: {
    copyAppBundle,
    validateDownloadedBundle,
    pickStableReleaseAsset
  }
};
