const { createPinnedNativeManager } = require("../../shared/runtime/pinned-native-manager");
const { createBundledNativeRuntime } = require("../../shared/runtime/bundled-native");
const path = require("node:path");

const manager = createPinnedNativeManager({ id: "gemrb", label: "GemRB",
  projectBuilds: { projectId: "gemrb", repository: "procrastinine/maclauncher-builds" },
  distributionRequired: false,
  sourceUrl: "https://github.com/gemrb/gemrb/releases",
  legacyInstalledRuntime: createBundledNativeRuntime({ managerId: "gemrb" }) });
manager.payloadPolicy = require("./payload-policy.json");
module.exports = manager;
