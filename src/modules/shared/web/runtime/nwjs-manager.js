const Core = require("./nwjs-runtime-manager");
const fs = require("node:fs");
const path = require("node:path");
const Custom = require("../../runtime/custom-runtime");
const { selectRuntimeVersion, managerDefaultVersion } = require("../../runtime/version-choices");
const AppBundle = require("../../runtime/app-bundle");
const managedInstalled = Core.listInstalled;
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
    defaultVersion: typeof input?.defaultVersion === "string" && input.defaultVersion.trim() !== "auto" ? input.defaultVersion.trim() || null : null,
    defaultVariant: input?.defaultVariant ? Core.normalizeVariant(input.defaultVariant) : DEFAULT_VARIANT,
    greenworksDefaultVersion: typeof input?.greenworksDefaultVersion === "string" && input.greenworksDefaultVersion.trim() !== "auto" ? input.greenworksDefaultVersion.trim() || null : null
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

function runtimeSelection({ runtimeData, managerSettings, userDataDir, sourceRoot, needsGreenworks, platform = process.platform, arch = process.arch } = {}) {
  const manual = selectRuntimeVersion({ manual: runtimeData?.version }).version;
  needsGreenworks ??= sourceRoot ? require("./greenworks-preparation").findGreenworksTargets(sourceRoot).length > 0 : false;
  const compatibleVersions = needsGreenworks ? require("./greenworks-contracts.json").map(item => item.nwVersion) : null;
  if (manual && compatibleVersions && !compatibleVersions.includes(manual))
    throw Object.assign(new Error(`NW.js ${manual} does not match this game's Greenworks ABI. Choose a compatible version in Runtimes.`),
      { code: "GREENWORKS_ABI_UNVERIFIED" });
  const listed = (catalog.installableVersions || catalog.versions).filter(value => catalog.availabilityByVersion?.[value]?.unavailable !== true &&
    (!compatibleVersions || compatibleVersions.includes(value))).sort((a,b) => compareSemver(b,a));
  const ready = userDataDir ? Core.resolveBestInstalled({ userDataDir, variant: DEFAULT_VARIANT, platform, arch, versions: compatibleVersions }) : null;
  const fallback = managerDefaultVersion({ listed, installed: ready ? [ready.version] : [] });
  const version = selectRuntimeVersion({ manual, recommended: needsGreenworks ? fallback : null,
    defaultVersion: managerSettings?.customDefaults?.default || managerSettings?.defaultVersion, fallback }).version;
  const install = version && userDataDir ? Core.resolveBestInstalled({ userDataDir, version, variant: DEFAULT_VARIANT, platform, arch, versions: compatibleVersions }) : null;
  return { version, variant: DEFAULT_VARIANT, install };
}

function resolveRuntimeConfig(options) {
  const { version, variant } = runtimeSelection(options);
  return { version, variant };
}

