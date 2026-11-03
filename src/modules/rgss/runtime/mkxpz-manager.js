const Core = require("./mkxpz-runtime-manager");
const Builds = require("./mkxpz-builds");
const { runDownloadTask } = require("../../shared/runtime/download-manager");
const { buildRuntimeDownloadMeta } = require("../../shared/runtime/runtime-downloads");
const { throwIfAborted } = require("../../shared/runtime/download-utils");
const Rtp = require("../rtp");
const { sourceCatalog } = require("../../shared/runtime/runtime-sources");
const { readRuntimeCatalog, writeRuntimeCatalog } = require("../../shared/runtime/runtime-catalog");
const UPSTREAM_SOURCE = "https://github.com/mkxp-z/mkxp-z/actions";
const Custom = require("../../shared/runtime/custom-runtime");
const Architecture = require("../../shared/runtime/architecture");
const { selectRuntimeVersion, managerDefaultVersion, usableDefaultVersion } = require("../../shared/runtime/version-choices");
const fs = require("node:fs"), path = require("node:path");
let loadedUpstreamDir = null;

let catalogPromise = null;
let catalogEntries = [];
let catalog = {
  status: "idle",
  versions: [],
  fetchedAt: null,
  source: null,
  error: null,
  mode: null
};

const VARIANTS = [];
const MKXPZ_NOTICE = {
  title: "Version sources",
  lines: [
    { text: "MacLauncher builds include Unicode filename fixes. Upstream downloads are the public macOS builds of the dev branch on GitHub Actions." }
  ]
};

function buildVersionLabels(versions) {
  const labels = {};
  const list = Array.isArray(versions) ? versions : [];
  for (const version of list) {
    const label = Core.formatVersionLabel ? Core.formatVersionLabel(version) : null;
    if (!label || label === version) continue;
    labels[version] = label;
  }
  return labels;
}

function normalizeSettings(input) {
  const version = typeof input?.defaultVersion === "string" ? input.defaultVersion.trim() : "";
  const architecture = Architecture.targetArchitecture(input?.defaultArchitecture);
  return {defaultVersion: version && version !== "auto" ? Core.normalizeVersion(version)
    : null, ...(architecture ? { defaultArchitecture: architecture } : {})};
}

// MacLauncher Builds packages follow the shared build choice; upstream
// downloads name no CPU and serve every Mac.
function buildArchitecture(entry, settings, userDataDir, options = {}) {
  return Builds.manager.chooseArchitecture(entry, settings, userDataDir, options);
}

function applySettingsUpdate(action, payload, settings, options = {}) {
  if (action !== "setDefault") return settings;
  // A version from another CPU's list saves that CPU as the build choice.
  const { defaultArchitecture } = Builds.manager.applySettingsUpdate(action, payload, settings, options) || {};
  const { defaultArchitecture: _previous, ...rest } = settings || {};
  return { ...rest, ...normalizeSettings({ defaultVersion: payload?.version, defaultArchitecture }) };
}

// Launch and preparation use the same exact version, including retained aliases.
function selectedVersion(entry, settings, userDataDir) {
  return resolveSelection(entry, settings, userDataDir).version;
}

function resolveSelection(entry, settings, userDataDir) {
  const state = getState({ userDataDir, settings: settings?.runtimes?.mkxpz });
  const chosen = selectRuntimeVersion({ manual: Custom.selectionPath(module.exports, entry, settings) || entry?.runtimeData?.mkxpz?.version,
    defaultVersion: usableDefaultVersion(state) });
  const version = chosen.version;
  if (!version) return { version: null, ready: false, install: null, discoveryRequired: true,
    reason: "No MKXP-Z versions are available to download.", installOptions: { sectionId: "default" } };
  let install = null, reason;
  try { install = Core.resolveOwnedRuntime({ userDataDir, version, architecture: buildArchitecture(entry, settings, userDataDir) }); }
  catch (error) { reason = error.message; }
  return {version,ready:Boolean(install),install,reason:install?null:reason || `MKXP-Z ${version} is not installed.`,
    installOptions:{sectionId:"default"}};
}

function newestInstalled(installed) {
  return [...installed].filter(item => item.ready !== false && item.status !== "damaged" && !item.error)
    .sort((a, b) => Core.compareVersionsDesc(String(a.version), String(b.version)) || String(a.installDir || "").localeCompare(String(b.installDir || "")))[0] || null;
}

