const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { shell } = require("electron");
const manifest = require("./manifest.json");
const GameData = require("../shared/game-data");
const { detectGame } = require("./detect");
const { buildUnrenCommand } = require("./unren");
const {
  resolveExtractionRoot,
  resolveExtractionStatus,
  writeExtractionMeta
} = require("./extract");
const {
  resolveConfigValueFromRoots,
  resolveRenpyIconPath
} = require("./options");

const LegacySdkManager = require("./runtime/sdk-manager");
const PatchSdk = require("./runtime/patch-sdk");
const RuntimePatcher = require("./runtime/patcher");
const RuntimeSdk = require("./runtime/sdk");
const SdkRuntimeManager = require("./runtime/sdk-runtime-manager");
const { cheatsSchema, cheatsHelpers } = require("./cheats");

function safeRm(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {}
}

function existsDir(p) {
  try {
    return fs.existsSync(p) && fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function existsFile(p) {
  try {
    return fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

const URW_RESOURCE_DIR = path.join("universal-renpy-walkthrough", "__urw");
const URW_FILES = ["_urw.rpy", "_urwdisp.rpy"];
const URM_FILE = "0x52_URM.rpa";

function updateModuleData(entry, patch) {
  const current = entry?.moduleData && typeof entry.moduleData === "object" ? entry.moduleData : {};
  const next = { ...current };
  for (const [key, value] of Object.entries(patch || {})) {
    if (value === null || value === undefined) delete next[key];
    else next[key] = value;
  }
  entry.moduleData = next;
}

function normalizeRuntimeId(input, fallback = "sdk") {
  const raw = typeof input === "string" ? input.trim().toLowerCase() : "";
  return raw || fallback;
}

function mergeEntry(existing, merged) {
  if (!existing) return merged;
  merged.defaultSaveDir = existing.defaultSaveDir ?? merged.defaultSaveDir;
  return merged;
}

function normalizeSdkVersion(version) {
  const v = String(version || "").trim().replace(/^v/i, "");
  const match = v.match(/^(\d+\.\d+\.\d+)/);
  return match ? match[1] : null;
}

function resolveVersion(entry) {
  const moduleData = entry?.moduleData && typeof entry.moduleData === "object" ? entry.moduleData : {};
  if (typeof moduleData.version === "string" && moduleData.version.trim()) {
    return moduleData.version.trim();
  }
  return null;
}

function normalizeRenpyMajor(input) {
  const major = Number(input);
  if (!Number.isFinite(major)) return null;
  if (major >= 8) return 8;
  if (major >= 1) return 7;
  return null;
}

function resolveMajor(entry) {
  const moduleData = entry?.moduleData && typeof entry.moduleData === "object" ? entry.moduleData : {};
  const direct = normalizeRenpyMajor(moduleData.major);
  if (direct) return direct;
  const version = resolveVersion(entry);
  const match = version ? version.match(/^(\d+)\./) : null;
  const major = match ? Number(match[1]) : null;
  return normalizeRenpyMajor(major);
}

function resolveBaseName(entry) {
  const moduleData = entry?.moduleData && typeof entry.moduleData === "object" ? entry.moduleData : {};
  if (typeof moduleData.baseName === "string" && moduleData.baseName.trim()) {
    return moduleData.baseName.trim();
  }
  return null;
}

function resolveGameOnly(entry) {
  const moduleData = entry?.moduleData && typeof entry.moduleData === "object" ? entry.moduleData : {};
  return moduleData.gameOnly === true;
}

function resolveContentRoot(entry) {
  return entry?.contentRootDir || entry?.gamePath || null;
}

function resolveGameDir(entry) {
  const root = resolveContentRoot(entry);
  if (!root) return null;
  return resolveGameOnly(entry) ? root : path.join(root, "game");
}

function resolveCheatsResourceRoots() {
  const roots = [];
  if (typeof process.resourcesPath === "string" && process.resourcesPath) {
    roots.push(path.join(process.resourcesPath, "renpy-cheats"));
    roots.push(path.join(process.resourcesPath, "resources", "renpy-cheats"));
    roots.push(path.join(process.resourcesPath, "app.asar.unpacked", "renpy-cheats"));
  }
  roots.push(path.resolve(__dirname, "resources"));
  return roots;
}

function resolveCheatResourceFile(relPath) {
  for (const root of resolveCheatsResourceRoots()) {
    const candidate = path.join(root, relPath);
    if (existsFile(candidate)) return candidate;
  }
  return null;
}

function resolveCheatResourceDir(relDir, files) {
  for (const root of resolveCheatsResourceRoots()) {
    const candidate = path.join(root, relDir);
    const ok = files.every(name => existsFile(path.join(candidate, name)));
    if (ok) return candidate;
  }
  return null;
}

function resolveCheatsGameDir(entry) {
  const gameDir = resolveGameDir(entry);
  if (!gameDir || !existsDir(gameDir)) throw new Error("Game directory missing.");
  return gameDir;
}

function getRenpyCheatsStatus(entry) {
  const gameDir = resolveGameDir(entry);
  if (!gameDir) {
    return { urwInstalled: false, urwPresent: false, urmInstalled: false, urmPresent: false };
  }
  const urwDir = path.join(gameDir, "__urw");
  const urwSourcePaths = URW_FILES.map(name => path.join(urwDir, name));
  const urwPaths = [];
  for (const name of URW_FILES) {
    const parsed = path.parse(name);
    const base = parsed.name;
    urwPaths.push(path.join(urwDir, name));
    urwPaths.push(path.join(urwDir, `${base}.rpyc`));
    urwPaths.push(path.join(urwDir, `${base}.rpyb`));
  }
  const urwFound = urwPaths.map(p => existsFile(p));
  const urwInstalled = urwSourcePaths.every(p => existsFile(p));
  const urwPresent = urwFound.some(Boolean);
  const urmPath = path.join(gameDir, URM_FILE);
  const urmPresent = existsFile(urmPath);
  return {
    urwInstalled,
    urwPresent,
    urmInstalled: urmPresent,
    urmPresent
  };
}

function installRenpyWalkthrough(entry) {
  const gameDir = resolveCheatsGameDir(entry);
  const sourceDir = resolveCheatResourceDir(URW_RESOURCE_DIR, URW_FILES);
  if (!sourceDir) throw new Error("Universal Ren'Py Walkthrough System files not found.");
  const destDir = path.join(gameDir, "__urw");
  ensureDir(destDir);
  for (const name of URW_FILES) {
    fs.copyFileSync(path.join(sourceDir, name), path.join(destDir, name));
  }
  return getRenpyCheatsStatus(entry);
}

function removeRenpyWalkthrough(entry) {
  const gameDir = resolveCheatsGameDir(entry);
  const destDir = path.join(gameDir, "__urw");
  safeRm(destDir);
  return getRenpyCheatsStatus(entry);
}

function installRenpyMod(entry) {
  const gameDir = resolveCheatsGameDir(entry);
  const sourcePath = resolveCheatResourceFile(URM_FILE);
  if (!sourcePath) throw new Error("Universal Ren'Py Mod file not found.");
  fs.copyFileSync(sourcePath, path.join(gameDir, URM_FILE));
  return getRenpyCheatsStatus(entry);
}

function removeRenpyMod(entry) {
  const gameDir = resolveCheatsGameDir(entry);
  safeRm(path.join(gameDir, URM_FILE));
  return getRenpyCheatsStatus(entry);
}

function resolveIconCachePath(entry, userDataDir, iconPath) {
  if (!userDataDir) return null;
  const gameId = entry?.gameId;
  if (!gameId) return null;
  const ext = path.extname(String(iconPath || "")) || ".png";
  const iconsRoot = path.join(GameData.resolveGameModuleDir(userDataDir, gameId, "renpy"), "icons");
  return path.join(iconsRoot, `window-icon${ext}`);
}

function cacheIconForEntry(entry, userDataDir, iconPath) {
  if (!iconPath || !userDataDir) return null;
  if (!existsFile(iconPath)) return null;
  const cachePath = resolveIconCachePath(entry, userDataDir, iconPath);
  if (!cachePath) return null;
  try {
    if (path.resolve(iconPath) !== path.resolve(cachePath)) {
      ensureDir(path.dirname(cachePath));
      fs.copyFileSync(iconPath, cachePath);
    }
  } catch {
    return null;
  }
  updateModuleData(entry, { extractedIconPath: cachePath });
  entry.iconPath = cachePath;
  entry.iconSource = "module";
  return cachePath;
}

function cleanupGameData(entry, context) {
  const userDataDir = context?.userDataDir;
  const gameId = entry?.gameId;
  if (!userDataDir || !gameId) return false;
  safeRm(GameData.resolveGameModuleDir(userDataDir, gameId, "renpy"));
  return true;
}

function resolveGameIcon(entry) {
  const moduleData = entry?.moduleData && typeof entry.moduleData === "object" ? entry.moduleData : {};
  const cachedIcon =
    typeof moduleData.extractedIconPath === "string" && moduleData.extractedIconPath.trim()
      ? moduleData.extractedIconPath.trim()
      : null;
  if (cachedIcon && existsFile(cachedIcon)) return cachedIcon;
  const root = resolveContentRoot(entry);
  if (!root) return null;
  const gameDir = resolveGameOnly(entry) ? root : path.join(root, "game");
  const iconPath = path.join(gameDir, "gui", "window_icon.png");
  try {
    if (fs.existsSync(iconPath) && fs.statSync(iconPath).isFile()) return iconPath;
  } catch {}
  return null;
}

function isX64Platform(platform) {
  const p = String(platform || "");
  return p.includes("x86_64") || p.includes("x86-64");
}

function resolveSdkVersion(settings, major, entry) {
  const cfg = SdkRuntimeManager.normalizeSettings(settings?.runtimes?.sdk);
  const key = major === 7 ? "v7" : "v8";
  const entryVersion = normalizeSdkVersion(
    entry?.runtimeData?.sdk?.version ?? ""
  );
  return entryVersion || cfg?.[key]?.defaultVersion || null;
}

function findInstalledSdk(userDataDir, major, version) {
  const installed = SdkRuntimeManager.core.listInstalled(userDataDir, major);
  if (version) return installed.find(i => i.version === version) || null;
  return installed[0] || null;
}

async function ensureSdkAvailable({ settings, userDataDir, major, version, allowInstall, logger, onState }) {
  const existing = findInstalledSdk(userDataDir, major, version);
  if (existing) return existing;
  if (!allowInstall) {
    const suffix = version ? ` v${version}` : "";
    throw new Error(`Ren'Py SDK${suffix} is not installed. Install it from Runtimes.`);
  }
  onState?.();
  const installed = await SdkRuntimeManager.installRuntime({
    userDataDir,
    major,
    version,
    logger,
    onProgress: () => onState?.()
  });
  onState?.();
  return installed;
}

function resolvePatchVersion(entry) {
  const v = normalizeSdkVersion(resolveVersion(entry));
  return v || null;
}

function formatPatchStatusLabel(status) {
  if (!status) return null;
  if (status.patched) return "Patched";
  if (status.partial) return "Partial";
  return "Not patched";
}

function decoratePatchStatus(entry, status) {
  const renpyVersion =
    resolveVersion(entry) || status?.renpyVersion || status?.sdkVersion || null;
  return {
    ...status,
    renpyVersion,
    patchStatusLabel: formatPatchStatusLabel(status)
  };
}

function formatExtractStatusLabel(status) {
  if (!status) return null;
  return status.extractedReady ? "Extracted" : "Not extracted";
}

function decorateExtractionStatus(status) {
  return {
    ...status,
    extractStatusLabel: formatExtractStatusLabel(status)
  };
}

function applyPatchStatus(entry, status) {
  updateModuleData(entry, {
    patched: Boolean(status?.patched),
    partial: Boolean(status?.partial)
  });
}

function applyExtractionStatus(entry, status) {
  updateModuleData(entry, {
    extractedReady: Boolean(status?.extractedReady),
    extractedRoot: status?.extractedRoot || null,
    extractedAt: Number.isFinite(status?.extractedAt) ? status.extractedAt : null
  });
}

function applyExtractedOverrides(entry, { userDataDir, extractedRoot, gameDir }) {
  const roots = [extractedRoot, gameDir].filter(Boolean);
  if (roots.length === 0) return null;

  const saveDirName = resolveConfigValueFromRoots(roots, "save_directory");
  if (saveDirName) {
    entry.defaultSaveDir = path.join(os.homedir(), "Library", "RenPy", saveDirName);
  }

  const iconValue = resolveConfigValueFromRoots(roots, "window_icon");
  const iconPath = resolveRenpyIconPath(roots, iconValue);
  const cachedIcon = iconPath ? cacheIconForEntry(entry, userDataDir, iconPath) : null;

  return {
    saveDirName: saveDirName || null,
    iconPath: cachedIcon || null
  };
}

async function ensurePatched(entry, { userDataDir, logger, allowDownload } = {}) {
  if (resolveGameOnly(entry)) {
    throw new Error("Patching is not available for game-only imports.");
  }
  const contentRootDir = resolveContentRoot(entry);
  const major = resolveMajor(entry);
  const baseName = resolveBaseName(entry);
  if (!contentRootDir || !baseName) {
    throw new Error("Game metadata missing.");
  }

  const status = RuntimePatcher.buildPatchStatus({
    userDataDir,
    gameId: entry.gameId,
    gamePath: entry.gamePath,
    contentRootDir,
    renpyBaseName: baseName,
    renpyMajor: major
  });
  if (status.patched) return status;

  if (!major) throw new Error("Runtime version not detected.");
  const patchVersion = resolvePatchVersion(entry);
  if (!patchVersion) throw new Error("Runtime version is missing or unsupported for patching.");
  if (!allowDownload) {
    throw new Error("Game is not patched. Use Patch… to download runtime files.");
  }

  const sdk = await PatchSdk.preparePatchSdk({ version: patchVersion, logger });
  try {
    return RuntimePatcher.patchGame({
      userDataDir,
      gameId: entry.gameId,
      gamePath: entry.gamePath,
      contentRootDir,
      renpyBaseName: baseName,
      renpyMajor: major,
      sdkInstallDir: sdk.sdkRoot,
      sdkVersion: sdk.sdkVersion,
      renpyVersion: resolveVersion(entry)
    });
  } finally {
    sdk.cleanup?.();
  }
}

function parseBuiltAt(value) {
  const ts = Date.parse(String(value || ""));
  return Number.isFinite(ts) ? ts : null;
}

function applyBuildMeta(entry, build) {
  const moduleData = entry?.moduleData && typeof entry.moduleData === "object" ? entry.moduleData : {};
  moduleData.builtSdkVersion =
    build && typeof build.sdkVersion === "string" && build.sdkVersion.trim()
      ? build.sdkVersion.trim()
      : null;
  entry.moduleData = moduleData;
  entry.lastBuiltAt = build ? parseBuiltAt(build.builtAt) : null;
  if (!String(entry?.gamePath || "").toLowerCase().endsWith(".app")) {
    entry.nativeAppPath =
      build && typeof build.appPath === "string" && build.appPath.trim()
        ? build.appPath.trim()
        : null;
  }
}

function refreshBuildState(entry, userDataDir) {
  const meta = RuntimeSdk.pruneBuildsMeta(userDataDir, entry.gameId);
  const builds = Array.isArray(meta.builds) ? meta.builds : [];
  const latest = builds[0] || null;
  applyBuildMeta(entry, latest);
  return latest;
}

function runCommand(cmd, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", data => {
      stdout += data.toString("utf8");
    });
    child.stderr.on("data", data => {
      stderr += data.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", code => {
      if (code === 0) return resolve({ stdout, stderr });
      const err = new Error(`${cmd} failed (${code})`);
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    });
  });
}

