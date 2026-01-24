const fs = require("node:fs");
const path = require("node:path");
const { shell } = require("electron");
const { createCheatsHelpers } = require("../cheats/cheats");
const CheatsPatcher = require("../web/cheats/patcher");
const { detectRpgmakerGame } = require("./rpgmaker-detect");
const { decodeSave, encodeSave } = require("./rpgmaker-save");
const NwjsLauncher = require("../web/runtime/nwjs-launcher");
const NwjsPatchedLauncher = require("../web/runtime/nwjs-patched-launcher");
const NwjsRuntimeManager = require("../web/runtime/nwjs-manager");
const PluginTools = require("./plugins");
const {
  resolveSourceRoot,
  resolveExtractionRoot,
  resolveExtractionStatus,
  writeExtractionMeta,
  runDecrypter
} = require("./decrypt");

const cheatsSchema = require("./cheats/schema.json");
const cheatsHelpers = createCheatsHelpers(cheatsSchema);

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

function normalizeRuntimeId(input, fallback = "electron") {
  const raw = typeof input === "string" ? input.trim().toLowerCase() : "";
  return raw || fallback;
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

  function formatDecryptStatusLabel(status) {
    if (!status?.sourcePath) return "No encrypted files found.";
    if (status.decryptedReady) return "Decrypted";
    return "Not decrypted";
  }

  function decorateDecryptStatus(status) {
    return {
      ...status,
      decryptStatusLabel: formatDecryptStatusLabel(status)
    };
  }

  function applyDecryptStatus(entry, status) {
    updateModuleData(entry, {
      decryptedReady: Boolean(status?.decryptedReady),
      decryptedRoot: status?.decryptedRoot || null,
      decryptedAt: Number.isFinite(status?.decryptedAt) ? status.decryptedAt : null,
      decryptedMode: status?.mode || null
    });
  }

  function cleanupGameData(entry, context) {
    const userDataDir = context?.userDataDir;
    if (!userDataDir) return false;
    const moduleData = entry?.moduleData && typeof entry.moduleData === "object" ? entry.moduleData : {};
    const roots = new Set();
    if (typeof moduleData.decryptedRoot === "string" && moduleData.decryptedRoot.trim()) {
      roots.add(moduleData.decryptedRoot.trim());
    }
    const computed = resolveExtractionRoot({ entry, userDataDir, moduleId: manifest.id });
    if (computed) roots.add(computed);
    for (const root of roots) {
      safeRm(root);
    }
    return true;
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
    launchRuntime,
    cleanupGameData,
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
      },
      refreshDecryptionStatus: (entry, _payload, context) => {
        const sourcePath = resolveSourceRoot(entry);
        const status = resolveExtractionStatus({
          entry,
          userDataDir: context.userDataDir,
          sourcePath,
          moduleId: manifest.id
        });
        applyDecryptStatus(entry, status);
        return decorateDecryptStatus(status);
      },
      revealDecryption: (entry, _payload, context) => {
        const sourcePath = resolveSourceRoot(entry);
        const status = resolveExtractionStatus({
          entry,
          userDataDir: context.userDataDir,
          sourcePath,
          moduleId: manifest.id
        });
        applyDecryptStatus(entry, status);
        if (!status?.decryptedRoot || !existsDir(status.decryptedRoot)) {
          return decorateDecryptStatus(status);
        }
        shell.showItemInFolder(status.decryptedRoot);
        return { revealed: true };
      },
      decryptGame: async (entry, _payload, context) => {
        const sourcePath = resolveSourceRoot(entry);
        if (!sourcePath || !existsDir(sourcePath)) {
          throw new Error("RPG Maker source root not found.");
        }
        const extractRoot = resolveExtractionRoot({
          entry,
          userDataDir: context.userDataDir,
          moduleId: manifest.id
        });
        safeRm(extractRoot);
        await runDecrypter({
          sourcePath,
          outputDir: extractRoot,
          reconstruct: false,
          logger: context.logger
        });
        writeExtractionMeta(extractRoot, {
          sourcePath,
          extractedAt: Date.now(),
          mode: "decrypt"
        });
        const status = resolveExtractionStatus({
          entry,
          userDataDir: context.userDataDir,
          sourcePath,
          moduleId: manifest.id
        });
        applyDecryptStatus(entry, status);
        return decorateDecryptStatus(status);
      },
      reconstructProject: async (entry, _payload, context) => {
        const sourcePath = resolveSourceRoot(entry);
        if (!sourcePath || !existsDir(sourcePath)) {
          throw new Error("RPG Maker source root not found.");
        }
        const extractRoot = resolveExtractionRoot({
          entry,
          userDataDir: context.userDataDir,
          moduleId: manifest.id
        });
        safeRm(extractRoot);
        await runDecrypter({
          sourcePath,
          outputDir: extractRoot,
          reconstruct: true,
          logger: context.logger
        });
        writeExtractionMeta(extractRoot, {
          sourcePath,
          extractedAt: Date.now(),
          mode: "reconstruct"
        });
        const status = resolveExtractionStatus({
          entry,
          userDataDir: context.userDataDir,
          sourcePath,
          moduleId: manifest.id
        });
        applyDecryptStatus(entry, status);
        return decorateDecryptStatus(status);
      },
      removeDecryption: (entry, _payload, context) => {
        const extractRoot = resolveExtractionRoot({
          entry,
          userDataDir: context.userDataDir,
          moduleId: manifest.id
        });
        safeRm(extractRoot);
        const status = resolveExtractionStatus({
          entry,
          userDataDir: context.userDataDir,
          sourcePath: resolveSourceRoot(entry),
          moduleId: manifest.id
        });
        applyDecryptStatus(entry, status);
        return decorateDecryptStatus(status);
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
