const { selectRuntimeVersion, managerDefaultVersion } = require("../../shared/runtime/version-choices");
const { newest } = require("../../shared/runtime/version-order");
const Core = require("./love-runtime");
const path = require("node:path");
const Custom = require("../../shared/runtime/custom-runtime");
const AppBundle = require("../../shared/runtime/app-bundle");
const LuaSteam = require("./luasteam-runtime");
const { runDownloadTask } = require("../../shared/runtime/download-manager");
const { buildRuntimeDownloadMeta } = require("../../shared/runtime/runtime-downloads");

const SECTION_STABLE = "stable";
const SECTION_NIGHTLY = "nightly";
const NIGHTLY_NOTICE = {
  title: "Nightly downloads",
  lines: [
    { text: "Nightly downloads require GitHub CLI authentication." }
  ]
};

let stableCatalogPromise = null;
let stableCatalogEntriesByVersion = {};
let stableCatalog = {
  status: "idle",
  versions: [],
  fetchedAt: null,
  source: null,
  error: null,
  mode: null
};

let nightlyCatalogPromise = null;
let nightlyCatalogEntriesByVersion = {};
let nightlyCatalogLabels = {};
let nightlyCatalog = {
  status: "idle",
  versions: [],
  fetchedAt: null,
  source: null,
  error: null,
  mode: null
};

function normalizeSettings(input) {
  const source = input && typeof input === "object" ? input : {};
  return {
    stable: { defaultVersion: typeof source.stable?.defaultVersion === "string" && source.stable?.defaultVersion.trim() !== "auto" ? source.stable?.defaultVersion.trim() || null : null },
    nightly: { defaultVersion: typeof source.nightly?.defaultVersion === "string" && source.nightly?.defaultVersion.trim() !== "auto" ? source.nightly?.defaultVersion.trim() || null : null },
    luasteam: {
      defaultVersion: typeof source.luasteam?.defaultVersion === "string" &&
        LuaSteam.Catalog.some(pin => pin.version === source.luasteam.defaultVersion.trim())
        ? source.luasteam.defaultVersion.trim() : null
    }
  };
}

function buildNightlyLabels(installed, catalogEntriesByVersion) {
  const labels = {};
  const append = entry => {
    const key = entry?.buildKey || entry?.version;
    if (!key || labels[key]) return;
    const label = Core.buildNightlyVersionLabel(entry);
    if (label) labels[key] = label;
  };
  for (const entry of installed || []) append(entry);
  for (const entry of Object.values(catalogEntriesByVersion || {})) append(entry);
  return labels;
}

async function refreshCatalog({ logger, force, latestOnly, sectionId } = {}) {
  if (sectionId === LuaSteam.SECTION_ID) return LuaSteam.getSection().catalog;
  return sectionId === SECTION_NIGHTLY
    ? refreshNightlyCatalog({ logger, force, latestOnly })
    : refreshStableCatalog({ logger, force });
}

async function refreshStableCatalog({ logger, force } = {}) {
  const ttlMs = 1000 * 60 * 60 * 6;
  const mode = "all";
  const now = Date.now();
  if (!force && stableCatalog.status === "success" && stableCatalog.fetchedAt && now - stableCatalog.fetchedAt < ttlMs && stableCatalog.mode === mode) {
    return stableCatalog;
  }
  if (stableCatalogPromise) return stableCatalogPromise;

  const previous = stableCatalog;
  stableCatalog = { ...stableCatalog, status: "loading", error: null, mode };
  stableCatalogPromise = (async () => {
    try {
      const result = await Core.fetchAvailableVersions({ logger });
      stableCatalogEntriesByVersion = result.entriesByVersion || {};
      stableCatalog = {
        status: "success",
        versions: result.versions || [],
        fetchedAt: Date.now(),
        source: result.source || null,
        error: null,
        mode
      };
      return stableCatalog;
    } catch (error) {
      stableCatalog = {
        ...previous, status: "error",
        error: String(error?.message || error)
      };
      throw error;
    } finally {
      stableCatalogPromise = null;
    }
  })();

  return stableCatalogPromise;
}