async function launchPatched(entry, context) {
  const status = await ensurePatched(entry, {
    userDataDir: context.userDataDir,
    logger: context.logger,
    allowDownload: false
  });

  const contentRootDir = resolveContentRoot(entry);
  const baseName = resolveBaseName(entry);
  const shPath = path.join(contentRootDir, `${baseName}.sh`);
  if (!fs.existsSync(shPath)) throw new Error("Launcher script not found.");

  const platform = status.platform || null;
  const needsRosetta = process.arch === "arm64" && isX64Platform(platform);
  const env = platform ? { ...process.env, RENPY_PLATFORM: platform } : process.env;

  context.logger?.info?.(`[runtime] launch patched ${shPath}`);
  return context.spawnDetachedChecked(shPath, [], { cwd: contentRootDir, env }, needsRosetta);
}

async function launchSdk(entry, context) {
  const contentRootDir = resolveContentRoot(entry);
  if (!contentRootDir) throw new Error("Game directory missing.");

  const major = resolveMajor(entry);
  if (!major) throw new Error("Runtime version not detected.");

  const sdkVersion = resolveSdkVersion(context.settings, major, entry);
  const sdkInstall = await ensureSdkAvailable({
    settings: context.settings,
    userDataDir: context.userDataDir,
    major,
    version: sdkVersion,
    allowInstall: false,
    logger: context.logger,
    onState: context.onRuntimeStateChange
  });

  const wrapperDir = RuntimeSdk.ensureWrapper({
    userDataDir: context.userDataDir,
    gameId: entry.gameId,
    gamePath: entry.gamePath,
    contentRootDir,
    sdkVersion: sdkInstall.version
  });

  const renpySh = path.join(sdkInstall.installDir, "renpy.sh");
  if (!fs.existsSync(renpySh)) throw new Error("Ren'Py SDK missing launcher script.");

  const platform = RuntimeSdk.detectSdkPlatform(sdkInstall.installDir, major);
  const needsRosetta = process.arch === "arm64" && isX64Platform(platform);
  const env = platform ? { ...process.env, RENPY_PLATFORM: platform } : process.env;

  context.logger?.info?.(`[runtime] launch sdk ${renpySh} ${wrapperDir}`);
  return context.spawnDetachedChecked(renpySh, [wrapperDir, "run"], { cwd: wrapperDir, env }, needsRosetta);
}

