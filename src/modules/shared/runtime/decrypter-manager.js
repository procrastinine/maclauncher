const { execFileSync } = require("node:child_process");
const Bundled = require("./bundled-native");
const MachO = require("./macho-load-commands");
const { createProjectBuildManager } = require("./project-build-manager");
const { confirmToolInstall } = require("./tool-install");
const { throwIfAborted } = require("./download-utils");
const Architecture = require("./architecture");

function createManager(dependencies = {}) {
  const manager = createProjectBuildManager({ projectId: "rpgmaker-decrypter", label: "RPGMakerDecrypter",
    repository: "procrastinine/maclauncher-builds", manifestRelative: "manifest.json", sourceRelative: null,
    executableRelative: "files/bin/RPGMakerDecrypter-cli", supportsDefault: true,
    validateManifest(manifest, record) {
      if (manifest.managerId !== "rpgmaker-decrypter" || manifest.toolABI !== 1 ||
          !manifest.arch || Architecture.normalizeArchitecture(manifest.arch) !== manifest.arch || manifest.arch !== record.arch ||
          manifest.executableRelative !== "files/bin/RPGMakerDecrypter-cli")
        throw new Error("The RPGMakerDecrypter package uses an unsupported tool format.");
    },
    verifyPayload(selected) {
      Bundled.verifyPayload(selected.root, selected.declaration, selected.resolveDependency);
      const image = MachO.assertSystemLibraryClosure(MachO.readMachOLoadCommands(selected.executablePath), {
        fileType: 2, maximumMacOS: selected.declaration.minimumMacOS });
      const required = selected.declaration.arch === "universal" ? ["arm64", "x86_64"]
        : [selected.declaration.arch === "x64" ? "x86_64" : selected.declaration.arch];
      if (image.architectures.length !== required.length || !required.every(architecture => image.architectures.includes(architecture)))
        throw new Error("The RPGMakerDecrypter executable differs from its package architecture.");
      execFileSync("/usr/bin/codesign", ["--verify", "--strict", selected.executablePath], { timeout: 30000, stdio: "pipe" });
    }, dependencies });
  manager.ui = { groupId: "tools", tabLabel: "Tools", sectionLabel: "RPGMakerDecrypter", order: 200,
    memberOrder: 220, management: "managed" };
  manager.ensure = async (entry = {}, payload = {}, context = {}) => {
    if (!context.userDataDir) throw new Error("RPGMakerDecrypter requires the launcher profile directory.");
    const architecture = manager.chooseArchitecture(entry, context.settings, context.userDataDir, payload);
    return Architecture.withArchitecture(architecture, async () => {
      const selectionOptions = {version: payload.toolVersion, architecture};
      const executable = async install => {
        await Architecture.ensureArchitecture(Architecture.recordArchitecture(install) || install.declaration?.arch, context);
        return install;
      };
      let selected = manager.resolveSelection(entry, context.settings, context.userDataDir, selectionOptions);
      if (selected.install && !selected.ready) await executable(selected.install);
      if (selected.ready) return executable(selected.install);
      await confirmToolInstall(context, { manager, version: selected.version, requiresDownload: true, installOptions: {architecture},
        detail: "Required to extract RPG Maker game data." });
      if (!selected.version || selected.discoveryRequired) {
        await manager.refreshCatalog({ ...context, force: false });
        context.onRuntimeStateChange?.();
        throwIfAborted(context.signal);
        selected = manager.resolveSelection(entry, context.settings, context.userDataDir, selectionOptions);
      }
      if (!selected.version) throw new Error("No RPGMakerDecrypter versions are available to download.");
      const installed = await manager.installRuntime({ ...context, version: selected.version, architecture });
      context.onRuntimeStateChange?.();
      return executable(installed);
    });
  };
  return manager;
}

module.exports = Object.assign(createManager(), { createManager });
