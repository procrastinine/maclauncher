const Runtime = require("./onsyuri-runtime");
const Versions = require("./onsyuri-versions");
const Upstream = require("../../runtime/upstream");
const { runDownloadTask } = require("../../runtime/download-manager");
const { buildRuntimeDownloadMeta } = require("../../runtime/runtime-downloads");
const { sourceCatalog } = require("../../runtime/runtime-sources");
const { readRuntimeCatalog, writeRuntimeCatalog } = require("../../runtime/runtime-catalog");
const UPSTREAM_SOURCE = "https://github.com/YuriSizuku/OnscripterYuri/releases";
const Custom = require("../../runtime/custom-runtime");
const Architecture = require("../../runtime/architecture");
const { selectRuntimeVersion, managerDefaultVersion, usableDefaultVersion } = require("../../runtime/version-choices");
const fs = require("node:fs"), path = require("node:path");
const loadedUpstream = new Set();

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
let upstreamRows = [];
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
  return { mac: { defaultVersion: input?.mac?.defaultVersion && input.mac.defaultVersion !== "auto"
    ? Versions.normalizeOnsyuriMacVersion(input.mac.defaultVersion)
    : null, defaultVariant: variant },
    web: { defaultVersion: input?.web?.defaultVersion && input.web.defaultVersion !== "auto"
      ? Versions.normalizeOnsyuriVersion(input.web.defaultVersion) : null, defaultVariant: null } };
}

function resolveInstalledSelection(entry, settings, userDataDir) {
  loadUpstream(userDataDir);
  const web = entry?.runtimeId === "onsyuri_web", cfg = normalizeSettings(settings?.runtimes?.onsyuri);
  const data = entry?.runtimeData?.onsyuri || {};
  const selected = typeof data.version === "string" && data.version.trim() && data.version.trim() !== "auto"
    ? data.version.trim().replace(/^v/i, "") : null;
  const variant = web ? null : data.variant || cfg.mac.defaultVariant;
  const section = getState({ userDataDir, settings: { ...cfg, mac: { ...cfg.mac, defaultVariant: variant } } })[web ? "web" : "mac"];
  // The saved default while it is listed or installed for this CPU; otherwise the newest one.
  const version = selectRuntimeVersion({ manual: selected, defaultVersion: usableDefaultVersion({ ...section,
    installed: section.installed.filter(row => !variant || row.variant === variant) }) }).version;
  const installed = (web ? Runtime.listInstalledWeb(userDataDir) : Runtime.listInstalledMac(userDataDir))
    .filter(row => row.ready !== false && (!variant || row.variant === variant));
  const install = installed.find(row => row.version === version);
  return { version, ready: Boolean(install), install: install || null,
    ...(!version ? { discoveryRequired: true, reason: "No ONScripter-Yuri versions are available to download." } : {}),
    installOptions: { sectionId: web ? SECTION_WEB : SECTION_MAC, ...(variant ? { variant } : {}) } };
}

async function resolveSelection(entry, settings, userDataDir) {
  return resolveInstalledSelection(entry, settings, userDataDir);
}

function defaultArchVariant() {
  return Architecture.selectedArchitecture() === "arm64" ? "arm64" : "x64";
}

function resolveSectionId(sectionId) {
  return sectionId === SECTION_WEB ? SECTION_WEB : SECTION_MAC;
}

