const path = require("node:path");
const { createPinnedNativeManager } = require("../shared/runtime/pinned-native-manager");
const { createBundledNativeRuntime } = require("../shared/runtime/bundled-native");
const { createCatalogDiscovery } = require("./catalog");
const { buildManagedDecompiler } = require("./decompiler-build");
const profiles = require("./decompiler-profiles.json");

const managers = Object.fromEntries(profiles.map(profile => {
  const manager = createPinnedNativeManager({ id: profile.managerId, label: profile.label, supportsDefault: true,
    projectBuilds: { projectId: profile.managerId, repository: "procrastinine/maclauncher-builds" },
    recommendedVersion: profile.version, sourceUrl: `https://github.com/kichikuou/${profile.repo}/releases`,
    legacyInstalledRuntime: createBundledNativeRuntime({ managerId: profile.managerId }),
    buildRuntime: buildManagedDecompiler, buildSourcePath: path.resolve(__dirname, "../../external", profile.repo),
    buildHelpUrl: `https://github.com/kichikuou/${profile.repo}/blob/${profile.upstreamRevision}/README.md`,
    buildRequirements: "Development Build requires the exact clean source checkout, Apple Command Line Tools, CMake and Ninja. Bundled Install requires none of them.",
    discoverCatalog: createCatalogDiscovery(profile.repo),
    catalog: profile.releases.map(release => ({ ...release, toolVersion: release.toolVersion || release.version,
      ...(release.version === profile.version ? { buildProfile: "alicesoft-decompiler-cmake-v1" }
        : { localBuild: false, installReason: "Windows release only. A matching local Mac tool can be imported; the managed Mac version is available." }) })) });
  manager.distributionRequired = false;
  return [profile.managerId, manager];
}));

module.exports = { managers, profiles };
