const { isAbortError } = require("../modules/shared/runtime/download-utils");
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

// Shared by UI adapters. Dialogs and settings persistence are injected; all
// version discovery, imports and installation stay in the runtime manager.
async function runRuntimeManagerActionOnce({ manager, action, payload, userDataDir,
  logger, downloads, readSettings = () => undefined, saveSettings = () => {},
  chooseImportPath, chooseInstalledActionInput, onStateChange = () => {},
  prerequisiteContext = {}, rosetta = Rosetta } = {}) {
  if (!manager) throw new Error("Runtime manager not found");
  const data = payload && typeof payload === "object" ? payload : {};
  const context = { ...data, ...prerequisiteContext, userDataDir, logger, downloads };
  context.ensureRosetta = options => rosetta.ensure({ ...context, ...options });
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
    if (action === "install" || action === "import") {
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
    } else if (action === "installedAction") {
      if (typeof manager.performInstalledAction !== "function") throw new Error("Runtime has no installed version actions.");
      const state = manager.getState({ settings: readSettings(), userDataDir });
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
      await manager.getState?.({ settings: current, userDataDir });
      await commitSettings(manager.applySettingsUpdate("setDefault", data, current), previous);
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
