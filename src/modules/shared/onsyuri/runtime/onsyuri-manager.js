const Runtime = require("./onsyuri-runtime");
const Releases = require("../../runtime/github-releases");

const SECTION_MAC = "mac";
const SECTION_WEB = "web";
const ARCH_VARIANTS = [
  { id: "arm64", label: "Apple Silicon" },
  { id: "x64", label: "Intel" }
];
const MAC_NOTICE = {
  title: "Onscripter Yuri (mac) dependencies",
  lines: [
    {
      text: "This runtime needs extra Homebrew libraries. Missing dylibs show in launch errors."
    },
    { text: "brew install lua sdl2 sdl2_ttf sdl2_image sdl2_mixer", mono: true }
  ]
};

let macInstallState = null;
let webInstallState = null;
let macInstallPromise = null;
let webInstallPromise = null;
let catalogPromise = null;
let catalogFetchedAt = null;
let catalogReleases = [];
let macCatalog = {
  status: "idle",
  versions: [],
  fetchedAt: null,
  source: null,
  error: null
};
let webCatalog = {
  status: "idle",
  versions: [],
  fetchedAt: null,
  source: null,
  error: null
};

function normalizeSettings(input) {
  const src = input && typeof input === "object" ? input : {};
  const normalizeSection = (key, defaults = {}) => {
    const section = src[key] && typeof src[key] === "object" ? src[key] : {};
    const defaultVersion =
      typeof section.defaultVersion === "string" && section.defaultVersion.trim()
        ? section.defaultVersion.trim().replace(/^v/i, "")
        : null;
    const defaultVariant =
      typeof section.defaultVariant === "string" && section.defaultVariant.trim()
        ? section.defaultVariant.trim()
        : defaults.defaultVariant || null;
    return { defaultVersion, defaultVariant };
  };
  return {
    mac: normalizeSection("mac", { defaultVariant: defaultArchVariant() }),
    web: normalizeSection("web")
  };
}

function defaultArchVariant() {
  return process.arch === "arm64" ? "arm64" : "x64";
}

function resolveSectionId(sectionId) {
  return sectionId === SECTION_WEB ? SECTION_WEB : SECTION_MAC;
}

function compareVersions(a, b) {
  return Releases.compareOnsyuriVersions(a, b);
}

function newestInstalled(installed) {
  const list = Array.isArray(installed) ? installed.slice() : [];
  list.sort((a, b) => {
    const byVersion = Releases.compareOnsyuriVersionsDesc(
      String(a?.version || ""),
      String(b?.version || "")
    );
    if (byVersion !== 0) return byVersion;
    return String(a?.installDir || "").localeCompare(String(b?.installDir || ""));
  });
  return list[0] || null;
}

async function refreshCatalog({ logger, force, sectionId } = {}) {
  await refreshCatalogs({ logger, force });
  return resolveSectionId(sectionId) === SECTION_WEB ? webCatalog : macCatalog;
}

