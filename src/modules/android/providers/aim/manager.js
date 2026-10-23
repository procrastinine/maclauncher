const Bundled = require("../../../shared/runtime/bundled-native");
const { createProjectBuildManager } = require("../../../shared/runtime/project-build-manager");

function createManager(dependencies = {}) {
  return createProjectBuildManager({ projectId: "android-aim", runtimeId: "aim", label: "AIM", repository: "procrastinine/maclauncher-builds",
    manifestRelative: "manifest.json", sourceRelative: manifest => manifest.files.some(file => file.path === "source.tar.gz") ? "files/source.tar.gz" : null,
    executableRelative: "bin/aimctl", filesPrefix: "files/",
    validateManifest: (manifest, record) => {
      if (record.arch !== "arm64") throw new Error("The selected AIM runtime requires Apple Silicon.");
      return Bundled.validateManifest(manifest, { managerId: "android-aim", version: record.version, arch: record.arch });
    },
    verifyPayload: selected => Bundled.verifyPayload(selected.root, selected.declaration), dependencies });
}
module.exports = createManager();
module.exports.createManager = createManager;
