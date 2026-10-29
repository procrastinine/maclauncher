const fs = require("node:fs");
const { getUiServices } = require("../shared/ui-services");
const manifest = require("./manifest.json");
const { detectGame } = require("./detect");
const Assets = require("./assets");
const Rtp = require("./rtp");
const { cheatsSchema, cheatsHelpers } = require("./cheats");
const {
  resolveArchivePath,
  resolveExtractionRoot,
  resolveExtractionStatus,
  writeExtractionMeta,
  runDecrypter
} = require("./decrypt");
const MkxpzLauncher = require("./runtime/mkxpz-launcher");
const MkxpzRuntimeManager = require("./runtime/mkxpz-manager");
const Decrypter = require("../shared/runtime/decrypter-manager");
const Packaged = require("./packaged");
const Tools = require("./tools");
const Writable = require("../shared/writable-input");
const { prepareInput } = require("./writable-input");

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

function resolveRuntimeVersion(entry, settings, userDataDir) {
  return MkxpzRuntimeManager.selectedVersion(entry, settings, userDataDir);
}

function resolveRuntimeSource(entry, userDataDir, settings) {
  const version = resolveRuntimeVersion(entry, settings, userDataDir);
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

function formatDecryptStatusLabel(status) {
  if (!status?.archivePath) return "No encrypted files found.";
  if (status.decryptedReady) return "Extracted";
  return "Not extracted";
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
    decryptedMode: status?.mode || null,
    archivePath: status?.archivePath || null
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
  const computed = resolveExtractionRoot({ entry, userDataDir });
  if (computed) roots.add(computed);
  for (const root of roots) {
    safeRm(root);
  }
  return true;
}

module.exports = {
  id: manifest.id,
  manifest,
  distributionSupplementals: require("./runtime/distribution-supplementals"),
  runtimeManagers: [MkxpzRuntimeManager, Decrypter],
  cheats: {
    schema: cheatsSchema,
    defaults: cheatsHelpers.defaults,
    normalize: cheatsHelpers.normalizeCheats,
    equals: cheatsHelpers.cheatsEqual
  },
  save: { extensions: ["rxdata", "rvdata", "rvdata2", "sav", "save", "dat"], recursive: false },
  detectGame,
  prepareInput,
  getRuntimeRequirements: async (entry, context) => {
    if (context.runtimeId !== "mkxpz") return [];
    // Executable containers reveal Game.ini during automatic extraction.
    const source = await Packaged.ensureExtracted(entry, context.userDataDir);
    if (source !== entry) entry.moduleData = { ...entry.moduleData, ...source.moduleData };
    return Rtp.getRuntimeRequirements(source, context, { runtimeVersion: resolveRuntimeVersion(entry, context.settings, context.userDataDir) });
  },
  prepareLaunch: async (entry, context) => {
    if (context.runtimeId !== "mkxpz") return;
    const { values } = await Rtp.resolveForEntry(entry, context);
    if (values.some(value => !value)) throw new Error("A required RTP pack is missing. Play downloads it after confirmation.");
    const version = resolveRuntimeVersion(entry, context.settings, context.userDataDir);
    for (const pack of values) await context.useRuntime?.({ managerId: "mkxpz", version: pack.installVersion || version, sectionId: "rtp-" + pack.id, sourcePath: pack.path });
  },
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
  launchRuntime: async (runtimeId, entry, context) => {
    if (runtimeId !== "mkxpz") return null;
    entry = prepareInput(entry, context);
    const extracted = await Packaged.ensureExtracted(entry, context.userDataDir);
    if (extracted !== entry) {
      Object.assign(entry, extracted);
      context.onEntryChange?.({
        contentRootDir: entry.contentRootDir,
        defaultSaveDir: entry.defaultSaveDir,
        moduleData: entry.moduleData
      });
    }
    return MkxpzLauncher.launchRuntime({
      entry,
      userDataDir: context.userDataDir,
      settings: context.settings,
      runtimeSettings: context.runtimeSettings,
      gameArguments: context.gameArguments,
      logger: context.logger,
      spawnDetachedChecked: context.spawnDetachedChecked,
      signal: context.signal,
      useRuntime: context.useRuntime,
      withRuntimeMutation: context.withRuntimeMutation,
      onRuntimeStateChange: context.onRuntimeStateChange,
      cheatsFilePath: context.cheatsFilePath
    });
  },
  cleanupGameData,
  actions: {
    refreshRgssTools: (entry, _payload, context) => {
      const scriptArchivePath = Tools.resolveScriptsPath(entry);
      const scriptsExportDir = Tools.resolveExportDir(entry, context);
      updateModuleData(entry, { scriptsAvailable: Boolean(scriptArchivePath), scriptsExportReady: Boolean(scriptsExportDir) });
      return { scriptArchivePath, scriptsExportDir, scriptsExportCount: entry.moduleData?.scriptsExportCount || 0 };
    },
    exportScripts: (entry, _payload, context) => {
      const result = Tools.exportGameScripts(entry, context);
      updateModuleData(entry, { scriptsAvailable: true, scriptsExportReady: true });
      return result;
    },
    repackScripts: (entry, _payload, context) => Tools.repackGameScripts(entry, context),
    revealScripts: (entry, _payload, context) => {
      const exportDir = Tools.resolveExportDir(entry, context);
      if (!exportDir) throw new Error("No exported Scripts folder found.");
      getUiServices(context).shell.showItemInFolder(exportDir);
      return { revealed: true, outputDir: exportDir };
    },
    inspectRgssFile: async (entry, payload, context) => {
      let filePath = payload?.filePath;
      if (!filePath) {
        const selection = await getUiServices(context).dialog.showOpenDialog({
          title: "Inspect RGSS save or database",
          properties: ["openFile"],
          defaultPath: entry.saveDirOverride || entry.contentRootDir,
          filters: [{ name: "RGSS data and saves", extensions: ["rxdata", "rvdata", "rvdata2", "sav"] }, { name: "All files", extensions: ["*"] }]
        });
        if (selection.canceled || !selection.filePaths?.[0]) return { canceled: true };
        filePath = selection.filePaths[0];
      }
      return Tools.writeInspectionReport(entry, filePath, context);
    },
    discoverSaves: (entry, payload, context) => Tools.writeSaveDiscoveryReport(entry, context, payload),
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
    removeAssets: async (entry, _payload, context) => {
      if (typeof context.withRuntimeMutation !== "function") throw new Error("Shared RGSS asset removal requires a runtime coordination context.");
      return context.withRuntimeMutation({ managerId: "mkxpz" }, async () => {
        Assets.removeStagedAssets({ userDataDir: context.userDataDir });
        const runtimeSource = resolveRuntimeSource(entry, context.userDataDir, context.settings);
        applyAssetsStatus(entry, { assetsStaged: false }, runtimeSource);
        return { assetsStaged: false, runtimeSource };
      });
    },
    refreshSetupStatus: (entry, _payload, context) => {
      const status = Assets.getAssetsStatus({ userDataDir: context.userDataDir });
      const runtimeSource = resolveRuntimeSource(entry, context.userDataDir, context.settings);
      applyAssetsStatus(entry, status, runtimeSource);
      return { assetsStaged: Boolean(status.assetsStaged), runtimeSource };
    },
    revealAssets: (_entry, _payload, context) => {
      const paths = Assets.resolveStagedPaths(context.userDataDir);
      if (!paths?.assetsRoot || !existsDir(paths.assetsRoot)) {
        throw new Error("No staged assets found.");
      }
      getUiServices(context).shell.showItemInFolder(paths.assetsRoot);
      return { revealed: true };
    },
    refreshDecryptionStatus: (entry, _payload, context) => {
      const status = resolveExtractionStatus({ entry, userDataDir: context.userDataDir });
      applyDecryptStatus(entry, status);
      return decorateDecryptStatus(status);
    },
    revealDecryption: (entry, _payload, context) => {
      const status = resolveExtractionStatus({ entry, userDataDir: context.userDataDir });
      applyDecryptStatus(entry, status);
      if (!status?.decryptedRoot || !existsDir(status.decryptedRoot)) {
        return decorateDecryptStatus(status);
      }
      getUiServices(context).shell.showItemInFolder(status.decryptedRoot);
      return { revealed: true };
    },
    decryptGame: async (entry, _payload, context) => {
      const archivePath = resolveArchivePath(entry);
      if (!archivePath) {
        const status = resolveExtractionStatus({ entry, userDataDir: context.userDataDir });
        applyDecryptStatus(entry, status);
        return decorateDecryptStatus(status);
      }
      const extractRoot = resolveExtractionRoot({ entry, userDataDir: context.userDataDir });
      const tool = await Decrypter.ensure(entry, _payload, context);
      safeRm(extractRoot);
      await runDecrypter({
        cli: tool.executablePath,
        context,
        archivePath,
        outputDir: extractRoot,
        reconstruct: false,
        logger: context.logger
      });
      writeExtractionMeta(extractRoot, {
        sourcePath: archivePath,
        extractedAt: Date.now(),
        mode: "decrypt"
      });
      const status = resolveExtractionStatus({ entry, userDataDir: context.userDataDir });
      applyDecryptStatus(entry, status);
      return decorateDecryptStatus(status);
    },
    reconstructProject: async (entry, _payload, context) => {
      const archivePath = resolveArchivePath(entry);
      if (!archivePath) {
        const status = resolveExtractionStatus({ entry, userDataDir: context.userDataDir });
        applyDecryptStatus(entry, status);
        return decorateDecryptStatus(status);
      }
      const extractRoot = resolveExtractionRoot({ entry, userDataDir: context.userDataDir });
      const tool = await Decrypter.ensure(entry, _payload, context);
      safeRm(extractRoot);
      await runDecrypter({
        cli: tool.executablePath,
        context,
        archivePath,
        outputDir: extractRoot,
        reconstruct: true,
        logger: context.logger
      });
      writeExtractionMeta(extractRoot, {
        sourcePath: archivePath,
        extractedAt: Date.now(),
        mode: "reconstruct"
      });
      const status = resolveExtractionStatus({ entry, userDataDir: context.userDataDir });
      applyDecryptStatus(entry, status);
      return decorateDecryptStatus(status);
    },
    removeDecryption: (entry, _payload, context) => {
      const extractRoot = resolveExtractionRoot({ entry, userDataDir: context.userDataDir });
      safeRm(extractRoot);
      const status = {
        decryptedReady: false,
        decryptedRoot: extractRoot,
        decryptedAt: null,
        archivePath: resolveArchivePath(entry),
        mode: null,
        sourcePath: null
      };
      applyDecryptStatus(entry, status);
      return decorateDecryptStatus(status);
    }
  }
};

for (const [id, action] of Object.entries(module.exports.actions)) {
  module.exports.actions[id] = (entry, payload, context = {}) =>
    Writable.runPrepared(entry, context, input => Writable.sourceEntry(prepareInput(input, context)), input => action(input, payload, context));
}