function applyUpstream(result, state) {
  upstreamRows = result.rows || [];
  catalogFetchedAt = state.fetchedAt;
  macCatalog = { ...state, versions: result.macVersions || Runtime.versionsOf(upstreamRows, SECTION_MAC), source: result.source || UPSTREAM_SOURCE };
  webCatalog = { ...state, versions: result.webVersions || Runtime.versionsOf(upstreamRows, SECTION_WEB), source: result.source || UPSTREAM_SOURCE };
}
// Cached rows: one listed download per version, section and CPU. Earlier
// caches hold GitHub's release objects, which are read the same way.
function cachedRows(entry) {
  if (entry?.release) return Runtime.rowsFromReleases([entry.release]);
  const file = Upstream.listedFile(entry?.asset);
  return file && [SECTION_MAC, SECTION_WEB].includes(entry.section) && Versions.normalizeOnsyuriVersion(entry.version) === entry.version
    ? [{ version: entry.version, label: entry.versionLabel, details: { section: entry.section }, ...(entry.architecture ? { architecture: entry.architecture } : {}), files: [file] }] : [];
}
function loadUpstream(userDataDir) {
  if (!userDataDir || loadedUpstream.has(userDataDir)) return;
  const cached = readRuntimeCatalog({ userDataDir, managerId: "onsyuri", sourceId: "upstream", validateEntry: row => cachedRows(row).length > 0 });
  if (cached?.source === UPSTREAM_SOURCE) applyUpstream({ rows: cached.entries.flatMap(cachedRows) },
    { status: cached.sourceStates?.upstream?.status === "error" ? "error" : "success", fetchedAt: cached.sourceStates?.upstream ? cached.sourceStates.upstream.fetchedAt : cached.fetchedAt,
      error: cached.sourceStates?.upstream?.error || null });
  loadedUpstream.add(userDataDir);
}
function saveUpstream(userDataDir) {
  if (!userDataDir) return;
  writeRuntimeCatalog({ userDataDir, managerId: "onsyuri", sourceId: "upstream", source: UPSTREAM_SOURCE,
    fetchedAt: catalogFetchedAt, sourceStates: { upstream: { status: macCatalog.status, fetchedAt: catalogFetchedAt, error: macCatalog.error } },
    entries: upstreamRows.filter(row => row.files?.length).map(row => ({ version: row.version, versionLabel: row.label, section: row.details?.section,
      ...(row.architecture ? { architecture: row.architecture } : {}), asset: Upstream.asset(row.files[0]) })) });
}
async function refreshCatalog({ logger, force, sectionId, userDataDir, signal, sourceId } = {}) {
  const section = resolveSectionId(sectionId);
  if (sourceId === "default") sourceId = section === SECTION_WEB ? "upstream" : "builds";
  if (sourceId == null && section === SECTION_WEB) sourceId = "upstream";
  if (sourceId != null && !["builds", "upstream"].includes(sourceId) || section === SECTION_WEB && sourceId === "builds")
    throw new Error("This ONScripter-Yuri download source is unavailable.");
  loadUpstream(userDataDir);
  if (sourceId == null) {
    const results = await Promise.allSettled([refreshCatalog({ logger, force, sectionId, userDataDir, signal, sourceId: "builds" }),
      refreshCatalog({ logger, force, sectionId, userDataDir, signal, sourceId: "upstream" })]);
    if (results.every(result => result.status === "rejected")) throw results[0].reason;
  } else if (sourceId === "builds") {
    Runtime.bundled.clearCache();
    await Runtime.hosted.refreshCatalog({ logger, force, userDataDir, signal, sourceId: "builds" });
  } else await refreshUpstream({ logger, force, userDataDir, signal });
  return getState({ userDataDir }).sections.find(row => row.id === section).catalog;
}
async function refreshUpstream({ logger, force, userDataDir, signal } = {}) {
  if (!force && macCatalog.status === "success" && catalogFetchedAt && Date.now() - catalogFetchedAt < 6 * 3600000) return;
  if (catalogPromise) return catalogPromise;
  const previousMac = macCatalog, previousWeb = webCatalog;
  macCatalog = { ...macCatalog, status: "loading", error: null };
  webCatalog = { ...webCatalog, status: "loading", error: null };
  catalogPromise = (async () => {
    try {
      const result = await Runtime.fetchAvailableVersions({ logger, userDataDir, signal, sourceId: "upstream" });
      applyUpstream(result, { status: "success", fetchedAt: Date.now(), error: null });
      saveUpstream(userDataDir);
    } catch (error) {
      macCatalog = { ...previousMac, status: "error", error: String(error.message || error) };
      webCatalog = { ...previousWeb, status: "error", error: String(error.message || error) };
      throw error;
    } finally { catalogPromise = null; }
  })();
  return catalogPromise;
}

