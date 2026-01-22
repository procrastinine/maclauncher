const Core = require("./godot-runtime");
const Gdsdecomp = require("./gdsdecomp-runtime");

const SECTION_GODOT = "default";
const SECTION_GDSDECOMP = "gdsdecomp";
const GDSDECOMP_LABEL = "Godot RE Tools";

let godotInstallState = null;
let godotInstallPromise = null;
let godotCatalogPromise = null;
let godotCatalog = {
  status: "idle",
  versions: [],
  fetchedAt: null,
  source: null,
  error: null,
  mode: null
};

let gdsdecompInstallState = null;
let gdsdecompInstallPromise = null;
let gdsdecompCatalogPromise = null;
let gdsdecompCatalog = {
  status: "idle",
  versions: [],
  fetchedAt: null,
  source: null,
  error: null
};
let gdsdecompReleases = [];

const DEFAULT_VARIANT = Core.DEFAULT_VARIANT;
const VARIANTS = Core.VARIANTS;

function normalizeSettings(input) {
  const src = input && typeof input === "object" ? input : {};
  const defaultVersion =
    typeof src.defaultVersion === "string" && src.defaultVersion.trim()
      ? src.defaultVersion.trim()
      : null;
  const defaultVariant =
    typeof src.defaultVariant === "string" && src.defaultVariant.trim()
      ? Core.normalizeVariant(src.defaultVariant.trim()) || DEFAULT_VARIANT
      : DEFAULT_VARIANT;
  const gdsdecompSettings =
    src.gdsdecomp && typeof src.gdsdecomp === "object" ? src.gdsdecomp : {};
  let gdsdecompDefaultVersion = null;
  const gdsdecompRaw =
    typeof gdsdecompSettings.defaultVersion === "string"
      ? gdsdecompSettings.defaultVersion.trim()
      : "";
  if (gdsdecompRaw) {
    try {
      gdsdecompDefaultVersion = Gdsdecomp.normalizeVersion(gdsdecompRaw);
    } catch {
      gdsdecompDefaultVersion = null;
    }
  }
  return {
    defaultVersion,
    defaultVariant,
    gdsdecomp: {
      defaultVersion: gdsdecompDefaultVersion
    }
  };
}

function resolveSectionId(sectionId) {
  return sectionId === SECTION_GDSDECOMP ? SECTION_GDSDECOMP : SECTION_GODOT;
}

function newestInstalled(installed, compareDesc) {
  const list = Array.isArray(installed) ? installed.slice() : [];
  list.sort((a, b) => {
    const byVersion = compareDesc(String(a?.version || ""), String(b?.version || ""));
    if (byVersion !== 0) return byVersion;
    return String(a?.installDir || "").localeCompare(String(b?.installDir || ""));
  });
  return list[0] || null;
}

async function refreshCatalog({ logger, force, latestOnly, sectionId } = {}) {
  const section = resolveSectionId(sectionId);
  if (section === SECTION_GDSDECOMP) {
    return refreshGdsdecompCatalog({ logger, force });
  }
  return refreshGodotCatalog({ logger, force, latestOnly });
}

async function refreshGodotCatalog({ logger, force, latestOnly } = {}) {
  const ttlMs = 1000 * 60 * 60 * 6;
  const now = Date.now();
  const wantsLatest = latestOnly !== false;
  const mode = wantsLatest ? "latest" : "all";
  if (
    !force &&
    godotCatalog.fetchedAt &&
    now - godotCatalog.fetchedAt < ttlMs &&
    godotCatalog.mode === mode
  ) {
    return godotCatalog;
  }
  if (godotCatalogPromise) return godotCatalogPromise;

  godotCatalog = { ...godotCatalog, status: "loading", error: null, mode };

  godotCatalogPromise = (async () => {
    try {
      const res = await Core.fetchAvailableVersions({ logger, latestOnly: wantsLatest });
      godotCatalog = {
        status: "success",
        versions: res.versions || [],
        fetchedAt: Date.now(),
        source: res.source || null,
        error: null,
        mode
      };
      return godotCatalog;
    } catch (e) {
      godotCatalog = {
        status: "error",
        versions: [],
        fetchedAt: Date.now(),
        source: null,
        error: String(e?.message || e),
        mode
      };
      throw e;
    } finally {
      godotCatalogPromise = null;
    }
  })();

  return godotCatalogPromise;
}

