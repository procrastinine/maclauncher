const fs = require("node:fs");
const { cloneOrCopy } = require("../../shared/copy-file");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { findMacLibDir, SDK_LAYOUT_FILE } = require("./patcher");
const Archive = require("../../shared/runtime/archive");
const ReleaseFiles = require("../../shared/runtime/release-files");
const Upstream = require("../../shared/runtime/upstream");
const {
  attachAbortSignal,
  createAbortError,
  throwIfAborted
} = require("../../shared/runtime/download-utils");

const DL = "https://www.renpy.org/dl/";
const LATEST = Object.freeze({ 8: "https://renpy.org/latest.html", 7: "https://renpy.org/latest-7.html" });

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function safeRm(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {}
}

function normalizeVersion(input) {
  const v = String(input ?? "").trim().replace(/^v/i, "");
  if (!/^\d+\.\d+\.\d+$/.test(v)) {
    throw new Error(`Invalid Ren'Py version: ${String(input ?? "")}`);
  }
  return v;
}

function normalizeMajor(input) {
  const major = Number(input);
  if (!Number.isFinite(major)) {
    throw new Error(`Invalid Ren'Py major: ${String(input ?? "")}`);
  }
  if (major >= 8) return 8;
  if (major >= 1) return 7;
  throw new Error(`Invalid Ren'Py major: ${String(input ?? "")}`);
}

function parseSemver(v) {
  const m = String(v || "").trim().replace(/^v/i, "").match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compareSemverDesc(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return String(b || "").localeCompare(String(a || ""));
  for (let i = 0; i < 3; i++) {
    const d = pb[i] - pa[i];
    if (d !== 0) return d;
  }
  return 0;
}

function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return String(a || "").localeCompare(String(b || ""));
  for (let i = 0; i < 3; i++) {
    const d = pa[i] - pb[i];
    if (d !== 0) return d;
  }
  return 0;
}

// Python 2 releases (Ren'Py 7 and earlier) and Python 3 releases (Ren'Py 8
// and later) form the two groups.
function majorGroup(version) {
  const parsed = parseSemver(version);
  return !parsed || parsed[0] < 1 ? null : parsed[0] >= 8 ? 8 : 7;
}
function isVersionInMajorGroup(version, major) {
  return majorGroup(version) === normalizeMajor(major);
}

// The SDK archives a version folder lists, with the SHA-256 from its
// checksums.txt where that file lists one. Builds for other systems, such as
// the ARM Linux sdkarm archive, are not read.
function folderSource(version) {
  const folder = `${DL}${version}/`, prefix = `renpy-${version}-sdk`;
  return Upstream.index({ locations: [folder, `${folder}checksums.txt`], hosts: ["renpy.org"], parse: documents => {
    const listing = documents.find(document => document.url === folder);
    if (!listing) return [];
    const sums = (documents.find(document => document.url !== folder)?.text || "").split("\n").map(line => line.trim().split(/\s+\*?/));
    const files = [...listing.text.matchAll(/href\s*=\s*["']([^"'?#]+)["']/gi)].map(match => path.posix.basename(match[1]))
      .filter(name => name.startsWith(prefix) && ReleaseFiles.archiveFormat(name) &&
        /^(?:[-_.](?:mac|macos|osx|universal))?$/i.test(name.slice(prefix.length, -ReleaseFiles.archiveFormat(name).length)))
      .map(name => ({ name, url: folder + name, digest: sums.find(([hash, listed]) => listed === name && /^[a-f0-9]{64}$/i.test(hash))?.[0] }));
    return files.length ? [{ version, sourceUrl: folder, files }] : [];
  } });
}

