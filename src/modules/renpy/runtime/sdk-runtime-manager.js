const Core = require("./sdk-manager");

const installState = { v7: null, v8: null };
const installPromise = { v7: null, v8: null };
const catalogPromise = { v7: null, v8: null };
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

function normalizeSettings(input) {
  const src = input && typeof input === "object" ? input : {};
  const normalizeChannel = key => {
    const channel = src[key] && typeof src[key] === "object" ? src[key] : {};
    const defaultVersion =
      typeof channel.defaultVersion === "string" && channel.defaultVersion.trim()
        ? channel.defaultVersion.trim().replace(/^v/i, "")
        : null;
    return { defaultVersion };
  };
  return {
    v7: normalizeChannel("v7"),
    v8: normalizeChannel("v8")
  };
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
  const list = Array.isArray(installed) ? installed.slice() : [];
  list.sort((a, b) => {
    const byVersion = compareSemver(String(b?.version || ""), String(a?.version || ""));
    if (byVersion !== 0) return byVersion;
    return String(a?.installDir || "").localeCompare(String(b?.installDir || ""));
  });
  return list[0] || null;
}

async function refreshCatalog({ logger, force, major, sectionId, section } = {}) {
  const resolvedMajor = resolveMajorPayload({ major, sectionId, section });
  if (!resolvedMajor) throw new Error("Missing runtime major");
  const key = keyForMajor(resolvedMajor);
  const ttlMs = 1000 * 60 * 60 * 6;
  const now = Date.now();
  const existing = catalog[key];
  if (!force && existing.fetchedAt && now - existing.fetchedAt < ttlMs) return existing;
  if (catalogPromise[key]) return catalogPromise[key];

  catalog[key] = { ...existing, status: "loading", error: null };

  catalogPromise[key] = (async () => {
    try {
      const res = await Core.fetchAvailableVersions({
        logger,
        major: Core.normalizeMajor(resolvedMajor)
      });
      catalog[key] = {
        status: "success",
        versions: res.versions || [],
        fetchedAt: Date.now(),
        source: res.source || null,
        error: null,
        latestStableVersion: res.latestStableVersion || null
      };
      return catalog[key];
    } catch (e) {
      catalog[key] = {
        status: "error",
        versions: [],
        fetchedAt: Date.now(),
        source: null,
        error: String(e?.message || e),
        latestStableVersion: null
      };
      throw e;
    } finally {
      catalogPromise[key] = null;
    }
  })();

  return catalogPromise[key];
}

function getState({ settings, userDataDir }) {
  const cfg = normalizeSettings(settings);
  const buildFor = (major, key) => {
    const installed = Core.listInstalled(userDataDir, major);
    const latestInstalled = newestInstalled(installed);
    const details = catalog[key] || {};
    const latestAvailable =
      details.latestStableVersion ||
      (Array.isArray(details.versions) ? details.versions[0] : null);
    const defaultVersion = cfg?.[key]?.defaultVersion || null;
    return {
      defaultVersion,
      installed,
      installing: installState[key],
      catalog: {
        status: details.status,
        versions: details.versions,
        fetchedAt: details.fetchedAt,
        source: details.source,
        error: details.error,
        latestAvailableVersion: latestAvailable,
        latestInstalledVersion: latestInstalled?.version || null,
        updateAvailable:
          latestAvailable && defaultVersion
            ? compareSemver(String(latestAvailable), String(defaultVersion)) > 0
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
      { id: "v7", label: "Ren'Py 7", ...v7 },
      { id: "v8", label: "Ren'Py 8", ...v8 }
    ]
  };
}

async function installRuntime({ userDataDir, major, sectionId, section, version, logger, onProgress }) {
  const resolvedMajor = resolveMajorPayload({ major, sectionId, section });
  if (!resolvedMajor) throw new Error("Missing runtime major");
  const key = keyForMajor(resolvedMajor);
  if (installPromise[key]) return installPromise[key];

  const v = Core.normalizeVersion(version);
  const m = Core.normalizeMajor(resolvedMajor);

  installState[key] = {
    version: v,
    downloaded: 0,
    total: null,
    status: "downloading"
  };

  installPromise[key] = (async () => {
    let installed = null;
    try {
      installed = await Core.installVersion({
        userDataDir,
        major: m,
        version: v,
        logger,
        onProgress: p => {
          installState[key] = { ...installState[key], ...p, status: "downloading" };
          onProgress?.(installState[key]);
        }
      });
      installState[key] = null;
      return installed;
    } catch (e) {
      installState[key] = {
        version: v,
        downloaded: installState[key]?.downloaded ?? 0,
        total: installState[key]?.total ?? null,
        status: "error",
        error: String(e?.message || e)
      };
      throw e;
    } finally {
      installPromise[key] = null;
    }
  })();

  return installPromise[key];
}

function uninstallRuntime({ userDataDir, major, sectionId, section, version }) {
  const resolvedMajor = resolveMajorPayload({ major, sectionId, section });
  if (!resolvedMajor) throw new Error("Missing runtime major");
  return Core.uninstallVersion({ userDataDir, major: resolvedMajor, version });
}

function updateSettingsAfterInstall(settings, installed, payload) {
  const resolvedMajor = resolveMajorPayload(payload || {});
  const key = resolvedMajor === 7 ? "v7" : resolvedMajor === 8 ? "v8" : null;
  if (!key || !installed?.version) return settings;
  const next = settings && typeof settings === "object" ? { ...settings } : {};
  const channel = next[key] && typeof next[key] === "object" ? { ...next[key] } : {};
  const current = channel.defaultVersion || null;
  if (!current || compareSemver(installed.version, current) > 0) {
    channel.defaultVersion = installed.version;
  }
  next[key] = channel;
  return next;
}

function updateSettingsAfterUninstall(settings, payload, { userDataDir } = {}) {
  const resolvedMajor = resolveMajorPayload(payload || {});
  const key = resolvedMajor === 7 ? "v7" : resolvedMajor === 8 ? "v8" : null;
  if (!key || !userDataDir) return settings;
  const next = settings && typeof settings === "object" ? { ...settings } : {};
  const channel = next[key] && typeof next[key] === "object" ? { ...next[key] } : {};
  const installed = Core.listInstalled(userDataDir, resolvedMajor);
  const hasDefault = installed.some(i => i.version === channel.defaultVersion);
  if (hasDefault) return settings;
  const latest = newestInstalled(installed);
  channel.defaultVersion = latest?.version || null;
  next[key] = channel;
  return next;
}

module.exports = {
  id: "sdk",
  label: "Ren'Py SDK",
  normalizeSettings,
  applySettingsUpdate: (action, payload, settings) => {
    if (action !== "setDefault") return settings;
    const next = settings && typeof settings === "object" ? { ...settings } : {};
    const resolvedMajor = resolveMajorPayload(payload || {});
    const key = resolvedMajor === 7 ? "v7" : resolvedMajor === 8 ? "v8" : null;
    if (!key) return next;
    const version = payload?.version ? String(payload.version).trim().replace(/^v/i, "") : null;
    next[key] = { ...(next[key] || {}), defaultVersion: version || null };
    return next;
  },
  refreshCatalog,
  getState,
  installRuntime,
  uninstallRuntime,
  updateSettingsAfterInstall,
  updateSettingsAfterUninstall,
  core: Core
};
