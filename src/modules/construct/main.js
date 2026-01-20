const fs = require("node:fs");
const path = require("node:path");

const manifest = require("./manifest.json");
const { detectGame } = require("./detect");
const NwjsLauncher = require("../shared/web/runtime/nwjs-launcher");
const NwjsPatchedLauncher = require("../shared/web/runtime/nwjs-patched-launcher");
const NwjsRuntimeManager = require("../shared/web/runtime/nwjs-manager");
const {
  extractPackage,
  resolveExtractionRoot,
  resolveExtractionStatus,
  writeExtractionMeta
} = require("./extract");

const WEBVIEW2_SHIM_NAME = "maclauncher-construct-webview2.js";
const WEBVIEW2_SHIM_SOURCE = (() => {
  try {
    return fs.readFileSync(path.join(__dirname, "webview2-shim.js"), "utf8");
  } catch {
    return null;
  }
})();

function getWebview2ShimConfig() {
  if (!WEBVIEW2_SHIM_SOURCE) return null;
  return {
    injectStart: [`./${WEBVIEW2_SHIM_NAME}`],
    extraFiles: [
      {
        path: WEBVIEW2_SHIM_NAME,
        contents: WEBVIEW2_SHIM_SOURCE
      }
    ]
  };
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

function applyExtractionStatus(entry, status) {
  updateModuleData(entry, {
    extractedReady: Boolean(status?.extractedReady),
    extractedRoot: status?.extractedRoot || null,
    constructRuntime: status?.constructRuntime || null
  });

  if (status?.contentRootDir && status?.indexHtml) {
    entry.contentRootDir = status.contentRootDir;
    entry.indexHtml = status.indexHtml;
    entry.indexDir = status.indexDir || path.dirname(status.indexHtml);
  } else if (entry?.moduleData?.packagedType) {
    entry.indexHtml = null;
    entry.indexDir = null;
  }
}

function isIndexWithinGamePath(entry) {
  const indexHtml = entry?.indexHtml;
  const gamePath = entry?.gamePath;
  if (!indexHtml || !gamePath) return false;
  const rel = path.relative(gamePath, indexHtml);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function resolveLaunchContent(entry, userDataDir) {
  const status = resolveExtractionStatus({
    entry,
    userDataDir,
    moduleId: manifest.id
  });

  if (status.extractedReady && status.indexHtml) {
    return {
      contentRootDir: status.contentRootDir,
      indexHtml: status.indexHtml
    };
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
  if (runtimeId === "nwjs") {
    const resolved = resolveLaunchContent(entry, context.userDataDir);
    if (!resolved.indexHtml) {
      throw new Error("Missing index.html; extract the Construct bundle first.");
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
    const shimConfig = getWebview2ShimConfig();
    return NwjsLauncher.launchRuntime({
      entry: launchEntry,
      moduleId: manifest.id,
      userDataDir: context.userDataDir,
      settings: context.settings,
      toolsButtonVisible: context.toolsButtonVisible,
      runtimeSettings,
      cheatsFilePath: context.cheatsFilePath,
      supportsCheats: false,
      injectStart: shimConfig?.injectStart,
      extraFiles: shimConfig?.extraFiles,
      logger: context.logger,
      onRuntimeStateChange: context.onRuntimeStateChange
    });
  }

  if (runtimeId === "nwjs-patched") {
    const resolved = resolveLaunchContent(entry, context.userDataDir);
    if (!resolved.indexHtml) {
      throw new Error("Missing index.html; extract the Construct bundle first.");
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
    const shimConfig = getWebview2ShimConfig();
    return NwjsPatchedLauncher.launchRuntime({
      entry: launchEntry,
      moduleId: manifest.id,
      userDataDir: context.userDataDir,
      settings: context.settings,
      toolsButtonVisible: context.toolsButtonVisible,
      runtimeSettings,
      cheatsFilePath: context.cheatsFilePath,
      supportsCheats: false,
      patchConfig: null,
      injectStart: shimConfig?.injectStart,
      extraFiles: shimConfig?.extraFiles,
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
      moduleId: manifest.id
    });
    applyExtractionStatus(entry, status);
    return {
      extractedReady: Boolean(status.extractedReady),
      extractedRoot: status.extractedRoot || null,
      constructRuntime: status.constructRuntime || null,
      packagedType: status.packagedType || null
    };
  },
  extractGame: async (entry, _payload, context) => {
    const moduleData = entry?.moduleData && typeof entry.moduleData === "object" ? entry.moduleData : {};
    const packagedType = moduleData.packagedType || null;
    const packagedPath = moduleData.packagedPath || null;

    if (!packagedType) {
      const status = resolveExtractionStatus({
        entry,
        userDataDir: context.userDataDir,
        moduleId: manifest.id
      });
      applyExtractionStatus(entry, status);
      return {
        extractedReady: Boolean(status.extractedReady),
        extractedRoot: status.extractedRoot || null,
        constructRuntime: status.constructRuntime || null,
        packagedType: status.packagedType || null
      };
    }

    if (!packagedPath) {
      throw new Error("Packaged Construct source not found.");
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
      moduleId: manifest.id
    });

    if (!status.extractedReady || !status.indexHtml) {
      throw new Error("Extraction completed but no index.html was found.");
    }

    applyExtractionStatus(entry, status);
    return {
      extractedReady: Boolean(status.extractedReady),
      extractedRoot: status.extractedRoot || null,
      constructRuntime: status.constructRuntime || null,
      packagedType: status.packagedType || null
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
      extractedReady: false
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
  filterRuntimeSupport: (entry, supported) => {
    if (entry?.moduleData?.packagedType && !isIndexWithinGamePath(entry)) {
      return supported.filter(rt => rt !== "electron");
    }
    return supported;
  },
  canLaunchRuntime: (runtimeId, entry) => {
    if (runtimeId === "electron") return isIndexWithinGamePath(entry);
    return true;
  },
  launchRuntime,
  runtimeManagers: [NwjsRuntimeManager],
  actions,
  cleanupGameData
};
