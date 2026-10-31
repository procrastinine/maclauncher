const { createPinnedNativeManager } = require("../../shared/runtime/pinned-native-manager");
const { createBundledNativeRuntime } = require("../../shared/runtime/bundled-native");

// The publisher's releases hold Windows executables only; Mac builds come from MacLauncher Builds.
const manager = createPinnedNativeManager({ id: "gm8-decompiler", label: "GM8Decompiler (Classic)", supportsDefault: true, sourceUrl: "https://github.com/OpenGMK/GM8Decompiler/releases",
  projectBuilds: { projectId: "gm8-decompiler", repository: "procrastinine/maclauncher-builds" },
  distributionRequired: false,
  legacyInstalledRuntime: createBundledNativeRuntime({ managerId: "gm8-decompiler" }) });

module.exports = { manager };
