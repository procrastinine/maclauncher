const fs = require("node:fs");
const path = require("node:path");
const { createCheatsHelpers } = require("../cheats/cheats");
const CheatsPatcher = require("../web/cheats/patcher");
const { detectRpgmakerGame } = require("./rpgmaker-detect");
const { decodeSave, encodeSave } = require("./rpgmaker-save");
const NwjsLauncher = require("../web/runtime/nwjs-launcher");
const NwjsPatchedLauncher = require("../web/runtime/nwjs-patched-launcher");
const NwjsRuntimeManager = require("../web/runtime/nwjs-manager");
const PluginTools = require("./plugins");

const cheatsSchema = require("./cheats/schema.json");
const cheatsHelpers = createCheatsHelpers(cheatsSchema);

const LEGACY_RUNTIME_MAP = {
  embedded: "electron",
  external: "nwjs",
  electron: "electron",
  nwjs: "nwjs",
  native: "native"
};

function normalizeRuntimeId(input, fallback = "electron") {
  const raw = typeof input === "string" ? input.trim().toLowerCase() : "";
  if (!raw) return fallback;
  if (raw in LEGACY_RUNTIME_MAP) return LEGACY_RUNTIME_MAP[raw];
  return raw;
}

function parseSemver(input) {
  const raw = String(input || "").trim().replace(/^v/i, "");
  const match = raw.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i += 1) {
    const diff = pa[i] - pb[i];
    if (diff !== 0) return diff;
  }
  return 0;
}

function supportsEs13(nwVersion) {
  if (!nwVersion) return false;
  return compareSemver(nwVersion, "0.57.0") >= 0;
}

function buildPatchedConfig({ engineId, runtimeSettings, nwVersion } = {}) {
  const modules = [];
  const scripts = [];
  const enableRemapFixes = runtimeSettings?.enableRemapFixes === true;
  const enableVarsInspector = runtimeSettings?.enableVarsInspector === true;
  const enableDecryptedAssets = runtimeSettings?.enableDecryptedAssets === true;

  if (enableRemapFixes) {
    modules.push("rpg-inject.mjs", "rpg-remap.mjs", "rpg-fixes.mjs");
  }

  if (enableVarsInspector && supportsEs13(nwVersion)) {
    modules.push("rpg-vars.mjs");
  }

  if (enableDecryptedAssets) {
    if (engineId === "mv") scripts.push("mv-decrypted-assets.js");
    if (engineId === "mz") scripts.push("mz-decrypted-assets.js");
  }

  return { modules, scripts };
}

