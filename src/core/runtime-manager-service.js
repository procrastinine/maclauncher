const { isAbortError } = require("../modules/shared/runtime/download-utils");
const { compareVersions } = require("../modules/shared/runtime/version-order");
const Rosetta = require("../modules/shared/runtime/rosetta");
const { coordinatorFor } = require("./runtime-coordinator");
const { instrumentRuntimeManagers, withRuntimeCoordinator } = require("./coordinated-runtime-managers");

function runRuntimeManagerAction(options = {}) {
  const { manager, userDataDir } = options;
  if (!manager?.id || !userDataDir) return runRuntimeManagerActionOnce(options);
  const coordinator = options.runtimeCoordinator || coordinatorFor(userDataDir).client();
  instrumentRuntimeManagers([manager]);
  return withRuntimeCoordinator(coordinator, userDataDir, () => runRuntimeManagerActionOnce(options));
}

// A manager whose newer versions generally run older games declares
// installSetsDefault: true, or the list of its sections that qualify. Installing
// a newer version then makes it that section's default, as Set default does.
// Other installs leave the saved default unchanged.
async function installedDefault(manager, settings, installed, data, userDataDir, runtimeSettings) {
  const sectionId = data.sectionId || "default", version = installed?.version || data.version;
  const declared = manager.installSetsDefault;
  if (!(declared === true || Array.isArray(declared) && declared.includes(sectionId))) return null;
  if (typeof version !== "string" || !version || typeof manager.applySettingsUpdate !== "function") return null;
  const state = await manager.getState?.({ settings, runtimeSettings, userDataDir }) || {};
  const section = (state.sections || [{ ...state, id: "default" }]).find(item => item.id === sectionId);
  if (!section || section.defaultVersion && compareVersions(version, section.defaultVersion) <= 0) return null;
  return manager.applySettingsUpdate("setDefault", { ...data, sectionId, version }, settings, { userDataDir });
}

