const path = require("node:path");
const { createPinnedNativeManager } = require("../../shared/runtime/pinned-native-manager");
const { createBundledNativeRuntime } = require("../../shared/runtime/bundled-native");

function createManager({ dependencies = {} } = {}) {
  const manager = createPinnedNativeManager({
    id: "onscripter-en", label: "ONScripter-EN", projectBuilds: { projectId: "onscripter-en", repository: "procrastinine/maclauncher-builds" },
    sourceUrl: "https://github.com/Galladite27/ONScripter-EN/releases",
    legacyInstalledRuntime: createBundledNativeRuntime({ managerId: "onscripter-en", ...(dependencies.bundle || {}) }),
    resolveExecutable: root => path.join(root, "bin", "onscripter-en"),
    dependencies: dependencies.manager || {}
  });
  const resolveSelection = manager.resolveSelection;
  manager.resolveSelection = (entry, settings, userDataDir) => {
    const version = entry?.runtimeData?.onscripter_en?.version;
    if (typeof version !== "string" || !version.trim()) return resolveSelection(entry, settings, userDataDir);
    return resolveSelection({ ...entry, runtimeData: { ...entry.runtimeData,
      "onscripter-en": { ...entry.runtimeData?.["onscripter-en"], version } } }, settings, userDataDir);
  };
  manager.distributionRequired = false;
  return manager;
}
module.exports = createManager();
module.exports.createManager = createManager;
