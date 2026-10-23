const Core = require("./godot-runtime");
const Gdsdecomp = require("./gdsdecomp-runtime");
const { runDownloadTask } = require("../../shared/runtime/download-manager");
const { buildRuntimeDownloadMeta } = require("../../shared/runtime/runtime-downloads");

const SECTION_GODOT = "default";
const SECTION_GDSDECOMP = "gdsdecomp";
const GDSDECOMP_LABEL = "Godot RE Tools";
const versionFamily = version => /^v?(\d+)\./.exec(String(version || ""))?.[1] || null;

let godotCatalogPromise = null;
let godotCatalogPromiseMode = null;
let godotCatalog = {
  status: "idle",
  versions: [],
  fetchedAt: null,
  source: null,
  error: null,
  mode: null
};

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
  const defaultVersion = null;
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
  const list = Array.isArray(installed) ? installed.filter(item => item.ready !== false) : [];
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
  const wantsLatest = latestOnly === true;
  const mode = wantsLatest ? "latest" : "all";
  if (
    !force &&
    godotCatalog.status === "success" &&
    godotCatalog.fetchedAt &&
    now - godotCatalog.fetchedAt < ttlMs &&
    godotCatalog.mode === mode
  ) {
    return godotCatalog;
  }
  if (godotCatalogPromise) {
    if (godotCatalogPromiseMode === mode) return godotCatalogPromise;
    await godotCatalogPromise.catch(() => {});
    return refreshGodotCatalog({ logger, force, latestOnly });
  }

  const previous = godotCatalog;
  godotCatalog = { ...godotCatalog, status: "loading", error: null, mode };

  godotCatalogPromiseMode = mode;
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
        ...previous, status: "error",
        error: String(e?.message || e)
      };
      throw e;
    } finally {
      godotCatalogPromise = null;
      godotCatalogPromiseMode = null;
    }
  })();

  return godotCatalogPromise;
}

