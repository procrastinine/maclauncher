const Core = require("./nwjs-runtime-manager");
const Greenworks = require("./greenworks-runtime");
const { cleanupNwjsGameData } = require("./nwjs-cleanup");

let installState = null;
let installPromise = null;
let catalogPromise = null;
let catalog = {
  status: "idle",
  versions: [],
  fetchedAt: null,
  source: null,
  error: null
};
let greenworksInstallState = null;
let greenworksInstallPromise = null;
let greenworksCatalogPromise = null;
let greenworksCatalog = {
  status: "idle",
  versions: [],
  fetchedAt: null,
  source: null,
  error: null
};
let greenworksCatalogReleases = [];
const DEFAULT_VERSION = "0.107.0";
const DEFAULT_VARIANT = "sdk";
const VARIANTS = [];
const GREENWORKS_SECTION_ID = "greenworks";

function normalizeSettings(input) {
  const src = input && typeof input === "object" ? input : {};
  const defaultVersion =
    typeof src.defaultVersion === "string" && src.defaultVersion.trim()
      ? src.defaultVersion.trim().replace(/^v/i, "")
      : DEFAULT_VERSION;
  const greenworksDefaultVersion =
    typeof src.greenworksDefaultVersion === "string" && src.greenworksDefaultVersion.trim()
      ? src.greenworksDefaultVersion.trim().replace(/^v/i, "")
      : null;
  return {
    defaultVersion,
    defaultVariant: DEFAULT_VARIANT,
    greenworksDefaultVersion
  };
}

function parseSemver(v) {
  const m = String(v || "").trim().replace(/^v/i, "").match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return String(a || "").localeCompare(String(b || ""));
  for (let i = 0; i < 3; i++) {
    const d = pa[i] - pb[i];
    if (d !== 0) return d;
  }
  return 0;
}

function newestInstalled(installed) {
  const list = Array.isArray(installed) ? installed.slice() : [];
  list.sort((a, b) => {
    const byVersion = compareSemver(String(b?.version || ""), String(a?.version || ""));
    if (byVersion !== 0) return byVersion;
    return String(a?.installDir || "").localeCompare(String(b?.installDir || ""));
  });
  return list[0] || null;
}

async function refreshCatalog({ logger, force, sectionId } = {}) {
  if (sectionId === GREENWORKS_SECTION_ID) {
    return refreshGreenworksCatalog({ logger, force });
  }
  return refreshNwjsCatalog({ logger, force });
}

async function refreshNwjsCatalog({ logger, force } = {}) {
  const ttlMs = 1000 * 60 * 60 * 6;
  const now = Date.now();
  if (!force && catalog.fetchedAt && now - catalog.fetchedAt < ttlMs) return catalog;
  if (catalogPromise) return catalogPromise;

  catalog = { ...catalog, status: "loading", error: null };

  catalogPromise = (async () => {
    try {
      const res = await Core.fetchAvailableVersions({ logger });
      catalog = {
        status: "success",
        versions: res.versions || [],
        fetchedAt: Date.now(),
        source: res.source || null,
        error: null
      };
      return catalog;
    } catch (e) {
      catalog = {
        status: "error",
        versions: [],
        fetchedAt: Date.now(),
        source: null,
        error: String(e?.message || e)
      };
      throw e;
    } finally {
      catalogPromise = null;
    }
  })();

  return catalogPromise;
}

async function refreshGreenworksCatalog({ logger, force } = {}) {
  const ttlMs = 1000 * 60 * 60 * 6;
  const now = Date.now();
  if (!force && greenworksCatalog.fetchedAt && now - greenworksCatalog.fetchedAt < ttlMs) {
    return greenworksCatalog;
  }
  if (greenworksCatalogPromise) return greenworksCatalogPromise;

  greenworksCatalog = { ...greenworksCatalog, status: "loading", error: null };

  greenworksCatalogPromise = (async () => {
    try {
      const res = await Greenworks.fetchAvailableVersions({ logger });
      greenworksCatalogReleases = res.releases || [];
      greenworksCatalog = {
        status: "success",
        versions: res.versions || [],
        fetchedAt: Date.now(),
        source: res.source || null,
        error: null
      };
      return greenworksCatalog;
    } catch (e) {
      greenworksCatalogReleases = [];
      greenworksCatalog = {
        status: "error",
        versions: [],
        fetchedAt: Date.now(),
        source: null,
        error: String(e?.message || e)
      };
      throw e;
    } finally {
      greenworksCatalogPromise = null;
    }
  })();

  return greenworksCatalogPromise;
}

