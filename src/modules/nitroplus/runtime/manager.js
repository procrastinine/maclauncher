const path = require("node:path");
const { createPinnedNativeManager } = require("../../shared/runtime/pinned-native-manager");
const { createBundledNativeRuntime } = require("../../shared/runtime/bundled-native");

const manager = createPinnedNativeManager({ id: "npengine", label: "Nitroplus", projectBuilds: { projectId: "npengine", repository: "procrastinine/maclauncher-builds" },
  sourceUrl: "https://github.com/FGRE/libnpengine/tags", legacyInstalledRuntime: createBundledNativeRuntime({ managerId: "npengine" }),
  resolveExecutable: root => path.join(root, "bin/npengine-runner") });
manager.distributionRequired = false;
module.exports = manager;
