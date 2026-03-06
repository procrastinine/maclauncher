const fs = require("node:fs");
const path = require("node:path");

const manifest = require("./manifest.json");
const { detectGame } = require("./detect");
const RuffleRuntimeManager = require("./runtime/ruffle-runtime-manager");
const GameData = require("../shared/game-data");

const RuffleCore = RuffleRuntimeManager.core;
const PROJECTOR_RUNTIME_ID = "projector";
const RUFFLE_RUNTIME_ID = "ruffle";
const PROJECTOR_APP_RELATIVE = path.join(
  "src",
  "modules",
  "flash",
  "resources",
  "flash-player",
  "Flash Player.app"
);

let projectorAppPathOverride = null;

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

function listProjectorAppCandidates() {
  if (projectorAppPathOverride) {
    return [projectorAppPathOverride];
  }

  const localResource = path.resolve(__dirname, "resources", "flash-player", "Flash Player.app");
  const resourcesPath =
    typeof process?.resourcesPath === "string" && process.resourcesPath.trim()
      ? process.resourcesPath.trim()
      : null;

  const candidates = [
    localResource,
    resourcesPath ? path.join(resourcesPath, "app.asar.unpacked", PROJECTOR_APP_RELATIVE) : null,
    resourcesPath ? path.join(resourcesPath, PROJECTOR_APP_RELATIVE) : null
  ].filter(Boolean);

  return Array.from(new Set(candidates));
}

function resolveProjectorAppPath() {
  for (const candidate of listProjectorAppCandidates()) {
    if (existsDir(candidate)) return candidate;
  }
  return null;
}

function readAppExecutableName(appPath) {
  const infoPath = path.join(appPath, "Contents", "Info.plist");
  try {
    const raw = fs.readFileSync(infoPath);
    if (!raw || raw.length < 16) return null;
    const header = raw.subarray(0, 6).toString("utf8");
    if (header === "bplist") return null;
    const text = raw.toString("utf8");
    const match = text.match(/<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

function resolveAppExecutablePath(appPath, preferredName) {
  if (!appPath) return null;

  const macosDir = path.join(appPath, "Contents", "MacOS");
  if (!existsDir(macosDir)) return null;

  if (preferredName) {
    const preferred = path.join(macosDir, preferredName);
    if (existsFile(preferred)) return preferred;
  }

  const fromPlist = readAppExecutableName(appPath);
  if (fromPlist) {
    const fromInfo = path.join(macosDir, fromPlist);
    if (existsFile(fromInfo)) return fromInfo;
  }

  const bundleName = path.basename(appPath, ".app");
  if (bundleName) {
    const sameAsBundle = path.join(macosDir, bundleName);
    if (existsFile(sameAsBundle)) return sameAsBundle;
  }

  try {
    const entries = fs.readdirSync(macosDir, { withFileTypes: true });
    const first = entries.find(entry => entry.isFile());
    return first ? path.join(macosDir, first.name) : null;
  } catch {
    return null;
  }
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
    latestOnly: true
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
    const appPath = resolveProjectorAppPath();
    if (!appPath) {
      const expected = listProjectorAppCandidates()[0] || PROJECTOR_APP_RELATIVE;
      throw new Error(
        `Bundled Adobe Flash Player is missing. Expected app bundle at ${expected}.`
      );
    }

    const executablePath = resolveAppExecutablePath(appPath, "Flash Player");
    if (!executablePath) {
      throw new Error(
        `Bundled Adobe Flash Player is invalid. Expected executable under ${path.join(appPath, "Contents", "MacOS")}.`
      );
    }

    context.logger?.info?.(`[runtime] launch flash projector ${executablePath} ${swfPath}`);
    return context.spawnDetachedChecked(executablePath, [swfPath], {
      cwd: path.dirname(swfPath)
    });
  }

  const selection = resolveRuffleSelection(entry, context.settings, context.userDataDir);
  if (!selection.install?.appPath) {
    const suffix = selection.requestedVersion ? ` v${selection.requestedVersion}` : "";
    throw new Error(`Ruffle runtime${suffix} is not installed. Install it from Runtimes.`);
  }

  const executablePath = resolveAppExecutablePath(selection.install.appPath, "Ruffle");
  if (!executablePath) {
    throw new Error("Ruffle app bundle is missing its executable.");
  }

  context.logger?.info?.(`[runtime] launch ruffle ${executablePath} ${swfPath}`);
  return context.spawnDetachedChecked(executablePath, [swfPath], {
    cwd: path.dirname(swfPath)
  });
}

module.exports = {
  id: manifest.id,
  manifest,
  detectGame,
  normalizeRuntimeId,
  runtimeManagers: [RuffleRuntimeManager],
  launchRuntime,
  cleanupGameData,
  actions: {
    runtimeStatus: (entry, _payload, context) => {
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
    setProjectorAppPathOverride: value => {
      projectorAppPathOverride =
        typeof value === "string" && value.trim() ? path.resolve(value.trim()) : null;
    },
    resetOverrides: () => {
      projectorAppPathOverride = null;
    },
    listProjectorAppCandidates,
    resolveProjectorAppPath,
    resolveAppExecutablePath,
    resolveRuffleSelection
  }
};
