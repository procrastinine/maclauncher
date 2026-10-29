const fs = require("node:fs");
const path = require("node:path");
const { createProjectBuildManager } = require("../../shared/runtime/project-build-manager");
const Custom = require("../../shared/runtime/custom-runtime");
const Bundled = require("../../shared/runtime/bundled-native");

function createManager(dependencies = {}) {
  const manager = createProjectBuildManager({ projectId: "prosper", label: "Prosper",
    repository: "procrastinine/maclauncher-builds", upstreamUrl: "https://github.com/mattias800/prosper",
    manifestRelative: "runtime.json", sourceRelative: "source.json", executableRelative: "bin/prosper-app", supportsDefault: true,
    validateManifest(manifest, record) {
      if (manifest.managerId !== "prosper" || manifest.arch !== record.arch || manifest.gameArchitecture !== "x86_64" ||
          !/^[a-f0-9]{40}$/.test(manifest.upstreamRevision || "") || manifest.redistribution !== "local-only")
        throw new Error("The Prosper runtime has an unsupported layout or distribution identity.");
    },
    verifyPayload: async selected => Bundled.verifyPayload(selected.root, selected.declaration), dependencies });
  const inspectPackage = manager.customRuntime.inspect;
  Custom.configure(manager, { inspect(runtimePath, options) {
    const start = fs.statSync(runtimePath).isDirectory() ? runtimePath : path.dirname(runtimePath);
    for (let root = start, depth = 0; depth < 4; root = path.dirname(root), depth++) {
      if (fs.existsSync(path.join(root, "runtime.json"))) return inspectPackage(runtimePath, options);
      if (path.dirname(root) === root) break;
    }
    const selected = Custom.inspectExecutable(runtimePath, { candidates: ["bin/prosper-app", "prosper-app"], preferredExecutable: "prosper-app" });
    if (!selected.architectures.includes("x86_64")) throw new Error("Prosper requires an Intel 64-bit macOS executable.");
    return { ...selected, runtimeVersion: null };
  } });
  return manager;
}
module.exports = createManager();
module.exports.createManager = createManager;
