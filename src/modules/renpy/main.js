const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const manifest = require("./manifest.json");
const { detectGame } = require("./detect");

const LegacySdkManager = require("./runtime/sdk-manager");
const PatchSdk = require("./runtime/patch-sdk");
const RuntimePatcher = require("./runtime/patcher");
const RuntimeSdk = require("./runtime/sdk");
const SdkRuntimeManager = require("./runtime/sdk-runtime-manager");

function normalizePathForCompare(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
}

function isLegacySaveDir(entry) {
  const saveDir = normalizePathForCompare(entry?.defaultSaveDir);
  if (!saveDir) return false;
  if (saveDir.endsWith("/game/saves")) return true;
  const root = normalizePathForCompare(path.join(os.homedir(), "Library", "RenPy"));
  return saveDir === root;
}

function stableIdForPath(input) {
  return crypto.createHash("sha256").update(String(input || "")).digest("hex").slice(0, 12);
}

function safeRm(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {}
}

function updateModuleData(entry, patch) {
  const current = entry?.moduleData && typeof entry.moduleData === "object" ? entry.moduleData : {};
  const next = { ...current };
  for (const [key, value] of Object.entries(patch || {})) {
    if (value === null || value === undefined) delete next[key];
    else next[key] = value;
  }
  entry.moduleData = next;
}

const LEGACY_RUNTIME_MAP = {
  renpy: "patched",
  "renpy-sdk": "sdk",
  native: "native"
};

function normalizeRuntimeId(input, fallback = "sdk") {
  const raw = typeof input === "string" ? input.trim().toLowerCase() : "";
  if (!raw) return fallback;
  if (raw in LEGACY_RUNTIME_MAP) return LEGACY_RUNTIME_MAP[raw];
  return raw;
}

function migrateSettings(settings) {
  if (!settings || typeof settings !== "object") return;
  if (!settings.modules || typeof settings.modules !== "object") settings.modules = {};
  if (!settings.modules[manifest.id]) settings.modules[manifest.id] = {};

  const legacyDefaults = settings.defaults && typeof settings.defaults === "object" ? settings.defaults : {};
  const legacyGroup = legacyDefaults.renpy && typeof legacyDefaults.renpy === "object"
    ? legacyDefaults.renpy
    : {};

  if (typeof legacyGroup.defaultRuntime === "string") {
    settings.modules[manifest.id].defaultRuntime = normalizeRuntimeId(legacyGroup.defaultRuntime);
  }
  if (typeof settings.modules[manifest.id].defaultRuntime === "string") {
    settings.modules[manifest.id].defaultRuntime = normalizeRuntimeId(
      settings.modules[manifest.id].defaultRuntime
    );
  }

  if (settings.renpy && typeof settings.renpy === "object") {
    if (!settings.runtimes || typeof settings.runtimes !== "object") settings.runtimes = {};
    settings.runtimes.sdk = { ...settings.renpy };
  }
}

function migrateEntry(entry) {
  if (!entry || typeof entry !== "object") return {};
  const moduleData = {};
  const runtimeData = {};

  if (typeof entry.renpyVersion === "string") moduleData.version = entry.renpyVersion;
  const resolvedMajor = resolveMajor(entry);
  if (typeof resolvedMajor === "number") moduleData.major = resolvedMajor;
  if (typeof entry.renpyBaseName === "string") moduleData.baseName = entry.renpyBaseName;
  if (typeof entry.renpyGameOnly === "boolean") moduleData.gameOnly = entry.renpyGameOnly;
  if (typeof entry.renpyBuiltSdkVersion === "string") moduleData.builtSdkVersion = entry.renpyBuiltSdkVersion;

  if (typeof entry.renpySdkVersion === "string" && entry.renpySdkVersion.trim()) {
    runtimeData.sdk = { version: entry.renpySdkVersion.trim() };
  }

  return {
    moduleData,
    runtimeData,
    runtimeId: normalizeRuntimeId(entry.runtime)
  };
}

