const path = require("node:path");
const { createPinnedNativeManager } = require("../../shared/runtime/pinned-native-manager");
const { createBundledNativeRuntime } = require("../../shared/runtime/bundled-native");
const manager = createPinnedNativeManager({ id: "reminori", label: "Minori", projectBuilds: { projectId: "reminori", repository: "procrastinine/maclauncher-builds" },
  distributionRequired: false, sourceUrl: "https://github.com/luoyily/ReMinori/commits/main/",
  legacyInstalledRuntime: createBundledNativeRuntime({ managerId: "reminori" }),
  resolveExecutable: root => path.join(root, "bin/eden") });
module.exports = manager;
