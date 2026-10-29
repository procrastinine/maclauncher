const { selectRuntimeVersion, managerDefaultVersion } = require("../../shared/runtime/version-choices");
const { compareVersions, newest } = require("../../shared/runtime/version-order");
const Core = require("./sdk-manager");
const Custom = require("../../shared/runtime/custom-runtime");
const Live2D = require("../live2d");
const { runDownloadTask } = require("../../shared/runtime/download-manager");
const { buildRuntimeDownloadMeta } = require("../../shared/runtime/runtime-downloads");

const catalogPromise = { v7: null, v8: null };
const catalogPromiseMode = { v7: null, v8: null };
const catalog = {
  v7: {
    status: "idle",
    versions: [],
    fetchedAt: null,
    source: null,
    error: null,
    latestStableVersion: null
  },
  v8: {
    status: "idle",
    versions: [],
    fetchedAt: null,
    source: null,
    error: null,
    latestStableVersion: null
  }
};

function normalizeSettings(input) {
  return { v7: { defaultVersion: typeof input?.v7?.defaultVersion === "string" && input.v7.defaultVersion.trim() !== "auto" ? input.v7.defaultVersion.trim() || null : null },
    v8: { defaultVersion: typeof input?.v8?.defaultVersion === "string" && input.v8.defaultVersion.trim() !== "auto" ? input.v8.defaultVersion.trim() || null : null } };
}

function keyForMajor(major) {
  const m = Core.normalizeMajor(major);
  return m === 7 ? "v7" : "v8";
}

function resolveMajorPayload(payload) {
  const direct = payload?.major;
  if (direct !== null && direct !== undefined && direct !== "") {
    const numeric = Number(direct);
    if (Number.isFinite(numeric)) {
      try {
        return Core.normalizeMajor(numeric);
      } catch {}
    }
  }
  const section = String(payload?.sectionId || payload?.section || "").toLowerCase();
  if (section === "v7") return 7;
  if (section === "v8") return 8;
  return null;
}

async function refreshCatalog({ logger, force, major, sectionId, section, latestOnly } = {}) {
  const resolvedMajor = resolveMajorPayload({ major, sectionId, section });
  if (!resolvedMajor) throw new Error("Missing runtime major");
  const key = keyForMajor(resolvedMajor);
  const ttlMs = 1000 * 60 * 60 * 6;
  const now = Date.now();
  const existing = catalog[key];
  const mode = latestOnly === true ? "latest" : "all";
  if (!force && existing.status === "success" && existing.mode === mode &&
      existing.fetchedAt && now - existing.fetchedAt < ttlMs) return existing;
  if (catalogPromise[key]) {
    if (catalogPromiseMode[key] === mode) return catalogPromise[key];
    await catalogPromise[key].catch(() => {});
    return refreshCatalog({ logger, force, major: resolvedMajor, latestOnly });
  }

  catalog[key] = { ...existing, status: "loading", error: null };

  catalogPromiseMode[key] = mode;
  catalogPromise[key] = (async () => {
    try {
      const res = await Core.fetchAvailableVersions({
        logger,
        major: Core.normalizeMajor(resolvedMajor),
        latestOnly: latestOnly === true
      });
      catalog[key] = {
        status: "success",
        versions: res.versions || [],
        fetchedAt: Date.now(),
        source: res.source || null,
        mode,
        error: null,
        latestStableVersion: res.latestStableVersion || null
      };
      return catalog[key];
    } catch (e) {
      catalog[key] = {
        ...existing, status: "error",
        error: String(e?.message || e)
      };
      throw e;
    } finally {
      catalogPromise[key] = null;
      catalogPromiseMode[key] = null;
    }
  })();

  return catalogPromise[key];
}

function getState({ settings, userDataDir }) {
  const cfg = normalizeSettings(settings);
  const buildFor = (major, key) => {
    const installed = Core.listInstalled(userDataDir, major).map(install => ({ ...install, ...Live2D.describeSdk(install) }));
    const latestInstalled = newest(installed.filter(row => row.ready !== false));
    const details = catalog[key] || {};
    const latestAvailable =
      details.latestStableVersion ||
      (Array.isArray(details.versions) ? details.versions[0] : null);
    const defaultVersion = selectRuntimeVersion({ defaultVersion: cfg?.[key]?.defaultVersion, fallback: managerDefaultVersion({
      listed: [...new Set([details.latestStableVersion, ...details.versions || []].filter(Boolean))], installed: latestInstalled ? [latestInstalled.version] : [] }) }).version;
    return {
      supportsDefault: true,
      defaultVersion,
      defaultSource: cfg?.[key]?.defaultVersion ? "saved" : "manager",
      installed,
      installing: null,
      catalog: {
        status: details.status,
        versions: details.versions,
        latestStableVersion: details.latestStableVersion || null,
        fetchedAt: details.fetchedAt,
        source: details.source || "https://www.renpy.org/dl/",
        error: details.error,
        mode: details.mode || null,
        supportsLatestOnly: false,
        latestAvailableVersion: latestAvailable,
        latestInstalledVersion: latestInstalled?.version || null,
        updateAvailable:
          latestAvailable && latestInstalled?.version
            ? compareVersions(String(latestAvailable), String(latestInstalled.version)) > 0
            : false
      }
    };
  };
  const v7 = buildFor(7, "v7");
  const v8 = buildFor(8, "v8");
  return {
    v7,
    v8,
    sections: [
      { id: "v8", label: "Ren'Py 8", ...v8 },
      { id: "v7", label: "Ren'Py (Python 2)", ...v7 }
    ]
  };
}