async function refreshGdsdecompCatalog({ logger, force } = {}) {
  const ttlMs = 1000 * 60 * 60 * 6;
  const now = Date.now();
  if (!force && gdsdecompCatalog.fetchedAt && now - gdsdecompCatalog.fetchedAt < ttlMs) {
    return gdsdecompCatalog;
  }
  if (gdsdecompCatalogPromise) return gdsdecompCatalogPromise;

  gdsdecompCatalog = { ...gdsdecompCatalog, status: "loading", error: null };

  gdsdecompCatalogPromise = (async () => {
    try {
      const res = await Gdsdecomp.fetchAvailableVersions({ logger });
      gdsdecompReleases = res.releases || [];
      gdsdecompCatalog = {
        status: "success",
        versions: res.versions || [],
        fetchedAt: Date.now(),
        source: res.source || null,
        error: null
      };
      return gdsdecompCatalog;
    } catch (e) {
      gdsdecompReleases = [];
      gdsdecompCatalog = {
        status: "error",
        versions: [],
        fetchedAt: Date.now(),
        source: null,
        error: String(e?.message || e)
      };
      throw e;
    } finally {
      gdsdecompCatalogPromise = null;
    }
  })();

  return gdsdecompCatalogPromise;
}

function getState({ settings, userDataDir }) {
  const cfg = normalizeSettings(settings);
  const installed = Core.listInstalled(userDataDir);
  const latestInstalled = newestInstalled(installed, Core.compareVersionsDesc);
  const latestAvailable = Array.isArray(godotCatalog.versions)
    ? godotCatalog.versions[0]
    : null;
  const base = {
    defaultVersion: cfg.defaultVersion,
    defaultVariant: cfg.defaultVariant,
    installed,
    installing: godotInstallState,
    catalog: {
      status: godotCatalog.status,
      versions: godotCatalog.versions,
      fetchedAt: godotCatalog.fetchedAt,
      source: godotCatalog.source,
      error: godotCatalog.error,
      mode: godotCatalog.mode,
      supportsLatestOnly: true,
      latestAvailableVersion: latestAvailable,
      latestInstalledVersion: latestInstalled?.version || null,
      updateAvailable:
        latestAvailable && cfg?.defaultVersion
          ? Core.compareVersions(String(latestAvailable), String(cfg.defaultVersion)) > 0
          : false
    }
  };

  const gdsdecompInstalled = Gdsdecomp.listInstalled(userDataDir);
  const gdsdecompLatestInstalled = newestInstalled(
    gdsdecompInstalled,
    Gdsdecomp.compareVersionsDesc
  );
  const gdsdecompLatestAvailable = Array.isArray(gdsdecompCatalog.versions)
    ? gdsdecompCatalog.versions[0]
    : null;
  const gdsdecompState = {
    defaultVersion: cfg.gdsdecomp?.defaultVersion || null,
    installed: gdsdecompInstalled,
    installing: gdsdecompInstallState,
    variants: [],
    catalog: {
      status: gdsdecompCatalog.status,
      versions: gdsdecompCatalog.versions,
      fetchedAt: gdsdecompCatalog.fetchedAt,
      source: gdsdecompCatalog.source,
      error: gdsdecompCatalog.error,
      supportsLatestOnly: false,
      latestAvailableVersion: gdsdecompLatestAvailable,
      latestInstalledVersion: gdsdecompLatestInstalled?.version || null,
      updateAvailable:
        gdsdecompLatestAvailable && cfg?.gdsdecomp?.defaultVersion
          ? Gdsdecomp.compareVersions(
              String(gdsdecompLatestAvailable),
              String(cfg.gdsdecomp.defaultVersion)
            ) > 0
          : false
    }
  };
  return {
    ...base,
    gdsdecomp: gdsdecompState,
    variants: VARIANTS,
    sections: [
      {
        id: SECTION_GODOT,
        label: "Godot versions",
        ...base,
        variants: VARIANTS
      },
      {
        id: SECTION_GDSDECOMP,
        label: GDSDECOMP_LABEL,
        ...gdsdecompState
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
} = {}) {
  const section = resolveSectionId(sectionId);
  if (section === SECTION_GDSDECOMP) {
    return installGdsdecompRuntime({ userDataDir, version, logger, onProgress });
  }
  return installGodotRuntime({ userDataDir, version, variant, logger, onProgress });
}

async function installGodotRuntime({ userDataDir, version, variant, logger, onProgress } = {}) {
  if (godotInstallPromise) return godotInstallPromise;
  const v = Core.normalizeVersion(version);
  const resolvedVariant = Core.resolveVariant(variant);

  godotInstallState = {
    version: v,
    variant: resolvedVariant,
    downloaded: 0,
    total: null,
    status: "downloading"
  };
  onProgress?.(godotInstallState);

  godotInstallPromise = (async () => {
    let installed = null;
    try {
      installed = await Core.installVersion({
        userDataDir,
        version: v,
        variant: resolvedVariant,
        logger,
        onProgress: p => {
          godotInstallState = { ...godotInstallState, ...p, status: "downloading" };
          onProgress?.(godotInstallState);
        }
      });
      godotInstallState = null;
      return installed;
    } catch (e) {
      godotInstallState = {
        version: v,
        variant: resolvedVariant,
        downloaded: godotInstallState?.downloaded ?? 0,
        total: godotInstallState?.total ?? null,
        status: "error",
        error: String(e?.message || e)
      };
      throw e;
    } finally {
      godotInstallPromise = null;
    }
  })();

  return godotInstallPromise;
}

async function installGdsdecompRuntime({ userDataDir, version, logger, onProgress } = {}) {
  if (gdsdecompInstallPromise) return gdsdecompInstallPromise;
  const v = Gdsdecomp.normalizeVersion(version);

  gdsdecompInstallState = {
    version: v,
    downloaded: 0,
    total: null,
    status: "downloading"
  };
  onProgress?.(gdsdecompInstallState);

  gdsdecompInstallPromise = (async () => {
    let installed = null;
    try {
      installed = await Gdsdecomp.installVersion({
        userDataDir,
        version: v,
        logger,
        releases: gdsdecompReleases.length ? gdsdecompReleases : undefined,
        onProgress: p => {
          gdsdecompInstallState = { ...gdsdecompInstallState, ...p, status: "downloading" };
          onProgress?.(gdsdecompInstallState);
        }
      });
      gdsdecompInstallState = null;
      return installed;
    } catch (e) {
      gdsdecompInstallState = {
        version: v,
        downloaded: gdsdecompInstallState?.downloaded ?? 0,
        total: gdsdecompInstallState?.total ?? null,
        status: "error",
        error: String(e?.message || e)
      };
      throw e;
    } finally {
      gdsdecompInstallPromise = null;
    }
  })();

  return gdsdecompInstallPromise;
}

function uninstallRuntime({ userDataDir, version, variant, sectionId }) {
  const section = resolveSectionId(sectionId);
  if (section === SECTION_GDSDECOMP) {
    return Gdsdecomp.uninstallVersion({ userDataDir, version });
  }
  return Core.uninstallVersion({ userDataDir, version, variant });
}

function updateSettingsAfterInstall(settings, installed, payload) {
  if (!installed?.version) return settings;
  const section = resolveSectionId(payload?.sectionId);
  const next = settings && typeof settings === "object" ? { ...settings } : {};
  if (section === SECTION_GDSDECOMP) {
    const current = next.gdsdecomp?.defaultVersion || null;
    if (!current || Gdsdecomp.compareVersions(installed.version, current) > 0) {
      next.gdsdecomp = { ...(next.gdsdecomp || {}), defaultVersion: installed.version };
    }
    return next;
  }
  const current = next.defaultVersion || null;
  if (!current || Core.compareVersions(installed.version, current) > 0) {
    next.defaultVersion = installed.version;
  }
  if (installed.variant) next.defaultVariant = installed.variant;
  return next;
}

function updateSettingsAfterUninstall(settings, payload, { userDataDir } = {}) {
  if (!userDataDir) return settings;
  const section = resolveSectionId(payload?.sectionId);
  const next = settings && typeof settings === "object" ? { ...settings } : {};
  if (section === SECTION_GDSDECOMP) {
    const installed = Gdsdecomp.listInstalled(userDataDir);
    const defaultVersion = next.gdsdecomp?.defaultVersion || null;
    const hasDefault = installed.some(entry => entry.version === defaultVersion);
    if (hasDefault) return settings;
    const latest = newestInstalled(installed, Gdsdecomp.compareVersionsDesc);
    next.gdsdecomp = { ...(next.gdsdecomp || {}), defaultVersion: latest?.version || null };
    return next;
  }
  const installed = Core.listInstalled(userDataDir);
  const defaultVersion = next.defaultVersion || null;
  const defaultVariant = next.defaultVariant || DEFAULT_VARIANT;
  const hasDefault = installed.some(
    entry => entry.version === defaultVersion && entry.variant === defaultVariant
  );
  if (hasDefault) return settings;
  const latest = newestInstalled(installed, Core.compareVersionsDesc);
  next.defaultVersion = latest?.version || null;
  next.defaultVariant = latest?.variant || DEFAULT_VARIANT;
  return next;
}

module.exports = {
  id: "godot",
  label: "Godot",
  normalizeSettings,
  applySettingsUpdate: (action, payload, settings) => {
    if (action !== "setDefault") return settings;
    const section = resolveSectionId(payload?.sectionId);
    const next = settings && typeof settings === "object" ? { ...settings } : {};
    const version = payload?.version ? String(payload.version).trim() : null;
    if (section === SECTION_GDSDECOMP) {
      next.gdsdecomp = { ...(next.gdsdecomp || {}), defaultVersion: version || null };
      return next;
    }
    const variant = payload?.variant ? String(payload.variant).trim() : null;
    next.defaultVersion = version || null;
    next.defaultVariant = Core.normalizeVariant(variant) || DEFAULT_VARIANT;
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
