const Runtime = require("./onsyuri-runtime");
const Releases = require("../../runtime/github-releases");
const { runDownloadTask } = require("../../runtime/download-manager");
const { buildRuntimeDownloadMeta } = require("../../runtime/runtime-downloads");

const SECTION_MAC = "mac";
const SECTION_WEB = "web";
const ARCH_VARIANTS = [
  { id: "arm64", label: "Apple Silicon" },
  { id: "x64", label: "Intel" }
];
const MAC_NOTICE = {
  title: "Native package availability",
  lines: [
    {
      text: "Native packages require a matching Mac architecture. Web uses a separate runtime."
    }
  ]
};

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
        : defaults.defaultVersion || null;
    const defaultVariant =
      typeof section.defaultVariant === "string" && section.defaultVariant.trim()
        ? section.defaultVariant.trim()
        : defaults.defaultVariant || null;
    return { defaultVersion, defaultVariant };
  };
  const macVariant = typeof src.mac?.defaultVariant === "string" && src.mac.defaultVariant.trim()
    ? src.mac.defaultVariant.trim() : defaultArchVariant();
  return {
    mac: normalizeSection("mac", { defaultVariant: defaultArchVariant(), defaultVersion: macVariant === "arm64" ? Runtime.recommendedVersion : null }),
    web: normalizeSection("web")
  };
}

function defaultArchVariant() {
  return process.arch === "arm64" ? "arm64" : "x64";
}

function resolveSectionId(sectionId) {
  return sectionId === SECTION_WEB ? SECTION_WEB : SECTION_MAC;
}

function compareVersions(a, b, section = SECTION_MAC) {
  return section === SECTION_WEB ? Releases.compareOnsyuriVersions(a, b) : Releases.compareOnsyuriMacVersions(a, b);
}

function newestInstalled(installed, section = SECTION_MAC) {
  const list = Array.isArray(installed) ? installed.filter(row => row.ready !== false) : [];
  list.sort((a, b) => {
    const compare = section === SECTION_WEB ? Releases.compareOnsyuriVersionsDesc : Releases.compareOnsyuriMacVersionsDesc;
    const byVersion = compare(
      String(a?.version || ""),
      String(b?.version || "")
    );
    if (byVersion !== 0) return byVersion;
    return String(a?.installDir || "").localeCompare(String(b?.installDir || ""));
  });
  return list[0] || null;
}

async function refreshCatalog({ logger, force, sectionId, userDataDir } = {}) {
  Runtime.bundled.clearCache();
  if (userDataDir) Runtime.listInstalledMac(userDataDir);
  await refreshCatalogs({ logger, force });
  return resolveSectionId(sectionId) === SECTION_WEB ? webCatalog : macCatalog;
}