async function refreshGdsdecompCatalog({ logger, force } = {}) {
  const ttlMs = 1000 * 60 * 60 * 6;
  const now = Date.now();
  if (!force && gdsdecompCatalog.status === "success" && gdsdecompCatalog.fetchedAt && now - gdsdecompCatalog.fetchedAt < ttlMs) {
    return gdsdecompCatalog;
  }
  if (gdsdecompCatalogPromise) return gdsdecompCatalogPromise;

  const previous = gdsdecompCatalog;
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
      gdsdecompCatalog = {
        ...previous, status: "error",
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
    defaultVersion: null,
    supportsDefault: false,
    defaultVariant: cfg.defaultVariant,
    installed,
    installing: null,
    catalog: {
      status: godotCatalog.status,
      versions: godotCatalog.versions,
      fetchedAt: godotCatalog.fetchedAt,
      source: godotCatalog.source || "https://godotengine.org/download/archive/",
      error: godotCatalog.error,
      mode: godotCatalog.mode,
      supportsLatestOnly: false,
      latestAvailableVersion: latestAvailable,
      latestInstalledVersion: latestInstalled?.version || null,
      updateAvailable:
        latestAvailable && latestInstalled?.version
          ? Core.compareVersions(String(latestAvailable), String(latestInstalled.version)) > 0
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
    supportsDefault: true,
    defaultVersion: cfg.gdsdecomp?.defaultVersion || null,
    installed: gdsdecompInstalled,
    installing: null,
    variants: [],
    catalog: {
      status: gdsdecompCatalog.status,
      versions: gdsdecompCatalog.versions,
      fetchedAt: gdsdecompCatalog.fetchedAt,
      source: gdsdecompCatalog.source || "https://github.com/GDRETools/gdsdecomp/releases",
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
  const families = [...new Set(["4", "3", ...godotCatalog.versions.map(versionFamily), ...installed.map(row => versionFamily(row.version))])]
    .filter(Boolean).sort((left, right) => Number(right) - Number(left));
  const engineSections = families.map(family => {
    const versions = godotCatalog.versions.filter(version => versionFamily(version) === family);
    const familyInstalled = installed.filter(row => versionFamily(row.version) === family);
    const latestAvailableVersion = versions[0] || null;
    const latestInstalledVersion = newestInstalled(familyInstalled, Core.compareVersionsDesc)?.version || null;
    const variants = Number(family) >= 3 ? VARIANTS : VARIANTS.filter(item => item.id === "standard");
    return { ...base, id: family, label: `Godot ${family}`, variants,
      defaultVariant: variants.some(item => item.id === cfg.defaultVariant) ? cfg.defaultVariant : variants[0].id,
      installed: familyInstalled,
      catalog: { ...base.catalog, versions, latestAvailableVersion, latestInstalledVersion,
        updateAvailable: Boolean(latestAvailableVersion && latestInstalledVersion &&
          Core.compareVersions(String(latestAvailableVersion), String(latestInstalledVersion)) > 0) } };
  });
  return {
    ...base,
    gdsdecomp: gdsdecompState,
    variants: VARIANTS,
    sections: [
      ...engineSections,
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
  sectionId,
  downloads,
  signal
} = {}) {
  const section = resolveSectionId(sectionId);
  if (section === SECTION_GDSDECOMP) {
    return installGdsdecompRuntime({ userDataDir, version, logger, onProgress, downloads, signal });
  }
  return installGodotRuntime({ userDataDir, version, variant, logger, onProgress, downloads, signal });
}

async function installGodotRuntime({
  userDataDir,
  version,
  variant,
  logger,
  onProgress,
  downloads,
  signal
} = {}) {
  const v = Core.normalizeVersion(version);
  const resolvedVariant = Core.resolveVariant(variant);
  const meta = buildRuntimeDownloadMeta({
    label: "Godot",
    managerId: "godot",
    sectionId: versionFamily(v) || SECTION_GODOT,
    version: v,
    variant: resolvedVariant
  });
  return runDownloadTask(
    downloads,
    meta,
    ({ signal: taskSignal, onProgress: taskProgress }) =>
      Core.installVersion({
        userDataDir,
        version: v,
        variant: resolvedVariant,
        logger,
        onProgress: taskProgress,
        signal: taskSignal || signal
      }),
    { onProgress }
  );
}

async function installGdsdecompRuntime({
  userDataDir,
  version,
  logger,
  onProgress,
  downloads,
  signal
} = {}) {
  const v = Gdsdecomp.normalizeVersion(version);
  const meta = buildRuntimeDownloadMeta({
    label: GDSDECOMP_LABEL,
    managerId: "godot",
    sectionId: SECTION_GDSDECOMP,
    version: v
  });
  return runDownloadTask(
    downloads,
    meta,
    ({ signal: taskSignal, onProgress: taskProgress }) =>
      Gdsdecomp.installVersion({
        userDataDir,
        version: v,
        logger,
        releases: gdsdecompReleases.length ? gdsdecompReleases : undefined,
        onProgress: taskProgress,
        signal: taskSignal || signal
      }),
    { onProgress }
  );
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
  if (payload?.preserveDefaults === true) return settings;
  const section = resolveSectionId(payload?.sectionId);
  const next = settings && typeof settings === "object" ? { ...settings } : {};
  if (section === SECTION_GDSDECOMP) {
    const current = next.gdsdecomp?.defaultVersion || null;
    if (!current || Gdsdecomp.compareVersions(installed.version, current) > 0) {
      next.gdsdecomp = { ...(next.gdsdecomp || {}), defaultVersion: installed.version };
    }
    return next;
  }
  return settings;
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
  return settings;
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
    return settings;
  },
  refreshCatalog,
  getState,
  installRuntime,
  uninstallRuntime,
  updateSettingsAfterInstall,
  updateSettingsAfterUninstall,
  core: Core
};
