const { createPinnedNativeManager } = require("../../runtime/pinned-native-manager");

function createManager(dependencies = {}) {
  return createPinnedNativeManager({ id: "onsyuri", label: "ONScripter-Yuri", catalog: [],
    projectBuilds: { projectId: "onsyuri", repository: "procrastinine/maclauncher-builds" },
    sourceUrl: "https://github.com/procrastinine/maclauncher-builds", dependencies });
}

module.exports = { createManager, manager: createManager() };