// The SDK file a version folder lists: the caller's formats first, then any
// other archive. Null when the folder cannot be read.
async function findListedDownload(version, { signal, formats = [".dmg", ".zip"] } = {}) {
  const v = normalizeVersion(version);
  let rows;
  try { rows = await folderSource(v).discover({ signal }); } catch { throwIfAborted(signal); return null; }
  const rank = name => { const index = formats.indexOf(ReleaseFiles.archiveFormat(name)); return index < 0 ? formats.length : index; };
  return [...(rows[0]?.files || [])].sort((a, b) => rank(a.name) - rank(b.name))[0] || null;
}
// The listed SDK file, or the folder's usual `renpy-<version>-sdk` name in the
// first format when the listing cannot be read.
async function sdkDownload(version, { signal, formats = [".dmg", ".zip"] } = {}) {
  const v = normalizeVersion(version), name = `renpy-${v}-sdk${formats[0]}`;
  return await findListedDownload(v, { signal, formats }) || Upstream.listedFile({ filename: name, url: `${DL}${v}/${name}` });
}

function installRootDir(userDataDir) {
  return path.join(userDataDir, "runtimes", "sdk");
}

function getInstallDir({ userDataDir, major, version }) {
  const m = normalizeMajor(major);
  const v = normalizeVersion(version);
  return path.join(installRootDir(userDataDir), String(m), v);
}

function looksLikeSdkRoot(dir) {
  const markers = ["renpy.app", "Ren'Py.app", "renpy.sh", "renpy.py"];
  return markers.some(name => fs.existsSync(path.join(dir, name)));
}

function isReadySdk(installDir, major) {
  const lib = findMacLibDir(installDir, major);
  try {
    return fs.statSync(path.join(installDir, "renpy.sh")).isFile() &&
      Boolean(lib && fs.statSync(path.join(lib.dir, "renpy")).isFile());
  } catch { return false; }
}

// Ren'Py's Mac SDK stores the programs in lib/py*-mac-* as `<name>.macho`
// with a five-byte "RENPY" prefix, which its launcher strips on first start
// (launcher/game/mac.rpy). Installation does the same, so the SDK is ready
// without opening its launcher.
function restoreMacBinaries(installDir) {
  let folders = [];
  try { folders = fs.readdirSync(path.join(installDir, "lib"), { withFileTypes: true }).filter(item => item.isDirectory() && /mac/i.test(item.name)); }
  catch { return; }
  for (const folder of folders) {
    const directory = path.join(installDir, "lib", folder.name);
    for (const name of fs.readdirSync(directory).filter(item => item.endsWith(".macho"))) {
      const file = path.join(directory, name), target = file.slice(0, -".macho".length), data = fs.readFileSync(file);
      fs.writeFileSync(target, data.subarray(data.subarray(0, 5).toString("latin1") === "RENPY" ? 5 : 0));
      fs.chmodSync(target, 0o755);
      fs.unlinkSync(file);
    }
  }
}

function findSdkRoot(mountDir, version) {
  if (looksLikeSdkRoot(mountDir)) return mountDir;

  let entries = [];
  try {
    entries = fs.readdirSync(mountDir, { withFileTypes: true }).filter(d => d.isDirectory());
  } catch {
    entries = [];
  }

  let best = null;
  let bestScore = -1;
  for (const entry of entries) {
    const full = path.join(mountDir, entry.name);
    if (!looksLikeSdkRoot(full)) continue;
    const name = entry.name.toLowerCase();
    let score = 0;
    if (name.includes("renpy")) score += 1;
    if (name.includes("sdk")) score += 1;
    if (version && name.includes(String(version).toLowerCase())) score += 2;
    if (score > bestScore) {
      best = full;
      bestScore = score;
    }
  }

  // A release that moves the SDK further down is searched breadth first.
  best ||= Archive.findEntry(mountDir, (file, item) => item.isDirectory() && looksLikeSdkRoot(file), { maxDepth: 3 });
  if (!best) throw new Error("Ren'Py SDK not found in the download");
  return best;
}