async function refreshNightlyCatalog({ logger, force, latestOnly } = {}) {
  const ttlMs = 1000 * 60 * 60 * 6;
  const wantsLatest = latestOnly !== false;
  const mode = wantsLatest ? "latest" : "all";
  const now = Date.now();
  if (!force && nightlyCatalog.status === "success" && nightlyCatalog.fetchedAt && now - nightlyCatalog.fetchedAt < ttlMs && nightlyCatalog.mode === mode) {
    return nightlyCatalog;
  }
  if (nightlyCatalogPromise) {
    if (nightlyCatalog.mode === mode) return nightlyCatalogPromise;
    await nightlyCatalogPromise.catch(() => {});
    return refreshNightlyCatalog({ logger, force, latestOnly });
  }

  const previous = nightlyCatalog;
  nightlyCatalog = { ...nightlyCatalog, status: "loading", error: null, mode };
  nightlyCatalogPromise = (async () => {
    try {
      const ghOk = await Core.canUseGh({ logger, required: true });
      if (!ghOk) {
        throw new Error("GitHub CLI (gh) is required for LÖVE nightlies.");
      }
      const result = await Core.listNightlyBuilds({ latestOnly: wantsLatest });
      nightlyCatalogEntriesByVersion = result.entriesByVersion || {};
      nightlyCatalogLabels = buildNightlyLabels([], nightlyCatalogEntriesByVersion);
      nightlyCatalog = {
        status: "success",
        versions: result.versions || [],
        fetchedAt: Date.now(),
        source: result.source || null,
        error: null,
        mode
      };
      return nightlyCatalog;
    } catch (error) {
      nightlyCatalog = {
        ...previous, status: "error",
        error: String(error?.message || error)
      };
      throw error;
    } finally {
      nightlyCatalogPromise = null;
    }
  })();

  return nightlyCatalogPromise;
}

function getState({ settings, userDataDir, resourcesRoot }) {
  const cfg = normalizeSettings(settings);
  const stableInstalled = Core.listInstalledStable(userDataDir);
  const nightlyInstalled = Core.listInstalledNightly(userDataDir);
  const latestInstalledStable = newest(stableInstalled.filter(row => row.ready !== false));
  const latestInstalledNightly = newest(nightlyInstalled.filter(row => row.ready !== false), { versionOf: row => row.buildKey || row.version });
  const nightlyLabels = buildNightlyLabels(nightlyInstalled, nightlyCatalogEntriesByVersion);

  const state = {
    variants: [],
    sections: [
      {
        id: SECTION_STABLE,
        label: "LÖVE 11",
        defaultVersion: selectRuntimeVersion({ defaultVersion: cfg.stable.defaultVersion, fallback: managerDefaultVersion({ listed: stableCatalog.versions, installed: latestInstalledStable ? [latestInstalledStable.version] : [] }) }).version,
        defaultSource: cfg.stable.defaultVersion ? "saved" : "manager",
        supportsDefault: true,
        installed: stableInstalled,
        installing: null,
        versionLabels: {},
        variants: [],
        catalog: {
          status: stableCatalog.status,
          versions: stableCatalog.versions,
          fetchedAt: stableCatalog.fetchedAt,
          source: stableCatalog.source || "https://github.com/love2d/love/releases",
          error: stableCatalog.error,
          mode: stableCatalog.mode,
          supportsLatestOnly: false,
          latestAvailableVersion: stableCatalog.versions[0] || null,
          latestInstalledVersion: latestInstalledStable?.version || null,
          updateAvailable:
            stableCatalog.versions[0] && latestInstalledStable?.version
              ? Core.compareVersions(stableCatalog.versions[0], latestInstalledStable.version) > 0
              : false
        }
      },
      {
        id: SECTION_NIGHTLY,
        label: "LÖVE 12 nightly",
        defaultVersion: selectRuntimeVersion({ defaultVersion: cfg.nightly.defaultVersion, fallback: managerDefaultVersion({ listed: nightlyCatalog.versions, installed: latestInstalledNightly ? [latestInstalledNightly.buildKey || latestInstalledNightly.version] : [] }) }).version,
        defaultSource: cfg.nightly.defaultVersion ? "saved" : "manager",
        supportsDefault: true,
        installed: nightlyInstalled,
        installing: null,
        versionLabels: nightlyLabels,
        variants: [],
        notice: NIGHTLY_NOTICE,
        catalog: {
          status: nightlyCatalog.status,
          versions: nightlyCatalog.versions,
          fetchedAt: nightlyCatalog.fetchedAt,
          source: "https://github.com/love2d/love/actions/workflows/main.yml",
          error: nightlyCatalog.error,
          mode: nightlyCatalog.mode,
          supportsLatestOnly: true,
          latestAvailableVersion: nightlyCatalog.versions[0] || null,
          latestInstalledVersion: latestInstalledNightly?.buildKey || latestInstalledNightly?.version || null,
          updateAvailable:
            nightlyCatalog.versions[0] && latestInstalledNightly
              ? Core.compareNightlyBuildKeysDesc(latestInstalledNightly.buildKey || latestInstalledNightly.version, nightlyCatalog.versions[0]) > 0
              : false
        }
      },
      { ...LuaSteam.getSection({ settings: cfg.luasteam, resourcesRoot }), supportsDefault: true, defaultSource: cfg.luasteam.defaultVersion ? "saved" : "manager" }
    ]
  };
  const family = version => String(version).startsWith("0.") ? String(version).split(".").slice(0, 2).join(".") : String(version).split(".")[0];
  const stable = state.sections[0], families = [...new Set([...stable.catalog.versions, ...stable.installed.map(row => row.version)].map(family))];
  const section = (selected, id) => {
    const versions = stable.catalog.versions.filter(version => family(version) === selected), installed = stable.installed.filter(row => family(row.version) === selected);
    const saved = cfg.stable.defaultVersion && family(cfg.stable.defaultVersion) === selected ? cfg.stable.defaultVersion : null;
    return { ...stable, defaultVersion: selectRuntimeVersion({ defaultVersion:saved, fallback:managerDefaultVersion({listed:versions,installed:installed.filter(row=>row.ready!==false).map(row=>row.version)}) }).version,
      defaultSource: saved ? "saved" : "manager", id, selectionSectionId: SECTION_STABLE, label: `LÖVE ${selected}`, installed, catalog: { ...stable.catalog, versions,
      latestAvailableVersion: versions[0] || null, latestInstalledVersion: installed.find(row => row.ready !== false)?.version || null } };
  };
  state.sections = [section("11", SECTION_STABLE), ...families.filter(value => value !== "11").map(value => section(value, `stable-${value.replace(".", "-")}`)), ...state.sections.slice(1)];
  return state;
}