async function installRuntime({
  userDataDir,
  major,
  sectionId,
  section,
  version,
  logger,
  onProgress,
  downloads,
  signal: callerSignal
}) {
  const resolvedMajor = resolveMajorPayload({ major, sectionId, section });
  if (!resolvedMajor) throw new Error("Missing runtime major");
  const key = keyForMajor(resolvedMajor);
  if (!version || version === "auto") {
    if (!catalog[key].versions.length) await refreshCatalog({ major: resolvedMajor, logger, force: true, latestOnly: false });
    version = catalog[key].latestStableVersion || catalog[key].versions[0] || null;
    if (!version) throw new Error(`No Ren'Py ${resolvedMajor} SDK version is available.`);
  }
  const v = Core.normalizeVersion(version);
  const m = Core.normalizeMajor(resolvedMajor);
  const meta = buildRuntimeDownloadMeta({
    label: "Ren'Py",
    managerId: "sdk",
    sectionId: key,
    version: v
  });
  return runDownloadTask(
    downloads,
    meta,
    ({ signal: taskSignal, onProgress: taskProgress }) =>
      Core.installVersion({
        userDataDir,
        major: m,
        version: v,
        logger,
        onProgress: taskProgress,
        signal: callerSignal && taskSignal ? AbortSignal.any([callerSignal, taskSignal]) : callerSignal || taskSignal
      }),
    { onProgress }
  );
}

function uninstallRuntime({ userDataDir, major, sectionId, section, version }) {
  const resolvedMajor = resolveMajorPayload({ major, sectionId, section });
  if (!resolvedMajor) throw new Error("Missing runtime major");
  return Core.uninstallVersion({ userDataDir, major: resolvedMajor, version });
}

async function performInstalledAction(payload = {}) {
  const major = resolveMajorPayload(payload);
  if (!major) throw new Error("Select a Ren'Py 7 or 8 SDK section.");
  const version = Core.normalizeVersion(payload.version);
  const install = Core.listInstalled(payload.userDataDir, major).find(item => item.version === version);
  if (!install) throw new Error(`Ren'Py ${version} is not installed in this SDK section.`);
  return Live2D.performSdkAction(install, payload);
}

function updateSettingsAfterInstall(settings, installed, payload) {
  const next = normalizeSettings(settings), key = payload?.sectionId || (Number(payload?.major || installed?.major) === 7 ? "v7" : "v8");
  if (!installed?.version || !next[key] || next[key].defaultVersion) return settings;
  next[key].defaultVersion = installed.version;
  return next;
}

function updateSettingsAfterUninstall(settings) { return settings; }

module.exports = Custom.configure({
  id: "sdk",
  label: "Ren'Py",
  // Newer SDKs of a major line run that line's older games.
  installSetsDefault: true,
  normalizeSettings,
  applySettingsUpdate: (action, payload, settings) => {
    if (action !== "setDefault") return settings;
    const key = keyForMajor(resolveMajorPayload(payload));
    return { ...normalizeSettings(settings), [key]: { defaultVersion: payload?.version && payload.version !== "auto" ? String(payload.version).trim() || null : null } };
  },
  refreshCatalog,
  getState,
  installRuntime,
  uninstallRuntime,
  performInstalledAction,
  updateSettingsAfterInstall,
  updateSettingsAfterUninstall,
  core: Core
}, { inspect: require("./custom-sdk").inspect,
  defaultsPath: sectionId => [sectionId, "defaultVersion"],
  providers: [{ core: Core, lists: { listInstalled: ({ args }) => Number(args[1]) === 7 ? "v7" : "v8" },
    versions: ["normalizeVersion"], directories: ["getInstallDir"] }],
  sectionForEntry: entry => Number(entry?.runtimeData?.sdk?.major || entry?.moduleData?.major) === 7 ? "v7" : "v8" });
