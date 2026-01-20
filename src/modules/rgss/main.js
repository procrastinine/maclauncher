const manifest = require("./manifest.json");
const { detectGame } = require("./detect");
const Assets = require("./assets");
const MkxpzLauncher = require("./runtime/mkxpz-launcher");
const MkxpzRuntimeManager = require("./runtime/mkxpz-manager");

function updateModuleData(entry, patch) {
  const current = entry?.moduleData && typeof entry.moduleData === "object" ? entry.moduleData : {};
  const next = { ...current };
  for (const [key, value] of Object.entries(patch || {})) {
    if (value === null || value === undefined) delete next[key];
    else next[key] = value;
  }
  entry.moduleData = next;
}

function mergeEntry(existing, incoming) {
  if (!existing) return incoming;
  const merged = { ...incoming };
  if (existing.moduleData || incoming.moduleData) {
    merged.moduleData = {
      ...(existing.moduleData && typeof existing.moduleData === "object" ? existing.moduleData : {}),
      ...(incoming.moduleData && typeof incoming.moduleData === "object" ? incoming.moduleData : {})
    };
  }
  if (existing.runtimeData || incoming.runtimeData) {
    merged.runtimeData = {
      ...(existing.runtimeData && typeof existing.runtimeData === "object" ? existing.runtimeData : {}),
      ...(incoming.runtimeData && typeof incoming.runtimeData === "object" ? incoming.runtimeData : {})
    };
  }
  if (existing.runtimeSettings || incoming.runtimeSettings) {
    merged.runtimeSettings = {
      ...(existing.runtimeSettings && typeof existing.runtimeSettings === "object"
        ? existing.runtimeSettings
        : {}),
      ...(incoming.runtimeSettings && typeof incoming.runtimeSettings === "object"
        ? incoming.runtimeSettings
        : {})
    };
  }
  return merged;
}

function resolveRuntimeVersion(entry, settings) {
  const managerSettings =
    settings?.runtimes && typeof settings.runtimes === "object" ? settings.runtimes.mkxpz : null;
  const cfg = MkxpzRuntimeManager.normalizeSettings(managerSettings);
  const runtimeData =
    entry?.runtimeData && typeof entry.runtimeData === "object" ? entry.runtimeData.mkxpz : null;
  const override =
    runtimeData && typeof runtimeData.version === "string" && runtimeData.version.trim()
      ? runtimeData.version.trim()
      : null;
  return override || cfg.defaultVersion || null;
}

function resolveRuntimeSource(entry, userDataDir, settings) {
  const version = resolveRuntimeVersion(entry, settings);
  if (!version) return null;
  const installed = MkxpzRuntimeManager.core.listInstalled(userDataDir);
  const match = installed.find(item => item.version === version);
  return match?.source || null;
}

function applyAssetsStatus(entry, status, runtimeSource) {
  updateModuleData(entry, {
    assetsStaged: Boolean(status?.assetsStaged),
    runtimeSource: runtimeSource || null
  });
}

module.exports = {
  id: manifest.id,
  manifest,
  runtimeManagers: [MkxpzRuntimeManager],
  detectGame,
  mergeEntry,
  onImport: (entry, context) => {
    if (!context?.userDataDir) return;
    try {
      const status = Assets.ensureAssetsStaged({
        userDataDir: context.userDataDir,
        logger: context.logger
      });
      const runtimeSource = resolveRuntimeSource(entry, context.userDataDir, context.settings);
      applyAssetsStatus(entry, status, runtimeSource);
    } catch (e) {
      context?.logger?.warn?.("[rgss] asset staging failed on import", String(e?.message || e));
    }
  },
  launchRuntime: (runtimeId, entry, context) => {
    if (runtimeId !== "mkxpz") return null;
    return MkxpzLauncher.launchRuntime({
      entry,
      userDataDir: context.userDataDir,
      settings: context.settings,
      runtimeSettings: context.runtimeSettings,
      logger: context.logger,
      spawnDetachedChecked: context.spawnDetachedChecked,
      onRuntimeStateChange: context.onRuntimeStateChange
    });
  },
  actions: {
    stageAssets: (entry, _payload, context) => {
      const status = Assets.ensureAssetsStaged({
        userDataDir: context.userDataDir,
        logger: context.logger,
        force: true
      });
      const runtimeSource = resolveRuntimeSource(entry, context.userDataDir, context.settings);
      applyAssetsStatus(entry, status, runtimeSource);
      return { assetsStaged: Boolean(status.assetsStaged), runtimeSource };
    },
    removeAssets: (entry, _payload, context) => {
      Assets.removeStagedAssets({ userDataDir: context.userDataDir });
      const runtimeSource = resolveRuntimeSource(entry, context.userDataDir, context.settings);
      applyAssetsStatus(entry, { assetsStaged: false }, runtimeSource);
      return { assetsStaged: false, runtimeSource };
    },
    refreshSetupStatus: (entry, _payload, context) => {
      const status = Assets.getAssetsStatus({ userDataDir: context.userDataDir });
      const runtimeSource = resolveRuntimeSource(entry, context.userDataDir, context.settings);
      applyAssetsStatus(entry, status, runtimeSource);
      return { assetsStaged: Boolean(status.assetsStaged), runtimeSource };
    }
  }
};