async function installRuntime({
  userDataDir,
  version,
  logger,
  onProgress,
  sectionId,
  downloads,
  signal: callerSignal,
  resourcesRoot
} = {}) {
  if (sectionId === LuaSteam.SECTION_ID) {
    const included = LuaSteam.resolveBundle({ version, resourcesRoot });
    if (!included.ready) throw new Error(included.reason);
    return { ...included, sectionId: LuaSteam.SECTION_ID, alreadyInstalled: true };
  }
  const section = sectionId === SECTION_NIGHTLY ? SECTION_NIGHTLY : SECTION_STABLE;
  if (section === SECTION_NIGHTLY) {
    let buildKey = version || null;
    if (!buildKey) {
      if (!nightlyCatalog.versions.length) {
        await refreshNightlyCatalog({ logger, force: true, latestOnly: true });
      }
      buildKey = nightlyCatalog.versions[0] || null;
    }
    if (!nightlyCatalogEntriesByVersion[buildKey]) await refreshNightlyCatalog({ logger, force: true, latestOnly: false });
    if (!nightlyCatalogEntriesByVersion[buildKey]) throw new Error(`LÖVE nightly build ${buildKey} is not available for download.`);
    if (!buildKey) throw new Error("No LÖVE nightly builds are available.");
    const meta = buildRuntimeDownloadMeta({
      label: "LÖVE",
      managerId: "love",
      sectionId: SECTION_NIGHTLY,
      version: buildKey
    });
    return runDownloadTask(
      downloads,
      meta,
      ({ signal: taskSignal }) =>
        Core.installNightlyVersion({
          userDataDir,
          entry: nightlyCatalogEntriesByVersion[buildKey] || { buildKey, version: buildKey },
          logger,
          signal: callerSignal && taskSignal ? AbortSignal.any([callerSignal, taskSignal]) : callerSignal || taskSignal
        }),
      { onProgress }
    );
  }

  let stableVersion = version ? Core.normalizeVersion(version) : null;
  if (!stableVersion) {
    if (!stableCatalog.versions.length) {
      await refreshStableCatalog({ logger, force: true });
    }
    stableVersion = stableCatalog.versions[0] || null;
  }
  if (!stableVersion) throw new Error("No LÖVE releases are available.");
  const meta = buildRuntimeDownloadMeta({
    label: "LÖVE",
    managerId: "love",
    sectionId: SECTION_STABLE,
    version: stableVersion
  });
  return runDownloadTask(
    downloads,
    meta,
    ({ signal: taskSignal, onProgress: taskProgress }) =>
      Core.installStableVersion({
        userDataDir,
        version: stableVersion,
        logger,
        onProgress: taskProgress,
        signal: callerSignal && taskSignal ? AbortSignal.any([callerSignal, taskSignal]) : callerSignal || taskSignal,
        entriesByVersion: stableCatalogEntriesByVersion
      }),
    { onProgress }
  );
}

function uninstallRuntime({ userDataDir, version, installDir, sectionId } = {}) {
  if (sectionId === LuaSteam.SECTION_ID) throw new Error("This LuaSteam bridge is included with MacLauncher.");
  return Core.uninstallVersion({
    userDataDir,
    channel: sectionId === SECTION_NIGHTLY ? SECTION_NIGHTLY : SECTION_STABLE,
    version,
    installDir
  });
}

