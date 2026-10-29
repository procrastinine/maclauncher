const { execFileSync } = require("node:child_process");
const Bundled = require("./bundled-native");
const MachO = require("./macho-load-commands");
const { createProjectBuildManager } = require("./project-build-manager");
const { confirmToolInstall } = require("./tool-install");
const { throwIfAborted } = require("./download-utils");

function createManager(dependencies = {}) {
  const manager = createProjectBuildManager({ projectId: "rpgmaker-decrypter", label: "RPGMakerDecrypter",
    repository: "procrastinine/maclauncher-builds", manifestRelative: "manifest.json", sourceRelative: null,
    executableRelative: "files/bin/RPGMakerDecrypter-cli", supportsDefault: true,
    validateManifest(manifest) {
      if (manifest.managerId !== "rpgmaker-decrypter" || manifest.toolABI !== 1 || manifest.arch !== "arm64" ||
          manifest.executableRelative !== "files/bin/RPGMakerDecrypter-cli")
        throw new Error("The RPGMakerDecrypter package uses an unsupported tool format.");
    },
    verifyPayload(selected) {
      Bundled.verifyPayload(selected.root, selected.declaration);
      const image = MachO.assertSystemLibraryClosure(MachO.readMachOLoadCommands(selected.executablePath), {
        fileType: 2, maximumMacOS: selected.declaration.minimumMacOS });
      if (image.architectures.length !== 1 || image.architectures[0] !== "arm64")
        throw new Error("RPGMakerDecrypter requires its Apple Silicon executable.");
      execFileSync("/usr/bin/codesign", ["--verify", "--strict", selected.executablePath], { timeout: 30000, stdio: "pipe" });
    }, dependencies });
  manager.ui = { groupId: "tools", tabLabel: "Tools", sectionLabel: "RPGMakerDecrypter", order: 200,
    memberOrder: 220, management: "managed" };
  manager.ensure = async (entry = {}, payload = {}, context = {}) => {
    if (!context.userDataDir) throw new Error("RPGMakerDecrypter requires the launcher profile directory.");
    let selected = manager.resolveSelection(entry, context.settings, context.userDataDir, { version: payload.toolVersion });
    if (selected.ready) return selected.install;
    await confirmToolInstall(context, { manager, version: selected.version, requiresDownload: true,
      detail: "Required to extract RPG Maker game data." });
    if (!selected.version || selected.discoveryRequired) {
      await manager.refreshCatalog({ ...context, force: false });
      context.onRuntimeStateChange?.();
      throwIfAborted(context.signal);
      selected = manager.resolveSelection(entry, context.settings, context.userDataDir, { version: payload.toolVersion });
    }
    if (!selected.version) throw new Error("No RPGMakerDecrypter versions are available to download.");
    const installed = await manager.installRuntime({ ...context, version: selected.version });
    context.onRuntimeStateChange?.();
    return installed;
  };
  return manager;
}

module.exports = Object.assign(createManager(), { createManager });
