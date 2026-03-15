const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { spawn } = require("node:child_process");
const {
  attachAbortSignal,
  createAbortError,
  fetchUrlBuffer,
  downloadToFile,
  throwIfAborted
} = require("../../shared/runtime/download-utils");

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

function isVersionInMajorGroup(version, major) {
  const parsed = parseSemver(version);
  if (!parsed) return false;
  const m = normalizeMajor(major);
  const vMajor = parsed[0];
  if (m === 7) return vMajor >= 1 && vMajor <= 7;
  return vMajor === 8;
}

function getDownloadUrl(version) {
  const v = normalizeVersion(version);
  return `https://www.renpy.org/dl/${v}/renpy-${v}-sdk.dmg`;
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

  if (!best) throw new Error("Ren'Py SDK not found in DMG");
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
    if (!/^\d+\.\d+\.\d+$/.test(version)) continue;
    const installDir = path.join(root, version);
    if (!looksLikeSdkRoot(installDir)) continue;
    out.push({
      version,
      installDir,
      launcherPath: getLauncherPath(installDir)
    });
  }

  out.sort((a, b) => compareSemverDesc(a.version, b.version));
  return out;
}

function decodeBody(body, headers) {
  const enc = String(headers?.["content-encoding"] || "").toLowerCase();
  try {
    if (enc.includes("gzip")) return zlib.gunzipSync(body);
    if (enc.includes("deflate")) return zlib.inflateSync(body);
    if (enc.includes("br")) return zlib.brotliDecompressSync(body);
  } catch {}
  return body;
}

function extractVersionsFromHtml(html) {
  const out = [];
  const re = /href=["'](?:\/dl\/)?(\d+\.\d+\.\d+)\/?["']/g;
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

async function fetchLatestStableVersion({ major, logger, signal } = {}) {
  const m = normalizeMajor(major);
  const url = m === 7 ? "https://renpy.org/latest-7.html" : "https://renpy.org/latest.html";
  logger?.info?.(`[renpy] fetching latest stable from ${url}`);
  const res = await fetchUrlBuffer(url, {
    headers: { "User-Agent": "MacLauncher" },
    signal
  });
  if (res.status !== 200) throw new Error(`Latest fetch failed (${res.status})`);
  const decoded = decodeBody(res.body, res.headers);
  const text = decoded.toString("utf8");
  const version = parseLatestVersionFromHtml(text);
  if (!version) throw new Error("Failed to parse latest Ren'Py version");
  const parsed = parseSemver(version);
  if (!parsed || parsed[0] !== m) {
    throw new Error(`Latest Ren'Py version mismatch (${version})`);
  }
  return version;
}

async function fetchAvailableVersions({ major, logger, signal } = {}) {
  const m = normalizeMajor(major);
  const url = "https://www.renpy.org/dl/";
  logger?.info?.(`[renpy] fetching versions from ${url}`);
  const res = await fetchUrlBuffer(url, {
    headers: { "User-Agent": "MacLauncher" },
    signal
  });
  if (res.status !== 200) throw new Error(`Fetch failed (${res.status})`);

  const decoded = decodeBody(res.body, res.headers);
  const text = decoded.toString("utf8");
  const versions = extractVersionsFromHtml(text);
  const unique = Array.from(new Set(versions)).filter(v => /^\d+\.\d+\.\d+$/.test(v));

  let latestStable = null;
  try {
    latestStable = await fetchLatestStableVersion({ major: m, logger, signal });
  } catch (e) {
    logger?.warn?.(`[renpy] latest stable fetch failed: ${String(e?.message || e)}`);
  }

  const filtered = unique.filter(v => {
    if (!isVersionInMajorGroup(v, m)) return false;
    if (latestStable && compareSemver(v, latestStable) > 0) return false;
    return true;
  });

  filtered.sort(compareSemverDesc);
  return { versions: filtered, source: url, latestStableVersion: latestStable };
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
  if (looksLikeSdkRoot(installDir)) {
    return { version: v, installDir, launcherPath: getLauncherPath(installDir) };
  }

  const url = getDownloadUrl(v);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-renpy-"));
  const dmgPath = path.join(tmpDir, `renpy-${v}-sdk.dmg`);
  const mountDir = path.join(tmpDir, "mount");
  ensureDir(mountDir);

  let mounted = false;

  try {
    logger?.info?.(`[renpy] downloading ${url}`);
    await downloadToFile(url, dmgPath, { onProgress, signal });
    throwIfAborted(signal);

    logger?.info?.(`[renpy] mounting ${path.basename(dmgPath)}`);
    await runCommand("/usr/bin/hdiutil", [
      "attach",
      "-nobrowse",
      "-readonly",
      "-mountpoint",
      mountDir,
      dmgPath
    ], { signal });
    mounted = true;
    throwIfAborted(signal);

    const sdkRoot = findSdkRoot(mountDir, v);

    safeRm(installDir);
    ensureDir(path.dirname(installDir));

    logger?.info?.(`[renpy] copying SDK to ${installDir}`);
    await runCommand("/usr/bin/ditto", [sdkRoot, installDir], { signal });

    if (!looksLikeSdkRoot(installDir)) {
      throw new Error("Installed Ren'Py SDK missing expected files");
    }

    const launcherPath = getLauncherPath(installDir);
    try {
      await primeLauncherApp(launcherPath, { logger, signal });
    } catch (e) {
      logger?.warn?.(`[renpy] failed to prime SDK app: ${String(e?.message || e)}`);
    }

    return { version: v, installDir, launcherPath };
  } finally {
    if (mounted) {
      try {
        await runCommand("/usr/bin/hdiutil", ["detach", mountDir, "-force"]);
      } catch {}
    }
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
  __test: {
    buildPrimeLauncherArgs,
    isVersionInMajorGroup,
    primeLauncherApp
  }
};