// Shared by UI adapters. Dialogs and settings persistence are injected; all
// version discovery, imports and installation stay in the runtime manager.
async function runRuntimeManagerActionOnce({ manager, action, payload, userDataDir,
  logger, downloads, readSettings = () => undefined, saveSettings = () => {},
  chooseImportPath, chooseInstalledActionInput, onStateChange = () => {},
  prerequisiteContext = {}, rosetta = Rosetta } = {}) {
  if (!manager) throw new Error("Runtime manager not found");
  const data = payload && typeof payload === "object" ? payload : {};
  const context = { ...data, ...prerequisiteContext, userDataDir, logger, downloads };
  // Selecting Install/Download authorizes that acquisition, so these actions
  // pass their own approval. Other plans keep the consent adapter, and a
  // context without one declines them, as Play and tool discovery do.
  // The intent is established here, never trusted from renderer payload fields.
  if (["install", "setup"].includes(action)) {
    const confirm = typeof context.confirmRuntimeInstall === "function" ? context.confirmRuntimeInstall : null;
    context.confirmRuntimeInstall = (plan, ...args) => plan?.requiresDownload === true ? Promise.resolve({approved: true})
      : confirm ? confirm(plan, ...args) : Promise.resolve(false);
  }
  context.ensureRosetta = options => rosetta.ensure({ ...context, ...options,
    confirmRuntimeInstall: prerequisiteContext.confirmRuntimeInstall });
  const effectiveSettings = value => typeof manager.normalizeSettings === "function" ? manager.normalizeSettings(value) : value;
  const commitSettings = (next, previous) => saveSettings(effectiveSettings(next), effectiveSettings(previous));
  let result;
  try {
    if (action === "refreshCatalog") {
      if (typeof manager.refreshCatalog !== "function") throw new Error("Runtime manager cannot refresh");
      const refresh = manager.refreshCatalog({ ...context, force: true });
      onStateChange();
      return await refresh;
    }
    if (action === "registerCustom") {
      if (typeof manager.registerCustomRuntime !== "function") throw new Error("Custom runtime registration is unavailable.");
      const runtimePath = data.runtimePath || (typeof chooseImportPath === "function" ? await chooseImportPath(manager, data) : null);
      if (!runtimePath) return false;
      result = await manager.registerCustomRuntime({ ...context, runtimePath, settings: readSettings() });
    } else if (action === "install" || action === "import") {
      if (action === "import") {
        if (typeof manager.importRuntime !== "function") throw new Error("Runtime manager cannot import");
        const runtimePath = typeof chooseImportPath === "function" ? await chooseImportPath(manager, data) : data.runtimePath || data.runtimeRoot;
        if (!runtimePath && typeof chooseImportPath !== "function") throw new Error("Select a runtime directory to import.");
        if (!runtimePath) return false;
        result = await manager.importRuntime({ ...context, runtimePath, runtimeRoot: runtimePath });
      } else {
        if (typeof manager.installRuntime !== "function") throw new Error("Runtime manager cannot install");
        result = await manager.installRuntime(context);
      }
      if (result && typeof manager.updateSettingsAfterInstall === "function") {
        const current = readSettings(), previous = structuredClone(current);
        const next = manager.updateSettingsAfterInstall(current, result, data);
        if (next) await commitSettings(next, previous);
      }
      if (result && action === "install") {
        const current = readSettings(), previous = structuredClone(current);
        const next = await installedDefault(manager, current, result, data, userDataDir, context.settings?.runtimes);
        if (next) await commitSettings(next, previous);
      }
    } else if (action === "installedAction") {
      if (typeof manager.performInstalledAction !== "function") throw new Error("Runtime has no installed version actions.");
      const state = manager.getState({ settings: readSettings(), runtimeSettings: context.settings?.runtimes, userDataDir });
      const section = (state.sections || [{ ...state, id: "default" }]).find(section => section.id === (data.sectionId || "default"));
      const installed = section?.installed?.find(install => install.version === data.version);
      const descriptor = installed?.actions?.find(action => action.id === data.installedActionId);
      if (!descriptor || descriptor.available === false) throw new Error("This action is unavailable for the selected installed runtime.");
      let input = {};
      if (descriptor.inputKind === "file" && !data.archivePath && !data.filePaths?.length) {
        if (typeof chooseInstalledActionInput !== "function") throw new Error("Select a file for this runtime action.");
        input = await chooseInstalledActionInput(descriptor);
        if (!input) return false;
      }
      result = await manager.performInstalledAction({ ...context, ...input });
    } else if (action === "setup") {
      if (typeof manager.performSetupAction !== "function") throw new Error("Runtime manager has no setup actions");
      result = await manager.performSetupAction(context);
      if (result && typeof manager.updateSettingsAfterSetup === "function") {
        const current = readSettings(), previous = structuredClone(current);
        const next = manager.updateSettingsAfterSetup(current, result, data);
        if (next) await commitSettings(next, previous);
      }
    } else if (action === "uninstall") {
      if (typeof manager.uninstallRuntime !== "function") throw new Error("Runtime manager cannot uninstall");
      result = await manager.uninstallRuntime(context);
      if (typeof manager.updateSettingsAfterUninstall === "function") {
        const current = readSettings(), previous = structuredClone(current);
        const next = manager.updateSettingsAfterUninstall(current, data, { userDataDir });
        if (next) await commitSettings(next, previous);
      }
    } else if (action === "setDefault") {
      if (typeof manager.applySettingsUpdate !== "function") throw new Error("Runtime manager cannot update settings");
      const current = readSettings(), previous = structuredClone(current);
      // A fresh action worker must load the local release cache before checking
      // a selected version. State inspection does not query upstream catalogs.
      await manager.getState?.({ settings: current, runtimeSettings: context.settings?.runtimes, userDataDir });
      const next=manager.applySettingsUpdate("setDefault", data, current,{userDataDir});
      await commitSettings(manager.updateSettingsAfterDefault?.(next,data,{userDataDir,previousSettings:previous})||next,previous);
    } else throw new Error("Unsupported runtime action");
    return result ?? true;
  } catch (error) {
    if (isAbortError(error)) return false;
    throw error;
  } finally {
    onStateChange();
  }
}

module.exports = { runRuntimeManagerAction };
