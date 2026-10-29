const Core = require("./core");
const { selectRuntimeVersion, managerDefaultVersion } = require("../../shared/runtime/version-choices");
const fs = require("node:fs");
const path = require("node:path");
const Custom = require("../../shared/runtime/custom-runtime");
const { runDownloadTask } = require("../../shared/runtime/download-manager");
const { buildRuntimeDownloadMeta } = require("../../shared/runtime/runtime-downloads");

const SECTION_DEFAULT = "default";

let catalogPromise = null;
let catalogReleasesByVersion = {};
let catalog = {
  status: "idle",
  versions: [],
  fetchedAt: null,
  source: null,
  error: null,
  mode: null
};

function normalizeSettings(input) {
  const version = typeof input?.defaultVersion === "string" ? input.defaultVersion.trim() : "";
  try { return { defaultVersion: version && version !== "auto" ? Core.normalizeVersion(version) : null }; }
  catch { return { defaultVersion: null }; }
}

function newestInstalled(installed) {
  const list = Array.isArray(installed) ? installed.slice() : [];
  list.sort((a, b) => {
    const byVersion = Core.compareVersionsDesc(String(a?.version || ""), String(b?.version || ""));
    if (byVersion !== 0) return byVersion;
    return String(a?.installDir || "").localeCompare(String(b?.installDir || ""));
  });
  return list[0] || null;
}

async function refreshCatalog({ logger, force, latestOnly } = {}) {
  const wantsLatest = latestOnly === true;
  const mode = wantsLatest ? "latest" : "all";
  const ttlMs = 1000 * 60 * 60 * 6;
  const now = Date.now();

  if (!force && catalog.status === "success" && catalog.fetchedAt && now - catalog.fetchedAt < ttlMs && catalog.mode === mode) {
    return catalog;
  }

  if (catalogPromise) {
    if (catalog.mode === mode) return catalogPromise;
    await catalogPromise.catch(() => {});
    return refreshCatalog({ logger, force, latestOnly });
  }

  const previous = catalog;
  catalog = {
    ...catalog,
    status: "loading",
    error: null,
    mode
  };

  catalogPromise = (async () => {
    try {
      const result = await Core.fetchAvailableVersions({
        logger,
        latestOnly: wantsLatest,
        maxPages: wantsLatest ? 1 : 5,
        limit: wantsLatest ? 1 : undefined
      });
      catalogReleasesByVersion = result.releasesByVersion || {};
      catalog = {
        status: "success",
        versions: result.versions || [],
        fetchedAt: Date.now(),
        source: result.source || null,
        error: null,
        mode
      };
      return catalog;
    } catch (e) {
      catalog = {
        ...previous, status: "error",
        error: String(e?.message || e)
      };
      throw e;
    } finally {
      catalogPromise = null;
    }
  })();

  return catalogPromise;
}

function getState({ settings, userDataDir }) {
  const cfg = normalizeSettings(settings);
  const installed = Core.listInstalled(userDataDir);
  const latestInstalled = newestInstalled(installed);
  const latestAvailable = Array.isArray(catalog.versions) ? catalog.versions[0] || null : null;

  const base = {
    supportsDefault: true,
    defaultVersion: selectRuntimeVersion({ defaultVersion: cfg.defaultVersion, fallback: managerDefaultVersion({
      listed: [...catalog.versions].sort(Core.compareVersionsDesc),
      installed: installed.filter(row => row.ready !== false).map(row => row.version).sort(Core.compareVersionsDesc) }) }).version,
    defaultSource: cfg.defaultVersion ? "saved" : "manager",
    installed,
    installing: null,
    catalog: {
      status: catalog.status,
      versions: catalog.versions,
      fetchedAt: catalog.fetchedAt,
      source: "https://frostyhowl.com/browser-woditor/",
      error: catalog.error,
      mode: catalog.mode,
      supportsLatestOnly: false,
      latestAvailableVersion: latestAvailable,
      latestInstalledVersion: latestInstalled?.version || null,
      updateAvailable:
        latestAvailable && cfg?.defaultVersion
          ? Core.compareVersions(String(latestAvailable), String(cfg.defaultVersion)) > 0
          : false
    }
  };

  return {
    ...base,
    variants: [],
    sections: [
      {
        id: SECTION_DEFAULT,
        label: "Browser Woditor versions",
        ...base,
        variants: []
      }
    ]
  };
}