async function resolveSelection(entry, settings, userDataDir) {
  const options = { userDataDir, managerSettings: settings?.runtimes?.nwjs, runtimeData: entry?.runtimeData?.[entry?.runtimeId || "nwjs"],
    sourceRoot: entry?.contentRootDir || entry?.gamePath };
  const selected = runtimeSelection(options);
  return { ...selected, ready: Boolean(selected.install), requiresDownload:!selected.install,
    discoveryRequired:!selected.version,
    installOptions: { sectionId: "default", variant: selected.variant } };
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
  const latestInstalled = newestInstalled(installed.filter(row => row.ready !== false && row.status !== "damaged"));
  const latestAvailable = Array.isArray(catalog.versions) ? catalog.versions[0] : null;
  const base = {
    ...cfg,
    supportsDefault: true,
    defaultVersion: selectRuntimeVersion({ defaultVersion: cfg.defaultVersion, fallback: managerDefaultVersion({
      listed: (catalog.installableVersions || catalog.versions).filter(version => catalog.availabilityByVersion?.[version]?.unavailable !== true), installed: latestInstalled ? [latestInstalled.version] : [] }) }).version,
    defaultSource: cfg.defaultVersion ? "saved" : "manager",
    installed,
    installing: null,
    availabilityByVersion: catalog.availabilityByVersion || {},
    catalog: {
      status: catalog.status,
      versions: catalog.versions,
      fetchedAt: catalog.fetchedAt,
      source: catalog.source || "https://dl.nwjs.io/",
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
    defaultVersion: cfg.greenworksDefaultVersion,
    defaultSource: cfg.greenworksDefaultVersion ? "saved" : "manager",
    supportsDefault: true,
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
      source: greenworksCatalog.source || "https://github.com/greenheartgames/greenworks/releases",
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
  if (!version || version === "auto") {
    // This install follows an explicit action or the shared Play consent.
    await refreshCatalog({ force: true, logger });
    version = runtimeSelection({ userDataDir }).version;
    if (!version) throw new Error("No compatible NW.js version is available for install.");
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
  const cfg = normalizeSettings(settings);
  const key = payload?.sectionId === GREENWORKS_SECTION_ID ? "greenworksDefaultVersion" : "defaultVersion";
  return installed?.version && !cfg[key] ? { ...cfg, [key]: installed.version } : settings;
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
  // Newer NW.js runs older games; Greenworks SDKs stay tied to their NW.js ABI.
  installSetsDefault: ["default"],
  normalizeSettings,
  resolveSelection,
  resolveRuntimeConfig,
  applySettingsUpdate: (action, payload, settings) => action === "setDefault"
    ? { ...normalizeSettings(settings), [payload?.sectionId === GREENWORKS_SECTION_ID ? "greenworksDefaultVersion" : "defaultVersion"]:
      payload?.version && payload.version !== "auto" ? String(payload.version).trim() || null : null } : settings,
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

Custom.configure(module.exports, {
  defaultsPath: sectionId => sectionId === GREENWORKS_SECTION_ID ? ["greenworksDefaultVersion"] : ["defaultVersion"],
  providers: [
    { core: Core, versions: ["normalizeVersion"], directories: ["getInstallDir"],
      lists: { listInstalled: "default" }, resolves: { resolveBestInstalled: "default" } },
    { core: Greenworks, versions: ["normalizeNwVersion"], directories: ["getInstallDir"], lists: { listInstalled: GREENWORKS_SECTION_ID } }
  ],
  selection(install, { entry }) {
    const root = entry?.contentRootDir || entry?.gamePath;
    if (!install.runtimeVersion && require("./greenworks-preparation").findGreenworksTargets(root).length)
      throw new Error("The custom NW.js version could not be established for Greenworks. Select a versioned NW.js installation.");
    return {};
  },
  inspect(runtimePath, { sectionId, userDataDir }) {
    if (sectionId === GREENWORKS_SECTION_ID) return Greenworks.inspectCustomRuntime(runtimePath);
    const native = Custom.inspectExecutable(runtimePath, { candidates: ["nwjs.app/Contents/MacOS/nwjs", "nwjs"] });
    let appPath = runtimePath.toLowerCase().endsWith(".app") ? runtimePath : null;
    if (!appPath && native.executablePath.endsWith(".app/Contents/MacOS/nwjs")) appPath = path.resolve(native.executablePath, "../../..");
    const chromiumVersion = appPath ? AppBundle.readAppBundleVersion(appPath) : null;
    const known = userDataDir && managedInstalled(userDataDir).find(install => {
      try { return fs.realpathSync(install.executablePath) === fs.realpathSync(native.executablePath); } catch { return false; }
    });
    return { ...native, appPath: appPath || native.executablePath, runtimeVersion: known?.version || null, chromiumVersion,
      variant: DEFAULT_VARIANT, platformKey: native.architecture === "x64" ? "osx-x64" : "osx-arm64" };
  }
});
