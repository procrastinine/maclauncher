const path = require("node:path");
const { createPinnedNativeManager } = require("../../runtime/pinned-native-manager");
const { confirmToolInstall } = require("../../runtime/tool-install");
const { throwIfAborted } = require("../../runtime/download-utils");
const { installerError } = require("../inno-header");
const Custom = require("../../runtime/custom-runtime");
const Binary = require("../../../../core/binary-arch");
function createManager(dependencies = {}) {
  const manager = createPinnedNativeManager({ id: "freearc", label: "FreeArc decoders", supportsDefault: true,
    projectBuilds: { projectId: "freearc", repository: "procrastinine/maclauncher-builds" },
    sourceUrl: "https://github.com/M-Gonzalo/FreeArc", resolveExecutable: root => path.join(root, "bin/fa-filter"), dependencies });
  manager.ui = { groupId: "tools", tabLabel: "Tools", sectionLabel: "FreeArc decoders", order: 101, memberOrder: 101, management: "managed" };
  manager.distributionRequired = false;
  const customRuntime = { inspect(runtimePath, options = {}) {
    const install = Custom.inspectManifest(runtimePath, { managerId: manager.id, verification: options.verification || "full" });
    const missing = () => { throw installerError("Select a complete FreeArc decoder package containing its native filter and Windows CLS host.", "INSTALLER_TOOL_MISSING"); };
    if (!install) missing();
    const { filter, clsHost } = install.runtimeFiles || {};
    if (!filter || !clsHost || path.join(install.installDir, filter) !== install.executablePath) missing();
    const cls = Binary.inspectBinary(path.join(install.installDir, clsHost));
    if (cls.format !== "pe" || cls.machine !== "i386") missing();
    return install;
  } };
  manager.configureCustomRuntime(customRuntime);
  Custom.configure(manager, customRuntime);
  manager.ensure = async (entry = {}, payload = {}, context = {}) => {
    if (!context.userDataDir) throw installerError("FreeArc extraction requires the launcher profile directory.", "INSTALLER_TOOL_MISSING");
    let selected = manager.resolveSelection(entry, context.settings, context.userDataDir, { version: payload.toolVersion });
    if (selected.ready) return selected.install;
    await confirmToolInstall(context, { manager, version: selected.version, requiresDownload: true, detail: "Required to read the FreeArc archives beside this installer." });
    if (!selected.version || selected.discoveryRequired) { await manager.refreshCatalog({ ...context, force: false }); context.onRuntimeStateChange?.(); throwIfAborted(context.signal); selected = manager.resolveSelection(entry, context.settings, context.userDataDir, { version: payload.toolVersion }); }
    if (!selected.version) throw installerError("No FreeArc decoder versions are available to download.", "INSTALLER_TOOL_MISSING");
    const installed = await manager.installRuntime({ ...context, version: selected.version, automatic: selected.automatic === true }); context.onRuntimeStateChange?.(); return installed;
  };
  return manager;
}
module.exports = Object.assign(createManager(), { createManager });
