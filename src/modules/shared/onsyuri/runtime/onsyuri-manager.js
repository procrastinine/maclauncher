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
  const variant = typeof input?.mac?.defaultVariant === "string" && input.mac.defaultVariant.trim()
    ? input.mac.defaultVariant.trim() : defaultArchVariant();
  return { mac: { defaultVersion: variant === "arm64" ? Runtime.recommendedVersion : null, defaultVariant: variant },
    web: { defaultVersion: null, defaultVariant: null } };
}

function resolveInstalledSelection(entry, settings, userDataDir) {
  const web = entry?.runtimeId === "onsyuri_web", cfg = normalizeSettings(settings?.runtimes?.onsyuri);
  const data = entry?.runtimeData?.onsyuri || {};
  const selected = typeof data.version === "string" && data.version.trim() && data.version.trim() !== "auto"
    ? data.version.trim().replace(/^v/i, "") : null;
  const variant = web ? null : data.variant || cfg.mac.defaultVariant;
  const required = selected || (!web && variant === "arm64" ? Runtime.recommendedVersion : null);
  const installed = web ? Runtime.listInstalledWeb(userDataDir) : Runtime.listInstalledMac(userDataDir);
  const install = installed.find(row => row.ready !== false && (!required || row.version === required) && (!variant || row.variant === variant));
  const catalog = web ? webCatalog : macCatalog;
  const version = required || install?.version || catalog.versions[0] || null;
  return { version, ready: Boolean(install), install: install || null,
    installOptions: {sectionId: web ? SECTION_WEB : SECTION_MAC, ...(variant ? {variant} : {})} };
}

async function resolveSelection(entry, settings, userDataDir) {
  let selection = resolveInstalledSelection(entry, settings, userDataDir);
  if (!selection.version) {
    await refreshCatalog({force: true});
    selection = resolveInstalledSelection(entry, settings, userDataDir);
  }
  return selection;
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
  await refreshCatalogs({ logger, force, userDataDir });
  return resolveSectionId(sectionId) === SECTION_WEB ? webCatalog : macCatalog;
}

async function refreshCatalogs({ logger, force, userDataDir } = {}) {
  const ttlMs = 1000 * 60 * 60 * 6;
  const now = Date.now();
  if (!force && macCatalog.status === "success" && webCatalog.status === "success" && catalogFetchedAt && now - catalogFetchedAt < ttlMs) return { macCatalog, webCatalog };
  if (catalogPromise) return catalogPromise;

  const previousMac = macCatalog, previousWeb = webCatalog;
  macCatalog = { ...macCatalog, status: "loading", error: null };
  webCatalog = { ...webCatalog, status: "loading", error: null };

  catalogPromise = (async () => {
    try {
      const res = await Runtime.fetchAvailableVersions({ logger, userDataDir });
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
  const hosted = Runtime.hosted.getState({ userDataDir });
  const hostedPins = Runtime.hosted.core.listCatalog({ userDataDir });
  const latestMacInstalled = newestInstalled(macInstalled);
  const latestWebInstalled = newestInstalled(webInstalled, SECTION_WEB);
  const latestMacAvailable = Array.isArray(macCatalog.versions) && macCatalog.versions.length ? macCatalog.versions[0] : Runtime.catalog[0].version;
  const latestWebAvailable = Array.isArray(webCatalog.versions) ? webCatalog.versions[0] : null;

  const pinnedVersions = Runtime.catalog.map(pin => pin.version);
  const versions = [...new Set([...pinnedVersions, ...hosted.catalog.versions, ...macCatalog.versions])].sort(Releases.compareOnsyuriMacVersionsDesc);
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
      const downloadable = hostedPins.some(pin => pin.version === version && pin.projectPackage?.arch === variant && hosted.catalog.installableVersions.includes(version));
      return [variant, { included, available: Boolean(available || row?.ready) && row?.ready !== false,
        installable: Boolean(available || downloadable) && !included, requiresDownload: !available, installLabel: included ? "Included" : "Install",
        minimumMacOS: available?.minimumMacOS || pin?.minimumMacOS || null,
        installReason: row?.error || reason || (pin?.hostArchitectures && !pin.hostArchitectures.includes(variant)
          ? "This Mac runtime supports Apple Silicon."
          : !available && !downloadable ? "No native package is available for this version and architecture." : "") }];
    }));
    return [version, { ...variants[cfg.mac.defaultVariant || defaultArchVariant()], variants }];
  }));
  const installableVersions = versions.filter(version => Object.values(versionRequirements[version].variants).some(row => row.installable));
  const includedVersions = macInstalled.filter(row => row.bundledExecution === "direct" && row.variant === (cfg.mac.defaultVariant || defaultArchVariant())).map(row => row.version);
  if (!packaged && !installReason && !installableVersions.length) installReason = "A self-contained native package is unavailable for this selected architecture. The Web runtime is a separate installation.";
  const macState = {
    supportsDefault: false,
    defaultVersion: cfg.mac.defaultVersion || null,
    defaultVariant: cfg.mac.defaultVariant || defaultArchVariant(),
    installed: macInstalled,
    installing: null,
    versionLabels: Object.fromEntries(Runtime.catalog.map(pin => [pin.version, pin.versionLabel || pin.version])),
    variants: ARCH_VARIANTS,
    notice: packaged || installableVersions.length ? null : MAC_NOTICE,
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
    supportsDefault: false,
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
      { id: SECTION_MAC, label: "ONScripter-Yuri", ...macState },
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
  downloads,
  signal: callerSignal
}) {
  const section = resolveSectionId(sectionId);
  if (section === SECTION_WEB) {
    return installWeb({ userDataDir, version, logger, onProgress, downloads, signal: callerSignal });
  }
  return installMac({ userDataDir, version, variant, logger, onProgress, downloads, signal: callerSignal });
}

async function installMac({
  userDataDir,
  version,
  variant,
  logger,
  onProgress,
  downloads,
  signal: callerSignal
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
    ({ signal: taskSignal, onProgress: taskProgress }) =>
      Runtime.installMacVersion({
        userDataDir,
        version: v,
        variant: arch,
        logger,
        releases: catalogReleases,
        onProgress: taskProgress,
        signal: callerSignal && taskSignal ? AbortSignal.any([callerSignal, taskSignal]) : callerSignal || taskSignal
      }),
    { onProgress }
  );
}

async function installWeb({ userDataDir, version, logger, onProgress, downloads, signal: callerSignal }) {
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
    ({ signal: taskSignal, onProgress: taskProgress }) =>
      Runtime.installWebVersion({
        userDataDir,
        version: v,
        logger,
        releases: catalogReleases,
        onProgress: taskProgress,
        signal: callerSignal && taskSignal ? AbortSignal.any([callerSignal, taskSignal]) : callerSignal || taskSignal
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

function updateSettingsAfterInstall() {}
function updateSettingsAfterUninstall() {}

module.exports = {
  id: "onsyuri",
  label: "ONScripter-Yuri",
  distributionRequired: true,
  distributionVersions: [Runtime.recommendedVersion],
  distributionArchitectures: { arm64: ["arm64"], x64: [] },
  normalizeSettings,
  resolveInstalledSelection,
  resolveSelection,
  applySettingsUpdate: (_action, _payload, settings) => settings,
  refreshCatalog,
  getState,
  installRuntime,
  uninstallRuntime,
  updateSettingsAfterInstall,
  updateSettingsAfterUninstall,
  core: Runtime
};
