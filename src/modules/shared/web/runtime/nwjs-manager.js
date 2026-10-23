const Core = require("./nwjs-runtime-manager");
const Greenworks = require("./greenworks-runtime");
const GreenworksSdk = require("./greenworks-sdk");
const { cleanupNwjsGameData } = require("./nwjs-cleanup");
const { runDownloadTask } = require("../../runtime/download-manager");
const { buildRuntimeDownloadMeta } = require("../../runtime/runtime-downloads");

let catalogPromise = null;
let catalogPromiseMode = null;
let catalog = {
  status: "idle",
  versions: [],
  fetchedAt: null,
  source: null,
  error: null
};
let greenworksCatalogPromise = null;
let greenworksCatalog = {
  status: "idle",
  versions: [],
  fetchedAt: null,
  source: null,
  error: null
};
let greenworksCatalogReleases = [];
const DEFAULT_VARIANT = "sdk";
const VARIANTS = [];
const GREENWORKS_SECTION_ID = "greenworks";

function normalizeSettings(input) {
  return {
    defaultVersion: null,
    defaultVariant: DEFAULT_VARIANT,
    greenworksDefaultVersion: null
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
  const list = Array.isArray(installed) ? installed.filter(entry => entry.ready !== false) : [];
  list.sort((a, b) => {
    const byVersion = compareSemver(String(b?.version || ""), String(a?.version || ""));
    if (byVersion !== 0) return byVersion;
    return String(a?.installDir || "").localeCompare(String(b?.installDir || ""));
  });
  return list[0] || null;
}

function runtimeSelection({ runtimeData, userDataDir, sourceRoot, needsGreenworks, platform = process.platform, arch = process.arch } = {}) {
  const requested = String(runtimeData?.version || "").trim();
  const explicit = requested && requested !== "auto" ? Core.normalizeVersion(requested) : null;
  needsGreenworks ??= sourceRoot ? require("./greenworks-preparation").findGreenworksTargets(sourceRoot).length > 0 : false;
  const compatibleVersions = needsGreenworks ? require("./greenworks-contracts.json").map(item => item.nwVersion) : null;
  const install = userDataDir ? Core.resolveBestInstalled({ userDataDir, version: explicit, variant: DEFAULT_VARIANT,
    platform, arch, versions: compatibleVersions }) : null;
  const available = compatibleVersions || catalog.installableVersions || catalog.versions;
  const version = explicit || install?.version || [...available].filter(value => catalog.availabilityByVersion?.[value]?.unavailable !== true)
    .sort((a, b) => compareSemver(b, a))[0] || null;
  return { version, variant: DEFAULT_VARIANT, install };
}

function resolveRuntimeConfig(options) {
  const { version, variant } = runtimeSelection(options);
  return { version, variant };
}

async function resolveSelection(entry, settings, userDataDir) {
  const options = { userDataDir, runtimeData: entry?.runtimeData?.[entry?.runtimeId || "nwjs"],
    sourceRoot: entry?.contentRootDir || entry?.gamePath };
  let selected = runtimeSelection(options);
  if (!selected.version) {
    await refreshCatalog({ force: true });
    selected = runtimeSelection(options);
  }
  return { ...selected, ready: Boolean(selected.install), installOptions: { sectionId: "default", variant: selected.variant } };
}

async function refreshCatalog({ logger, force, sectionId, latestOnly } = {}) {
  if (sectionId === GREENWORKS_SECTION_ID) {
    return refreshGreenworksCatalog({ logger, force });
  }
  return refreshNwjsCatalog({ logger, force, latestOnly });
}

async function refreshNwjsCatalog({ logger, force, latestOnly } = {}) {
  const ttlMs = 1000 * 60 * 60 * 6;
  const now = Date.now();
  const mode = latestOnly === true ? "latest" : "all";
  if (!force && catalog.status === "success" && catalog.mode === mode &&
      catalog.fetchedAt && now - catalog.fetchedAt < ttlMs) return catalog;
  if (catalogPromise) {
    if (catalogPromiseMode === mode) return catalogPromise;
    await catalogPromise.catch(() => {});
    return refreshNwjsCatalog({ logger, force, latestOnly });
  }

  const previous = catalog;
  catalog = { ...catalog, status: "loading", error: null };

  catalogPromiseMode = mode;
  catalogPromise = (async () => {
    try {
      const res = await Core.fetchAvailableVersions({ logger, latestOnly: latestOnly === true });
      catalog = {
        status: "success",
        versions: res.versions || [],
        fetchedAt: Date.now(),
        source: res.source || null,
        mode,
        availabilityByVersion: res.availabilityByVersion || {},
        installableVersions: res.installableVersions || res.versions || [],
        error: null
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
      catalogPromiseMode = null;
    }
  })();

  return catalogPromise;
}

async function refreshGreenworksCatalog({ logger, force } = {}) {
  const ttlMs = 1000 * 60 * 60 * 6;
  const now = Date.now();
  if (!force && greenworksCatalog.status === "success" && greenworksCatalog.fetchedAt && now - greenworksCatalog.fetchedAt < ttlMs) {
    return greenworksCatalog;
  }
  if (greenworksCatalogPromise) return greenworksCatalogPromise;

  const previous = greenworksCatalog;
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
      greenworksCatalog = {
        ...previous, status: "error",
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
    supportsDefault: false,
    installed,
    installing: null,
    availabilityByVersion: catalog.availabilityByVersion || {},
    catalog: {
      status: catalog.status,
      versions: catalog.versions,
      fetchedAt: catalog.fetchedAt,
      source: catalog.source,
      error: catalog.error,
      mode: catalog.mode || null,
      supportsLatestOnly: false,
      installableVersions: catalog.installableVersions || catalog.versions,
      latestAvailableVersion: latestAvailable,
      latestInstalledVersion: latestInstalled?.version || null,
      updateAvailable:
        latestAvailable && latestInstalled?.version
          ? compareSemver(String(latestAvailable), String(latestInstalled.version)) > 0
          : false
    }
  };
  const greenworksInstalled = Greenworks.listInstalled(userDataDir);
  const greenworksLatestInstalled = newestInstalled(greenworksInstalled);
  const greenworksLatestAvailable = Array.isArray(greenworksCatalog.versions)
    ? greenworksCatalog.versions[0]
    : null;
  const nativeSdk = GreenworksSdk.resolveManagedTicket(userDataDir);
  const greenworksState = {
    defaultVersion: null,
    supportsDefault: false,
    installed: greenworksInstalled,
    installing: null,
    catalog: {
      importable: true,
      importLabel: nativeSdk ? "Reimport Steamworks SDK 1.63…" : "Import Steamworks SDK 1.63…",
      importInputKinds: ["directory"],
      importDescription: "Choose an authorized Steamworks SDK 1.63 folder or its native encrypted-ticket library directory. The optional native Steam API is also validated when present. Inputs are registered once; SDK headers and command-line tools are unnecessary.",
      nativeTicket: { ...GreenworksSdk.PIN, available: Boolean(nativeSdk), nativeApiAvailable: Boolean(nativeSdk?.apiLibraryPath) },
      status: greenworksCatalog.status,
      versions: greenworksCatalog.versions,
      fetchedAt: greenworksCatalog.fetchedAt,
      source: greenworksCatalog.source,
      error: greenworksCatalog.error,
      supportsLatestOnly: false,
      latestAvailableVersion: greenworksLatestAvailable,
      latestInstalledVersion: greenworksLatestInstalled?.version || null,
      updateAvailable:
        greenworksLatestAvailable && greenworksLatestInstalled?.version
          ? compareSemver(
              String(greenworksLatestAvailable),
              String(greenworksLatestInstalled.version)
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
  sectionId,
  downloads,
  signal: callerSignal
}) {
  if (sectionId === GREENWORKS_SECTION_ID) {
    return installGreenworks({ userDataDir, version, logger, onProgress, downloads, signal: callerSignal });
  }
  const v = Core.normalizeVersion(version);
  const kind = Core.normalizeVariant(variant);
  const platform = process.platform;
  const arch = process.arch;
  const meta = buildRuntimeDownloadMeta({
    label: "NW.js",
    managerId: "nwjs",
    sectionId: "default",
    version: v,
    variant: kind
  });
  return runDownloadTask(
    downloads,
    meta,
    ({ signal: taskSignal, onProgress: taskProgress }) =>
      Core.installVersion({
        userDataDir,
        version: v,
        variant: kind,
        platform,
        arch,
        logger,
        onProgress: taskProgress,
        signal: callerSignal && taskSignal ? AbortSignal.any([callerSignal, taskSignal]) : callerSignal || taskSignal
      }),
    { onProgress }
  );
}

async function installGreenworks({ userDataDir, version, logger, onProgress, downloads, signal: callerSignal }) {
  const v = Greenworks.normalizeNwVersion(version);
  const meta = buildRuntimeDownloadMeta({
    label: "Greenworks",
    managerId: "nwjs",
    sectionId: GREENWORKS_SECTION_ID,
    version: v
  });
  return runDownloadTask(
    downloads,
    meta,
    ({ signal: taskSignal, onProgress: taskProgress }) =>
      Greenworks.installVersion({
        userDataDir,
        nwVersion: v,
        logger,
        releases: greenworksCatalogReleases,
        onProgress: taskProgress,
        signal: callerSignal && taskSignal ? AbortSignal.any([callerSignal, taskSignal]) : callerSignal || taskSignal
      }),
    { onProgress }
  );
}

function uninstallRuntime({ userDataDir, version, platformKey, variant, installDir, sectionId }) {
  if (sectionId === GREENWORKS_SECTION_ID) {
    return Greenworks.uninstallVersion({ userDataDir, nwVersion: version, installDir });
  }
  return Core.uninstallVersion({ userDataDir, version, platformKey, variant, installDir });
}

function updateSettingsAfterInstall(settings, installed, payload) {
  // Installing a dependency does not express a new global host preference.
  return settings;
}

function updateSettingsAfterUninstall(settings, payload, { userDataDir } = {}) {
  return settings;
}

function cleanupGameData({ entry, gameId, userDataDir } = {}) {
  const resolvedGameId =
    typeof gameId === "string" && gameId.trim()
      ? gameId.trim()
      : typeof entry?.gameId === "string"
        ? entry.gameId.trim()
        : "";
  if (!userDataDir || !resolvedGameId) return false;
  return cleanupNwjsGameData({
    userDataDir,
    gameId: resolvedGameId
  });
}

module.exports = {
  id: "nwjs",
  label: "NW.js",
  normalizeSettings,
  resolveSelection,
  resolveRuntimeConfig,
  applySettingsUpdate: (_action, _payload, settings) => settings,
  refreshCatalog,
  getState,
  installRuntime,
  importRuntime: async context => {
    if (context.sectionId !== GREENWORKS_SECTION_ID) throw new Error("SDK import is available in the Greenworks section.");
    return { ...(await GreenworksSdk.importSdk(context)), role: "encrypted-ticket" };
  },
  uninstallRuntime,
  cleanupGameData,
  updateSettingsAfterInstall,
  updateSettingsAfterUninstall,
  core: Core
};