function updateSettingsAfterInstall(settings, installed, payload) {
  const cfg = normalizeSettings(settings);
  const next = {
    stable: { ...cfg.stable },
    nightly: { ...cfg.nightly },
    luasteam: { ...cfg.luasteam }
  };
  if (payload?.sectionId === LuaSteam.SECTION_ID || installed?.sectionId === LuaSteam.SECTION_ID) {
    if (installed?.version) next.luasteam.defaultVersion = LuaSteam.selectedPin(installed.version).version;
    return next;
  }
  const section = payload?.sectionId || installed?.sectionId || SECTION_STABLE;
  if (installed?.version && next[section] && !next[section].defaultVersion) next[section].defaultVersion = installed.buildKey || installed.version;
  return next;
}

function updateSettingsAfterUninstall(settings) { return settings; }

function applySettingsUpdate(action, payload, settings) {
  if (action !== "setDefault") return settings;
  const cfg = normalizeSettings(settings);
  const next = {
    stable: { ...cfg.stable },
    nightly: { ...cfg.nightly },
    luasteam: { ...cfg.luasteam }
  };
  if (payload?.sectionId === LuaSteam.SECTION_ID) {
    next.luasteam.defaultVersion = payload?.version ? LuaSteam.selectedPin(payload.version).version : null;
    return next;
  }
  const section = payload?.sectionId === SECTION_NIGHTLY ? SECTION_NIGHTLY : SECTION_STABLE;
  next[section].defaultVersion = payload?.version && payload.version !== "auto" ? String(payload.version).trim() || null : null;
  return next;
}

module.exports = {
  id: "love",
  label: "LÖVE",
  normalizeSettings,
  applySettingsUpdate,
  refreshCatalog,
  getState,
  installRuntime,
  uninstallRuntime,
  updateSettingsAfterInstall,
  updateSettingsAfterUninstall,
  core: Core,
  __test: {
    SECTION_STABLE,
    SECTION_NIGHTLY,
    resetState: () => {
      stableCatalogPromise = null;
      stableCatalogEntriesByVersion = {};
      stableCatalog = {
        status: "idle",
        versions: [],
        fetchedAt: null,
        source: null,
        error: null,
        mode: null
      };
      nightlyCatalogPromise = null;
      nightlyCatalogEntriesByVersion = {};
      nightlyCatalogLabels = {};
      nightlyCatalog = {
        status: "idle",
        versions: [],
        fetchedAt: null,
        source: null,
        error: null,
        mode: null
      };
    }
  }
};

Custom.configure(module.exports, {
  defaultsPath: sectionId => [sectionId, "defaultVersion"],
  providers: [
    { core: Core, versions: ["normalizeVersion"], directories: ["getInstallDir"],
      lists: { listInstalled: ({ args }) => Core.normalizeChannel(args[1]), listInstalledStable: SECTION_STABLE, listInstalledNightly: SECTION_NIGHTLY },
      resolves: { resolveInstalled: ({ query }) => Core.normalizeChannel(query.channel) } },
    { core: require("../version"), versions: ["normalizeLoveVersion", "normalizeNightlyBuildKey"] },
    { core: LuaSteam, resolves: { resolveBundle: { section: LuaSteam.SECTION_ID,
      result: install => install || { ready: false, reason: "The selected LuaSteam runtime is unavailable. Check its path in Runtimes." } } } }
  ],
  sectionForEntry: entry => entry?.runtimeData?.love?.channel ||
    (Number.parseInt(entry?.moduleData?.detectedVersionNormalized || entry?.moduleData?.detectedVersion, 10) >= 12 ? "nightly" : "stable"),
  inspect(runtimePath, { sectionId }) {
    if (sectionId === LuaSteam.SECTION_ID) return LuaSteam.inspectCustomRuntime(runtimePath);
    const native = Custom.inspectExecutable(runtimePath, { candidates: ["love", "love.app/Contents/MacOS/love"] });
    let appPath = runtimePath.toLowerCase().endsWith(".app") ? runtimePath : null;
    for (let directory = path.dirname(native.executablePath), depth = 0; !appPath && depth < 5; depth++, directory = path.dirname(directory)) {
      if (directory.toLowerCase().endsWith(".app")) appPath = directory;
    }
    const runtimeVersion = appPath ? AppBundle.readAppBundleVersion(appPath) : null;
    const major = Number.parseInt(runtimeVersion, 10);
    if (Number.isFinite(major) && (sectionId === "nightly" ? major < 12 : major >= 12)) {
      throw new Error(`The selected LÖVE ${major} runtime belongs in the ${major >= 12 ? "12" : "11"} list.`);
    }
    return { ...native, appPath: appPath || native.executablePath,
      channel: sectionId, buildKey: sectionId === "nightly" ? runtimePath : undefined,
      bundleVersionNormalized: Core.normalizeVersion(runtimeVersion), runtimeVersion };
  }
});
