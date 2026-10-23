const Core = require("./mkxpz-runtime-manager");
const Builds = require("./mkxpz-builds");
const { runDownloadTask } = require("../../shared/runtime/download-manager");
const { buildRuntimeDownloadMeta } = require("../../shared/runtime/runtime-downloads");
const { throwIfAborted } = require("../../shared/runtime/download-utils");
const Rtp = require("../rtp");
const { sourceCatalog } = require("../../shared/runtime/runtime-sources");
const { readRuntimeCatalog, writeRuntimeCatalog } = require("../../shared/runtime/runtime-catalog");
const UPSTREAM_SOURCE = "https://github.com/mkxp-z/mkxp-z/actions";
const loadedUpstream = new Set();

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

const DEFAULT_VERSION = Core.DEFAULT_VERSION;
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

function normalizeSettings() {
  return { defaultVersion: DEFAULT_VERSION };
}

function resolveSelection(entry, _settings, userDataDir) {
  const selected = entry?.runtimeData?.mkxpz?.version;
  const explicit = typeof selected === "string" && selected.trim() && selected.trim() !== "auto";
  let version = explicit ? Core.normalizeVersion(selected) : DEFAULT_VERSION;
  let install, reason;
  try { install = Core.resolveOwnedRuntime({userDataDir, version}); }
  catch (error) { reason = error.message; }
  if (!explicit && !install) {
    const previous = Core.catalog.find(pin => pin.version === DEFAULT_VERSION)?.sourceArtifact?.directoryRelative
      ?.split("/").pop()?.replace(/-source\.tar\.gz$/, "");
    if (previous && previous !== version) try {
      install = Core.resolveOwnedRuntime({ userDataDir, version: previous });
      if (install) version = previous;
    } catch {}
  }
  return { version, ready: Boolean(install), install: install || null, ...(reason && !install ? {reason} : {}),
    installOptions: {sectionId: "default"} };
}

function newestInstalled(installed) {
  const list = Array.isArray(installed) ? installed.slice() : [];
  list.sort((a, b) => {
    const byVersion = Core.compareVersionsDesc(String(a?.version || ""), String(b?.version || ""));
    if (byVersion !== 0) return byVersion;
    return String(a?.installDir || "").localeCompare(String(b?.installDir || ""));
  });
  return list[0] || null;
}

function loadUpstream(userDataDir) {
  if (!userDataDir || loadedUpstream.has(userDataDir)) return;
  const cached = readRuntimeCatalog({ userDataDir, managerId: "mkxpz", sourceId: "upstream", validateEntry: item =>
    typeof item?.version === "string" && /^[A-Za-z0-9._-]+$/.test(item.version) && Number.isSafeInteger(item.artifactId) && item.artifactId > 0 });
  if (cached?.source === UPSTREAM_SOURCE) {
    catalogEntries = cached.entries;
    catalog = { status: "success", versions: catalogEntries.map(item => item.version), source: UPSTREAM_SOURCE,
      fetchedAt: cached.fetchedAt, mode: cached.sourceStates?.upstream?.mode || null, error: null };
  }
  loadedUpstream.add(userDataDir);
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
  const latestInstalled = newestInstalled(installed);
  const latestAvailable = available[0] || null;
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
  const base = {
    supportsDefault: false,
    ...cfg,
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
      recommendedVersion: available.includes(DEFAULT_VERSION) ? DEFAULT_VERSION : null,
      supportsLatestOnly: true,
      latestAvailableVersion: latestAvailable,
      latestInstalledVersion: latestInstalled?.version || null,
      updateAvailable:
        latestAvailable && cfg?.defaultVersion
          ? Core.compareVersions(String(latestAvailable), String(cfg.defaultVersion)) > 0
          : false
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

async function installRuntime({ userDataDir, version, logger, onProgress, downloads, rtpPack, signal }) {
  loadUpstream(userDataDir);
  if (rtpPack) {
    const pack = Rtp.packFor(rtpPack);
    if (version !== pack.installVersion) throw new Error("The selected RTP download version is invalid.");
    const meta = buildRuntimeDownloadMeta({ label: pack.label, managerId: "mkxpz", sectionId: "rtp", version: pack.version, kind: "asset" });
    return runDownloadTask(downloads, meta, async ({ signal: taskSignal, onProgress: progress }) => {
      const controller = new AbortController(), abort = () => controller.abort();
      const signals = [taskSignal, signal].filter(Boolean);
      for (const input of signals) { input.addEventListener("abort", abort, { once: true }); if (input.aborted) abort(); }
      try { return { ...await Rtp.installPack({ userDataDir, id: rtpPack, version, signal: controller.signal, onProgress: progress }), rtpPack }; }
      finally { for (const input of signals) input.removeEventListener("abort", abort); }
    }, { onProgress });
  }
  const v = Core.normalizeVersion(version);
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
      const hosted = Core.catalog.some(pin => pin.version === v) || Builds.manager.core.listCatalog({ userDataDir }).some(entry => entry.version === v);
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

function updateSettingsAfterInstall() {}
function updateSettingsAfterUninstall() {}

module.exports = {
  id: "mkxpz",
  label: "MKXP-Z",
  distributionRequired: false,
  delivery: Object.freeze({ included: "none", catalog: "remote", authenticatedUpdatesOptional: true, sourceBuild: false }),
  normalizeSettings,
  resolveSelection,
  applySettingsUpdate: (_action, _payload, settings) => settings,
  refreshCatalog,
  getState,
  installRuntime,
  uninstallRuntime,
  updateSettingsAfterInstall,
  updateSettingsAfterUninstall,
  core: Core
};