function loadUpstream(userDataDir) {
  if (!userDataDir || loadedUpstreamDir === userDataDir) return;
  loadedUpstreamDir = userDataDir;
  catalogEntries = [];
  catalog = { status: "idle", versions: [], fetchedAt: null, source: null, error: null, mode: null };
  const cached = readRuntimeCatalog({ userDataDir, managerId: "mkxpz", sourceId: "upstream", validateEntry: item =>
    typeof item?.version === "string" && /^[A-Za-z0-9._-]+$/.test(item.version) && Number.isSafeInteger(item.artifactId) && item.artifactId > 0 &&
    typeof item.file?.url === "string" });
  if (cached?.source === UPSTREAM_SOURCE) {
    catalogEntries = cached.entries;
    catalog = { status: "success", versions: catalogEntries.map(item => item.version), source: UPSTREAM_SOURCE,
      fetchedAt: cached.fetchedAt, mode: cached.sourceStates?.upstream?.mode || null, error: null };
  }
}
function saveUpstream(userDataDir) {
  if (userDataDir) writeRuntimeCatalog({ userDataDir, managerId: "mkxpz", sourceId: "upstream", entries: catalogEntries,
    source: UPSTREAM_SOURCE, fetchedAt: catalog.fetchedAt,
    sourceStates: { upstream: { status: "success", fetchedAt: catalog.fetchedAt, error: null, mode: catalog.mode } } });
}
async function refreshCatalog({ userDataDir, logger, force, latestOnly, signal, sourceId } = {}) {
  if (sourceId === "default") sourceId = "builds";
  if (sourceId != null && !["builds", "upstream"].includes(sourceId)) throw new Error("This MKXP-Z download source is unavailable.");
  loadUpstream(userDataDir);
  if (sourceId == null) {
    const results = await Promise.allSettled([refreshCatalog({ userDataDir, logger, force, latestOnly, signal, sourceId: "builds" }),
      refreshCatalog({ userDataDir, logger, force, latestOnly, signal, sourceId: "upstream" })]);
    if (results.every(result => result.status === "rejected")) throw results[0].reason;
  } else if (sourceId === "builds") {
    await Builds.manager.refreshCatalog({ userDataDir, logger, force, signal, sourceId: "builds" });
  } else await refreshUpstream({ userDataDir, logger, force, latestOnly, signal });
  return getState({ userDataDir }).catalog;
}
async function refreshUpstream({ userDataDir, logger, force, latestOnly, signal }) {
  const wantsLatest = latestOnly !== false, mode = wantsLatest ? "latest" : "all";
  if (!force && catalog.status === "success" && catalog.mode === mode && catalog.fetchedAt && Date.now() - catalog.fetchedAt < 6 * 3600000) return;
  if (catalogPromise) {
    if (catalog.mode === mode) return catalogPromise;
    await catalogPromise.catch(() => {});
    throwIfAborted(signal);
    return refreshUpstream({ userDataDir, logger, force, latestOnly, signal });
  }
  const previous = catalog;
  catalog = { ...previous, status: "loading", error: null, mode };
  catalogPromise = (async () => {
    try {
      const result = wantsLatest ? await Core.fetchLatestAvailableVersions({ logger, signal }) : await Core.fetchAvailableVersions({ logger, signal });
      throwIfAborted(signal);
      catalogEntries = (result.entries || []).map(item => ({ ...item }));
      catalog = { status: "success", versions: catalogEntries.map(item => item.version), source: UPSTREAM_SOURCE,
        fetchedAt: Date.now(), error: null, mode };
      saveUpstream(userDataDir);
    } catch (error) {
      catalog = { ...previous, status: "error", error: String(error.message || error) };
      throw error;
    } finally { catalogPromise = null; }
  })();
  return catalogPromise;
}