module.exports = {
  id: manifest.id,
  manifest,
  detectGame,
  mergeEntry,
  normalizeRuntimeId,
  resolveGameIcon,
  filterRuntimeSupport: (entry, supported) => {
    const isApp =
      String(entry?.gamePath || "").toLowerCase().endsWith(".app") ||
      String(entry?.nativeAppPath || "").toLowerCase().endsWith(".app");
    if (resolveGameOnly(entry)) return supported.filter(rt => rt === "sdk");
    if (isApp) return supported.filter(rt => rt !== "patched");
    return supported;
  },
  canLaunchRuntime: (runtimeId, entry) => {
    const root = resolveContentRoot(entry);
    if (!root) return false;
    const isApp =
      String(entry?.gamePath || "").toLowerCase().endsWith(".app") ||
      String(entry?.nativeAppPath || "").toLowerCase().endsWith(".app");
    if (runtimeId === "patched") {
      if (resolveGameOnly(entry)) return false;
      return !isApp;
    }
    if (runtimeId === "sdk") {
      return true;
    }
    return true;
  },
  resolveNativeLaunchPath: (entry, context) => {
    const userDataDir = context?.userDataDir;
    const direct = typeof entry?.nativeAppPath === "string" ? entry.nativeAppPath.trim() : "";
    if (direct && direct.toLowerCase().endsWith(".app")) return direct;
    try {
      const meta = RuntimeSdk.readBuildsMeta(userDataDir, entry.gameId);
      const build = Array.isArray(meta?.builds) ? meta.builds[0] : null;
      const appPath =
        build && typeof build.appPath === "string" && build.appPath ? build.appPath : null;
      if (appPath && appPath.toLowerCase().endsWith(".app")) return appPath;
    } catch {}
    const fallback = typeof context?.resolveNativeLaunchPath === "function"
      ? context.resolveNativeLaunchPath(entry)
      : null;
    return direct || fallback || null;
  },
  runtimeManagers: [SdkRuntimeManager],
  cheats: {
    schema: cheatsSchema,
    defaults: cheatsHelpers.defaults,
    normalize: cheatsHelpers.normalizeCheats,
    equals: cheatsHelpers.cheatsEqual
  },
  cleanupGameData,
  launchRuntime: (runtimeId, entry, context) => {
    if (runtimeId === "patched") return launchPatched(entry, context);
    if (runtimeId === "sdk") return launchSdk(entry, context);
    return null;
  },
  actions: {
    patchStatus: (entry, _payload, context) => {
      if (resolveGameOnly(entry)) {
        throw new Error("Patching is not available for game-only imports.");
      }
      const contentRootDir = resolveContentRoot(entry);
      const baseName = resolveBaseName(entry);
      if (!contentRootDir || !baseName) throw new Error("Game metadata missing.");
      const status = RuntimePatcher.buildPatchStatus({
        userDataDir: context.userDataDir,
        gameId: entry.gameId,
        gamePath: entry.gamePath,
        contentRootDir,
        renpyBaseName: baseName,
        renpyMajor: resolveMajor(entry)
      });
      applyPatchStatus(entry, status);
      return decoratePatchStatus(entry, status);
    },
    patch: async (entry, _payload, context) => {
      const status = await ensurePatched(entry, {
        userDataDir: context.userDataDir,
        logger: context.logger,
        allowDownload: true
      });
      applyPatchStatus(entry, status);
      return decoratePatchStatus(entry, status);
    },
    unpatch: (entry, _payload, context) => {
      if (resolveGameOnly(entry)) {
        throw new Error("Patching is not available for game-only imports.");
      }
      const contentRootDir = resolveContentRoot(entry);
      const baseName = resolveBaseName(entry);
      if (!contentRootDir || !baseName) throw new Error("Game metadata missing.");
      const status = RuntimePatcher.unpatchGame({
        userDataDir: context.userDataDir,
        gameId: entry.gameId,
        gamePath: entry.gamePath,
        contentRootDir,
        renpyBaseName: baseName,
        renpyMajor: resolveMajor(entry)
      });
      applyPatchStatus(entry, status);
      return decoratePatchStatus(entry, status);
    },
    buildApp: async (entry, _payload, context) => {
      if (resolveGameOnly(entry)) {
        throw new Error("Packaging is not available for game-only imports.");
      }
      if (String(entry?.gamePath || "").toLowerCase().endsWith(".app")) {
        throw new Error("Packaging is disabled for imported app bundles.");
      }
      const contentRootDir = resolveContentRoot(entry);
      if (!contentRootDir) throw new Error("Game directory missing.");

      const major = resolveMajor(entry);
      if (!major) throw new Error("Runtime version not detected.");

      const sdkVersion = resolveSdkVersion(context.settings, major, entry);
      const sdkInstall = await ensureSdkAvailable({
        settings: context.settings,
        userDataDir: context.userDataDir,
        major,
        version: sdkVersion,
        allowInstall: true,
        logger: context.logger,
        onState: context.onRuntimeStateChange
      });

      const existingBuilds = RuntimeSdk.pruneBuildsMeta(context.userDataDir, entry.gameId);
      if (Array.isArray(existingBuilds.builds) && existingBuilds.builds.length > 0) {
        throw new Error("App already built. Delete it before rebuilding.");
      }

      const platform = RuntimeSdk.detectSdkPlatform(sdkInstall.installDir, major);
      const needsRosetta = process.arch === "arm64" && isX64Platform(platform);

      const res = await RuntimeSdk.buildMacApp({
        userDataDir: context.userDataDir,
        gameId: entry.gameId,
        gamePath: entry.gamePath,
        contentRootDir,
        sdkInstallDir: sdkInstall.installDir,
        sdkVersion: sdkInstall.version,
        platform,
        needsRosetta
      });

      applyBuildMeta(entry, { appPath: res.appPath, sdkVersion: sdkInstall.version, builtAt: new Date().toISOString() });
      return { appPath: res.appPath, sdkVersion: sdkInstall.version };
    },
    refreshBuild: (entry, _payload, context) => {
      if (resolveGameOnly(entry)) {
        throw new Error("Builds are not available for game-only imports.");
      }
      refreshBuildState(entry, context.userDataDir);
      return true;
    },
    deleteBuild: (entry, _payload, context) => {
      if (resolveGameOnly(entry)) {
        throw new Error("Builds are not available for game-only imports.");
      }
      if (String(entry?.gamePath || "").toLowerCase().endsWith(".app")) {
        throw new Error("Imported app bundles cannot be deleted here.");
      }
      let deleted = false;
      for (;;) {
        const res = RuntimeSdk.deleteLatestBuild(context.userDataDir, entry.gameId);
        if (!res) break;
        if (!res.removed) {
          throw new Error("Refusing to delete build outside the build directory.");
        }
        deleted = true;
      }
      if (!deleted) throw new Error("No build found.");
      applyBuildMeta(entry, null);
      return true;
    },
    refreshExtractionStatus: (entry, _payload, context) => {
      const gameDir = resolveGameDir(entry);
      const status = resolveExtractionStatus({
        entry,
        userDataDir: context.userDataDir,
        sourcePath: gameDir || null
      });
      applyExtractionStatus(entry, status);
      if (status.extractedReady) {
        applyExtractedOverrides(entry, {
          userDataDir: context.userDataDir,
          extractedRoot: status.extractedRoot,
          gameDir
        });
      }
      return decorateExtractionStatus(status);
    },
    extractGame: async (entry, _payload, context) => {
      const gameDir = resolveGameDir(entry);
      if (!gameDir || !existsDir(gameDir)) {
        throw new Error("Game directory missing.");
      }
      const extractRoot = resolveExtractionRoot({ entry, userDataDir: context.userDataDir });
      safeRm(extractRoot);
      ensureDir(extractRoot);

      const unren = buildUnrenCommand({ userDataDir: context.userDataDir });
      context.logger?.info?.(`[renpy] running unren extract for ${gameDir}`);
      await runCommand(
        unren.command,
        [
          ...unren.args,
          "extract",
          "--mode",
          "all",
          "--output",
          extractRoot,
          "--base-dir",
          gameDir,
          "--detect-all",
          gameDir
        ],
        { env: unren.env }
      );

      context.logger?.info?.(`[renpy] running unren decompile for ${gameDir}`);
      await runCommand(
        unren.command,
        [
          ...unren.args,
          "decompile",
          "--mode",
          "auto",
          "--output",
          extractRoot,
          "--base-dir",
          gameDir,
          gameDir
        ],
        { env: unren.env }
      );

      context.logger?.info?.(`[renpy] running unren decompile for extracted archives`);
      await runCommand(
        unren.command,
        [
          ...unren.args,
          "decompile",
          "--mode",
          "auto",
          "--output",
          extractRoot,
          "--base-dir",
          extractRoot,
          extractRoot
        ],
        { env: unren.env }
      );

      writeExtractionMeta(extractRoot, {
        sourcePath: gameDir,
        extractedAt: Date.now()
      });

      const status = resolveExtractionStatus({
        entry,
        userDataDir: context.userDataDir,
        sourcePath: gameDir
      });
      applyExtractionStatus(entry, status);
      if (status.extractedReady) {
        applyExtractedOverrides(entry, {
          userDataDir: context.userDataDir,
          extractedRoot: status.extractedRoot,
          gameDir
        });
      }
      return decorateExtractionStatus(status);
    },
    revealExtraction: (entry, _payload, context) => {
      const gameDir = resolveGameDir(entry);
      const status = resolveExtractionStatus({
        entry,
        userDataDir: context.userDataDir,
        sourcePath: gameDir || null
      });
      if (!status.extractedRoot || !existsDir(status.extractedRoot)) {
        throw new Error("No extracted data found.");
      }
      shell.showItemInFolder(status.extractedRoot);
      return { revealed: true };
    },
    removeExtraction: (entry, _payload, context) => {
      const extractRoot = resolveExtractionRoot({ entry, userDataDir: context.userDataDir });
      safeRm(extractRoot);
      applyExtractionStatus(entry, { extractedReady: false, extractedRoot: null, extractedAt: null });
      return decorateExtractionStatus({ extractedReady: false, extractedRoot: null, extractedAt: null });
    },
    renpyCheatsStatus: (entry, _payload, _context) => getRenpyCheatsStatus(entry),
    patchRenpyWalkthrough: (entry, _payload, _context) => installRenpyWalkthrough(entry),
    removeRenpyWalkthrough: (entry, _payload, _context) => removeRenpyWalkthrough(entry),
    addRenpyMod: (entry, _payload, _context) => installRenpyMod(entry),
    removeRenpyMod: (entry, _payload, _context) => removeRenpyMod(entry)
  },
  runtime: {
    sdkManager: LegacySdkManager,
    patcher: RuntimePatcher,
    patchSdk: PatchSdk,
    sdk: RuntimeSdk
  }
};
