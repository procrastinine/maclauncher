const Core = require("./sdk-manager");
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

function parseSemver(v) {
  const m = String(v || "").trim().replace(/^v/i, "").match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return String(a || "").localeCompare(String(b || ""));
  for (let i = 0; i < 3; i++) {
    const d = pa[i] - pb[i];
    if (d !== 0) return d;
  }
  return 0;
}

function normalizeSettings() {
  return { v7: { defaultVersion: null }, v8: { defaultVersion: null } };
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

function newestInstalled(installed) {
  const list = Array.isArray(installed) ? installed.filter(item => item.ready !== false) : [];
  list.sort((a, b) => {
    const byVersion = compareSemver(String(b?.version || ""), String(a?.version || ""));
    if (byVersion !== 0) return byVersion;
    return String(a?.installDir || "").localeCompare(String(b?.installDir || ""));
  });
  return list[0] || null;
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
    const latestInstalled = newestInstalled(installed);
    const details = catalog[key] || {};
    const latestAvailable =
      details.latestStableVersion ||
      (Array.isArray(details.versions) ? details.versions[0] : null);
    const defaultVersion = cfg?.[key]?.defaultVersion || null;
    return {
      supportsDefault: false,
      defaultVersion,
      installed,
      installing: null,
      catalog: {
        status: details.status,
        versions: details.versions,
        fetchedAt: details.fetchedAt,
        source: details.source || "https://www.renpy.org/dl/",
        error: details.error,
        mode: details.mode || null,
        supportsLatestOnly: false,
        latestAvailableVersion: latestAvailable,
        latestInstalledVersion: latestInstalled?.version || null,
        updateAvailable:
          latestAvailable && latestInstalled?.version
            ? compareSemver(String(latestAvailable), String(latestInstalled.version)) > 0
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

function updateSettingsAfterInstall(settings) { return settings; }

function updateSettingsAfterUninstall(settings) { return settings; }

module.exports = {
  id: "sdk",
  label: "Ren'Py",
  normalizeSettings,
  applySettingsUpdate: (_action, _payload, settings) => settings,
  refreshCatalog,
  getState,
  installRuntime,
  uninstallRuntime,
  performInstalledAction,
  updateSettingsAfterInstall,
  updateSettingsAfterUninstall,
  core: Core
};