function mergeEntry(existing, merged) {
  if (!existing) return merged;
  if (!isLegacySaveDir(existing)) {
    merged.defaultSaveDir = existing.defaultSaveDir ?? merged.defaultSaveDir;
  }
  return merged;
}

function normalizeSdkVersion(version) {
  const v = String(version || "").trim().replace(/^v/i, "");
  const match = v.match(/^(\d+\.\d+\.\d+)/);
  return match ? match[1] : null;
}

function resolveVersion(entry) {
  const moduleData = entry?.moduleData && typeof entry.moduleData === "object" ? entry.moduleData : {};
  if (typeof moduleData.version === "string" && moduleData.version.trim()) return moduleData.version.trim();
  if (typeof entry?.renpyVersion === "string" && entry.renpyVersion.trim()) return entry.renpyVersion.trim();
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
  const direct = normalizeRenpyMajor(moduleData.major ?? entry?.renpyMajor);
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
  if (typeof entry?.renpyBaseName === "string" && entry.renpyBaseName.trim()) {
    return entry.renpyBaseName.trim();
  }
  return null;
}

function resolveGameOnly(entry) {
  const moduleData = entry?.moduleData && typeof entry.moduleData === "object" ? entry.moduleData : {};
  if (moduleData.gameOnly === true) return true;
  if (entry?.renpyGameOnly === true) return true;
  return false;
}

function resolveContentRoot(entry) {
  return entry?.contentRootDir || entry?.gamePath || null;
}

function cleanupGameData(entry, context) {
  const userDataDir = context?.userDataDir;
  const gamePath = entry?.gamePath;
  if (!userDataDir || !gamePath) return false;
  const id = stableIdForPath(gamePath);
  const root = path.join(userDataDir, "modules", "renpy");
  safeRm(path.join(root, "builds", id));
  safeRm(path.join(root, "projects", id));
  safeRm(path.join(root, "patches", `${id}.json`));
  return true;
}

function resolveGameIcon(entry) {
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
    entry?.runtimeData?.sdk?.version ?? entry?.renpySdkVersion ?? ""
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

function applyPatchStatus(entry, status) {
  updateModuleData(entry, {
    patched: Boolean(status?.patched),
    partial: Boolean(status?.partial)
  });
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
  const meta = RuntimeSdk.pruneBuildsMeta(userDataDir, entry.gamePath);
  const builds = Array.isArray(meta.builds) ? meta.builds : [];
  const latest = builds[0] || null;
  applyBuildMeta(entry, latest);
  return latest;
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
  migrateSettings,
  migrateEntry,
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
      const meta = RuntimeSdk.readBuildsMeta(userDataDir, entry.gamePath);
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

      const existingBuilds = RuntimeSdk.pruneBuildsMeta(context.userDataDir, entry.gamePath);
      if (Array.isArray(existingBuilds.builds) && existingBuilds.builds.length > 0) {
        throw new Error("App already built. Delete it before rebuilding.");
      }

      const platform = RuntimeSdk.detectSdkPlatform(sdkInstall.installDir, major);
      const needsRosetta = process.arch === "arm64" && isX64Platform(platform);

      const res = await RuntimeSdk.buildMacApp({
        userDataDir: context.userDataDir,
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
        const res = RuntimeSdk.deleteLatestBuild(context.userDataDir, entry.gamePath);
        if (!res) break;
        if (!res.removed) {
          throw new Error("Refusing to delete build outside the build directory.");
        }
        deleted = true;
      }
      if (!deleted) throw new Error("No build found.");
      applyBuildMeta(entry, null);
      return true;
    }
  },
  runtime: {
    sdkManager: LegacySdkManager,
    patcher: RuntimePatcher,
    patchSdk: PatchSdk,
    sdk: RuntimeSdk
  }
};