async function resolveInstallVersion(version, logger) {
  if (typeof version === "string" && version.trim()) {
    return Core.normalizeVersion(version.trim());
  }

  if (!Array.isArray(catalog.versions) || catalog.versions.length === 0) {
    await refreshCatalog({ logger, force: true, latestOnly: false });
  }

  const latest = Array.isArray(catalog.versions) ? catalog.versions[0] || null : null;
  if (!latest) throw new Error("No Browser Woditor versions are available for install.");
  return latest;
}

async function installRuntime({ userDataDir, version, logger, onProgress, downloads, signal: callerSignal } = {}) {
  const targetVersion = await resolveInstallVersion(version, logger);
  const meta = buildRuntimeDownloadMeta({
    label: "Browser Woditor",
    managerId: "browser-woditor",
    sectionId: SECTION_DEFAULT,
    version: targetVersion
  });

  return runDownloadTask(
    downloads,
    meta,
    ({ signal: taskSignal, onProgress: taskProgress }) =>
      Core.installVersion({
        userDataDir,
        version: targetVersion,
        logger,
        releasesByVersion: catalogReleasesByVersion,
        onProgress: taskProgress,
        signal: callerSignal && taskSignal ? AbortSignal.any([callerSignal, taskSignal]) : callerSignal || taskSignal
      }),
    { onProgress }
  );
}

function uninstallRuntime({ userDataDir, version, installDir } = {}) {
  return Core.uninstallVersion({ userDataDir, version, installDir });
}

function updateSettingsAfterInstall(settings, installed) {
  return normalizeSettings(settings).defaultVersion ? settings : { ...settings, defaultVersion: installed.version };
}
function updateSettingsAfterUninstall() {}

module.exports = {
  id: "browser-woditor",
  label: "Browser Woditor",
  normalizeSettings,
  applySettingsUpdate: (action, payload, settings) => action === "setDefault"
    ? { ...settings, ...normalizeSettings({ defaultVersion: payload?.version }) } : settings,
  refreshCatalog,
  getState,
  installRuntime,
  uninstallRuntime,
  updateSettingsAfterInstall,
  updateSettingsAfterUninstall,
  core: Core,
  __test: {
    SECTION_DEFAULT
  }
};

Custom.configure(module.exports, {
  defaultsPath: () => ["defaultVersion"],
  providers: [{ core: Core, versions: ["normalizeVersion"], directories: ["getInstallDir"],
    comparators: { compareVersions: 1, compareVersionsDesc: -1 },
    lists: { listInstalled: SECTION_DEFAULT }, resolves: { resolveInstalled: SECTION_DEFAULT } }],
  inspect(runtimePath) {
    let root = fs.statSync(runtimePath).isDirectory() ? runtimePath : path.dirname(runtimePath);
    let contentRoot = fs.existsSync(path.join(root, "public/index.html")) ? path.join(root, "public") : root;
    if (path.basename(contentRoot) === "public") root = path.dirname(contentRoot);
    for (const name of Core.REQUIRED_FILES) {
      if (!fs.statSync(path.join(contentRoot, name)).isFile()) throw new Error(`The Browser Woditor runtime is missing ${name}.`);
    }
    if (!fs.statSync(path.join(root, "BrowserWoditor.dat")).isFile()) throw new Error("The Browser Woditor runtime is missing BrowserWoditor.dat.");
    return { installDir: root, root, contentRoot, platformKey: "web", ready: true };
  }
});
