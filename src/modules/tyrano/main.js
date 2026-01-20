const fs = require("node:fs");
const path = require("node:path");
const { shell } = require("electron");

const manifest = require("./manifest.json");
const { detectGame } = require("./detect");
const NwjsLauncher = require("../shared/web/runtime/nwjs-launcher");
const NwjsPatchedLauncher = require("../shared/web/runtime/nwjs-patched-launcher");
const NwjsRuntimeManager = require("../shared/web/runtime/nwjs-manager");
const {
  extractPackage,
  findContentRoot,
  resolveExtractionRoot,
  resolveExtractionStatus,
  writeExtractionMeta
} = require("./extract");

function updateModuleData(entry, patch) {
  const current = entry?.moduleData && typeof entry.moduleData === "object" ? entry.moduleData : {};
  const next = { ...current };
  for (const [key, value] of Object.entries(patch || {})) {
    if (value === null || value === undefined) delete next[key];
    else next[key] = value;
  }
  entry.moduleData = next;
}

function formatBundleLabel(packagedType) {
  const raw = String(packagedType || "").trim();
  if (!raw) return null;
  if (raw === "zip-exe") return "zip exe";
  if (raw === "package.nw") return "package.nw";
  if (raw === "asar") return "asar";
  return raw.replace(/[-_]+/g, " ");
}

function applyExtractionStatus(entry, status) {
  const moduleData = entry?.moduleData && typeof entry.moduleData === "object" ? entry.moduleData : {};
  const packagedPath =
    typeof moduleData.packagedPath === "string" && moduleData.packagedPath.trim()
      ? moduleData.packagedPath.trim()
      : null;
  const extractedRoot = status?.extractedRoot || null;
  const revealPath =
    status?.extractedReady && extractedRoot ? extractedRoot : packagedPath || null;
  updateModuleData(entry, {
    extractedReady: Boolean(status?.extractedReady),
    extractedRoot: extractedRoot,
    version: status?.version || null,
    bundleRevealPath: revealPath
  });

  if (status?.contentRootDir && status?.indexHtml) {
    entry.contentRootDir = status.contentRootDir;
    entry.indexHtml = status.indexHtml;
    entry.indexDir = status.indexDir || path.dirname(status.indexHtml);
  } else {
    entry.indexHtml = null;
    entry.indexDir = null;
  }
}

function resolveLaunchContent(entry) {
  const moduleData = entry?.moduleData && typeof entry.moduleData === "object" ? entry.moduleData : {};
  const extractedRoot = moduleData.extractedRoot && typeof moduleData.extractedRoot === "string"
    ? moduleData.extractedRoot
    : null;

  if (extractedRoot) {
    const content = findContentRoot(extractedRoot);
    if (content) {
      return {
        contentRootDir: content.contentRootDir,
        indexHtml: content.indexHtml
      };
    }
  }

  return {
    contentRootDir: entry?.contentRootDir || entry?.gamePath,
    indexHtml: entry?.indexHtml || null
  };
}

function cleanupGameData(entry, context) {
  const userDataDir = context?.userDataDir;
  if (!userDataDir) return false;
  const moduleData = entry?.moduleData && typeof entry.moduleData === "object" ? entry.moduleData : {};
  const roots = new Set();
  if (typeof moduleData.extractedRoot === "string" && moduleData.extractedRoot.trim()) {
    roots.add(moduleData.extractedRoot.trim());
  }
  const computed = resolveExtractionRoot({ entry, userDataDir, moduleId: manifest.id });
  if (computed) roots.add(computed);
  for (const root of roots) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {}
  }
  return true;
}

async function launchRuntime(runtimeId, entry, context) {
  if (runtimeId === "nwjs" || runtimeId === "nwjs-patched") {
    const resolved = resolveLaunchContent(entry);
    if (!resolved.indexHtml) {
      throw new Error("Missing index.html; extract the Tyrano bundle first.");
    }
    const launchEntry = {
      ...entry,
      gameType: "web",
      contentRootDir: resolved.contentRootDir,
      indexHtml: resolved.indexHtml,
      indexDir: path.dirname(resolved.indexHtml)
    };

    const runtimeSettings =
      context?.runtimeSettings && typeof context.runtimeSettings === "object"
        ? context.runtimeSettings
        : null;

    if (runtimeId === "nwjs") {
      return NwjsLauncher.launchRuntime({
        entry: launchEntry,
        moduleId: manifest.id,
        userDataDir: context.userDataDir,
        settings: context.settings,
        toolsButtonVisible: context.toolsButtonVisible,
        runtimeSettings,
        cheatsFilePath: context.cheatsFilePath,
        supportsCheats: false,
        logger: context.logger,
        onRuntimeStateChange: context.onRuntimeStateChange
      });
    }

    return NwjsPatchedLauncher.launchRuntime({
      entry: launchEntry,
      moduleId: manifest.id,
      userDataDir: context.userDataDir,
      settings: context.settings,
      toolsButtonVisible: context.toolsButtonVisible,
      runtimeSettings,
      cheatsFilePath: context.cheatsFilePath,
      supportsCheats: false,
      patchConfig: {
        modules: [],
        scripts: []
      },
      contentRootOverride: resolved.contentRootDir,
      indexHtmlOverride: resolved.indexHtml,
      logger: context.logger,
      onRuntimeStateChange: context.onRuntimeStateChange
    });
  }

  return null;
}