function getState({ settings, userDataDir } = {}) {
  loadUpstream(userDataDir);
  const cfg = normalizeSettings(settings);
  const hostedState = Builds.manager.getState({ userDataDir });
  const hosted = hostedState.catalog;
  const upstreamVersions = catalogEntries.map(entry => entry.version);
  const installed = userDataDir ? Core.listInstalled(userDataDir) : [];
  const latestInstalled = newestInstalled(installed);
  // Each CPU's list joins that CPU's MacLauncher Builds packages with the
  // upstream downloads, which name no CPU.
  function catalogFor(hostedCatalog, architecture) {
    const available = [...new Set([...upstreamVersions, ...(hostedCatalog.versions || [])])].sort(Core.compareVersionsDesc);
    const installedVersions = new Set(installed.filter(item => !architecture || !item.architecture || item.architecture === "universal" ||
      item.architecture === architecture).map(item => item.version));
    const installableVersions = available.filter(version => !installedVersions.has(version));
    const versionRequirements = { ...(hostedCatalog.versionRequirements || {}) };
    for (const version of upstreamVersions) versionRequirements[version] ||= { available: true, requiresDownload: true };
    const list = {
      status: catalog.status === "idle" ? hostedCatalog.status : catalog.status,
      versions: available,
      fetchedAt: catalog.fetchedAt || hostedCatalog.fetchedAt,
      source: "https://procrastinine.github.io/maclauncher-builds/#mkxpz",
      error: catalog.error || hostedCatalog.error,
      mode: catalog.mode,
      includedVersions: [], installableVersions, versionRequirements,
      installable: installableVersions.length > 0,
      supportsLatestOnly: true,
      latestAvailableVersion: available[0] || null,
      latestInstalledVersion: latestInstalled?.version || null,
      updateAvailable: Boolean(available[0] && cfg.defaultVersion && Core.compareVersions(available[0], cfg.defaultVersion) > 0),
      versionLabels: buildVersionLabels([...installed.map(item => item.version), cfg.defaultVersion, ...available].filter(Boolean)),
      ...(architecture ? { architecture } : {})
    };
    list.sources = [sourceCatalog(list, { id: "builds", label: "MacLauncher Builds",
      source: "https://procrastinine.github.io/maclauncher-builds/#mkxpz", versions: hostedCatalog.versions || [],
      state: hostedCatalog.sources?.find(item => item.id === "builds") || hostedCatalog }),
      sourceCatalog(list, { id: "upstream", label: "Upstream GitHub Actions",
        source: UPSTREAM_SOURCE, versions: upstreamVersions, state: catalog })];
    list.sources[1].installReason = upstreamVersions.length ? null : "No macOS build from GitHub Actions is listed.";
    return list;
  }
  const lists = Object.fromEntries(Object.entries(hosted.architectureCatalogs || {}).map(([architecture, list]) => [architecture, catalogFor(list, architecture)]));
  const main = { ...catalogFor(hosted, hosted.architecture), ...(Object.keys(lists).length ? { architectureCatalogs: lists } : {}) };
  const defaultVersion = selectRuntimeVersion({ defaultVersion: cfg.defaultVersion, fallback: managerDefaultVersion({
    listed: main.versions.filter(version => !main.versionRequirements[version]?.installReason),
    installed: [...installed].filter(row => row.ready !== false && !row.error).sort((a, b) => Core.compareVersionsDesc(a.version, b.version)).map(row => row.version) }) }).version;
  const base = {
    supportsDefault: true,
    ...cfg, defaultVersion, defaultSource: cfg.defaultVersion ? "saved" : "manager",
    ...(hostedState.launcherArchitecture ? { launcherArchitecture: hostedState.launcherArchitecture,
      automaticArchitecture: hostedState.automaticArchitecture, defaultArchitecture: cfg.defaultArchitecture || hostedState.automaticArchitecture } : {}),
    installed,
    installing: null,
    versionLabels: main.versionLabels,
    notice: MKXPZ_NOTICE,
    catalog: main
  };
  return {
    ...base,
    variants: VARIANTS,
    sections: [
      {
        id: "default",
        label: "MKXP-Z versions",
        ...base,
        variants: VARIANTS
      }
    ]
  };
}

