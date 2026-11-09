const path = require("node:path");
const { createPinnedNativeManager } = require("../../shared/runtime/pinned-native-manager");
const { createBundledNativeRuntime } = require("../../shared/runtime/bundled-native");

const SOURCE_URL = "https://github.com/CommitteeOfZero/impacto/releases";

function createManager({ resourceRoot, dependencies = {} } = {}) {
  const bundledRuntime = createBundledNativeRuntime({ managerId: "impacto", resourceRoot,
    ...(dependencies.bundled ? { dependencies: dependencies.bundled } : {}) });
  const manager = createPinnedNativeManager({
    // The Windows ABIs a package declares, not the Impacto package version, select the Lua adapter profile.
    versionCompatibility: () => true,
     id: "impacto", label: "Impacto", maxEntries: 1000,
    projectBuilds: { projectId: "impacto", repository: "procrastinine/maclauncher-builds" },
    sourceUrl: SOURCE_URL, legacyInstalledRuntime: bundledRuntime, resolveExecutable: root => path.join(root, "Impacto.app", "Contents", "MacOS", "Impacto") });
  manager.distributionRequired = false;
  return manager;
}

module.exports = { SOURCE_URL, createManager };