function getLauncherPath(installDir) {
  const candidates = ["Ren'Py.app", "renpy.app"];
  for (const name of candidates) {
    const p = path.join(installDir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const SDK_PRIME_DELAY_MS = 4000;

function buildPrimeLauncherArgs(launcherPath, delayMs = SDK_PRIME_DELAY_MS) {
  const delaySeconds = Math.max(0, Number(delayMs) || 0) / 1000;
  return [
    "-e",
    "on run argv",
    "-e",
    "set appAlias to POSIX file (item 1 of argv) as alias",
    "-e",
    "set appRef to appAlias as text",
    "-e",
    "tell application appRef to launch",
    "-e",
    `delay ${delaySeconds}`,
    "-e",
    "tell application appRef to quit",
    "-e",
    "end run",
    launcherPath
  ];
}

async function primeLauncherApp(
  launcherPath,
  { logger, signal, delayMs = SDK_PRIME_DELAY_MS, platform = process.platform, runner = runCommand } = {}
) {
  const appPath = typeof launcherPath === "string" ? launcherPath.trim() : "";
  if (platform !== "darwin") return false;
  if (!appPath || !fs.existsSync(appPath)) return false;

  logger?.info?.(`[renpy] priming SDK app ${path.basename(appPath)}`);
  await runner("/usr/bin/osascript", buildPrimeLauncherArgs(appPath, delayMs), { signal });
  return true;
}

function listInstalled(userDataDir, major) {
  const m = normalizeMajor(major);
  const root = path.join(installRootDir(userDataDir), String(m));
  const out = [];

  let versions = [];
  try {
    versions = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory());
  } catch {
    return out;
  }

  for (const versionDir of versions) {
    const version = versionDir.name;
    if (!/^\d+\.\d+\.\d+$/.test(version) || !isVersionInMajorGroup(version, m)) continue;
    const installDir = path.join(root, version);
    if (!looksLikeSdkRoot(installDir)) continue;
    const ready = isReadySdk(installDir, m);
    out.push({
      ready,
      version,
      installDir,
      launcherPath: getLauncherPath(installDir)
    });
  }

  out.sort((a, b) => compareSemverDesc(a.version, b.version));
  return out;
}

function extractVersionsFromHtml(html) {
  const out = [];
  // A version folder link, relative or absolute.
  const re = /href\s*=\s*["'](?:[^"'?#]*\/)?(\d+\.\d+\.\d+)\/?["']/gi;
  let m = null;
  while ((m = re.exec(String(html || "")))) {
    if (m[1]) out.push(m[1]);
  }
  return out;
}

function parseLatestVersionFromHtml(html) {
  const text = String(html || "");
  const candidates = [
    /renpy-(\d+\.\d+\.\d+)-sdk\.dmg/i,
    /Ren'Py\s+(\d+\.\d+\.\d+)/i,
    /Renpy\s+(\d+\.\d+\.\d+)/i
  ];
  for (const re of candidates) {
    const m = re.exec(text);
    if (m && m[1]) return m[1];
  }
  return null;
}

// The download index lists one folder per version; latest.html and
// latest-7.html name each group's newest stable release, and a later folder
// is a prerelease. Without a latest page the folder list stands on its own.
const source = Upstream.index({ locations: [DL, LATEST[8], LATEST[7]], hosts: ["renpy.org"], parse: documents => {
  const listing = documents.find(document => document.url === DL);
  if (!listing) throw new Error("The Ren'Py download index is unavailable.");
  const stable = {};
  for (const major of [7, 8]) {
    const page = documents.find(document => document.url === LATEST[major]), version = page && parseLatestVersionFromHtml(page.text);
    if (version && majorGroup(version) === major) stable[major] = version;
  }
  return [...new Set([...extractVersionsFromHtml(listing.text), ...Object.values(stable)])].flatMap(version => {
    const major = majorGroup(version);
    if (!major || stable[major] && compareSemver(version, stable[major]) > 0) return [];
    return [{ version, channel: `v${major}`, sourceUrl: `${DL}${version}/`, details: { major, latestStable: stable[major] || null } }];
  });
} });

async function fetchAvailableVersions({ major, logger, signal, latestOnly } = {}) {
  const m = normalizeMajor(major);
  logger?.info?.(`[renpy] fetching versions from ${DL}`);
  let rows;
  try { rows = (await source.discover({ logger, signal })).filter(row => row.details?.major === m); }
  catch (error) { throwIfAborted(signal); throw error; }
  const versions = rows.map(row => row.version).sort(compareSemverDesc);
  if (!versions.length) throw new Error(`No Ren'Py ${m} SDK versions found`);
  return {
    versions: versions.slice(0, latestOnly === true ? 1 : 500),
    source: DL,
    mode: latestOnly === true ? "latest" : "all",
    latestStableVersion: rows[0]?.details?.latestStable || null
  };
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

async function installVersion({ userDataDir, version, major, logger, onProgress, signal }) {
  const v = normalizeVersion(version);
  const m = normalizeMajor(major);
  if (!isVersionInMajorGroup(v, m)) {
    throw new Error(`Ren'Py version ${v} does not match major ${m}`);
  }

  const installDir = getInstallDir({ userDataDir, major: m, version: v });
  if (isReadySdk(installDir, m)) {
    return { version: v, installDir, launcherPath: getLauncherPath(installDir), ready: true };
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-renpy-"));
  const unpackedDir = path.join(tmpDir, "unpacked");
  ensureDir(unpackedDir);

  try {
    // The version folder names the SDK file; a listed SHA-256 is checked.
    const file = await sdkDownload(v, { signal, formats: [".dmg", ".zip"] });
    const dmgPath = path.join(tmpDir, file.name);
    logger?.info?.(`[renpy] downloading ${file.url}`);
    await source.download(file, dmgPath, { onProgress, signal });
    throwIfAborted(signal);

    // A disk image is mounted, copied and detached by the shared extractor.
    logger?.info?.(`[renpy] unpacking ${path.basename(dmgPath)}`);
    await ReleaseFiles.extractArchive(dmgPath, unpackedDir, signal);
    throwIfAborted(signal);

    const sdkRoot = findSdkRoot(unpackedDir, v);

    safeRm(installDir);
    ensureDir(path.dirname(installDir));

    logger?.info?.(`[renpy] copying SDK to ${installDir}`);
    await cloneOrCopy(sdkRoot, installDir, { signal });
    restoreMacBinaries(installDir);

    if (!isReadySdk(installDir, m)) {
      throw new Error("Installed Ren'Py SDK missing expected files");
    }
    const layout = findMacLibDir(installDir, m, {version: v});
    try {
      fs.writeFileSync(path.join(installDir, SDK_LAYOUT_FILE), JSON.stringify({version: v,
        macLibDirName: layout.name, platform: layout.platform}, null, 2));
    } catch (error) { logger?.warn?.(`[renpy] could not record SDK layout: ${error.message}`); }

    const launcherPath = getLauncherPath(installDir);
    try {
      await primeLauncherApp(launcherPath, { logger, signal });
    } catch (e) {
      logger?.warn?.(`[renpy] failed to prime SDK app: ${String(e?.message || e)}`);
    }

    return { version: v, installDir, launcherPath };
  } finally {
    safeRm(tmpDir);
  }
}

function uninstallVersion({ userDataDir, version, major }) {
  const v = normalizeVersion(version);
  const m = normalizeMajor(major);
  const dir = getInstallDir({ userDataDir, major: m, version: v });
  safeRm(dir);
  return true;
}

module.exports = {
  normalizeVersion,
  normalizeMajor,
  installRootDir,
  listInstalled,
  fetchAvailableVersions,
  installVersion,
  uninstallVersion,
  findListedDownload,
  sdkDownload,
  findSdkRoot,
  source,
  __test: {
    restoreMacBinaries,
    buildPrimeLauncherArgs,
    extractVersionsFromHtml,
    findListedDownload,
    findSdkRoot,
    isVersionInMajorGroup,
    primeLauncherApp
  }
};
