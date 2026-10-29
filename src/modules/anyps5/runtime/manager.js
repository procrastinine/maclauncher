const path = require("node:path");
const { promisify } = require("node:util");
const execute = promisify(require("node:child_process").execFile);
const { createProjectBuildManager } = require("../../shared/runtime/project-build-manager");
const Bundled = require("../../shared/runtime/bundled-native");

function createManager(dependencies = {}) {
  const base = createProjectBuildManager({ projectId: "anyps5", label: "AnyPS5",
    repository: "procrastinine/maclauncher-builds", upstreamUrl: "https://github.com/boykopovar/AnyPS5",
    manifestRelative: "runtime.json", sourceRelative: "source.json", executableRelative: "tools/relinker", supportsDefault: true,
    validateManifest(manifest, record) {
      if (manifest.managerId !== "anyps5" || manifest.arch !== record.arch || !/^[a-f0-9]{40}$/.test(manifest.upstreamRevision || "") ||
          manifest.gameArchitecture !== "x86_64" || manifest.runtimeFiles?.libraries !== "libs" ||
          manifest.runtimeFiles?.unwrap !== "tools/unwrap-self.cjs" ||
          !manifest.files.some(file => file.path === "tools/unwrap-self.cjs") ||
          !manifest.files.some(file => file.path === "libs/libkernel.prx" && file.executionArchitecture === "x86_64"))
        throw new Error("The AnyPS5 package has an unsupported runtime layout.");
    },
    async verifyPayload(selected, { signal } = {}) {
      Bundled.verifyPayload(selected.root, selected.declaration);
      for (const file of selected.manifest.files.filter(file => file.architectures))
        await (dependencies.execute || execute)("/usr/bin/codesign", ["--verify", "--strict", path.join(selected.payloadRoot,file.path)],
          { signal, timeout:30000, maxBuffer:1024*1024 });
    }, dependencies });
  return base;
}
module.exports = createManager();
module.exports.createManager = createManager;
