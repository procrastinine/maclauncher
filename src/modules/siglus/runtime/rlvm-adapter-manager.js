const path = require("node:path");
const { execFileSync } = require("node:child_process");
const Bundled = require("../../shared/runtime/bundled-native");
const MachO = require("../../shared/runtime/macho-load-commands");
const { createProjectBuildManager } = require("../../shared/runtime/project-build-manager");

function verifyInstall(install) {
  Bundled.verifyPayload(install.root, install.declaration);
  const file = install.executablePath;
  const image = MachO.assertSystemLibraryClosure(MachO.readMachOLoadCommands(file), {
    fileType: 6, installName: "@rpath/rlvm-adapter.dylib", maximumMacOS: install.declaration.minimumMacOS });
  if (!image.architectures.includes("arm64") || !image.architectures.includes("x86_64")) throw new Error("The RLVM adapter requires both Mac CPU architectures.");
  execFileSync("/usr/bin/codesign", ["--verify", "--strict", file], { timeout: 30000, stdio: "pipe" });
  return file;
}
function createManager(dependencies = {}) {
  const manager = createProjectBuildManager({ projectId: "rlvm-adapter", label: "RLVM adapter", repository: "procrastinine/maclauncher-builds",
    manifestRelative: "manifest.json", sourceRelative: null, filesPrefix: "files/", executableRelative: "rlvm-adapter.dylib", nativeLibrary: true,
    validateManifest(manifest) {
      if (manifest.managerId !== "rlvm-adapter" || manifest.adapterABI !== 1 || manifest.arch !== "universal" ||
          !manifest.files.some(file => file.path === "adapter.json")) throw new Error("The RLVM adapter package uses an unsupported integration ABI.");
    },
    verifyPayload: selected => { verifyInstall({ ...selected, executablePath: path.join(selected.payloadRoot, "rlvm-adapter.dylib") }); }, dependencies });
  manager.ui = { groupId: "rlvm", tabLabel: "RLVM", sectionLabel: "MacLauncher adapter", order: 156, memberOrder: 10, management: "managed" };
  return manager;
}
module.exports = Object.assign(createManager(), { createManager, verifyInstall });
