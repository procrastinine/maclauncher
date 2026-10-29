const { createPinnedNativeManager } = require("../../shared/runtime/pinned-native-manager");
const { createBundledNativeRuntime } = require("../../shared/runtime/bundled-native");
const path = require("node:path");
const { discoverCatalog } = require("./catalog");

const manager = createPinnedNativeManager({ id: "gemrb", label: "GemRB", discoverCatalog,
  projectBuilds: { projectId: "gemrb", repository: "procrastinine/maclauncher-builds" },
  distributionRequired: false,
  sourceUrl: "https://github.com/gemrb/gemrb/releases",
  legacyInstalledRuntime: createBundledNativeRuntime({ managerId: "gemrb" }),
  catalog: [] });
manager.payloadPolicy = require("./payload-policy.json");
module.exports = manager;
