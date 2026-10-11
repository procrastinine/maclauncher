const fs = require("node:fs");
const path = require("node:path");
const { createPinnedNativeManager } = require("../../shared/runtime/pinned-native-manager");
const { createBundledNativeRuntime } = require("../../shared/runtime/bundled-native");
const Github = require("../../shared/runtime/github-releases");
const Build = require("./build");
const LEGACY_PROFILE = "26.10-net8-arm64-v1";

function createManager({ dependencies = {} } = {}) {
  const manager = createPinnedNativeManager({
    id: "fna", label: "FNA native host", sourceUrl: "https://github.com/FNA-XNA/FNA/tags",
    bundledExecution: "direct",
    recommendedVersion: Build.PROFILE,
    catalog: [{ version: Build.PROFILE, upstreamRevision: Build.FNA_REVISION, hostArchitectures: ["arm64"],
      architecture: "arm64", label: "FNA 26.10 · .NET 8.0.31 · Apple Silicon", sourceUrl: "https://github.com/FNA-XNA/FNA/tree/26.10",
      asset: { filename: "dotnet-runtime-8.0.31-osx-arm64.tar.gz",
        url: "https://builds.dotnet.microsoft.com/dotnet/Runtime/8.0.31/dotnet-runtime-8.0.31-osx-arm64.tar.gz",
        sha256: "278d93091093a5b9a8e5d8466bf31183fdc12a7af86c41afa2865f4e4c6c07eb" } },
      { version: LEGACY_PROFILE, upstreamRevision: Build.FNA_REVISION, architecture: "arm64", hostArchitectures: ["arm64"],
        deprecated: true, localBuild: false,
        installReason: "FNA host v1 lacks shader resources. Select FNA 26.10 host v2 for graphics." }],
    resolveExecutable: root => path.join(root, "dotnet"),
    prepareInstall: options => Build.prepareRuntime({ ...options, dependencies: dependencies.build || {} }),
    dependencies: dependencies.manager || {},
    bundledRuntime: createBundledNativeRuntime({ managerId: "fna", ...(dependencies.bundle || {}) }),
    discoverCatalog: async ({ signal, logger }) => {
      logger?.info?.("[fna] fetching monthly source versions");
      const tags = await Github.fetchGithubTags({ owner: "FNA-XNA", repo: "FNA", signal });
      return tags.filter(tag => /^\d{2}\.\d{2}$/.test(tag.name)).map(tag => ({
        version: `${tag.name}-net8-arm64-v2`, upstreamRevision: tag.commit.sha,
        architecture: "arm64", hostArchitectures: ["arm64"], sourceUrl: `https://github.com/FNA-XNA/FNA/tree/${tag.name}`,
        label: `FNA ${tag.name} source`, localBuild: false,
        installReason: "No Mac host is available for this source version. FNA 26.10 supports Apple Silicon."
      }));
    }
  });
  const baseNormalize = manager.normalizeSettings;
  manager.normalizeSettings = settings => {
    const normalized = baseNormalize(settings);
    return normalized.defaultVersion === LEGACY_PROFILE ? { ...normalized, defaultVersion: Build.PROFILE } : normalized;
  };
  const baseResolve = manager.resolveSelection;
  manager.resolveSelection = (...args) => {
    let result = baseResolve(...args);
    if (result.version === LEGACY_PROFILE) {
      const [entry, settings, userDataDir] = args;
      result = { ...baseResolve({ ...entry, runtimeData: { ...entry?.runtimeData,
        fna: { ...entry?.runtimeData?.fna, version: Build.PROFILE } } }, settings, userDataDir),
        upgradedFromVersion: LEGACY_PROFILE };
    }
    if (!result.ready) return result;
    try { return { ...result, profile: Build.verifyRuntime(result.install) }; }
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
    try { Build.verifyRuntime(install); } catch (failure) { error = String(failure.message || failure); }
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
    return { ...state, installed, sections: state.sections.map(section => ({ ...section, installed })), catalog: { ...state.catalog, supportsLatestOnly: false,
      installableVersions: process.platform === "darwin" && process.arch === "arm64" && !state.catalog.includedVersions.includes(Build.PROFILE) ? [Build.PROFILE] : [],
      installLabel: "Install", installReason: state.catalog.includedVersions.includes(Build.PROFILE) ? null : "FNA 26.10 supports Apple Silicon. Source builds require Apple Command Line Tools (/Library/Developer/CommandLineTools)." } };
  };
  const baseRefresh = manager.refreshCatalog;
  manager.refreshCatalog = async options => { profileDisplayCache.clear(); return baseRefresh(options); };
  manager.verifyRuntime = Build.verifyRuntime;
  manager.distributionRequired = true;
  manager.distributionVersions = [Build.PROFILE];
  return manager;
}

module.exports = createManager();
module.exports.createManager = createManager;
