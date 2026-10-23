const { createPinnedNativeManager } = require("../../runtime/pinned-native-manager");
const { CATALOG, RECOMMENDED_VERSION, validateVersionProvenance } = require("./onsyuri-bundled");

function createManager(dependencies = {}) {
  return createPinnedNativeManager({ id: "onsyuri", label: "ONScripter-Yuri", catalog: CATALOG,
    recommendedVersion: RECOMMENDED_VERSION,
    projectBuilds: { projectId: "onsyuri", repository: "procrastinine/maclauncher-builds", validateManifest: validateVersionProvenance },
    sourceUrl: "https://github.com/procrastinine/maclauncher-builds", dependencies });
}

module.exports = { createManager, manager: createManager() };
