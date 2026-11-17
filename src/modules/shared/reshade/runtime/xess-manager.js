const Library = require("../xess/library"), Versions = require("../xess/versions");
const { confirmToolInstall } = require("../../runtime/tool-install");
const { selectRuntimeVersion } = require("../../runtime/version-choices");
function requested(context = {}) {
  return selectRuntimeVersion({ manual: context.version,
    defaultVersion: context.settings?.runtimes?.[Library.Source.managerId]?.defaultVersion }).version;
}
function missing(message = "Install or import a compatible Intel XeSS SDK.") {
  return Object.assign(Error(message), { code: "GRAPHICS_XESS_RUNTIME_MISSING", managerId: Library.Source.managerId });
}
function createManager(dependencies = {}) {
  const manager = Versions.createManager(dependencies), state = manager.getState, remove = manager.uninstallRuntime, install = manager.installRuntime;
  manager.ui = { groupId: "graphics", tabLabel: "Graphics", sectionLabel: "XeSS", order: 0, memberOrder: 6, management: "managed" };
  manager.updateSettingsAfterInstall = settings => manager.normalizeSettings(settings);
  manager.getState = context => {
    const value = state(context), legacy = Library.legacyListInstalled(context?.userDataDir);
    if (!legacy.length) return value;
    const installed = [...value.installed, ...legacy];
    return { ...value, installed, sections: value.sections.map(section => section.id === 'default' ? { ...section, installed } : section) };
  };
  manager.uninstallRuntime = context => context.version === Library.Source.version
    ? Library.remove(context) : remove(context);
  manager.installRuntime = context => context.version === Library.Source.version
    ? Library.installLegacy({ ...context, confirmRuntimeInstall: require("../../runtime/tool-install").approveDownloads }) : install(context);
  manager.resolveRuntime = (context = {}) => {
    const selection = manager.resolveSelection(context.entry || {}, context.settings, context.userDataDir, { version: context.version });
    if (!selection.ready) {
      if (requested(context) && requested(context) !== Library.Source.version) throw missing(selection.reason);
      return null;
    }
    const install = selection.install, operation = context.operation || "superresolution";
    if (!install.capabilities?.includes(operation)) throw missing("The selected XeSS SDK does not contain the required runtime components.");
    if (operation === 'superresolution' && context.backend && context.backend !== 'auto' && !install.backends?.includes(context.backend))
      throw missing("The selected XeSS SDK does not expose the selected GPU backend.");
    return { ...install, library: operation === 'interpolate' ? install.libraries.frameGeneration : install.library,
      sourcePath: operation === 'interpolate' ? install.libraries.frameGeneration : install.library };
  };
  manager.ensure = async (context = {}) => {
    let selected = manager.resolveSelection(context.entry || {}, context.settings, context.userDataDir, { version: context.version });
    if (selected.ready) return manager.resolveRuntime(context);
    await confirmToolInstall(context, { manager, version: selected.version, requiresDownload: true, detail: "Required for the selected XeSS effect." });
    if (!selected.version || selected.discoveryRequired) {
      await manager.refreshCatalog({ ...context, force: false }); context.onRuntimeStateChange?.(); context.signal?.throwIfAborted();
      selected = manager.resolveSelection(context.entry || {}, context.settings, context.userDataDir, { version: context.version });
    }
    if (!selected.version) throw missing("No Intel XeSS SDK releases are available.");
    await manager.installRuntime({ ...context, version: selected.version,
      automatic: typeof context.automatic === "boolean" ? context.automatic : selected.automatic === true });
    context.onRuntimeStateChange?.();
    return manager.resolveRuntime(context);
  };
  manager.launchPlan = (context = {}) => {
    try { if (manager.resolveRuntime(context)) return null; } catch (error) { if (error.code !== 'GRAPHICS_XESS_RUNTIME_MISSING') throw error; }
    const legacy = Library.legacyListInstalled(context.userDataDir).find(row => row.capabilities?.includes(context.operation || 'superresolution'));
    if (legacy && (!requested(context) || requested(context) === Library.Source.version)) return null;
    const selected = manager.resolveSelection(context.entry || {}, context.settings, context.userDataDir, { version: context.version });
    return { managerId: manager.id, version: selected.version, automatic: selected.automatic === true,
      label: 'Intel XeSS SDK', requiresDownload: true, installOptions: { sectionId: 'default' } };
  };
  return manager;
}
module.exports = Object.assign(createManager(), { createManager });