function getState({ settings, userDataDir } = {}) {
  loadUpstream(userDataDir);
  const cfg = normalizeSettings(settings);
  const macInstalled = Runtime.listInstalledMac(userDataDir, { verification: "status" });
  const webInstalled = Runtime.listInstalledWeb(userDataDir);
  const hosted = Runtime.hosted.getState({ userDataDir });
  const hostedPins = Runtime.hosted.core.listCatalog({ userDataDir });
  const versions = [...new Set([...hosted.catalog.versions, ...macCatalog.versions])].sort(Versions.compareOnsyuriMacVersionsDesc);
  const latestMacInstalled = macInstalled.find(row => row.ready !== false)?.version || null;
  const latestWebInstalled = webInstalled.find(row => row.ready !== false)?.version || null;
  let installReason = null;
  const versionRequirements = Object.fromEntries(versions.map(version => {
    const pin = hostedPins.find(entry => entry?.version === version) || macInstalled.find(entry => entry.version === version)?.catalogEntry;
    const variants = Object.fromEntries(ARCH_VARIANTS.map(({ id: variant }) => {
      const row = macInstalled.find(row => row.version === version && row.variant === variant);
      const available = row?.ready === true;
      const listed = !/(?:-macos-v|-MCLv)\d+$/.test(version) && upstreamRows.some(item =>
        item.details?.section === SECTION_MAC && item.version === version && item.architecture === variant && item.files?.length);
      const downloadable = hostedPins.some(pin => pin.version === version && Architecture.matchesArchitecture(pin, variant) && hosted.catalog.installableVersions.includes(version)) ||
        listed;
      return [variant, { included: false, available,
        installable: Boolean(downloadable) && !available, requiresDownload: !available, installLabel: "Install",
        minimumMacOS: row?.minimumMacOS || pin?.minimumMacOS || null,
        installReason: row?.error || (available || downloadable ? "" : pin && !Architecture.matchesArchitecture(pin, variant)
          ? `This Mac runtime supports ${Architecture.architectureLabel(variant === "arm64" ? "x64" : "arm64")}.`
          : "No native package is available for this version and architecture.") }];
    }));
    return [version, { ...variants[cfg.mac.defaultVariant || defaultArchVariant()], variants }];
  }));
  const installableVersions = versions.filter(version => Object.values(versionRequirements[version].variants).some(row => row.installable));
  const includedVersions = [];
  if (!installReason && !installableVersions.length && !macInstalled.some(row => row.ready)) installReason = "A self-contained native package is unavailable for this selected architecture. The Web runtime is a separate installation.";
  const macState = {
    supportsDefault: true,
    defaultVersion: selectRuntimeVersion({ defaultVersion: cfg.mac.defaultVersion, fallback: managerDefaultVersion({
      listed: versions.filter(version => !versionRequirements[version]?.installReason),
      installed: macInstalled.filter(row => row.ready !== false && row.variant === cfg.mac.defaultVariant).map(row => row.version) }) }).version,
    defaultSource: cfg.mac.defaultVersion ? "saved" : "manager",
    defaultVariant: cfg.mac.defaultVariant || defaultArchVariant(),
    installed: macInstalled,
    installing: null,
    versionLabels: { ...Object.fromEntries(upstreamRows.filter(row=>row.label).map(row=>[row.version,row.label])), ...Object.fromEntries([...hostedPins.filter(Boolean), ...macInstalled].map(pin => [pin.version, /-MCLv[1-9]\d*$/.test(pin.version) ? pin.version : pin.versionLabel || pin.version])) },
    variants: ARCH_VARIANTS,
    notice: macInstalled.some(row => row.ready) || installableVersions.length ? null : MAC_NOTICE,
    installReason,
    catalog: {
      status: macCatalog.status === "idle" ? hosted.catalog?.status || hosted.status : macCatalog.status,
      versions,
      installableVersions,
      installable: installableVersions.length > 0,
      includedVersions,
      versionRequirements,
      installReason,
      fetchedAt: macCatalog.fetchedAt,
      source: "https://procrastinine.github.io/maclauncher-builds/#onsyuri",
      error: macCatalog.error,
      latestAvailableVersion: versions[0] || null,
      latestInstalledVersion: latestMacInstalled,
      updateAvailable: Boolean(versions[0] && cfg.mac.defaultVersion && Versions.compareOnsyuriMacVersions(versions[0], cfg.mac.defaultVersion) > 0)
    }
  };
  macState.catalog.versionLabels = macState.versionLabels;
  macState.catalog.sources = [sourceCatalog(macState.catalog, { id: "builds", label: "MacLauncher Builds",
    source: "https://procrastinine.github.io/maclauncher-builds/#onsyuri", versions: hosted.catalog.versions,
    state: hosted.catalog.sources?.find(row => row.id === "builds") || hosted.catalog }),
    sourceCatalog(macState.catalog, { id: "upstream", label: "Upstream", source: UPSTREAM_SOURCE, versions: macCatalog.versions, state: macCatalog })];


  const webState = {
    versionLabels: Object.fromEntries(upstreamRows.filter(row=>row.label).map(row=>[row.version,row.label])),
    supportsDefault: true,
    defaultVersion: selectRuntimeVersion({ defaultVersion: cfg.web.defaultVersion, fallback: managerDefaultVersion({
      listed: webCatalog.versions, installed: webInstalled.filter(row => row.ready !== false).map(row => row.version) }) }).version,
    defaultSource: cfg.web.defaultVersion ? "saved" : "manager",
    installed: webInstalled,
    installing: null,
    variants: [],
    catalog: {
      status: webCatalog.status,
      versionLabels: Object.fromEntries(upstreamRows.filter(row=>row.label).map(row=>[row.version,row.label])),
      versions: webCatalog.versions,
      fetchedAt: webCatalog.fetchedAt,
      source: webCatalog.source || UPSTREAM_SOURCE,
      error: webCatalog.error,
      latestAvailableVersion: webCatalog.versions[0] || null,
      latestInstalledVersion: latestWebInstalled,
      updateAvailable: Boolean(webCatalog.versions[0] && cfg.web.defaultVersion && Versions.compareOnsyuriVersions(webCatalog.versions[0], cfg.web.defaultVersion) > 0)
    }
  };

  return {
    mac: macState,
    web: webState,
    sections: [
      { id: SECTION_MAC, label: "Native", ...macState },
      { id: SECTION_WEB, label: "Web", ...webState }
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
  if (!version || version === "auto") {
    await refreshCatalog({ userDataDir, logger, signal: callerSignal, sectionId: SECTION_MAC, force: true });
    const arch = Runtime.normalizeVariant(variant) || defaultArchVariant();
    const state = getState({ userDataDir, settings: { mac: { defaultVariant: arch } } }).mac;
    version = usableDefaultVersion({ ...state, installed: state.installed.filter(row => row.variant === arch) });
    if (!version) throw new Error("No ONScripter-Yuri version is available.");
  }
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
        rows: upstreamRows,
        onProgress: taskProgress,
        signal: callerSignal && taskSignal ? AbortSignal.any([callerSignal, taskSignal]) : callerSignal || taskSignal || undefined
      }),
    { onProgress }
  );
}

