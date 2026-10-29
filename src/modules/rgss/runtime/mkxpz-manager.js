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
const { selectRuntimeVersion, managerDefaultVersion } = require("../../shared/runtime/version-choices");
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
    { text: "MacLauncher builds include Unicode filename fixes. Upstream downloads require GitHub CLI authentication." }
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
  return {defaultVersion: version && version !== "auto" ? Core.normalizeVersion(version)
    : null};
}

// Launch and preparation use the same exact version, including retained aliases.
function selectedVersion(entry, settings, userDataDir) {
  return resolveSelection(entry, settings, userDataDir).version;
}

function resolveSelection(entry, settings, userDataDir) {
  const state = getState({ userDataDir, settings: settings?.runtimes?.mkxpz });
  const chosen = selectRuntimeVersion({ manual: Custom.selectionPath(module.exports, entry, settings) || entry?.runtimeData?.mkxpz?.version,
    defaultVersion: state.defaultVersion });
  const version = chosen.version;
  if (!version) return { version: null, ready: false, install: null, discoveryRequired: true,
    reason: "No MKXP-Z versions are available to download.", installOptions: { sectionId: "default" } };
  let install = null, reason;
  try { install = Core.resolveOwnedRuntime({ userDataDir, version }); } catch (error) { reason = error.message; }
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
    typeof item?.version === "string" && /^[A-Za-z0-9._-]+$/.test(item.version) && Number.isSafeInteger(item.artifactId) && item.artifactId > 0 });
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
      if (!await Core.canUseGh({ logger })) throw new Error("Upstream GitHub Actions downloads require GitHub CLI authentication. Authenticate with gh and restart MacLauncher.");
      throwIfAborted(signal);
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
  const hosted = Builds.manager.getState({ userDataDir }).catalog;
  const upstreamVersions = catalogEntries.map(entry => entry.version);
  const available = [...new Set([...upstreamVersions, ...(hosted.versions || [])])].sort(Core.compareVersionsDesc);
  const installed = userDataDir ? Core.listInstalled(userDataDir) : [];
  const latestInstalled = newestInstalled(installed), latestAvailable = available[0] || null;
  const versionSet = new Set();
  for (const inst of installed) {
    if (inst?.version) versionSet.add(inst.version);
  }
  if (cfg.defaultVersion) versionSet.add(cfg.defaultVersion);
  if (Array.isArray(available)) {
    for (const version of available) {
      if (version) versionSet.add(version);
    }
  }
  const versionLabels = buildVersionLabels(Array.from(versionSet));
  const includedVersions = [];
  const installedVersions = new Set(installed.map(item => item.version));
  const installableVersions = available.filter(version => !installedVersions.has(version));
  const versionRequirements = { ...(hosted.versionRequirements || {}) };
  for (const version of catalogEntries.map(item => item.version)) versionRequirements[version] ||= { available: true, requiresDownload: true };
  const defaultVersion = selectRuntimeVersion({ defaultVersion: cfg.defaultVersion, fallback: managerDefaultVersion({
    listed: available.filter(version => !versionRequirements[version]?.installReason),
    installed: [...installed].filter(row => row.ready !== false && !row.error).sort((a, b) => Core.compareVersionsDesc(a.version, b.version)).map(row => row.version) }) }).version;
  const base = {
    supportsDefault: true,
    ...cfg, defaultVersion, defaultSource: cfg.defaultVersion ? "saved" : "manager",
    installed,
    installing: null,
    versionLabels,
    notice: MKXPZ_NOTICE,
    catalog: {
      status: catalog.status === "idle" ? hosted.status : catalog.status,
      versions: available,
      fetchedAt: catalog.fetchedAt || hosted.fetchedAt,
      source: "https://procrastinine.github.io/maclauncher-builds/#mkxpz",
      error: catalog.error || hosted.error,
      mode: catalog.mode,
      includedVersions, installableVersions, versionRequirements,
      installable: installableVersions.length > 0,
      supportsLatestOnly: true,
      latestAvailableVersion: latestAvailable,
      latestInstalledVersion: latestInstalled?.version || null,
      updateAvailable: Boolean(latestAvailable && cfg.defaultVersion && Core.compareVersions(latestAvailable, cfg.defaultVersion) > 0)
    }
  };
  base.catalog.versionLabels = versionLabels;
  base.catalog.sources = [sourceCatalog(base.catalog, { id: "builds", label: "MacLauncher Builds",
    source: "https://procrastinine.github.io/maclauncher-builds/#mkxpz", versions: hosted.versions || [],
    state: hosted.sources?.find(item => item.id === "builds") || hosted }),
    sourceCatalog(base.catalog, { id: "upstream", label: "Upstream GitHub Actions",
      source: UPSTREAM_SOURCE, versions: upstreamVersions, state: catalog })];
  base.catalog.sources[1].installReason = upstreamVersions.length ? null : "GitHub Actions downloads require GitHub CLI authentication and an available macOS build.";
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
      let installed = null;
      let downloadError = null;
      const owned = Core.resolveOwnedRuntime({ userDataDir, version: v });
      if (owned) return owned;
      const hosted = Builds.manager.core.listCatalog({ userDataDir }).some(entry => entry.version === v);
      if (hosted) {
        await Builds.manager.installRuntime({ userDataDir, version: v, logger, signal: activeSignal, onProgress: progress });
        return Builds.resolveOwned({ userDataDir, version: v });
      }
      const ghOk = await Core.canUseGh({ logger, required: true });

      if (ghOk) {
        let entry = catalogEntries.find(item => item.version === v) || null;
        if (!entry) {
          try {
            await refreshCatalog({ userDataDir, logger, signal: activeSignal, force: true, latestOnly: false, sourceId: "upstream" });
            entry = catalogEntries.find(item => item.version === v) || null;
          } catch (e) {
            downloadError = e;
          }
        }
        if (entry) {
          try {
            installed = await Core.installFromGh({ userDataDir, entry, logger, signal: activeSignal });
          } catch (e) {
            downloadError = e;
          }
        } else if (!downloadError) {
          downloadError = new Error(`MKXP-Z build not found for version ${v}`);
        }
      } else if (!ghOk) {
        downloadError = new Error("GitHub CLI unavailable or not authenticated.");
      }

      if (!installed) throw downloadError || new Error("The selected MKXP-Z download is unavailable.");

      return installed;
    },
    { onProgress }
  );
}

function uninstallRuntime({ userDataDir, version, installDir }) {
  return Core.uninstallVersion({ userDataDir, version, installDir });
}

function updateSettingsAfterInstall(settings, installed) {
  return normalizeSettings(settings).defaultVersion ? settings : { ...settings, defaultVersion: installed.version };
}
function updateSettingsAfterUninstall() {}

module.exports = {
  id: "mkxpz",
  label: "MKXP-Z",
  distributionRequired: false,
  delivery: Object.freeze({ included: "none", catalog: "remote", authenticatedUpdatesOptional: true, sourceBuild: false }),
  normalizeSettings,
  selectedVersion,
  resolveSelection,
  applySettingsUpdate: (action, payload, settings) => action === "setDefault" ? {...settings,...normalizeSettings({defaultVersion:payload?.version})} : settings,
  refreshCatalog,
  getState,
  installRuntime,
  uninstallRuntime,
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