function getState({ settings, userDataDir }) {
  const cfg = normalizeSettings(settings);
  const installed = Core.listInstalled(userDataDir);
  const latestInstalled = newestInstalled(installed);
  const latestAvailable = Array.isArray(catalog.versions) ? catalog.versions[0] : null;
  const base = {
    ...cfg,
    installed,
    installing: installState,
    catalog: {
      status: catalog.status,
      versions: catalog.versions,
      fetchedAt: catalog.fetchedAt,
      source: catalog.source,
      error: catalog.error,
      latestAvailableVersion: latestAvailable,
      latestInstalledVersion: latestInstalled?.version || null,
      updateAvailable:
        latestAvailable && cfg?.defaultVersion
          ? compareSemver(String(latestAvailable), String(cfg.defaultVersion)) > 0
          : false
    }
  };
  const greenworksInstalled = Greenworks.listInstalled(userDataDir);
  const greenworksLatestInstalled = newestInstalled(greenworksInstalled);
  const greenworksLatestAvailable = Array.isArray(greenworksCatalog.versions)
    ? greenworksCatalog.versions[0]
    : null;
  const greenworksState = {
    defaultVersion: cfg.greenworksDefaultVersion || null,
    installed: greenworksInstalled,
    installing: greenworksInstallState,
    catalog: {
      status: greenworksCatalog.status,
      versions: greenworksCatalog.versions,
      fetchedAt: greenworksCatalog.fetchedAt,
      source: greenworksCatalog.source,
      error: greenworksCatalog.error,
      latestAvailableVersion: greenworksLatestAvailable,
      latestInstalledVersion: greenworksLatestInstalled?.version || null,
      updateAvailable:
        greenworksLatestAvailable && cfg?.greenworksDefaultVersion
          ? compareSemver(
              String(greenworksLatestAvailable),
              String(cfg.greenworksDefaultVersion)
            ) > 0
          : false
    }
  };
  return {
    ...base,
    variants: VARIANTS,
    sections: [
      {
        id: "default",
        label: "NW.js versions",
        ...base,
        variants: VARIANTS
      },
      {
        id: GREENWORKS_SECTION_ID,
        label: "Greenworks (Steamworks)",
        ...greenworksState,
        variants: []
      }
    ]
  };
}

