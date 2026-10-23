const Core = require("./mkxpz-runtime-manager");
const Builds = require("./mkxpz-builds");
const { runDownloadTask } = require("../../shared/runtime/download-manager");
const { buildRuntimeDownloadMeta } = require("../../shared/runtime/runtime-downloads");
const { throwIfAborted } = require("../../shared/runtime/download-utils");
const Rtp = require("../rtp");

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
  title: "Recommended build",
  lines: [
    { text: "The MacLauncher build for Apple Silicon includes macOS filename fixes. Installed versions work offline; MacLauncher Builds downloads need no GitHub CLI or account." },
    { text: "Publisher versions remain available. Optional upstream GitHub Actions downloads require GitHub CLI authentication." }
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
  const version = typeof selected === "string" && selected.trim() && selected.trim() !== "auto"
    ? Core.normalizeVersion(selected) : DEFAULT_VERSION;
  let install, reason;
  try { install = Core.resolveOwnedRuntime({userDataDir, version}); }
  catch (error) { reason = error.message; }
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

async function refreshCatalog({ userDataDir, logger, force, latestOnly, signal } = {}) {
  const ttlMs = 1000 * 60 * 60 * 6;
  const now = Date.now();
  const wantsLatest = latestOnly !== false;
  const mode = wantsLatest ? "latest" : "all";
  if (
    !force &&
    catalog.status === "success" &&
    catalog.fetchedAt &&
    now - catalog.fetchedAt < ttlMs &&
    catalog.mode === mode
  ) {
    return catalog;
  }
  if (catalogPromise) {
    if (catalog.mode === mode) return catalogPromise;
    await catalogPromise.catch(() => {});
    return refreshCatalog({ userDataDir, logger, force, latestOnly, signal });
  }

  const previous = catalog;
  catalog = { ...catalog, status: "loading", error: null, mode };

  catalogPromise = (async () => {
    try {
      let hostedFailure;
      try { await Builds.manager.refreshCatalog({ userDataDir, logger, force, latestOnly, signal }); }
      catch (error) { throwIfAborted(signal); hostedFailure = error; }
      throwIfAborted(signal);
      const hosted = Builds.manager.getState({ userDataDir }).catalog;
      const ghOk = await Core.canUseGh({ logger });
      let res = { versions: [], entries: [] }, actionsAvailable = false;
      if (ghOk) try {
        res = wantsLatest ? await Core.fetchLatestAvailableVersions({ logger }) : await Core.fetchAvailableVersions({ logger });
        actionsAvailable = true;
      } catch (error) {
        throwIfAborted(signal);
        if (hostedFailure) throw hostedFailure;
        logger?.warn?.("[mkxpz] Optional GitHub Actions catalog is unavailable.");
      }
      if (hostedFailure && !res.versions?.length) throw hostedFailure;
      throwIfAborted(signal);
      catalogEntries = (res.entries || []).map(entry => ({ ...entry }));
      catalog = {
        status: "success",
        versions: [...new Set([...(res.versions || []), ...(hosted.versions || [])])].sort(Core.compareVersionsDesc),
        fetchedAt: Date.now(),
        source: [!hostedFailure && "MacLauncher Builds", actionsAvailable && "GitHub Actions"].filter(Boolean).join(" and "),
        error: null,
        mode
      };
      return catalog;
    } catch (e) {
      catalog = {
        ...previous, status: "error",
        error: String(e?.message || e)
      };
      throw e;
    } finally {
      catalogPromise = null;
    }
  })();

  return catalogPromise;
}

function getState({ settings, userDataDir } = {}) {
  const cfg = normalizeSettings(settings);
  const hosted = Builds.manager.getState({ userDataDir }).catalog;
  const available = [...new Set([...(catalog.versions || []), ...(hosted.versions || [])])].sort(Core.compareVersionsDesc);
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
      source: catalog.source || hosted.source,
      error: catalog.error || hosted.error,
      mode: catalog.mode,
      includedVersions, installableVersions, versionRequirements,
      installable: installableVersions.length > 0,
      recommendedVersion: DEFAULT_VERSION,
      supportsLatestOnly: true,
      latestAvailableVersion: latestAvailable,
      latestInstalledVersion: latestInstalled?.version || null,
      updateAvailable:
        latestAvailable && cfg?.defaultVersion
          ? Core.compareVersions(String(latestAvailable), String(cfg.defaultVersion)) > 0
          : false
    }
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

async function installRuntime({ userDataDir, version, logger, onProgress, downloads, rtpPack, signal }) {
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
            const res = await Core.fetchAvailableVersions({ logger });
            catalogEntries = (res.entries || []).map(item => ({ ...item }));
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
