const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const GameData = require("../../shared/game-data");
const { findMacLibDir } = require("./patcher");

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function safeStat(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

function existsDir(p) {
  const st = safeStat(p);
  return Boolean(st && st.isDirectory());
}

function existsFile(p) {
  const st = safeStat(p);
  return Boolean(st && st.isFile());
}

function looksLikeGameDir(dir) {
  if (!existsDir(dir)) return false;
  if (path.basename(dir).toLowerCase() !== "game") return false;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  const extensions = new Set([".rpa", ".rpy", ".rpyc", ".rpyb"]);
  return entries.some(entry => {
    if (!entry.isFile()) return false;
    const ext = path.extname(entry.name).toLowerCase();
    return extensions.has(ext);
  });
}

function safeRm(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {}
}

function moduleRootDir(userDataDir, gameId) {
  if (!userDataDir || !gameId) return null;
  return GameData.resolveGameModuleDir(userDataDir, gameId, "renpy");
}

function resolveWrapperDir(userDataDir, gameId, sdkVersion) {
  const root = moduleRootDir(userDataDir, gameId);
  if (!root) return null;
  return path.join(root, "projects", String(sdkVersion || "default"));
}

function wrapperMetaPath(wrapperDir) {
  return path.join(wrapperDir, ".maclauncher-renpy-wrapper.json");
}

function readWrapperMeta(wrapperDir) {
  const p = wrapperMetaPath(wrapperDir);
  if (!existsFile(p)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function writeWrapperMeta(wrapperDir, meta) {
  const p = wrapperMetaPath(wrapperDir);
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(meta, null, 2), "utf8");
  return p;
}

function resolveSymlinkTarget(destPath) {
  try {
    if (!fs.lstatSync(destPath).isSymbolicLink()) return null;
    const link = fs.readlinkSync(destPath);
    return path.resolve(path.dirname(destPath), link);
  } catch {
    return null;
  }
}

function ensureSymlink(src, dest, type) {
  const desired = path.resolve(src);
  const existing = resolveSymlinkTarget(dest);
  if (existing && existing === desired) return true;

  if (fs.existsSync(dest)) {
    safeRm(dest);
  }

  try {
    fs.symlinkSync(src, dest, type);
    return true;
  } catch {
    return false;
  }
}

function linkOrCopyDir(src, dest) {
  if (ensureSymlink(src, dest, "dir")) return;
  safeRm(dest);
  fs.cpSync(src, dest, { recursive: true });
}

function linkOrCopyFile(src, dest) {
  if (ensureSymlink(src, dest, "file")) return;
  safeRm(dest);
  fs.copyFileSync(src, dest);
}

function collectExtras(rootDir) {
  let entries = [];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const excludeNames = new Set([
    "game",
    "lib",
    "renpy",
    "cache",
    "tmp",
    ".ds_store"
  ]);

  return entries.filter(entry => {
    const name = entry.name || "";
    const lower = name.toLowerCase();
    if (excludeNames.has(lower)) return false;
    if (lower.endsWith(".exe") || lower.endsWith(".py") || lower.endsWith(".sh")) return false;
    if (lower.endsWith(".app")) return false;
    return entry.isFile();
  });
}

function ensureWrapper({ userDataDir, gameId, gamePath, contentRootDir, sdkVersion }) {
  if (!existsDir(contentRootDir)) throw new Error("Ren'Py game folder missing.");
  const wrapperDir = resolveWrapperDir(userDataDir, gameId, sdkVersion);
  if (!wrapperDir) throw new Error("Missing wrapper directory.");
  const meta = readWrapperMeta(wrapperDir);
  if (meta?.source && meta.source !== contentRootDir) {
    safeRm(wrapperDir);
  }

  ensureDir(wrapperDir);

  const nestedGameDir = path.join(contentRootDir, "game");
  const gameDir = existsDir(nestedGameDir)
    ? nestedGameDir
    : looksLikeGameDir(contentRootDir)
      ? contentRootDir
      : null;
  if (!gameDir) throw new Error("Ren'Py game directory missing.");
  const wrapperGameDir = path.join(wrapperDir, "game");
  linkOrCopyDir(gameDir, wrapperGameDir);

  if (gameDir === nestedGameDir) {
    const extras = collectExtras(contentRootDir);
    for (const entry of extras) {
      const src = path.join(contentRootDir, entry.name);
      const dest = path.join(wrapperDir, entry.name);
      if (existsFile(dest) || existsDir(dest)) continue;
      linkOrCopyFile(src, dest);
    }
  }

  writeWrapperMeta(wrapperDir, {
    source: contentRootDir,
    gamePath,
    sdkVersion: sdkVersion || null,
    createdAt: new Date().toISOString()
  });

  return wrapperDir;
}

function runCommand(cmd, args, options = {}) {
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

function findNewestZip(outDir) {
  let entries = [];
  try {
    entries = fs.readdirSync(outDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const zips = entries
    .filter(e => e.isFile() && e.name.toLowerCase().endsWith(".zip"))
    .map(e => path.join(outDir, e.name));
  if (zips.length === 0) return null;

  zips.sort((a, b) => {
    const am = safeStat(a)?.mtimeMs || 0;
    const bm = safeStat(b)?.mtimeMs || 0;
    return bm - am;
  });
  return zips[0] || null;
}

function findAppPath(outDir) {
  let entries = [];
  try {
    entries = fs.readdirSync(outDir, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.toLowerCase().endsWith(".app")) return path.join(outDir, entry.name);
  }
  return null;
}

function buildsMetaPath(userDataDir, gameId) {
  const root = moduleRootDir(userDataDir, gameId);
  if (!root) return null;
  return path.join(root, "builds", "builds.json");
}

function buildRootDir(userDataDir, gameId) {
  const root = moduleRootDir(userDataDir, gameId);
  if (!root) return null;
  return path.join(root, "builds");
}

function readBuildsMeta(userDataDir, gameId) {
  const p = buildsMetaPath(userDataDir, gameId);
  if (!existsFile(p)) return { builds: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.builds)) return parsed;
  } catch {}
  return { builds: [] };
}

function writeBuildsMeta(userDataDir, gameId, meta) {
  const p = buildsMetaPath(userDataDir, gameId);
  if (!p) throw new Error("Missing builds metadata path.");
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(meta, null, 2), "utf8");
  return p;
}

function isSubpath(parent, child) {
  if (!parent || !child) return false;
  const rel = path.relative(parent, child);
  return Boolean(rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function isValidBuildApp(appPath) {
  if (!appPath || typeof appPath !== "string") return false;
  if (!appPath.toLowerCase().endsWith(".app")) return false;
  return existsDir(appPath);
}

function pruneBuildsMeta(userDataDir, gameId) {
  const meta = readBuildsMeta(userDataDir, gameId);
  const builds = Array.isArray(meta.builds) ? meta.builds : [];
  const nextBuilds = builds.filter(build => isValidBuildApp(build?.appPath));
  if (nextBuilds.length !== builds.length) {
    writeBuildsMeta(userDataDir, gameId, { ...meta, builds: nextBuilds });
  }
  return { ...meta, builds: nextBuilds };
}

function deleteLatestBuild(userDataDir, gameId) {
  const meta = pruneBuildsMeta(userDataDir, gameId);
  const builds = Array.isArray(meta.builds) ? meta.builds : [];
  if (!builds.length) return null;

  const build = builds[0];
  const root = path.resolve(buildRootDir(userDataDir, gameId));
  const outDir = typeof build.outDir === "string" ? build.outDir : "";
  const appPath = typeof build.appPath === "string" ? build.appPath : "";
  const zipPath = typeof build.zipPath === "string" ? build.zipPath : "";
  let removed = false;

  if (outDir && isSubpath(root, path.resolve(outDir))) {
    safeRm(outDir);
    removed = true;
  }
  if (appPath && isSubpath(root, path.resolve(appPath))) {
    safeRm(appPath);
    removed = true;
  }
  if (zipPath && isSubpath(root, path.resolve(zipPath))) {
    safeRm(zipPath);
  }

  if (!removed) return { build, removed: false };

  writeBuildsMeta(userDataDir, gameId, { ...meta, builds: builds.slice(1) });
  return { build, removed: true };
}

async function buildMacApp({
  userDataDir,
  gameId,
  gamePath,
  contentRootDir,
  sdkInstallDir,
  sdkVersion,
  platform,
  needsRosetta
}) {
  const wrapperDir = ensureWrapper({ userDataDir, gameId, gamePath, contentRootDir, sdkVersion });

  const buildRoot = buildRootDir(userDataDir, gameId);
  if (!buildRoot) throw new Error("Missing build root directory.");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = path.join(buildRoot, String(sdkVersion || "unknown"), stamp);
  ensureDir(outDir);

  const renpySh = path.join(sdkInstallDir, "renpy.sh");
  if (!existsFile(renpySh)) throw new Error("Ren'Py SDK is missing renpy.sh.");
  const launcherDir = path.join(sdkInstallDir, "launcher");
  if (!existsDir(launcherDir)) throw new Error("Ren'Py SDK is missing the launcher project.");

  const env = platform ? { ...process.env, RENPY_PLATFORM: platform } : process.env;
  const distributeArgs = [
    launcherDir,
    "distribute",
    "--package",
    "mac",
    "--format",
    "app-zip",
    "--destination",
    outDir,
    wrapperDir
  ];
  const cmd = needsRosetta ? "arch" : renpySh;
  const args = needsRosetta
    ? ["-x86_64", renpySh, ...distributeArgs]
    : distributeArgs;

  await runCommand(cmd, args, { env, cwd: sdkInstallDir });

  const zipPath = findNewestZip(outDir);
  if (!zipPath) throw new Error("Ren'Py build did not produce a mac zip.");

  const ditto = fs.existsSync("/usr/bin/ditto") ? "/usr/bin/ditto" : "ditto";
  await runCommand(ditto, ["-x", "-k", zipPath, outDir]);

  const appPath = findAppPath(outDir);
  if (!appPath) throw new Error("Ren'Py build zip did not contain a .app.");
  safeRm(zipPath);

  const meta = readBuildsMeta(userDataDir, gameId);
  meta.builds = Array.isArray(meta.builds) ? meta.builds : [];
  meta.builds.unshift({
    sdkVersion: sdkVersion || null,
    builtAt: new Date().toISOString(),
    outDir,
    zipPath,
    appPath
  });
  writeBuildsMeta(userDataDir, gameId, meta);

  return { appPath, outDir, zipPath };
}

function detectSdkPlatform(sdkInstallDir, renpyMajor) {
  const info = findMacLibDir(sdkInstallDir, renpyMajor);
  return info ? info.platform : null;
}

module.exports = {
  ensureWrapper,
  buildMacApp,
  detectSdkPlatform,
  readBuildsMeta,
  pruneBuildsMeta,
  deleteLatestBuild
};
