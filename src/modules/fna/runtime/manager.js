const fs = require("node:fs");
const path = require("node:path");
const { createPinnedNativeManager } = require("../../shared/runtime/pinned-native-manager");
const { createBundledNativeRuntime } = require("../../shared/runtime/bundled-native");
const Profile = require("./profile");
const Custom = require("../../shared/runtime/custom-runtime");
const { managerDefaultVersion } = require("../../shared/runtime/version-choices");

function createManager({ dependencies = {} } = {}) {
  const manager = createPinnedNativeManager({
    id: "fna", label: "FNA native host", sourceUrl: "https://github.com/FNA-XNA/FNA/tags",
    projectBuilds: { projectId: "fna", repository: "procrastinine/maclauncher-builds", launcherContract: 2 },
    resolveExecutable: root => path.join(root, "dotnet"),
    dependencies: dependencies.manager || {},
    legacyInstalledRuntime: createBundledNativeRuntime({ managerId: "fna", ...(dependencies.bundle || {}) })
  });
  const baseResolve = manager.resolveSelection;
  manager.resolveSelection = (...args) => {
    const result = baseResolve(...args);
    if (!result.ready) return result;
    try { return { ...result, profile: Profile.requireOriginalGamePaths(Profile.verifyRuntime(result.install)) }; }
    catch (error) { return { ...result, ready: false, reason: String(error.message || error), install: null,
      ...(error.code === "FNA_RUNTIME_UPDATE_REQUIRED" ? {runtimeRequirement: "originalGamePaths"} : {}) }; }
  };
  const baseGetState = manager.getState;
  const profileDisplayCache = new Map();
  function fileIdentity(file) {
    const stat = fs.statSync(file, { bigint: true });
    if (!stat.isFile()) throw new Error("FNA runtime file is missing.");
    return [stat.dev, stat.ino, stat.size, stat.mode, stat.mtimeNs, stat.ctimeNs].join(":");
  }
  function verifyDisplayProfile(install) {
    if (install.source === 'download') {
      const profilePath = require("../../shared/runtime/bundled-native").resolveInstalledAsset(install, "fnaProfile") ||
        require("../../shared/runtime/bundled-native").resolveInstalledAsset(install, "profile") || path.join(path.dirname(install.executablePath), "fna-runtime.json");
      const identity = fileIdentity(profilePath), cached = profileDisplayCache.get(profilePath);
      if (cached?.identity === identity) {
        if (cached.error) throw new Error(cached.error);
        return cached.profile;
      }
      const profile = Profile.requireOriginalGamePaths(Profile.verifyRuntime(install));
      if (profileDisplayCache.size >= 32) profileDisplayCache.delete(profileDisplayCache.keys().next().value);
      profileDisplayCache.set(profilePath, {identity, profile});
      return profile;
    }
    const root = path.dirname(install.executablePath), profilePath = path.join(root, "fna-runtime.json");
    const profileIdentity = fileIdentity(profilePath);
    let cached = profileDisplayCache.get(root);
    let paths = cached?.profileIdentity === profileIdentity ? cached.paths : null;
    if (!paths) {
      if (fs.statSync(profilePath).size > 1024 * 1024) throw new Error("FNA runtime profile exceeds its size limit.");
      const record = JSON.parse(fs.readFileSync(profilePath, "utf8"));
      paths = Object.keys(record.files || {});
      if (!paths.length || paths.length > 128 || paths.some(relative => !relative || relative.includes("\\") || path.isAbsolute(relative) || relative.split("/").some(part => !part || part === "." || part === ".."))) {
        throw new Error("FNA runtime profile metadata is invalid.");
      }
    }
    const identity = JSON.stringify([install.version, install.binarySha256, install.bundledManifestSha256, profileIdentity,
      paths.map(relative => fileIdentity(path.join(root, relative)))]);
    if (cached?.identity === identity) {
      if (cached.error) throw new Error(cached.error);
      return;
    }
    // Only a cold/changed profile needs its byte hashes. Ordinary broadcasts
    // reuse this outcome; resolveSelection remains strict before every execution.
    let error = null;
    try { Profile.requireOriginalGamePaths(Profile.verifyRuntime(install)); } catch (failure) { error = String(failure.message || failure); }
    if (profileDisplayCache.size >= 32) profileDisplayCache.delete(profileDisplayCache.keys().next().value);
    profileDisplayCache.set(root, { profileIdentity, paths, identity, error });
    if (error) throw new Error(error);
  }
  manager.getState = options => {
    const state = baseGetState({ ...options, settings: manager.normalizeSettings(options?.settings) });
    const installed = state.installed.map(install => {
      if (!install.ready) return install;
      try { verifyDisplayProfile(install); return install; }
      catch (error) { return { ...install, ready: false, incomplete: true, reason: error.message }; }
    });
    const catalog = state.catalog;
    return { ...state, installed, catalog, sections: state.sections.map(section => ({ ...section, installed, catalog })) };
  };
  const baseRefresh = manager.refreshCatalog;
  manager.refreshCatalog = async options => { profileDisplayCache.clear(); return baseRefresh(options); };
  manager.verifyRuntime = Profile.verifyRuntime;
  manager.distributionRequired = false;
  Custom.configure(manager, { inspect(runtimePath, { verification } = {}) {
    const install = Custom.inspectManifest(runtimePath, { managerId: "fna", verification }) || Custom.inspectExecutable(runtimePath, { candidates: ["dotnet"] });
    const profile = Profile.verifyRuntime({ ...install, source: "custom" });
    return { ...install, profile, runtimeVersion: profile.profile, upstreamRevision: profile.upstreamRevision };
  }, selection: install => ({ profile: install.profile }) });
  const resolve = manager.resolveSelection;
  const hasCapability = pin => (pin?.capabilities?.originalGamePaths ?? pin?.projectPackage?.capabilities?.originalGamePaths) !== false;
  function compatible(pin, userDataDir, architecture) {
    const install = manager.core.resolveInstalled({userDataDir, version: pin.version, architecture});
    if (install) {
      try { Profile.requireOriginalGamePaths(Profile.verifyRuntime(install)); return true; }
      catch (error) { if (error.code === "FNA_RUNTIME_UPDATE_REQUIRED") return false; }
    }
    return hasCapability(pin);
  }
  manager.resolveSelection = (entry, settings, userDataDir, options = {}) => {
    const selected = resolve(entry, settings, userDataDir, options);
    if (selected.ready && selected.profile?.capabilities?.originalGamePaths === true) return selected;
    const pin = manager.core.listCatalog({userDataDir, architecture: selected.architecture}).find(pin => pin.version === selected.version);
    if (!selected.runtimeRequirement && (!pin || hasCapability(pin)) && !selected.ready) return selected;
    // A runtime requirement changes the effective selection, not the saved
    // game/default choice. The shared resolver still chooses CPU and version.
    const currentEntry = {...entry, runtimeData: {...entry?.runtimeData, fna: {...entry?.runtimeData?.fna, version: null}}};
    const currentSettings = {...settings, runtimes: {...settings?.runtimes,
      fna: {...settings?.runtimes?.fna, defaultVersion: null, customDefaults: {}}}};
    const current = resolve(currentEntry, currentSettings, userDataDir, {...options, version: null, recommendedVersion: null, recommended: null,
      ...(selected.architecture ? {architecture: selected.architecture} : {}),
      compatible: pin => (!options.compatible || options.compatible(pin)) && compatible(pin, userDataDir, selected.architecture)});
    return {...current, requestedVersion: selected.version, runtimeRequirement: "originalGamePaths",
      ...(!current.version ? {ready: false, requiresDownload: true, discoveryRequired: true,
        reason: "An updated FNA runtime is required to run from the original game directory."} : {})};
  };
  const getState = manager.getState;
  manager.getState = options => {
    const state = getState(options), installed = state.installed.map(install => {
      if (!install.ready) return install;
      try { verifyDisplayProfile(install); return install; }
      catch (error) { return {...install, ready: false, incomplete: true, reason: error.message}; }
    });
    const ready = new Set(installed.filter(row => row.ready).map(row => row.version));
    const updateCatalog = catalog => {
      const pins = manager.core.listCatalog({userDataDir: options?.userDataDir, architecture: catalog.architecture});
      const available = new Set(installed.filter(row => row.ready && (!catalog.architecture ||
        require("../../shared/runtime/architecture").matchesArchitecture(row, catalog.architecture))).map(row => row.version));
      const requirements = Object.fromEntries(Object.entries(catalog.versionRequirements || {}).map(([version, requirement]) => {
        const pin = pins.find(pin => pin.version === version);
        return [version, {...requirement, available: available.has(version), ...(!available.has(version) && pin && !hasCapability(pin)
          ? {installReason: "An updated FNA runtime is required to run from the original game directory."} : {})}];
      }));
      const installableVersions = (catalog.installableVersions || []).filter(version => !requirements[version]?.installReason);
      return {...catalog, versionRequirements: requirements, installableVersions, installable: installableVersions.length > 0,
        ...(catalog.architectureCatalogs ? {architectureCatalogs: Object.fromEntries(Object.entries(catalog.architectureCatalogs)
          .map(([architecture, current]) => [architecture, updateCatalog(current)]))} : {})};
    };
    const catalog = updateCatalog(state.catalog), configured = manager.normalizeSettings(options?.settings);
    const defaultVersion = configured.defaultVersion || Custom.defaultVersion({runtimes: {fna: configured}}, "fna") || managerDefaultVersion({
      listed: (catalog.versions || []).filter(version => !catalog.versionRequirements[version]?.installReason), installed: [...ready]});
    return {...state, installed, catalog, defaultVersion,
      sections: state.sections.map(section => ({...section, installed, catalog, defaultVersion}))};
  };
  return manager;
}

module.exports = createManager();
module.exports.createManager = createManager;
