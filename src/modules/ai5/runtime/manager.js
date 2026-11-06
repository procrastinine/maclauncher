const path = require("node:path");
const { createPinnedNativeManager } = require("../../shared/runtime/pinned-native-manager");
const { createBundledNativeRuntime } = require("../../shared/runtime/bundled-native");
const manager = createPinnedNativeManager({
    // Game data uses the AI5 interpreter contract rather than a package patch version.
    versionCompatibility: () => true,
     id: "ai5", label: "AI5WIN", projectBuilds: { projectId: "ai5", repository: "procrastinine/maclauncher-builds" },
  distributionRequired: false,
  sourceUrl: "https://github.com/nunuhara/ai5-sdl2/releases", legacyInstalledRuntime: createBundledNativeRuntime({ managerId: "ai5" }),
  resolveExecutable: root => path.join(root, "bin", "ai5") });
manager.payloadPolicy = require("./payload-policy.json");
module.exports = manager;
