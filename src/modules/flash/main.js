const fs = require("node:fs");
const path = require("node:path");

const manifest = require("./manifest.json");
const { detectGame } = require("./detect");
const RuffleRuntimeManager = require("./runtime/ruffle-runtime-manager");
const Custom = require("../shared/runtime/custom-runtime");
const { selectRuntimeVersion } = require("../shared/runtime/version-choices");
const ProjectorRuntimeManager = require("./runtime/projector-manager");
const FFDec = require("./runtime/ffdec-manager");
const Tools = require("./tools");
const GameData = require("../shared/game-data");
const AppBundle = require("../shared/runtime/app-bundle");
const GraphicsInputs = require("../shared/runtime/native-graphics-inputs");

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
  if (typeof input !== "string" || !input.trim() || input.trim() === "auto") return null;
  try {
    return RuffleCore.normalizeVersion(input);
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
  try { if (fs.statSync(appPath).isFile()) return appPath; } catch {}
  return AppBundle.resolveAppBundleExecutablePath(appPath, preferredName);
}

function ruffleLaunchCommand(appPath, executablePath, swfPath, gameArguments = []) {
  if (!appPath.toLowerCase().endsWith(".app")) return { command: executablePath, args: [swfPath, ...gameArguments] };
  return AppBundle.appBundleLaunchCommand(appPath, [swfPath, ...gameArguments], { executablePath });
}
const needsTranslation = install => Boolean(install?.requiresRosetta || install?.needsRosetta);

const resolveRuffleSelection = Custom.createSelector(RuffleRuntimeManager, function managedRuffleSelection(entry, settings, userDataDir) {
  const runtimeData = resolveRuntimeData(entry, RUFFLE_RUNTIME_ID);
  const overrideVersion = normalizeRuffleVersionOrNull(runtimeData.version);
  const state = RuffleRuntimeManager.getState({ settings: settings?.runtimes?.ruffle, userDataDir });
  const defaultVersion = state.sections?.[0]?.defaultVersion || state.defaultVersion;
  const latestInstalled = RuffleCore.listInstalled(userDataDir)[0]?.version || null;
  const requestedVersion = selectRuntimeVersion({ manual: overrideVersion, defaultVersion }).version;

  const install = requestedVersion ? RuffleCore.resolveInstalled({ userDataDir, version: requestedVersion }) : null;

  return {
    runtimeData,
    overrideVersion,
    defaultVersion,
    latestInstalled,
    requestedVersion,
    install
  };
}, { result: (selection, { entry, settings, userDataDir }) => ({
  runtimeData: resolveRuntimeData(entry, RUFFLE_RUNTIME_ID),
  overrideVersion: normalizeRuffleVersionOrNull(resolveRuntimeData(entry, RUFFLE_RUNTIME_ID).version),
  defaultVersion: RuffleRuntimeManager.getState({ settings: settings?.runtimes?.ruffle, userDataDir }).sections?.[0]?.defaultVersion,
  latestInstalled: RuffleCore.listInstalled(userDataDir)[0]?.version || null,
  requestedVersion: selection.version, install: selection.install, reason: selection.reason
}) });

function shouldPersistRuffleVersion(payload, overrideVersion) {
  if (payload?.persistVersion === true || normalizeRuffleVersionOrNull(payload?.version)) return true;
  return Boolean(overrideVersion);
}

async function resolveInstallVersion(context) {
  const current = RuffleRuntimeManager.getState({
    settings: context.settings?.runtimes?.ruffle,
    userDataDir: context.userDataDir
  });
  let version = selectRuntimeVersion({ defaultVersion: current?.sections?.[0]?.defaultVersion || current.defaultVersion }).version;
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
  version = selectRuntimeVersion({ defaultVersion: refreshed?.sections?.[0]?.defaultVersion || refreshed.defaultVersion }).version;
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
    if (selection.ready) return null;
    return { managerId: ProjectorRuntimeManager.id, version: selection.version,
      ...(selection.discoveryRequired ? { discoveryRequired: true } : {}),
      installOptions: { sectionId: "default" } };
  }
  const selection = resolveRuffleSelection(entry, context.settings, context.userDataDir);
  if (selection.install?.appPath) return null;
  if (selection.reason) throw new Error(selection.reason);
  const version = selection.requestedVersion;
  if (!version) return { managerId: RuffleRuntimeManager.id, version: null, discoveryRequired: true,
    installOptions: { sectionId: "default" } };
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
    if (!selection.ready) throw new Error(selection.reason || "Install Flash Player in Runtimes.");
    const { executablePath } = selection.install;
    context.logger?.info?.(`[runtime] launch flash projector ${executablePath} ${swfPath}`);
    return context.spawnDetachedChecked(executablePath, [swfPath, ...(context.gameArguments || [])], {
      cwd: path.dirname(swfPath)
    }, needsTranslation(selection.install));
  }

  const selection = resolveRuffleSelection(entry, context.settings, context.userDataDir);
  if (!selection.install?.appPath) {
    const suffix = selection.requestedVersion ? ` v${selection.requestedVersion}` : "";
    throw new Error(`Ruffle runtime${suffix} is not installed. Install it from Runtimes.`);
  }

  const executablePath = selection.install.executablePath || resolveAppExecutablePath(selection.install.appPath);
  if (!executablePath) {
    throw new Error("Ruffle app bundle is missing its executable.");
  }

  const command = ruffleLaunchCommand(selection.install.appPath, executablePath, swfPath, context.gameArguments);
  context.logger?.info?.(`[runtime] launch ruffle ${selection.install.version} ${selection.install.appPath} ${swfPath}`);
  return context.spawnDetachedChecked(command.command, command.args, {
    cwd: selection.install.custom ? path.dirname(executablePath) : process.platform === "darwin" ? selection.install.appPath : path.dirname(swfPath)
  }, needsTranslation(selection.install));
}

function resolveGraphicsInputs(entry,context={}) {
  const runtimeId=normalizeRuntimeId(context.runtimeId||entry.runtimeId||manifest.runtime.default);
  const selection=runtimeId===PROJECTOR_RUNTIME_ID
    ? ProjectorRuntimeManager.resolveSelection(entry,context.settings,context.userDataDir)
    : resolveRuffleSelection(entry,context.settings,context.userDataDir);
  const install=selection?.install;
  const executable=install?.executablePath||(install?.appPath&&resolveAppExecutablePath(install.appPath));
  if(!executable)return null;
  return GraphicsInputs.withInputs({moduleData:{executablePath:executable}}, {
    runtimeId:"native",declaredArchitecture:needsTranslation(install)?"x86_64":undefined
  });
}

module.exports = {
  id: manifest.id,
  manifest,
  detectGame,
  normalizeRuntimeId,
  resolveGraphicsInputs,
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
        if (selection.ready) return { version: selection.version, alreadyInstalled: true };
        const installed = await ProjectorRuntimeManager.installRuntime({ userDataDir: context.userDataDir,
          version: payload?.version || selection.version, logger: context.logger,
          downloads: context.downloads, signal: context.signal });
        return { version: installed.version };
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