async function installRuntime(options = {}) {
  const { userDataDir, version, logger, onProgress, downloads, rtpPack, signal } = options;
  loadUpstream(userDataDir);
  if (rtpPack) {
    const pack = Rtp.packFor(rtpPack);
    if (version !== pack.installVersion) throw new Error("The selected RTP download version is invalid.");
    const meta = buildRuntimeDownloadMeta({ label: pack.label, managerId: "mkxpz", sectionId: "rtp", version: pack.version, kind: "asset" });
    return runDownloadTask(downloads, meta, async ({ signal: taskSignal, onProgress: progress }) => {
      const controller = new AbortController(), abort = () => controller.abort();
      const signals = [taskSignal, signal].filter(Boolean);
      for (const input of signals) { input.addEventListener("abort", abort, { once: true }); if (input.aborted) abort(); }
      try { return { ...await Rtp.installPack({ ...options, userDataDir, id: rtpPack, version, signal: controller.signal, onProgress: progress }), rtpPack }; }
      finally { for (const input of signals) input.removeEventListener("abort", abort); }
    }, { onProgress });
  }
  if (!version) {
    // Consented Play discovers the catalog before using the existing selection path.
    await refreshCatalog({ userDataDir, logger, signal, force: true });
    const selected = resolveSelection(null, options.settings, userDataDir);
    if (!selected.version) throw new Error(selected.reason);
    return installRuntime({ ...options, version: selected.version });
  }
  const v = Core.normalizeVersion(version);
  // A Builds package installs for the explicit build choice or the one Play uses.
  const architecture = Architecture.requestedArchitecture(options) || buildArchitecture(null, options.settings, userDataDir);
  if (!catalogEntries.some(entry => entry.version === v) && !Builds.manager.core.listCatalog({ userDataDir }).some(entry => entry.version === v)) {
    await Builds.manager.refreshCatalog({ userDataDir, logger, signal, force: true });
  }
  const meta = buildRuntimeDownloadMeta({
    label: "MKXP-Z",
    managerId: "mkxpz",
    sectionId: "default",
    version: v
  });
  return runDownloadTask(
    downloads,
    meta,
    async ({ signal: taskSignal, onProgress: progress }) => {
      const activeSignal = signal && taskSignal ? AbortSignal.any([signal, taskSignal]) : signal || taskSignal || undefined;
      throwIfAborted(activeSignal);
      const owned = Core.resolveOwnedRuntime({ userDataDir, version: v, architecture });
      if (owned) return owned;
      const hosted = Builds.manager.core.listCatalog({ userDataDir }).some(entry => entry.version === v);
      if (hosted) {
        await Builds.manager.installRuntime({ userDataDir, version: v, architecture, logger, signal: activeSignal, onProgress: progress });
        return Builds.resolveOwned({ userDataDir, version: v, architecture });
      }
      let entry = catalogEntries.find(item => item.version === v) || null;
      if (!entry) {
        await refreshCatalog({ userDataDir, logger, signal: activeSignal, force: true, latestOnly: false, sourceId: "upstream" });
        entry = catalogEntries.find(item => item.version === v) || null;
      }
      if (!entry) throw new Error(`MKXP-Z build not found for version ${v}`);
      return Core.installFromActions({ userDataDir, entry, logger, signal: activeSignal, onProgress: progress });
    },
    { onProgress }
  );
}

function uninstallRuntime({ userDataDir, version, installDir }) {
  return Core.uninstallVersion({ userDataDir, version, installDir });
}

function updateSettingsAfterInstall(settings, installed, options = {}) {
  if (installed?.rtpPack || options.rtpPack || normalizeSettings(settings).defaultVersion) return;
  return { ...settings, defaultVersion: installed.version };
}
function updateSettingsAfterUninstall() {}

module.exports = {
  id: "mkxpz",
  label: "MKXP-Z",
  distributionRequired: false,
  delivery: Object.freeze({ included: "none", catalog: "remote", sourceBuild: false }),
  upstream: Core.source,
  normalizeSettings,
  selectedVersion,
  buildArchitecture,
  resolveSelection,
  applySettingsUpdate,
  refreshCatalog,
  getState,
  installRuntime,
  uninstallRuntime,
  trashFirst: true,
  updateSettingsAfterInstall,
  updateSettingsAfterUninstall,
  core: Core
};
Custom.configure(module.exports, { defaultsPath: () => ["defaultVersion"],
  providers: [{ core: Core, lists: { listInstalled: "default" }, resolves: { resolveOwnedRuntime: "default" },
    versions: ["normalizeVersion"], directories: ["getInstallDir"] }], inspect(runtimePath) {
  let appPath = fs.statSync(runtimePath).isDirectory() ? runtimePath : path.dirname(runtimePath);
  for (let depth = 0; depth < 7 && !appPath.toLowerCase().endsWith(".app"); depth += 1) {
    const apps = fs.statSync(appPath).isDirectory() ? fs.readdirSync(appPath).filter(name => name.toLowerCase().endsWith(".app")) : [];
    if (apps.length === 1) { appPath = path.join(appPath, apps[0]); break; }
    appPath = path.dirname(appPath);
  }
  if (!appPath.toLowerCase().endsWith(".app")) throw new Error("Select a complete MKXP-Z application or an executable inside that application.");
  const install = Custom.inspectExecutable(appPath);
  return { ...install, appPath, resourceRoot: path.dirname(appPath), runtimeVersion: require("../../shared/runtime/app-bundle").readAppBundleVersion(appPath) };
} });
