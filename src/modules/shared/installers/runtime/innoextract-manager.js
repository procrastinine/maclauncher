const path = require("node:path");
const { createPinnedNativeManager } = require("../../runtime/pinned-native-manager");
const { createBundledNativeRuntime } = require("../../runtime/bundled-native");
const { confirmToolInstall } = require("../../runtime/tool-install");
const { throwIfAborted } = require("../../runtime/download-utils");
const { installerError } = require("../inno-header");

function createManager(dependencies = {}) {
  const manager = createPinnedNativeManager({ id: "innoextract", label: "Installer reader", supportsDefault: true,
    projectBuilds: { projectId: "innoextract", repository: "procrastinine/maclauncher-builds" },
    sourceUrl: "https://github.com/dscharrer/innoextract/releases",
    resolveExecutable: root => path.join(root, "bin/innoextract"),
    // Versions are the published Builds records, which identify their source.
    legacyInstalledRuntime: createBundledNativeRuntime({ managerId: "innoextract" }), dependencies });
  manager.ui = { groupId: "tools", tabLabel: "Tools", sectionLabel: "Installer reader", order: 100,
    memberOrder: 100, management: "managed" };
  manager.payloadPolicy = require("./innoextract-payload-policy.json");
  manager.distributionRequired = false;
  manager.ensure = async (entry = {}, payload = {}, context = {}) => {
    if (process.arch !== "arm64") throw installerError("The installer reader is unavailable for this Mac.", "INSTALLER_TOOL_MISSING");
    if (!context.userDataDir) throw installerError("The installer reader requires the launcher profile directory.", "INSTALLER_TOOL_MISSING");
    let selected = manager.resolveSelection(entry, context.settings, context.userDataDir, { version: payload.toolVersion });
    if (selected.ready) return selected.install;
    await confirmToolInstall(context, { manager, version: selected.version, requiresDownload: true,
      detail: "Required to read this Inno Setup installer." });
    if (!selected.version || selected.discoveryRequired) {
      await manager.refreshCatalog({ ...context, force: false });
      context.onRuntimeStateChange?.(); throwIfAborted(context.signal);
      selected = manager.resolveSelection(entry, context.settings, context.userDataDir, { version: payload.toolVersion });
    }
    if (!selected.version) throw installerError("No Installer reader versions are available to download.", "INSTALLER_TOOL_MISSING");
    const installed = await manager.installRuntime({ ...context, version: selected.version });
    context.onRuntimeStateChange?.(); return installed;
  };
  return manager;
}

module.exports = Object.assign(createManager(), { createManager });