async function refreshCatalogs({ logger, force } = {}) {
  const ttlMs = 1000 * 60 * 60 * 6;
  const now = Date.now();
  if (!force && macCatalog.status === "success" && webCatalog.status === "success" && catalogFetchedAt && now - catalogFetchedAt < ttlMs) return { macCatalog, webCatalog };
  if (catalogPromise) return catalogPromise;

  const previousMac = macCatalog, previousWeb = webCatalog;
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
      const error = String(e?.message || e);
      macCatalog = {
        ...previousMac, status: "error",
        error
      };
      webCatalog = {
        ...previousWeb, status: "error",
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
  const macInstalled = Runtime.listInstalledMac(userDataDir, { verification: "status" });
  const webInstalled = Runtime.listInstalledWeb(userDataDir);
  const latestMacInstalled = newestInstalled(macInstalled);
  const latestWebInstalled = newestInstalled(webInstalled, SECTION_WEB);
  const latestMacAvailable = Array.isArray(macCatalog.versions) && macCatalog.versions.length ? macCatalog.versions[0] : Runtime.catalog[0].version;
  const latestWebAvailable = Array.isArray(webCatalog.versions) ? webCatalog.versions[0] : null;

  const pinnedVersions = Runtime.catalog.map(pin => pin.version);
  const versions = [...new Set([...pinnedVersions, ...macCatalog.versions])].sort(Releases.compareOnsyuriMacVersionsDesc);
  let packaged = null, installReason = null;
  try { packaged = Runtime.bundled.available({ version: pinnedVersions[0], variant: cfg.mac.defaultVariant || defaultArchVariant() }); }
  catch (error) { installReason = error.message; }
  const versionRequirements = Object.fromEntries(versions.map(version => {
    const pin = Runtime.catalog.find(entry => entry.version === version);
    const variants = Object.fromEntries(ARCH_VARIANTS.map(({ id: variant }) => {
      const row = macInstalled.find(row => row.version === version && row.variant === variant);
      const included = row?.bundledExecution === "direct";
      let available = null, reason = null;
      try { available = Runtime.bundled.available({ version, variant }); } catch (error) { reason = error.message; }
      return [variant, { included, available: Boolean(available) && row?.ready !== false,
        installable: Boolean(available) && !included, requiresDownload: !available, installLabel: included ? "Included" : "Install",
        minimumMacOS: available?.minimumMacOS || pin?.minimumMacOS || null,
        installReason: row?.error || reason || (pin?.hostArchitectures && !pin.hostArchitectures.includes(variant)
          ? "This Mac runtime supports Apple Silicon."
          : !available ? "No native package is available for this version and architecture." : "") }];
    }));
    return [version, { ...variants[cfg.mac.defaultVariant || defaultArchVariant()], variants }];
  }));
  const installableVersions = versions.filter(version => Object.values(versionRequirements[version].variants).some(row => row.installable));
  const includedVersions = macInstalled.filter(row => row.bundledExecution === "direct" && row.variant === (cfg.mac.defaultVariant || defaultArchVariant())).map(row => row.version);
  if (!packaged && !installReason) installReason = "A self-contained native package is unavailable for this selected architecture. The Web runtime is a separate installation.";
  const macState = {
    defaultVersion: cfg.mac.defaultVersion || null,
    defaultVariant: cfg.mac.defaultVariant || defaultArchVariant(),
    installed: macInstalled,
    installing: null,
    versionLabels: Object.fromEntries(Runtime.catalog.map(pin => [pin.version, pin.versionLabel || pin.version])),
    variants: ARCH_VARIANTS,
    notice: packaged ? null : MAC_NOTICE,
    installReason,
    catalog: {
      status: packaged && macCatalog.status === "idle" ? "success" : macCatalog.status,
      versions,
      installableVersions,
      includedVersions,
      versionRequirements,
      installReason,
      fetchedAt: macCatalog.fetchedAt,
      source: macCatalog.source || Runtime.catalog[0].sourceUrl,
      error: macCatalog.error,
      latestAvailableVersion: latestMacAvailable,
      recommendedVersion: Runtime.recommendedVersion,
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
    installing: null,
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
          ? compareVersions(String(latestWebAvailable), String(cfg.web.defaultVersion), SECTION_WEB) > 0
          : false
    }
  };

  return {
    mac: macState,
    web: webState,
    sections: [
      { id: SECTION_MAC, label: "ONScripter-Yuri (Included)", ...macState },
      { id: SECTION_WEB, label: "ONScripter-Yuri Web", ...webState }
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
  downloads
}) {
  const section = resolveSectionId(sectionId);
  if (section === SECTION_WEB) {
    return installWeb({ userDataDir, version, logger, onProgress, downloads });
  }
  return installMac({ userDataDir, version, variant, logger, onProgress, downloads });
}

async function installMac({
  userDataDir,
  version,
  variant,
  logger,
  onProgress,
  downloads
}) {
  const v = Runtime.normalizeMacVersion(version);
  const arch = Runtime.normalizeVariant(variant) || defaultArchVariant();
  const meta = buildRuntimeDownloadMeta({
    label: "ONScripter-Yuri",
    managerId: "onsyuri",
    sectionId: SECTION_MAC,
    version: v,
    variant: arch
  });
  return runDownloadTask(
    downloads,
    meta,
    ({ signal, onProgress: taskProgress }) =>
      Runtime.installMacVersion({
        userDataDir,
        version: v,
        variant: arch,
        logger,
        releases: catalogReleases,
        onProgress: taskProgress,
        signal
      }),
    { onProgress }
  );
}

async function installWeb({ userDataDir, version, logger, onProgress, downloads }) {
  const v = Runtime.normalizeVersion(version);
  const meta = buildRuntimeDownloadMeta({
    label: "ONScripter-Yuri Web",
    managerId: "onsyuri",
    sectionId: SECTION_WEB,
    version: v
  });
  return runDownloadTask(
    downloads,
    meta,
    ({ signal, onProgress: taskProgress }) =>
      Runtime.installWebVersion({
        userDataDir,
        version: v,
        logger,
        releases: catalogReleases,
        onProgress: taskProgress,
        signal
      }),
    { onProgress }
  );
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
    if (!current || compareVersions(installed.version, current, SECTION_WEB) > 0) {
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
    const latest = newestInstalled(installed, SECTION_WEB);
    next.web = { ...(next.web || {}), defaultVersion: latest?.version || null };
    return next;
  }

  const installed = Runtime.listInstalledMac(userDataDir);
  const currentVersion = next.mac?.defaultVersion || null;
  const currentVariant = next.mac?.defaultVariant || defaultArchVariant();
  const hasDefault = installed.some(
    entry => entry.version === currentVersion && entry.variant === currentVariant && entry.ready !== false
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
  label: "ONScripter-Yuri",
  distributionRequired: true,
  distributionVersions: [Runtime.recommendedVersion],
  distributionArchitectures: { arm64: ["arm64"], x64: [] },
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