async function installRuntime({
  userDataDir,
  version,
  variant,
  logger,
  onProgress,
  sectionId
}) {
  if (sectionId === GREENWORKS_SECTION_ID) {
    return installGreenworks({ userDataDir, version, logger, onProgress });
  }
  if (installPromise) return installPromise;
  const v = Core.normalizeVersion(version);
  const kind = Core.normalizeVariant(variant);
  const platform = process.platform;
  const arch = process.arch;

  installState = {
    version: v,
    variant: kind,
    downloaded: 0,
    total: null,
    status: "downloading"
  };

  installPromise = (async () => {
    let installed = null;
    try {
      installed = await Core.installVersion({
        userDataDir,
        version: v,
        variant: kind,
        platform,
        arch,
        logger,
        onProgress: p => {
          installState = { ...installState, ...p, status: "downloading" };
          onProgress?.(installState);
        }
      });
      installState = null;
      return installed;
    } catch (e) {
      installState = {
        version: v,
        variant: kind,
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

async function installGreenworks({ userDataDir, version, logger, onProgress }) {
  if (greenworksInstallPromise) return greenworksInstallPromise;
  const v = Greenworks.normalizeNwVersion(version);

  greenworksInstallState = {
    version: v,
    downloaded: 0,
    total: null,
    status: "downloading"
  };

  greenworksInstallPromise = (async () => {
    let installed = null;
    try {
      installed = await Greenworks.installVersion({
        userDataDir,
        nwVersion: v,
        logger,
        releases: greenworksCatalogReleases,
        onProgress: p => {
          greenworksInstallState = { ...greenworksInstallState, ...p, status: "downloading" };
          onProgress?.(greenworksInstallState);
        }
      });
      greenworksInstallState = null;
      return installed;
    } catch (e) {
      greenworksInstallState = {
        version: v,
        downloaded: greenworksInstallState?.downloaded ?? 0,
        total: greenworksInstallState?.total ?? null,
        status: "error",
        error: String(e?.message || e)
      };
      throw e;
    } finally {
      greenworksInstallPromise = null;
    }
  })();

  return greenworksInstallPromise;
}

function uninstallRuntime({ userDataDir, version, platformKey, variant, installDir, sectionId }) {
  if (sectionId === GREENWORKS_SECTION_ID) {
    return Greenworks.uninstallVersion({ userDataDir, nwVersion: version, installDir });
  }
  return Core.uninstallVersion({ userDataDir, version, platformKey, variant, installDir });
}

function updateSettingsAfterInstall(settings, installed, payload) {
  if (!installed || !installed.version) return settings;
  if (payload?.sectionId === GREENWORKS_SECTION_ID) {
    const cfg = normalizeSettings(settings);
    const next = settings && typeof settings === "object" ? { ...settings } : {};
    const current = cfg.greenworksDefaultVersion || null;
    if (!current || compareSemver(installed.version, current) > 0) {
      next.greenworksDefaultVersion = installed.version;
    }
    return next;
  }
  const cfg = normalizeSettings(settings);
  const next = settings && typeof settings === "object" ? { ...settings } : {};
  if (compareSemver(installed.version, cfg.defaultVersion) > 0) {
    next.defaultVersion = installed.version;
    next.defaultVariant = DEFAULT_VARIANT;
  }
  return next;
}

function updateSettingsAfterUninstall(settings, payload, { userDataDir } = {}) {
  if (!userDataDir) return settings;
  if (payload?.sectionId === GREENWORKS_SECTION_ID) {
    const cfg = normalizeSettings(settings);
    const installed = Greenworks.listInstalled(userDataDir);
    const hasDefault = installed.some(entry => entry.version === cfg.greenworksDefaultVersion);
    if (hasDefault) return settings;
    const latest = newestInstalled(installed);
    const next = settings && typeof settings === "object" ? { ...settings } : {};
    next.greenworksDefaultVersion = latest?.version || null;
    return next;
  }
  const cfg = normalizeSettings(settings);
  const installed = Core.listInstalled(userDataDir);
  const hasDefault = installed.some(
    entry => entry.version === cfg.defaultVersion && entry.variant === cfg.defaultVariant
  );
  if (hasDefault) return settings;
  const latest = newestInstalled(installed.filter(entry => entry.variant === cfg.defaultVariant));
  if (!latest) return settings;
  const next = settings && typeof settings === "object" ? { ...settings } : {};
  next.defaultVersion = latest.version;
  next.defaultVariant = DEFAULT_VARIANT;
  return next;
}

function cleanupGameData({ entry, moduleId, gamePath, userDataDir } = {}) {
  const resolvedGamePath =
    typeof gamePath === "string" && gamePath.trim()
      ? gamePath.trim()
      : typeof entry?.gamePath === "string"
        ? entry.gamePath.trim()
        : "";
  const resolvedModuleId =
    typeof moduleId === "string" && moduleId.trim()
      ? moduleId.trim()
      : typeof entry?.moduleId === "string"
        ? entry.moduleId.trim()
        : typeof entry?.engine === "string"
          ? entry.engine.trim()
          : "";
  if (!userDataDir || !resolvedGamePath || !resolvedModuleId) return false;
  return cleanupNwjsGameData({
    userDataDir,
    moduleId: resolvedModuleId,
    gamePath: resolvedGamePath
  });
}

module.exports = {
  id: "nwjs",
  label: "NW.js",
  normalizeSettings,
  applySettingsUpdate: (action, payload, settings) => {
    if (action !== "setDefault") return settings;
    const next = settings && typeof settings === "object" ? { ...settings } : {};
    if (payload?.sectionId === GREENWORKS_SECTION_ID) {
      if (payload?.version) {
        next.greenworksDefaultVersion = String(payload.version).trim().replace(/^v/i, "");
      } else {
        next.greenworksDefaultVersion = null;
      }
      return next;
    }
    if (payload?.version) {
      next.defaultVersion = String(payload.version).trim().replace(/^v/i, "");
    }
    next.defaultVariant = DEFAULT_VARIANT;
    return next;
  },
  refreshCatalog,
  getState,
  installRuntime,
  uninstallRuntime,
  cleanupGameData,
  updateSettingsAfterInstall,
  updateSettingsAfterUninstall,
  core: Core
};
