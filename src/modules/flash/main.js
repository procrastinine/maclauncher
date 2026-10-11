const fs = require("node:fs");
const path = require("node:path");

const manifest = require("./manifest.json");
const { detectGame } = require("./detect");
const RuffleRuntimeManager = require("./runtime/ruffle-runtime-manager");
const ProjectorRuntimeManager = require("./runtime/projector-manager");
const FFDec = require("./runtime/ffdec-manager");
const Tools = require("./tools");
const GameData = require("../shared/game-data");
const AppBundle = require("../shared/runtime/app-bundle");

const RuffleCore = RuffleRuntimeManager.core;
const PROJECTOR_RUNTIME_ID = "projector";
const RUFFLE_RUNTIME_ID = "ruffle";

function safeRm(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {}
}

function existsFile(p) {
  try {
    return fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function normalizeRuntimeId(input) {
  const value = typeof input === "string" ? input.trim().toLowerCase() : "";
  if (value === RUFFLE_RUNTIME_ID) return RUFFLE_RUNTIME_ID;
  if (value === PROJECTOR_RUNTIME_ID) return PROJECTOR_RUNTIME_ID;
  return PROJECTOR_RUNTIME_ID;
}

function updateRuntimeData(entry, runtimeId, patch) {
  const runtimeData =
    entry?.runtimeData && typeof entry.runtimeData === "object" ? entry.runtimeData : {};
  const current =
    runtimeData[runtimeId] && typeof runtimeData[runtimeId] === "object"
      ? runtimeData[runtimeId]
      : {};
  const next = { ...current };

  for (const [key, value] of Object.entries(patch || {})) {
    if (value === null || value === undefined) delete next[key];
    else next[key] = value;
  }

  if (Object.keys(next).length === 0) delete runtimeData[runtimeId];
  else runtimeData[runtimeId] = next;

  entry.runtimeData = { ...runtimeData };
}

function resolveRuntimeData(entry, runtimeId) {
  const runtimeData =
    entry?.runtimeData && typeof entry.runtimeData === "object" ? entry.runtimeData : {};
  const section = runtimeData[runtimeId];
  return section && typeof section === "object" ? section : {};
}

function normalizeRuffleVersionOrNull(input) {
  if (typeof input !== "string" || !input.trim()) return null;
  try {
    return RuffleCore.normalizeVersion(input.trim());
  } catch {
    return null;
  }
}

function resolveSwfPath(entry) {
  const moduleData = entry?.moduleData && typeof entry.moduleData === "object" ? entry.moduleData : {};
  const fromModuleData =
    typeof moduleData.swfPath === "string" && moduleData.swfPath.trim()
      ? moduleData.swfPath.trim()
      : null;
  if (fromModuleData) return fromModuleData;

  const gamePath = typeof entry?.gamePath === "string" && entry.gamePath.trim() ? entry.gamePath.trim() : null;
  if (gamePath && path.extname(gamePath).toLowerCase() === ".swf") return gamePath;

  return null;
}

function resolveAppExecutablePath(appPath, preferredName) {
  return AppBundle.resolveAppBundleExecutablePath(appPath, preferredName);
}

function ruffleLaunchCommand(appPath, executablePath, swfPath) {
  return AppBundle.appBundleLaunchCommand(appPath, [swfPath], { executablePath });
}

function resolveRuffleSelection(entry, settings, userDataDir) {
  const runtimeData = resolveRuntimeData(entry, RUFFLE_RUNTIME_ID);
  const cfg = RuffleRuntimeManager.normalizeSettings(settings?.runtimes?.ruffle);

  const overrideVersion = normalizeRuffleVersionOrNull(runtimeData.version);
  const defaultVersion = normalizeRuffleVersionOrNull(cfg.defaultVersion);
  const latestInstalled = RuffleCore.listInstalled(userDataDir)[0]?.version || null;
  const requestedVersion = overrideVersion || defaultVersion || latestInstalled || null;

  const install = RuffleCore.resolveInstalled({
    userDataDir,
    version: requestedVersion
  });

  return {
    runtimeData,
    overrideVersion,
    defaultVersion,
    latestInstalled,
    requestedVersion,
    install
  };
}

function shouldPersistRuffleVersion(payload, overrideVersion) {
  if (payload?.persistVersion === true) return true;
  if (typeof payload?.version === "string" && payload.version.trim()) return true;
  return Boolean(overrideVersion);
}

async function resolveInstallVersion(context) {
  const current = RuffleRuntimeManager.getState({
    settings: context.settings?.runtimes?.ruffle,
    userDataDir: context.userDataDir
  });
  let version = current?.sections?.[0]?.catalog?.versions?.[0] || null;
  if (version) return version;

  await RuffleRuntimeManager.refreshCatalog({
    logger: context.logger,
    force: true,
    latestOnly: false
  });
  context.onRuntimeStateChange?.();

  const refreshed = RuffleRuntimeManager.getState({
    settings: context.settings?.runtimes?.ruffle,
    userDataDir: context.userDataDir
  });
  version = refreshed?.sections?.[0]?.catalog?.versions?.[0] || null;
  return version || null;
}

function cleanupGameData(entry, context) {
  const userDataDir = context?.userDataDir;
  const gameId = entry?.gameId;
  if (!userDataDir || !gameId) return false;
  safeRm(GameData.resolveGameModuleDir(userDataDir, gameId, manifest.id));
  return true;
}

async function ensureRuntime(entry, context) {
  if (normalizeRuntimeId(context.runtimeId || entry.runtimeId || manifest.runtime.default) === PROJECTOR_RUNTIME_ID) {
    const selection = ProjectorRuntimeManager.resolveSelection(entry, context.settings, context.userDataDir);
    if (!selection.ready) throw new Error(selection.reason || "Included Flash Player is missing. Reinstall MacLauncher.");
    return null;
  }
  const selection = resolveRuffleSelection(entry, context.settings, context.userDataDir);
  if (selection.install?.appPath) return null;
  const version = selection.requestedVersion || await resolveInstallVersion(context);
  if (!version) throw new Error("No Ruffle version is available for install.");
  if (RuffleCore.resolveInstalled({ userDataDir: context.userDataDir, version })?.appPath) return null;
  return { managerId: RuffleRuntimeManager.id, version, installOptions: { sectionId: "default" } };
}

async function launchRuntime(runtimeId, entry, context) {
  const normalizedRuntimeId = normalizeRuntimeId(runtimeId);
  if (normalizedRuntimeId !== PROJECTOR_RUNTIME_ID && normalizedRuntimeId !== RUFFLE_RUNTIME_ID) {
    return null;
  }

  const swfPath = resolveSwfPath(entry);
  if (!swfPath || !existsFile(swfPath)) {
    throw new Error("Flash .swf file not found.");
  }

  if (normalizedRuntimeId === PROJECTOR_RUNTIME_ID) {
    const selection = ProjectorRuntimeManager.resolveSelection(entry, context.settings, context.userDataDir);
    if (!selection.ready) throw new Error(selection.reason || "Included Flash Player is missing. Reinstall MacLauncher.");
    const { executablePath } = selection.install;
    context.logger?.info?.(`[runtime] launch flash projector ${executablePath} ${swfPath}`);
    return context.spawnDetachedChecked(executablePath, [swfPath], {
      cwd: path.dirname(swfPath)
    }, false);
  }

  const selection = resolveRuffleSelection(entry, context.settings, context.userDataDir);
  if (!selection.install?.appPath) {
    const suffix = selection.requestedVersion ? ` v${selection.requestedVersion}` : "";
    throw new Error(`Ruffle runtime${suffix} is not installed. Install it from Runtimes.`);
  }

  const executablePath = resolveAppExecutablePath(selection.install.appPath);
  if (!executablePath) {
    throw new Error("Ruffle app bundle is missing its executable.");
  }

  const command = ruffleLaunchCommand(selection.install.appPath, executablePath, swfPath);
  context.logger?.info?.(`[runtime] launch ruffle ${selection.install.version} ${selection.install.appPath} ${swfPath}`);
  return context.spawnDetachedChecked(command.command, command.args, {
    cwd: process.platform === "darwin" ? selection.install.appPath : path.dirname(swfPath)
  });
}

module.exports = {
  id: manifest.id,
  manifest,
  detectGame,
  normalizeRuntimeId,
  runtimeManagers: [RuffleRuntimeManager, ProjectorRuntimeManager, FFDec],
  launchRuntime,
  ensureRuntime,
  cleanupGameData,
  actions: {
    decompile: (entry, payload, context) => Tools.exportGame(entry, payload || {}, context),
    exportAssets: (entry, payload, context) => Tools.exportGame(entry, { ...payload, assets: true }, context),
    revealExport: Tools.revealExport,
    runtimeStatus: (entry, _payload, context) => {
      if (context.runtimeId === PROJECTOR_RUNTIME_ID) {
        const selection = ProjectorRuntimeManager.resolveSelection(entry, context.settings, context.userDataDir);
        return { ready: selection.ready, installed: selection.ready, requiredVersion: selection.version, resolvedVersion: selection.version };
      }
      const selection = resolveRuffleSelection(entry, context.settings, context.userDataDir);
      const installed = Boolean(selection.install?.appPath);

      return {
        ready: installed,
        installed,
        requiredVersion: selection.requestedVersion || null,
        resolvedVersion: selection.install?.version || selection.requestedVersion || null
      };
    },
    installRuntime: async (entry, payload, context) => {
      if (context.runtimeId === PROJECTOR_RUNTIME_ID) {
        const selection = ProjectorRuntimeManager.resolveSelection(entry, context.settings, context.userDataDir);
        if (!selection.ready) throw new Error(selection.reason || "Included Flash Player is missing. Reinstall MacLauncher.");
        return { version: selection.version, alreadyInstalled: true };
      }
      const status = payload?.status && typeof payload.status === "object" ? payload.status : null;
      const selection = resolveRuffleSelection(entry, context.settings, context.userDataDir);
      const overrideVersion = selection.overrideVersion;

      let requestedVersion =
        normalizeRuffleVersionOrNull(payload?.version) ||
        normalizeRuffleVersionOrNull(status?.requiredVersion) ||
        normalizeRuffleVersionOrNull(status?.resolvedVersion) ||
        overrideVersion ||
        selection.defaultVersion ||
        null;

      if (!requestedVersion) {
        requestedVersion = await resolveInstallVersion(context);
      }
      if (!requestedVersion) {
        throw new Error("No Ruffle version is available for install.");
      }

      const existing = RuffleCore.resolveInstalled({
        userDataDir: context.userDataDir,
        version: requestedVersion
      });

      if (existing?.appPath) {
        if (shouldPersistRuffleVersion(payload, overrideVersion)) {
          updateRuntimeData(entry, RUFFLE_RUNTIME_ID, { version: existing.version });
        }
        return {
          version: existing.version,
          alreadyInstalled: true
        };
      }

      const installed = await RuffleRuntimeManager.installRuntime({
        userDataDir: context.userDataDir,
        version: requestedVersion,
        logger: context.logger,
        downloads: context.downloads
      });

      const resolvedVersion = installed?.version || requestedVersion;
      if (shouldPersistRuffleVersion(payload, overrideVersion)) {
        updateRuntimeData(entry, RUFFLE_RUNTIME_ID, { version: resolvedVersion });
      }

      return {
        version: resolvedVersion
      };
    }
  },
  __test: {
    resolveAppExecutablePath,
    resolveRuffleSelection,
    ruffleLaunchCommand
  }
};
