const fs = require("node:fs");
const { shell } = require("electron");
const manifest = require("./manifest.json");
const { detectGame } = require("./detect");
const Assets = require("./assets");
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

function formatDecryptStatusLabel(status) {
  if (!status?.archivePath) return "No archive found";
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
  runtimeManagers: [MkxpzRuntimeManager],
  cheats: {
    schema: cheatsSchema,
    defaults: cheatsHelpers.defaults,
    normalize: cheatsHelpers.normalizeCheats,
    equals: cheatsHelpers.cheatsEqual
  },
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
      onRuntimeStateChange: context.onRuntimeStateChange,
      cheatsFilePath: context.cheatsFilePath
    });
  },
  cleanupGameData,
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
    },
    refreshDecryptionStatus: (entry, _payload, context) => {
      const status = resolveExtractionStatus({ entry, userDataDir: context.userDataDir });
      applyDecryptStatus(entry, status);
      return decorateDecryptStatus(status);
    },
    revealDecryption: (entry, _payload, context) => {
      const status = resolveExtractionStatus({ entry, userDataDir: context.userDataDir });
      if (!status?.decryptedRoot || !existsDir(status.decryptedRoot)) {
        throw new Error("No decrypted files found.");
      }
      shell.showItemInFolder(status.decryptedRoot);
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
      safeRm(extractRoot);
      await runDecrypter({
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
      safeRm(extractRoot);
      await runDecrypter({
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