function buildRpgmakerModule({ manifest, engineId, saveExtension, libs, smokeTest } = {}) {
  if (!manifest || !engineId) throw new Error("rpgmaker module missing manifest/engineId");

  function resolveDefaultLibVersion(dep) {
    return dep.versions.length ? dep.versions[0].id : null;
  }

  function buildLibsState() {
    if (!libs?.catalog) return null;
    const deps = libs.catalog.listDependencies();
    const dependencies = deps.map(dep => {
      const defaultVersion = resolveDefaultLibVersion(dep);
      return {
        id: dep.id,
        label: dep.label,
        engine: dep.engine,
        description: dep.description ?? null,
        defaultVersion,
        versions: (dep.versions || []).map(version => ({
          id: version.id,
          label: version.label,
          summary: version.summary ?? null,
          engineVersion: version.engineVersion ?? null,
          notes: Array.isArray(version.notes) ? version.notes.slice() : [],
          source: version.source ?? null
        }))
      };
    });
    return { dependencies };
  }

  function detectGame(context, helpers) {
    const detected = detectRpgmakerGame(context, helpers);
    if (!detected || detected.engine !== engineId) return null;
    return detected;
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

  function resolveIndexDir(entry) {
    if (entry?.indexDir) return entry.indexDir;
    if (entry?.indexHtml) return path.dirname(entry.indexHtml);
    if (entry?.contentRootDir) return entry.contentRootDir;
    return null;
  }

  function resolveGameIcon(entry) {
    const rootDir =
      typeof entry?.contentRootDir === "string" && entry.contentRootDir
        ? entry.contentRootDir
        : typeof entry?.gamePath === "string"
          ? entry.gamePath
          : "";
    if (!rootDir) return null;
    const candidates =
      engineId === "mv"
        ? [
            path.join(rootDir, "www", "icon", "icon.png"),
            path.join(rootDir, "icon", "icon.png")
          ]
        : [
            path.join(rootDir, "icon", "icon.png"),
            path.join(rootDir, "www", "icon", "icon.png")
          ];
    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          return candidate;
        }
      } catch {}
    }
    return null;
  }

  function resolvePatchedVersion(settings, runtimeData, entry, userDataDir) {
    const managerSettings =
      settings?.runtimes && typeof settings.runtimes === "object" ? settings.runtimes.nwjs : null;
    const sourceRoot =
      typeof entry?.contentRootDir === "string" && entry.contentRootDir
        ? entry.contentRootDir
        : entry?.gamePath || "";
    const greenworks = NwjsPatchedLauncher.resolveGreenworksRequirement({
      userDataDir,
      managerSettings,
      sourceRoot
    });
    if (greenworks.needsGreenworks && !greenworks.greenworksVersion) {
      throw new Error(
        "Greenworks is required but no Greenworks runtime is installed. Install it from Runtimes."
      );
    }
    const resolved = NwjsPatchedLauncher.resolveRuntimeConfig({
      managerSettings,
      runtimeData,
      greenworksVersion: greenworks.greenworksVersion
    });
    return resolved?.version || null;
  }

  function applyPluginStatus(entry, status) {
    updateModuleData(entry, {
      clipboardPluginInstalled: Boolean(status?.clipboard?.installed),
      saveSlotsPluginInstalled: Boolean(status?.saveSlots?.installed)
    });
  }

  function refreshPluginStatus(entry, logger) {
    const indexDir = resolveIndexDir(entry);
    if (!indexDir) throw new Error("Missing indexDir for plugin actions.");
    const status = PluginTools.getAllStatus(indexDir);
    applyPluginStatus(entry, status);
    return status;
  }

  function migrateSettings(settings) {
    if (!settings || typeof settings !== "object") return;
    if (!settings.modules || typeof settings.modules !== "object") settings.modules = {};
    if (!settings.modules[manifest.id]) settings.modules[manifest.id] = {};

    const legacyDefaults = settings.defaults && typeof settings.defaults === "object" ? settings.defaults : {};
    const legacyGroup = legacyDefaults.rpgmaker && typeof legacyDefaults.rpgmaker === "object"
      ? legacyDefaults.rpgmaker
      : {};

    if (typeof legacyGroup.toolsButtonVisible === "boolean") {
      settings.modules[manifest.id].toolsButtonVisible = legacyGroup.toolsButtonVisible;
    }

    if (typeof legacyGroup.defaultRuntime === "string") {
      settings.modules[manifest.id].defaultRuntime = normalizeRuntimeId(legacyGroup.defaultRuntime);
    }
    if (typeof settings.modules[manifest.id].defaultRuntime === "string") {
      settings.modules[manifest.id].defaultRuntime = normalizeRuntimeId(
        settings.modules[manifest.id].defaultRuntime
      );
    }

    if (!settings.runtimes || typeof settings.runtimes !== "object") settings.runtimes = {};
    if (settings.runtimes.external && !settings.runtimes.nwjs) {
      settings.runtimes.nwjs = { ...settings.runtimes.external };
    }
    if (settings.nwjs && typeof settings.nwjs === "object" && !settings.runtimes.nwjs) {
      settings.runtimes.nwjs = { ...settings.nwjs };
    }
    if (settings.runtimes.nwjs && typeof settings.runtimes.nwjs === "object") {
      if (typeof settings.runtimes.nwjs.defaultVariant === "string") {
        settings.runtimes.nwjs.defaultVariant = "sdk";
      }
    }
  }

  function migrateEntry(entry) {
    if (!entry || typeof entry !== "object") return {};
    const moduleData = {};
    const runtimeData = {};

    if (typeof entry.toolsButtonVisibleOverride === "boolean") {
      moduleData.toolsButtonVisibleOverride = entry.toolsButtonVisibleOverride;
    }

    if (entry.libVersions && typeof entry.libVersions === "object") {
      moduleData.libVersions = { ...entry.libVersions };
    }

    if (entry.runtimeData && typeof entry.runtimeData === "object") {
      if (entry.runtimeData.nwjs && typeof entry.runtimeData.nwjs === "object") {
        runtimeData.nwjs = { ...entry.runtimeData.nwjs };
      } else if (entry.runtimeData.external && typeof entry.runtimeData.external === "object") {
        runtimeData.nwjs = { ...entry.runtimeData.external };
      }
    }

    if (typeof entry.nwjsVersion === "string" && entry.nwjsVersion.trim()) {
      runtimeData.nwjs = {
        ...runtimeData.nwjs,
        version: entry.nwjsVersion.trim().replace(/^v/i, "")
      };
    }

    if (typeof entry.nwjsVariant === "string" && entry.nwjsVariant.trim()) {
      runtimeData.nwjs = {
        ...runtimeData.nwjs,
        variant: "sdk"
      };
    }

    if (runtimeData.nwjs && typeof runtimeData.nwjs === "object") {
      if (typeof runtimeData.nwjs.variant === "string" && runtimeData.nwjs.variant.trim()) {
        runtimeData.nwjs.variant = "sdk";
      }
    }

    return {
      moduleData,
      runtimeData,
      runtimeId: normalizeRuntimeId(entry.runtime)
    };
  }

  async function launchRuntime(runtimeId, entry, context) {
    if (runtimeId !== "nwjs" && runtimeId !== "nwjs-patched") return null;
    const runtimeSettings =
      context?.runtimeSettings && typeof context.runtimeSettings === "object"
        ? context.runtimeSettings
        : null;
    if (runtimeId === "nwjs-patched") {
      const runtimeData =
        entry?.runtimeData && typeof entry.runtimeData === "object"
          ? entry.runtimeData["nwjs-patched"]
          : null;
      const nwVersion = resolvePatchedVersion(
        context?.settings,
        runtimeData,
        entry,
        context.userDataDir
      );
      const patchConfig = buildPatchedConfig({ engineId, runtimeSettings, nwVersion });
      return NwjsPatchedLauncher.launchRuntime({
        entry,
        moduleId: manifest.id,
        userDataDir: context.userDataDir,
        settings: context.settings,
        toolsButtonVisible: context.toolsButtonVisible,
        runtimeSettings,
        cheatsFilePath: context.cheatsFilePath,
        supportsCheats: manifest.supports?.cheats === true,
        patchConfig,
        logger: context.logger,
        onRuntimeStateChange: context.onRuntimeStateChange
      });
    }
    return NwjsLauncher.launchRuntime({
      entry,
      moduleId: manifest.id,
      userDataDir: context.userDataDir,
      settings: context.settings,
      toolsButtonVisible: context.toolsButtonVisible,
      runtimeSettings,
      cheatsFilePath: context.cheatsFilePath,
      supportsCheats: manifest.supports?.cheats === true,
      logger: context.logger,
      onRuntimeStateChange: context.onRuntimeStateChange
    });
  }

  return {
    id: manifest.id,
    manifest,
    detectGame,
    resolveGameIcon,
    migrateSettings,
    migrateEntry,
    launchRuntime,
    actions: {
      refreshPluginStatus: (entry, _payload, context) => {
        const status = refreshPluginStatus(entry, context?.logger);
        return {
          clipboardPluginInstalled: Boolean(status?.clipboard?.installed),
          saveSlotsPluginInstalled: Boolean(status?.saveSlots?.installed)
        };
      },
      installClipboardPlugin: (entry, _payload, context) => {
        const indexDir = resolveIndexDir(entry);
        if (!indexDir) throw new Error("Missing indexDir for plugin actions.");
        PluginTools.installPlugin(indexDir, PluginTools.PLUGIN_IDS.clipboard, {
          logger: context?.logger
        });
        const status = refreshPluginStatus(entry, context?.logger);
        return {
          clipboardPluginInstalled: Boolean(status?.clipboard?.installed),
          saveSlotsPluginInstalled: Boolean(status?.saveSlots?.installed)
        };
      },
      removeClipboardPlugin: (entry, _payload, context) => {
        const indexDir = resolveIndexDir(entry);
        if (!indexDir) throw new Error("Missing indexDir for plugin actions.");
        PluginTools.removePlugin(indexDir, PluginTools.PLUGIN_IDS.clipboard, {
          logger: context?.logger
        });
        const status = refreshPluginStatus(entry, context?.logger);
        return {
          clipboardPluginInstalled: Boolean(status?.clipboard?.installed),
          saveSlotsPluginInstalled: Boolean(status?.saveSlots?.installed)
        };
      },
      installSaveSlotsPlugin: (entry, _payload, context) => {
        const indexDir = resolveIndexDir(entry);
        if (!indexDir) throw new Error("Missing indexDir for plugin actions.");
        PluginTools.installPlugin(indexDir, PluginTools.PLUGIN_IDS.saveSlots, {
          logger: context?.logger
        });
        const status = refreshPluginStatus(entry, context?.logger);
        return {
          clipboardPluginInstalled: Boolean(status?.clipboard?.installed),
          saveSlotsPluginInstalled: Boolean(status?.saveSlots?.installed)
        };
      },
      removeSaveSlotsPlugin: (entry, _payload, context) => {
        const indexDir = resolveIndexDir(entry);
        if (!indexDir) throw new Error("Missing indexDir for plugin actions.");
        PluginTools.removePlugin(indexDir, PluginTools.PLUGIN_IDS.saveSlots, {
          logger: context?.logger
        });
        const status = refreshPluginStatus(entry, context?.logger);
        return {
          clipboardPluginInstalled: Boolean(status?.clipboard?.installed),
          saveSlotsPluginInstalled: Boolean(status?.saveSlots?.installed)
        };
      }
    },
    runtimeManagers: [NwjsRuntimeManager],
    getState: () => ({ libs: buildLibsState() }),
    smokeTest,
    save: {
      extensions: [saveExtension],
      decode: raw => decodeSave(engineId, raw),
      encode: json => encodeSave(engineId, json)
    },
    cheats: {
      schema: cheatsSchema,
      defaults: cheatsHelpers.defaults,
      normalize: cheatsHelpers.normalizeCheats,
      equals: cheatsHelpers.cheatsEqual,
      patcher: CheatsPatcher
    },
    libs
  };
}

module.exports = {
  buildRpgmakerModule,
  normalizeRuntimeId,
  buildPatchedConfig,
  supportsEs13
};
