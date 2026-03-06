const Core = require("./ruffle-runtime");
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
  const src = input && typeof input === "object" ? input : {};
  let defaultVersion = null;
  if (typeof src.defaultVersion === "string" && src.defaultVersion.trim()) {
    try {
      defaultVersion = Core.normalizeVersion(src.defaultVersion.trim());
    } catch {
      defaultVersion = null;
    }
  }
  return { defaultVersion };
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
  const wantsLatest = latestOnly !== false;
  const mode = wantsLatest ? "latest" : "all";
  const ttlMs = 1000 * 60 * 60 * 6;
  const now = Date.now();

  if (!force && catalog.fetchedAt && now - catalog.fetchedAt < ttlMs && catalog.mode === mode) {
    return catalog;
  }

  if (catalogPromise) return catalogPromise;

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
        maxPages: wantsLatest ? 1 : 20,
        limit: wantsLatest ? 50 : undefined
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
      catalogReleasesByVersion = {};
      catalog = {
        status: "error",
        versions: [],
        fetchedAt: Date.now(),
        source: null,
        error: String(e?.message || e),
        mode
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
    defaultVersion: cfg.defaultVersion,
    installed,
    installing: null,
    catalog: {
      status: catalog.status,
      versions: catalog.versions,
      fetchedAt: catalog.fetchedAt,
      source: catalog.source,
      error: catalog.error,
      mode: catalog.mode,
      supportsLatestOnly: true,
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
        label: "Ruffle versions",
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
    await refreshCatalog({ logger, force: true, latestOnly: true });
  }

  const latest = Array.isArray(catalog.versions) ? catalog.versions[0] || null : null;
  if (!latest) throw new Error("No Ruffle versions are available for install.");
  return latest;
}

async function installRuntime({ userDataDir, version, logger, onProgress, downloads } = {}) {
  const targetVersion = await resolveInstallVersion(version, logger);
  const meta = buildRuntimeDownloadMeta({
    label: "Ruffle",
    managerId: "ruffle",
    sectionId: SECTION_DEFAULT,
    version: targetVersion
  });

  return runDownloadTask(
    downloads,
    meta,
    ({ signal, onProgress: taskProgress }) =>
      Core.installVersion({
        userDataDir,
        version: targetVersion,
        logger,
        releasesByVersion: catalogReleasesByVersion,
        onProgress: taskProgress,
        signal
      }),
    { onProgress }
  );
}

function uninstallRuntime({ userDataDir, version, installDir } = {}) {
  return Core.uninstallVersion({ userDataDir, version, installDir });
}

function updateSettingsAfterInstall(settings, installed) {
  if (!installed?.version) return settings;

  const cfg = normalizeSettings(settings);
  const next = settings && typeof settings === "object" ? { ...settings } : {};
  if (!cfg.defaultVersion || Core.compareVersions(installed.version, cfg.defaultVersion) > 0) {
    next.defaultVersion = installed.version;
  }
  return next;
}

function updateSettingsAfterUninstall(settings, _payload, { userDataDir } = {}) {
  if (!userDataDir) return settings;

  const cfg = normalizeSettings(settings);
  const installed = Core.listInstalled(userDataDir);
  const hasDefault = installed.some(entry => entry.version === cfg.defaultVersion);
  if (hasDefault) return settings;

  const latest = newestInstalled(installed);
  const next = settings && typeof settings === "object" ? { ...settings } : {};
  next.defaultVersion = latest?.version || null;
  return next;
}

module.exports = {
  id: "ruffle",
  label: "Ruffle",
  normalizeSettings,
  applySettingsUpdate: (action, payload, settings) => {
    if (action !== "setDefault") return settings;
    const next = settings && typeof settings === "object" ? { ...settings } : {};

    if (typeof payload?.version === "string" && payload.version.trim()) {
      next.defaultVersion = Core.normalizeVersion(payload.version.trim());
    } else {
      next.defaultVersion = null;
    }

    return next;
  },
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