async function installWeb({ userDataDir, version, logger, onProgress, downloads, signal: callerSignal }) {
  if (!version || version === "auto") {
    await refreshCatalog({ userDataDir, logger, signal: callerSignal, sectionId: SECTION_WEB, force: true });
    version = usableDefaultVersion(getState({ userDataDir }).web);
    if (!version) throw new Error("No ONScripter-Yuri Web version is available.");
  }
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
        rows: upstreamRows,
        onProgress: taskProgress,
        signal: callerSignal && taskSignal ? AbortSignal.any([callerSignal, taskSignal]) : callerSignal || taskSignal || undefined
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

function updateSettingsAfterInstall(settings, installed, { sectionId } = {}) {
  const section = resolveSectionId(sectionId), next = normalizeSettings(settings);
  if (!next[section].defaultVersion) next[section].defaultVersion = installed.version;
  return next;
}
function updateSettingsAfterUninstall() {}

module.exports = {
  id: "onsyuri",
  label: "ONScripter-Yuri",
  delivery: Object.freeze({ included: "none", catalog: "remote", sourceBuild: false }),
  distributionRequired: false,
  payloadPolicy: require("./payload-policy.json"),
  normalizeSettings,
  resolveInstalledSelection,
  resolveSelection,
  applySettingsUpdate: (action, payload, settings) => {
    if (action !== "setDefault") return settings;
    const section = resolveSectionId(payload?.sectionId), next = normalizeSettings(settings);
    const value = typeof payload?.version === "string" && payload.version.trim() !== "auto" ? payload.version.trim() : null;
    next[section].defaultVersion = value ? (section === SECTION_WEB ? Runtime.normalizeVersion(value) : Runtime.normalizeMacVersion(value)) : null;
    if (section === SECTION_MAC && ["arm64", "x64"].includes(payload?.variant)) next.mac.defaultVariant = payload.variant;
    return next;
  },
  refreshCatalog,
  getState,
  installRuntime,
  uninstallRuntime,
  updateSettingsAfterInstall,
  updateSettingsAfterUninstall,
  upstream: Runtime.source,
  core: Runtime
};
Custom.configure(module.exports, { sectionForEntry: entry => entry?.runtimeId === "onsyuri_web" ? SECTION_WEB : SECTION_MAC,
  defaultsPath: sectionId => [sectionId, "defaultVersion"],
  providers: [{ core: Runtime, lists: { listInstalledMac: SECTION_MAC, listInstalledWeb: SECTION_WEB } },
    { core: Versions, comparators: { compareOnsyuriVersions: 1, compareOnsyuriVersionsDesc: -1,
      compareOnsyuriMacVersions: 1, compareOnsyuriMacVersionsDesc: -1 } }],
  inspect(runtimePath, { sectionId }) {
    if (sectionId === SECTION_WEB) {
      const root = fs.statSync(runtimePath).isDirectory() ? runtimePath : path.dirname(runtimePath);
      const names = fs.readdirSync(root);
      if (!names.some(name => /\.html$/i.test(name)) || !names.some(name => /\.(?:js|wasm)$/i.test(name)))
        throw new Error("Select the extracted ONScripter Yuri web runtime folder containing its HTML, JavaScript and WebAssembly files.");
      return { installDir: root, root, ready: true };
    }
    const install = Custom.inspectExecutable(runtimePath, { candidates: ["onsyuri", "bin/onsyuri", "onscripter", "onsyuri.app/Contents/MacOS/onsyuri"] });
    return { ...install, variant: install.architecture };
  }
});
module.exports.resolveInstalledSelection = Custom.createSelector(module.exports, resolveInstalledSelection, {
  sectionId: context => context.entry?.runtimeId === "onsyuri_web" ? SECTION_WEB : SECTION_MAC,
  result: selected => ({ ...selected, installOptions: { sectionId: selected.sectionId,
    ...(selected.install?.variant ? { variant: selected.install.variant } : {}) } })
});
resolveInstalledSelection = module.exports.resolveInstalledSelection;
