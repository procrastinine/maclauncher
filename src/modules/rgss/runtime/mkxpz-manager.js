const Core = require("./mkxpz-runtime-manager");

let installState = null;
let installPromise = null;
let catalogPromise = null;
let catalogEntries = [];
let catalog = {
  status: "idle",
  versions: [],
  fetchedAt: null,
  source: null,
  error: null,
  mode: null
};

const DEFAULT_VERSION = Core.BUNDLED_VERSION;
const VARIANTS = [];

function buildVersionLabels(versions) {
  const labels = {};
  const list = Array.isArray(versions) ? versions : [];
  for (const version of list) {
    const label = Core.formatVersionLabel ? Core.formatVersionLabel(version) : null;
    if (!label || label === version) continue;
    labels[version] = label;
  }
  return labels;
}

function normalizeSettings(input) {
  const src = input && typeof input === "object" ? input : {};
  const defaultVersion =
    typeof src.defaultVersion === "string" && src.defaultVersion.trim()
      ? src.defaultVersion.trim()
      : DEFAULT_VERSION;
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
  const ttlMs = 1000 * 60 * 60 * 6;
  const now = Date.now();
  const wantsLatest = latestOnly !== false;
  const mode = wantsLatest ? "latest" : "all";
  if (
    !force &&
    catalog.fetchedAt &&
    now - catalog.fetchedAt < ttlMs &&
    catalog.mode === mode
  ) {
    return catalog;
  }
  if (catalogPromise) return catalogPromise;

  catalog = { ...catalog, status: "loading", error: null, mode };

  catalogPromise = (async () => {
    try {
      const ghOk = await Core.canUseGh({ logger });
      if (!ghOk) {
        const bundled = Core.resolveBundledRuntime();
        if (!bundled) throw new Error("Bundled MKXP-Z runtime not found");
        catalogEntries = [];
        catalog = {
          status: "success",
          versions: [bundled.version],
          fetchedAt: Date.now(),
          source: "Bundled",
          error: null,
          mode
        };
        return catalog;
      }
      const res = wantsLatest
        ? await Core.fetchLatestAvailableVersions({ logger })
        : await Core.fetchAvailableVersions({ logger });
      catalogEntries = (res.entries || []).map(entry => ({ ...entry }));
      catalog = {
        status: "success",
        versions: res.versions || [],
        fetchedAt: Date.now(),
        source: res.source || null,
        error: null,
        mode
      };
      return catalog;
    } catch (e) {
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
  const latestAvailable = Array.isArray(catalog.versions) ? catalog.versions[0] : null;
  const versionSet = new Set();
  for (const inst of installed) {
    if (inst?.version) versionSet.add(inst.version);
  }
  if (cfg.defaultVersion) versionSet.add(cfg.defaultVersion);
  if (Array.isArray(catalog.versions)) {
    for (const version of catalog.versions) {
      if (version) versionSet.add(version);
    }
  }
  const versionLabels = buildVersionLabels(Array.from(versionSet));
  const base = {
    ...cfg,
    installed,
    installing: installState,
    versionLabels,
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
    variants: VARIANTS,
    sections: [
      {
        id: "default",
        label: "MKXP-Z versions",
        ...base,
        variants: VARIANTS
      }
    ]
  };
}

async function installRuntime({ userDataDir, version, logger, onProgress }) {
  if (installPromise) return installPromise;
  const v = Core.normalizeVersion(version);

  installState = {
    version: v,
    downloaded: 0,
    total: null,
    status: "downloading"
  };
  onProgress?.(installState);

  installPromise = (async () => {
    let installed = null;
    let downloadError = null;
    try {
      const bundled = Core.resolveBundledRuntime();
      const wantsBundled = bundled && v === bundled.version;
      const ghOk = !wantsBundled && (await Core.canUseGh({ logger }));

      if (!wantsBundled && ghOk) {
        let entry = catalogEntries.find(item => item.version === v) || null;
        if (!entry) {
          try {
            const res = await Core.fetchAvailableVersions({ logger });
            catalogEntries = (res.entries || []).map(item => ({ ...item }));
            entry = catalogEntries.find(item => item.version === v) || null;
          } catch (e) {
            downloadError = e;
          }
        }
        if (entry) {
          try {
            installed = await Core.installFromGh({ userDataDir, entry, logger });
          } catch (e) {
            downloadError = e;
          }
        } else if (!downloadError) {
          downloadError = new Error(`MKXP-Z build not found for version ${v}`);
        }
      } else if (!wantsBundled && !ghOk) {
        downloadError = new Error("GitHub CLI unavailable or not authenticated.");
      }

      if (!installed) {
        if (bundled) {
          if (downloadError) {
            logger?.warn?.("[mkxpz] download failed, using bundled fallback", String(downloadError?.message || downloadError));
          }
          installed = Core.installBundledRuntime({ userDataDir, bundled });
        } else if (downloadError) {
          throw downloadError;
        } else {
          throw new Error("Bundled MKXP-Z runtime not found");
        }
      }

      installState = null;
      return installed;
    } catch (e) {
      installState = {
        version: v,
        downloaded: installState?.downloaded ?? 0,
        total: installState?.total ?? null,
        status: "error",
        error: String(e?.message || e)
      };
      throw e;
    } finally {
      installPromise = null;
    }
  })();

  return installPromise;
}

function uninstallRuntime({ userDataDir, version, installDir }) {
  return Core.uninstallVersion({ userDataDir, version, installDir });
}

function updateSettingsAfterInstall(settings, installed) {
  if (!installed || !installed.version) return settings;
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
  if (!latest) return settings;
  const next = settings && typeof settings === "object" ? { ...settings } : {};
  next.defaultVersion = latest.version;
  return next;
}

module.exports = {
  id: "mkxpz",
  label: "MKXP-Z",
  normalizeSettings,
  applySettingsUpdate: (action, payload, settings) => {
    if (action !== "setDefault") return settings;
    const next = settings && typeof settings === "object" ? { ...settings } : {};
    if (payload?.version) next.defaultVersion = String(payload.version).trim();
    return next;
  },
  refreshCatalog,
  getState,
  installRuntime,
  uninstallRuntime,
  updateSettingsAfterInstall,
  updateSettingsAfterUninstall,
  core: Core
};
