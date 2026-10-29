const fs = require("node:fs");
const path = require("node:path");
const { createPinnedNativeManager } = require("../../shared/runtime/pinned-native-manager");
const { createBundledNativeRuntime } = require("../../shared/runtime/bundled-native");
const Github = require("../../shared/runtime/github-releases");
const Profile = require("./profile");
const Custom = require("../../shared/runtime/custom-runtime");

function createManager({ dependencies = {} } = {}) {
  const manager = createPinnedNativeManager({
    id: "fna", label: "FNA native host", sourceUrl: "https://github.com/FNA-XNA/FNA/tags",
    projectBuilds: { projectId: "fna", repository: "procrastinine/maclauncher-builds" },
    catalog: [],
    resolveExecutable: root => path.join(root, "dotnet"),
    dependencies: dependencies.manager || {},
    legacyInstalledRuntime: createBundledNativeRuntime({ managerId: "fna", ...(dependencies.bundle || {}) }),
    discoverCatalog: async ({ signal, logger }) => {
      logger?.info?.("[fna] fetching monthly source versions");
      const tags = await Github.fetchGithubTags({ owner: "FNA-XNA", repo: "FNA", signal });
      return tags.filter(tag => /^\d{2}\.\d{2}$/.test(tag.name)).map(tag => ({
        version: tag.name, upstreamRevision: tag.commit.sha,
        architecture: "arm64", hostArchitectures: ["arm64"], sourceUrl: `https://github.com/FNA-XNA/FNA/tree/${tag.name}`,
        label: `FNA ${tag.name} source`, localBuild: false,
        installReason: "Source release; Mac hosts are available from MacLauncher Builds."
      }));
    }
  });
  const baseResolve = manager.resolveSelection;
  manager.resolveSelection = (...args) => {
    const result = baseResolve(...args);
    if (!result.ready) return result;
    try { return { ...result, profile: Profile.verifyRuntime(result.install) }; }
    catch (error) { return { ...result, ready: false, reason: String(error.message || error), install: null }; }
  };
  const baseGetState = manager.getState;
  const profileDisplayCache = new Map();
  function fileIdentity(file) {
    const stat = fs.statSync(file, { bigint: true });
    if (!stat.isFile()) throw new Error("FNA runtime file is missing.");
    return [stat.dev, stat.ino, stat.size, stat.mode, stat.mtimeNs, stat.ctimeNs].join(":");
  }
  function verifyDisplayProfile(install) {
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
    try { Profile.verifyRuntime(install); } catch (failure) { error = String(failure.message || failure); }
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
  return manager;
}

module.exports = createManager();
module.exports.createManager = createManager;