const actions = {
  refreshExtractionStatus: (entry, _payload, context) => {
    const status = resolveExtractionStatus({
      entry,
      userDataDir: context.userDataDir,
      moduleId: manifest.id,
      logger: context.logger
    });
    applyExtractionStatus(entry, status);
    return {
      extractedReady: Boolean(status.extractedReady),
      extractedRoot: status.extractedRoot || null,
      version: status.version || null,
      packagedType: status.packagedType || null,
      bundleLabel: formatBundleLabel(status.packagedType)
    };
  },
  revealBundle: (entry) => {
    const moduleData = entry?.moduleData && typeof entry.moduleData === "object" ? entry.moduleData : {};
    const target =
      moduleData.bundleRevealPath ||
      moduleData.extractedRoot ||
      moduleData.packagedPath ||
      entry?.gamePath ||
      null;
    if (!target) throw new Error("No bundle location to reveal.");
    shell.showItemInFolder(target);
    return { revealed: true };
  },
  extractGame: async (entry, _payload, context) => {
    const moduleData = entry?.moduleData && typeof entry.moduleData === "object" ? entry.moduleData : {};
    const packagedType = moduleData.packagedType || null;
    const packagedPath = moduleData.packagedPath || null;

    if (!packagedType) {
      const status = resolveExtractionStatus({
        entry,
        userDataDir: context.userDataDir,
        moduleId: manifest.id,
        logger: context.logger
      });
      applyExtractionStatus(entry, status);
      return {
        extractedReady: Boolean(status.extractedReady),
        extractedRoot: status.extractedRoot || null,
        version: status.version || null,
        packagedType: status.packagedType || null
      };
    }

    if (!packagedPath) {
      throw new Error("Packaged Tyrano source not found.");
    }

    const extractRoot = resolveExtractionRoot({
      entry,
      userDataDir: context.userDataDir,
      moduleId: manifest.id
    });

    await extractPackage({
      packagePath: packagedPath,
      packageType: packagedType,
      extractRoot,
      userDataDir: context.userDataDir,
      logger: context.logger
    });

    writeExtractionMeta(extractRoot, {
      sourcePath: packagedPath,
      sourceType: packagedType,
      extractedAt: Date.now()
    });

    const status = resolveExtractionStatus({
      entry,
      userDataDir: context.userDataDir,
      moduleId: manifest.id,
      logger: context.logger
    });

    if (!status.extractedReady || !status.indexHtml) {
      throw new Error("Extraction completed but no index.html was found.");
    }

    applyExtractionStatus(entry, status);
    return {
      extractedReady: Boolean(status.extractedReady),
      extractedRoot: status.extractedRoot || null,
      version: status.version || null,
      packagedType: status.packagedType || null,
      bundleLabel: formatBundleLabel(status.packagedType)
    };
  },
  removeExtraction: (entry, _payload, context) => {
    const moduleData = entry?.moduleData && typeof entry.moduleData === "object" ? entry.moduleData : {};
    const extractRoot = moduleData.extractedRoot || resolveExtractionRoot({
      entry,
      userDataDir: context.userDataDir,
      moduleId: manifest.id
    });
    try {
      fs.rmSync(extractRoot, { recursive: true, force: true });
    } catch {}

    updateModuleData(entry, {
      extractedRoot: null,
      extractedReady: false,
      bundleRevealPath:
        typeof moduleData.packagedPath === "string" && moduleData.packagedPath.trim()
          ? moduleData.packagedPath.trim()
          : null
    });
    entry.indexHtml = null;
    entry.indexDir = null;

    return {
      extractedReady: false,
      extractedRoot: null,
      packagedType: moduleData.packagedType || null
    };
  }
};

module.exports = {
  id: manifest.id,
  manifest,
  detectGame,
  launchRuntime,
  runtimeManagers: [NwjsRuntimeManager],
  actions,
  cleanupGameData
};
