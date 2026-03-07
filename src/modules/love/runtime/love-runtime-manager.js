const Core = require("./love-runtime");
const { runDownloadTask } = require("../../shared/runtime/download-manager");
const { buildRuntimeDownloadMeta } = require("../../shared/runtime/runtime-downloads");

const SECTION_STABLE = "stable";
const SECTION_NIGHTLY = "nightly";
const NIGHTLY_NOTICE = {
  title: "Nightly installs need GitHub CLI",
  lines: [
    { text: "Main-branch LÖVE nightlies are downloaded with the GitHub CLI (gh)." },
    { text: "Authenticate gh before installing nightlies.", mono: false },
    { text: "gh auth login", mono: true }
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
  const stableRaw = source.stable && typeof source.stable === "object" ? source.stable : {};
  const nightlyRaw = source.nightly && typeof source.nightly === "object" ? source.nightly : {};
  let stableDefaultVersion = null;
  const stableValue =
    typeof stableRaw.defaultVersion === "string" ? stableRaw.defaultVersion.trim() : "";
  if (stableValue) {
    try {
      stableDefaultVersion = Core.normalizeVersion(stableValue);
    } catch {
      stableDefaultVersion = null;
    }
  }
  return {
    stable: {
      defaultVersion: stableDefaultVersion
    },
    nightly: {
      defaultVersion:
        typeof nightlyRaw.defaultVersion === "string" && nightlyRaw.defaultVersion.trim()
          ? nightlyRaw.defaultVersion.trim()
          : null
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

function newestInstalled(installed, compareDesc) {
  const list = Array.isArray(installed) ? installed.slice() : [];
  list.sort((a, b) => {
    const left = a?.buildKey || a?.version || "";
    const right = b?.buildKey || b?.version || "";
    const byVersion = compareDesc(left, right);
    if (byVersion !== 0) return byVersion;
    return String(a?.installDir || "").localeCompare(String(b?.installDir || ""));
  });
  return list[0] || null;
}

async function refreshCatalog({ logger, force, latestOnly, sectionId } = {}) {
  return sectionId === SECTION_NIGHTLY
    ? refreshNightlyCatalog({ logger, force, latestOnly })
    : refreshStableCatalog({ logger, force });
}

async function refreshStableCatalog({ logger, force } = {}) {
  const ttlMs = 1000 * 60 * 60 * 6;
  const mode = "all";
  const now = Date.now();
  if (!force && stableCatalog.fetchedAt && now - stableCatalog.fetchedAt < ttlMs && stableCatalog.mode === mode) {
    return stableCatalog;
  }
  if (stableCatalogPromise) return stableCatalogPromise;

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
      stableCatalogEntriesByVersion = {};
      stableCatalog = {
        status: "error",
        versions: [],
        fetchedAt: Date.now(),
        source: null,
        error: String(error?.message || error),
        mode
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
  if (!force && nightlyCatalog.fetchedAt && now - nightlyCatalog.fetchedAt < ttlMs && nightlyCatalog.mode === mode) {
    return nightlyCatalog;
  }
  if (nightlyCatalogPromise) return nightlyCatalogPromise;

  nightlyCatalog = { ...nightlyCatalog, status: "loading", error: null, mode };
  nightlyCatalogPromise = (async () => {
    try {
      const ghOk = await Core.canUseGh({ logger });
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
      nightlyCatalogEntriesByVersion = {};
      nightlyCatalogLabels = {};
      nightlyCatalog = {
        status: "error",
        versions: [],
        fetchedAt: Date.now(),
        source: null,
        error: String(error?.message || error),
        mode
      };
      throw error;
    } finally {
      nightlyCatalogPromise = null;
    }
  })();

  return nightlyCatalogPromise;
}

function getState({ settings, userDataDir }) {
  const cfg = normalizeSettings(settings);
  const stableInstalled = Core.listInstalledStable(userDataDir);
  const nightlyInstalled = Core.listInstalledNightly(userDataDir);
  const latestInstalledStable = newestInstalled(stableInstalled, Core.compareVersionsDesc);
  const latestInstalledNightly = newestInstalled(
    nightlyInstalled,
    Core.compareNightlyBuildKeysDesc
  );
  const nightlyLabels = buildNightlyLabels(nightlyInstalled, nightlyCatalogEntriesByVersion);

  return {
    variants: [],
    sections: [
      {
        id: SECTION_STABLE,
        label: "Releases",
        defaultVersion: cfg.stable.defaultVersion,
        installed: stableInstalled,
        installing: null,
        versionLabels: {},
        variants: [],
        catalog: {
          status: stableCatalog.status,
          versions: stableCatalog.versions,
          fetchedAt: stableCatalog.fetchedAt,
          source: stableCatalog.source,
          error: stableCatalog.error,
          mode: stableCatalog.mode,
          supportsLatestOnly: false,
          latestAvailableVersion: stableCatalog.versions[0] || null,
          latestInstalledVersion: latestInstalledStable?.version || null,
          updateAvailable:
            stableCatalog.versions[0] && cfg.stable.defaultVersion
              ? Core.compareVersions(stableCatalog.versions[0], cfg.stable.defaultVersion) > 0
              : false
        }
      },
      {
        id: SECTION_NIGHTLY,
        label: "Nightlies",
        defaultVersion: cfg.nightly.defaultVersion,
        installed: nightlyInstalled,
        installing: null,
        versionLabels: nightlyLabels,
        variants: [],
        notice: NIGHTLY_NOTICE,
        catalog: {
          status: nightlyCatalog.status,
          versions: nightlyCatalog.versions,
          fetchedAt: nightlyCatalog.fetchedAt,
          source: nightlyCatalog.source,
          error: nightlyCatalog.error,
          mode: nightlyCatalog.mode,
          supportsLatestOnly: true,
          latestAvailableVersion: nightlyCatalog.versions[0] || null,
          latestInstalledVersion: latestInstalledNightly?.buildKey || latestInstalledNightly?.version || null,
          updateAvailable:
            nightlyCatalog.versions[0] && cfg.nightly.defaultVersion
              ? Core.compareNightlyBuildKeysDesc(cfg.nightly.defaultVersion, nightlyCatalog.versions[0]) > 0
              : false
        }
      }
    ]
  };
}

async function installRuntime({
  userDataDir,
  version,
  logger,
  onProgress,
  sectionId,
  downloads
} = {}) {
  const section = sectionId === SECTION_NIGHTLY ? SECTION_NIGHTLY : SECTION_STABLE;
  if (section === SECTION_NIGHTLY) {
    let buildKey = version || null;
    if (!buildKey) {
      if (!nightlyCatalog.versions.length) {
        await refreshNightlyCatalog({ logger, force: true, latestOnly: true });
      }
      buildKey = nightlyCatalog.versions[0] || null;
    }
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
      ({ signal }) =>
        Core.installNightlyVersion({
          userDataDir,
          entry: nightlyCatalogEntriesByVersion[buildKey] || { buildKey, version: buildKey },
          logger,
          signal
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
    ({ signal, onProgress: taskProgress }) =>
      Core.installStableVersion({
        userDataDir,
        version: stableVersion,
        logger,
        onProgress: taskProgress,
        signal,
        entriesByVersion: stableCatalogEntriesByVersion
      }),
    { onProgress }
  );
}

function uninstallRuntime({ userDataDir, version, installDir, sectionId } = {}) {
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
    nightly: { ...cfg.nightly }
  };
  const sectionId =
    payload?.sectionId === SECTION_NIGHTLY || installed?.channel === SECTION_NIGHTLY
      ? SECTION_NIGHTLY
      : SECTION_STABLE;
  if (sectionId === SECTION_NIGHTLY) {
    if (installed?.buildKey || installed?.version) {
      next.nightly.defaultVersion = installed.buildKey || installed.version;
    }
    return next;
  }
  if (installed?.version) {
    if (!cfg.stable.defaultVersion || Core.compareVersions(installed.version, cfg.stable.defaultVersion) > 0) {
      next.stable.defaultVersion = installed.version;
    }
  }
  return next;
}

function updateSettingsAfterUninstall(settings, payload, { userDataDir } = {}) {
  const cfg = normalizeSettings(settings);
  const next = {
    stable: { ...cfg.stable },
    nightly: { ...cfg.nightly }
  };
  const sectionId = payload?.sectionId === SECTION_NIGHTLY ? SECTION_NIGHTLY : SECTION_STABLE;
  if (sectionId === SECTION_NIGHTLY) {
    const installed = Core.listInstalledNightly(userDataDir);
    const hasDefault = installed.some(entry => (entry.buildKey || entry.version) === cfg.nightly.defaultVersion);
    if (!hasDefault) {
      next.nightly.defaultVersion = installed[0]?.buildKey || installed[0]?.version || null;
    }
    return next;
  }
  const installed = Core.listInstalledStable(userDataDir);
  const hasDefault = installed.some(entry => entry.version === cfg.stable.defaultVersion);
  if (!hasDefault) {
    next.stable.defaultVersion = installed[0]?.version || null;
  }
  return next;
}

function applySettingsUpdate(action, payload, settings) {
  if (action !== "setDefault") return settings;
  const cfg = normalizeSettings(settings);
  const next = {
    stable: { ...cfg.stable },
    nightly: { ...cfg.nightly }
  };
  if (payload?.sectionId === SECTION_NIGHTLY) {
    next.nightly.defaultVersion =
      typeof payload?.version === "string" && payload.version.trim() ? payload.version.trim() : null;
    return next;
  }
  next.stable.defaultVersion =
    typeof payload?.version === "string" && payload.version.trim()
      ? Core.normalizeVersion(payload.version)
      : null;
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
