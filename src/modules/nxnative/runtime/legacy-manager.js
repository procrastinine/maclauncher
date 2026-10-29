const path = require("node:path");
const { promisify } = require("node:util");
const execute = promisify(require("node:child_process").execFile);
const { createProjectBuildManager } = require("../../shared/runtime/project-build-manager");
const Bundled = require("../../shared/runtime/bundled-native");

function createManager(dependencies = {}, { projectId = "nxnative" } = {}) {
  const base = createProjectBuildManager({ projectId, label: "nxnative", repository: "procrastinine/maclauncher-builds",
    upstreamUrl: "https://github.com/seedds/nxnative", manifestRelative: "manifest.json", sourceRelative: "source.json",
    executableRelative: "bin/nxnative", supportsDefault: true,
    validateManifest(manifest, record) {
      Bundled.validateManifest(manifest, { managerId: projectId, version: record.version, arch: record.arch });
      if (manifest.executableRelative !== "bin/nxnative" || manifest.arch !== "arm64" ||
          !manifest.files.some(file => file.path === "runtime.json") || !manifest.files.some(file => file.path === "bin/nxnative-host"))
        throw new Error("The nxnative package has an unsupported runtime layout.");
    },
    async verifyPayload(selected, { signal } = {}) {
      Bundled.verifyPayload(selected.root, selected.declaration);
      for (const file of selected.manifest.files.filter(file => file.architectures))
        await (dependencies.execute || execute)("/usr/bin/codesign", ["--verify", "--strict", path.join(selected.payloadRoot, file.path)], { signal, timeout: 30000, maxBuffer: 1024 * 1024 });
    }, dependencies });
  return { ...base, async installRuntime(options = {}) {
    if (options.version && options.version !== "latest") return base.installRuntime(options);
    await base.refreshCatalog({ ...options, force: true });
    const selected = base.resolveSelection(null, options.settings, options.userDataDir);
    if (!selected.version) throw new Error("No compatible nxnative build is available from MacLauncher Builds.");
    return base.installRuntime({ ...options, version: selected.version });
  } };
}
module.exports = { createManager };