async function refreshCatalogs({ logger, force } = {}) {
  const ttlMs = 1000 * 60 * 60 * 6;
  const now = Date.now();
  if (!force && catalogFetchedAt && now - catalogFetchedAt < ttlMs) return { macCatalog, webCatalog };
  if (catalogPromise) return catalogPromise;

  macCatalog = { ...macCatalog, status: "loading", error: null };
  webCatalog = { ...webCatalog, status: "loading", error: null };

  catalogPromise = (async () => {
    try {
      const res = await Runtime.fetchAvailableVersions({ logger });
      catalogReleases = res.releases || [];
      catalogFetchedAt = Date.now();
      macCatalog = {
        status: "success",
        versions: res.macVersions || [],
        fetchedAt: catalogFetchedAt,
        source: res.source || null,
        error: null
      };
      webCatalog = {
        status: "success",
        versions: res.webVersions || [],
        fetchedAt: catalogFetchedAt,
        source: res.source || null,
        error: null
      };
      return { macCatalog, webCatalog };
    } catch (e) {
      catalogReleases = [];
      catalogFetchedAt = Date.now();
      const error = String(e?.message || e);
      macCatalog = {
        status: "error",
        versions: [],
        fetchedAt: catalogFetchedAt,
        source: null,
        error
      };
      webCatalog = {
        status: "error",
        versions: [],
        fetchedAt: catalogFetchedAt,
        source: null,
        error
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
  const macInstalled = Runtime.listInstalledMac(userDataDir);
  const webInstalled = Runtime.listInstalledWeb(userDataDir);
  const latestMacInstalled = newestInstalled(macInstalled);
  const latestWebInstalled = newestInstalled(webInstalled);
  const latestMacAvailable = Array.isArray(macCatalog.versions) ? macCatalog.versions[0] : null;
  const latestWebAvailable = Array.isArray(webCatalog.versions) ? webCatalog.versions[0] : null;

  const macState = {
    defaultVersion: cfg.mac.defaultVersion || null,
    defaultVariant: cfg.mac.defaultVariant || defaultArchVariant(),
    installed: macInstalled,
    installing: macInstallState,
    variants: ARCH_VARIANTS,
    notice: MAC_NOTICE,
    catalog: {
      status: macCatalog.status,
      versions: macCatalog.versions,
      fetchedAt: macCatalog.fetchedAt,
      source: macCatalog.source,
      error: macCatalog.error,
      latestAvailableVersion: latestMacAvailable,
      latestInstalledVersion: latestMacInstalled?.version || null,
      updateAvailable:
        latestMacAvailable && cfg?.mac?.defaultVersion
          ? compareVersions(String(latestMacAvailable), String(cfg.mac.defaultVersion)) > 0
          : false
    }
  };

  const webState = {
    defaultVersion: cfg.web.defaultVersion || null,
    installed: webInstalled,
    installing: webInstallState,
    variants: [],
    catalog: {
      status: webCatalog.status,
      versions: webCatalog.versions,
      fetchedAt: webCatalog.fetchedAt,
      source: webCatalog.source,
      error: webCatalog.error,
      latestAvailableVersion: latestWebAvailable,
      latestInstalledVersion: latestWebInstalled?.version || null,
      updateAvailable:
        latestWebAvailable && cfg?.web?.defaultVersion
          ? compareVersions(String(latestWebAvailable), String(cfg.web.defaultVersion)) > 0
          : false
    }
  };

  return {
    mac: macState,
    web: webState,
    sections: [
      { id: SECTION_MAC, label: "Onsyuri (mac)", ...macState },
      { id: SECTION_WEB, label: "Onsyuri (web)", ...webState }
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
  const section = resolveSectionId(sectionId);
  if (section === SECTION_WEB) {
    return installWeb({ userDataDir, version, logger, onProgress });
  }
  return installMac({ userDataDir, version, variant, logger, onProgress });
}

async function installMac({ userDataDir, version, variant, logger, onProgress }) {
  if (macInstallPromise) return macInstallPromise;
  const v = Runtime.normalizeVersion(version);
  const arch = Runtime.normalizeVariant(variant) || defaultArchVariant();

  macInstallState = {
    version: v,
    variant: arch,
    downloaded: 0,
    total: null,
    status: "downloading"
  };

  macInstallPromise = (async () => {
    let installed = null;
    try {
      installed = await Runtime.installMacVersion({
        userDataDir,
        version: v,
        variant: arch,
        logger,
        releases: catalogReleases,
        onProgress: p => {
          macInstallState = { ...macInstallState, ...p, status: "downloading" };
          onProgress?.(macInstallState);
        }
      });
      macInstallState = null;
      return installed;
    } catch (e) {
      macInstallState = {
        version: v,
        variant: arch,
        downloaded: macInstallState?.downloaded ?? 0,
        total: macInstallState?.total ?? null,
        status: "error",
        error: String(e?.message || e)
      };
      throw e;
    } finally {
      macInstallPromise = null;
    }
  })();

  return macInstallPromise;
}

async function installWeb({ userDataDir, version, logger, onProgress }) {
  if (webInstallPromise) return webInstallPromise;
  const v = Runtime.normalizeVersion(version);

  webInstallState = {
    version: v,
    downloaded: 0,
    total: null,
    status: "downloading"
  };

  webInstallPromise = (async () => {
    let installed = null;
    try {
      installed = await Runtime.installWebVersion({
        userDataDir,
        version: v,
        logger,
        releases: catalogReleases,
        onProgress: p => {
          webInstallState = { ...webInstallState, ...p, status: "downloading" };
          onProgress?.(webInstallState);
        }
      });
      webInstallState = null;
      return installed;
    } catch (e) {
      webInstallState = {
        version: v,
        downloaded: webInstallState?.downloaded ?? 0,
        total: webInstallState?.total ?? null,
        status: "error",
        error: String(e?.message || e)
      };
      throw e;
    } finally {
      webInstallPromise = null;
    }
  })();

  return webInstallPromise;
}

function uninstallRuntime({ userDataDir, version, variant, installDir, sectionId }) {
  const section = resolveSectionId(sectionId);
  if (section === SECTION_WEB) {
    return Runtime.uninstallWebVersion({ userDataDir, version, installDir });
  }
  return Runtime.uninstallMacVersion({ userDataDir, version, variant, installDir });
}

function updateSettingsAfterInstall(settings, installed, payload) {
  if (!installed || !installed.version) return settings;
  const section = resolveSectionId(payload?.sectionId);
  const next = settings && typeof settings === "object" ? { ...settings } : {};
  if (section === SECTION_WEB) {
    const current = next.web?.defaultVersion || null;
    if (!current || compareVersions(installed.version, current) > 0) {
      next.web = { ...(next.web || {}), defaultVersion: installed.version };
    }
    return next;
  }

  const current = next.mac?.defaultVersion || null;
  if (!current || compareVersions(installed.version, current) > 0) {
    next.mac = {
      ...(next.mac || {}),
      defaultVersion: installed.version,
      defaultVariant: installed.variant || next.mac?.defaultVariant || defaultArchVariant()
    };
  }
  return next;
}

function updateSettingsAfterUninstall(settings, payload, { userDataDir } = {}) {
  if (!userDataDir) return settings;
  const section = resolveSectionId(payload?.sectionId);
  const next = settings && typeof settings === "object" ? { ...settings } : {};

  if (section === SECTION_WEB) {
    const installed = Runtime.listInstalledWeb(userDataDir);
    const current = next.web?.defaultVersion || null;
    const hasDefault = installed.some(entry => entry.version === current);
    if (hasDefault) return settings;
    const latest = newestInstalled(installed);
    next.web = { ...(next.web || {}), defaultVersion: latest?.version || null };
    return next;
  }

  const installed = Runtime.listInstalledMac(userDataDir);
  const currentVersion = next.mac?.defaultVersion || null;
  const currentVariant = next.mac?.defaultVariant || defaultArchVariant();
  const hasDefault = installed.some(
    entry => entry.version === currentVersion && entry.variant === currentVariant
  );
  if (hasDefault) return settings;
  const latest = newestInstalled(installed);
  next.mac = {
    ...(next.mac || {}),
    defaultVersion: latest?.version || null,
    defaultVariant: latest?.variant || currentVariant
  };
  return next;
}

module.exports = {
  id: "onsyuri",
  label: "Onscripter Yuri",
  normalizeSettings,
  applySettingsUpdate: (action, payload, settings) => {
    if (action !== "setDefault") return settings;
    const section = resolveSectionId(payload?.sectionId);
    const next = settings && typeof settings === "object" ? { ...settings } : {};
    const version = payload?.version ? String(payload.version).trim().replace(/^v/i, "") : null;
    if (section === SECTION_WEB) {
      next.web = { ...(next.web || {}), defaultVersion: version };
      return next;
    }
    const variant = payload?.variant ? String(payload.variant).trim() : null;
    next.mac = {
      ...(next.mac || {}),
      defaultVersion: version,
      defaultVariant: variant || next.mac?.defaultVariant || defaultArchVariant()
    };
    return next;
  },
  refreshCatalog,
  getState,
  installRuntime,
  uninstallRuntime,
  updateSettingsAfterInstall,
  updateSettingsAfterUninstall,
  core: Runtime
};
