const fs = require("node:fs");
const path = require("node:path");
const Modules = require("../modules/registry");
const GameStore = require("./game-store");
const { createLauncher, resolveModuleId } = require("./launcher");
const { createProcessLauncher } = require("./processes");
const { runRuntimeManagerAction } = require("./runtime-manager-service");
const { hydrateGameSaveLocations, selectKnownSaveLocation } = require("./save-locations");
const { prepareModuleInput } = require("../modules/shared/writable-input");
const { DownloadManager } = require("../modules/shared/runtime/download-manager");
const { errorRecord } = require("./backend-worker-client");
const { coordinatorFor } = require("./runtime-coordinator");

function listRuntimeManagers(registry) {
  const managers = new Map();
  for (const id of registry.listModuleIds()) {
    for (const manager of registry.getModule(id)?.runtimeManagers || []) if (manager?.id && !managers.has(manager.id)) managers.set(manager.id, manager);
  }
  for (const manager of registry.listSharedRuntimeManagers()) if (manager?.id && !managers.has(manager.id)) managers.set(manager.id, manager);
  return [...managers.values()];
}

/** All operations in this service run in Node, including the CLI's launch core. */
function createBackendOperations({ userDataDir, appInfo = {}, registry = Modules,
  emit = () => {}, callHost = async () => { throw new Error("Host service unavailable."); },
  getRunning = () => ({}), runtimeCoordinator } = {}) {
  runtimeCoordinator ||= coordinatorFor(userDataDir).client();
  const gameLifecycle = require("./game-lifecycle").createGameLifecycle({ userDataDir, coordinator: runtimeCoordinator });
  const logger = Object.fromEntries(["debug", "info", "warn", "error"].map(level => [level, (...args) => emit("log", { level, args })]));
  const app = { isPackaged: appInfo.isPackaged === true,
    getPath: name => name === "userData" ? userDataDir : appInfo.paths?.[name],
    getAppPath: () => appInfo.appPath,
    getVersion: () => appInfo.version,
    getName: () => "MacLauncher" };
  if (appInfo.resourcesPath) process.resourcesPath = appInfo.resourcesPath;
  const ui = {
    dialog: Object.fromEntries(["showOpenDialog", "showSaveDialog", "showMessageBox"].map(method =>
      [method, (...args) => callHost(`dialog.${method}`, ...args)])),
    shell: Object.fromEntries(["showItemInFolder", "openPath", "openExternal", "trashItem"].map(method =>
      [method, (...args) => callHost(`shell.${method}`, ...args)])),
    nativeImage: null
  };
  ui.openLiveVariableEditor = options => callHost("openLiveVariableEditor", options);
  const downloads = new DownloadManager({ onChange: () => emit("downloads", downloads.list()) });
  const managers = listRuntimeManagers(registry);
  const processes = new Map();
  let nextProcess = 0;
  function processRecord(id, child) { return { id, pid: child.pid, exitCode: child.exitCode ?? null, signalCode: child.signalCode ?? null }; }
  function trackProcess(child) {
    const id = String(++nextProcess);
    processes.set(id, child); emit("activity", { processes: processes.size });
    let finished = false;
    const finish = () => { if (!finished) { finished = true; processes.delete(id); emit("activity", { processes: processes.size }); } };
    for (const event of ["exit", "close"]) child.once(event, (code, signal) => {
      emit("process", { process: processRecord(id, child), event, code, signal }); finish();
    });
    child.once("error", error => { emit("process", { process: processRecord(id, child), event: "error", error: errorRecord(error) }); finish(); });
    // A checked/hosted launch can settle after its child has already exited.
    // Its terminal record still goes to the host, but must not retain a worker.
    if (child.exitCode != null || child.signalCode != null) finish();
    return processRecord(id, child);
  }
  const nativeProcesses = createProcessLauncher();
  function isRunning(entry) {
    const running = getRunning();
    if ((running.games || running)[entry.gamePath]) return true;
    const directory = entry.saveDirOverride || entry.defaultSaveDir;
    if (typeof directory !== "string" || !path.isAbsolute(directory)) return false;
    const canonical = value => { try { return fs.realpathSync(value); } catch { return path.resolve(value); } };
    const root = canonical(directory);
    return (running.saveRoots || []).some(value => {
      const active = canonical(value);
      return root === active || root.startsWith(active + path.sep) || active.startsWith(root + path.sep);
    });
  }
  const launcher = createLauncher({ userDataDir, registry, logger, app, ui, downloads, runtimeCoordinator,
    onToolLaunch: (entry, result) => emit("toolLaunch", { gamePath: entry.gamePath, gameId: entry.gameId,
      runtimeId: result.runtimeId, process: trackProcess(result.child) }),
    isGameRunning: isRunning,
    confirmRuntimeInstall: (plan, entry) => callHost("confirmRuntimeInstall", plan, entry),
    onPreparationChange: state => emit("preparation", state),
    onRuntimeStateChange: change => emit("runtimeChanged", change || {}),
    onEntryChange: (entry, patch) => {
      const stored = GameStore.readGameRecord(userDataDir, entry.gameId);
      if (stored) {
        for (const key of ["contentRootDir", "defaultSaveDir", "moduleData", "runtimeData"]) if (Object.hasOwn(patch || {}, key)) stored[key] = patch[key];
        GameStore.writeGameRecord(userDataDir, stored);
      }
      emit("entryChanged", { gameId: entry.gameId, gamePath: entry.gamePath });
    },
    launchHosted: async (entry, runtimeId) => {
      const { createElectronHostLaunch, resolveElectronBinary } = require("./electron-binary");
      const launch = createElectronHostLaunch({ executable: appInfo.execPath || resolveElectronBinary(),
        appPath: appInfo.bootstrapPath || appInfo.appPath || path.resolve(__dirname, "../main/bootstrap.js"),
        gamePath: entry.importPath || entry.gamePath, runtimeId, userDataDir });
      return require("./hosted-process").launchHostedProcess({ ...launch,
        spawn: nativeProcesses.spawnDetachedChecked, logger });
    }
  });
  function context(settings) { return { settings, userDataDir, logger, app, ui, fs, path, downloads }; }
  function managerState(manager, settings) {
    try {
      const state = manager.getState({ settings: settings?.runtimes?.[manager.id], userDataDir, logger });
      return { id: manager.id, label: manager.label || manager.id, ...state,
        ui: registry.getRuntimeManagerUi(manager.id) || state.ui || manager.ui || undefined };
    } catch (error) {
      logger.error(`[runtime:${manager.id}] state failed`, error.message);
      return { id: manager.id, label: manager.label || manager.id, installed: [],
        catalog: { versions: [], loading: false, error: error.message } };
    }
  }
  const metadata = require("./game-metadata").createGameMetadataService({ userDataDir, registry, app, ui, logger, runtimeCoordinator });
  const removeGameData = require("./game-removal").createGameRemoval({ userDataDir, registry, lifecycle: gameLifecycle,
    listRuntimeManagers: () => managers, isGameRunning: isRunning, logger, resolveModuleId,
    readSettings: () => launcher.loadSettings(), trashItem: file => ui.shell.trashItem(file) });
  const pendingImports = new Map();
  function currentEntry(entry) {
    return entry.gameId && GameStore.readGameRecord(userDataDir, entry.gameId) || entry;
  }
  async function refreshedEntry(entry, settings = launcher.loadSettings()) {
    return metadata.refreshEntry(currentEntry(entry), settings);
  }

  const operations = {
    removeGameData,
    async runtimeStates(settings, ids) {
      for (const manager of managers) {
        if (ids?.length && !ids.includes(manager.id) || typeof manager.getState !== "function") continue;
        emit("runtimeState", { id: manager.id, state: managerState(manager, settings) });
        // Cancellation and new jobs get an opportunity between independent inventories.
        await new Promise(resolve => setImmediate(resolve));
      }
      return true;
    },
    async moduleStates(settings) {
      for (const id of registry.listModuleIds()) {
        const mod = registry.getModule(id);
        try {
          const raw = typeof mod?.getState === "function" ? await mod.getState(context(settings)) : {};
          const state = raw && typeof raw === "object" ? { ...raw } : {};
          if (!state.cheats && mod?.cheats?.schema && registry.getModuleInfo(id)?.supports?.cheats) {
            state.cheats = { schema: mod.cheats.schema, defaults: mod.cheats.defaults || {} };
          }
          if (Object.keys(state).length) emit("moduleState", { id, state });
        } catch (error) { logger.warn(`[module:${id}] state failed`, error.message); }
        await new Promise(resolve => setImmediate(resolve));
      }
      return true;
    },
    async launchEntry(entry, options = {}) {
      const active = await refreshedEntry(entry, options.settings);
      const result = await launcher.launchEntry(active, options);
      emit("entryChanged", { gameId: active.gameId, gamePath: active.gamePath });
      if (result.kind !== "process") return result;
      return { kind: result.kind, runtimeId: result.runtimeId, process: trackProcess(result.child) };
    },
    async runtimeAction(managerId, action, payload) {
      const manager = managers.find(item => item.id === managerId);
      if (!manager) throw new Error("Runtime manager not found.");
      const result = await runRuntimeManagerAction({ manager, action, payload, userDataDir, logger, downloads, runtimeCoordinator,
        prerequisiteContext: { confirmRuntimeInstall: plan => callHost("confirmRuntimeInstall", plan) },
        readSettings: () => launcher.loadSettings().runtimes?.[managerId],
        saveSettings: async (next, previous) => {
          await runtimeCoordinator.applySettings({ runtimes: { [managerId]: previous } }, { runtimes: { [managerId]: next } });
          emit("settingsChanged", { managerId });
        },
        chooseImportPath: () => {
          const state = managerState(manager, launcher.loadSettings());
          const catalog = state.sections?.find(section => section.id === (payload?.sectionId || "default"))?.catalog || state.catalog || {};
          return callHost("chooseImportPath", { label: catalog.importLabel || manager.importLabel || `Import ${manager.label || manager.id}`,
            kinds: catalog.importInputKinds || manager.importInputKinds || ["directory"],
            extensions: catalog.importExtensions || manager.importExtensions || [] });
        },
        chooseInstalledActionInput: descriptor => callHost("chooseInstalledActionInput", descriptor),
        onStateChange: () => emit("runtimeState", { id: managerId, state: managerState(manager, launcher.loadSettings()) })
      });
      return result;
    },
    async moduleAction(entry, action, payload, settings) {
      entry = currentEntry(entry);
      const before = JSON.stringify(entry);
      const result = await launcher.runAction(entry, action, payload, { settings: settings || launcher.loadSettings() });
      if (JSON.stringify(GameStore.readGameRecord(userDataDir, entry.gameId)) !== before) emit("entryChanged", { gameId: entry.gameId, gamePath: entry.gamePath });
      return result ?? true;
    },
    async refreshEntry(entry, settings, options) { return metadata.refreshEntry(currentEntry(entry), settings, options); },
    refreshSaveLocations(entry, settings) {
      const hydrated = hydrateGameSaveLocations(currentEntry(entry), registry, { settings, userDataDir });
      GameStore.writeGameRecord(userDataDir, hydrated);
      emit("entryChanged", { gameId: hydrated.gameId, gamePath: hydrated.gamePath });
      return hydrated;
    },
    async importEntry(inputPath, settings) {
      const key = path.resolve(inputPath), controller = new AbortController();
      if (pendingImports.has(key)) throw new Error("This game is already being imported.");
      let finished; controller.finished = new Promise(resolve => { finished = resolve; });
      pendingImports.set(key, controller);
      try {
        return await metadata.importEntry(key, settings, { signal: controller.signal,
          onProgress: progress => emit("importProgress", { inputPath: key, ...progress }) });
      } finally { pendingImports.delete(key); emit("importProgress", { inputPath: key, phase: "done" }); finished(); }
    },
    async cancelImport(inputPath) { const controller = pendingImports.get(path.resolve(inputPath)); if (!controller) return false; controller.abort(); await controller.finished; return true; },
    async saveInfo(entry, settings) {
      entry = await refreshedEntry(entry, settings);
      emit("entryChanged", { gameId: entry.gameId, gamePath: entry.gamePath });
      const moduleId = resolveModuleId(entry), info = registry.getModuleInfo(moduleId);
      const saveDir = entry.saveDirOverride || entry.defaultSaveDir;
      if (!saveDir) throw new Error(`Save directory is not available for ${info.label}.`);
      fs.mkdirSync(saveDir, { recursive: true });
      return { saveDir, directoryChoices: entry.saveLocations || [], moduleId,
        moduleLabel: info.label, moduleShortLabel: info.shortLabel, name: entry.name,
        canEditJson: info.supports?.saveEditing === true, structuredActions: registry.getModule(moduleId)?.save?.structured || null };
    },
    selectSaveLocation(entry, directory, settings) {
      const selected = selectKnownSaveLocation(currentEntry(entry), directory, registry, { settings, userDataDir });
      GameStore.writeGameRecord(userDataDir, selected); emit("entryChanged", { gameId: entry.gameId, gamePath: entry.gamePath });
      return true;
    },
    save(entry, method, ...args) {
      if (!["listFiles", "runAction", "exportFolder", "prepareExternalDocument", "readExternalDocument"].includes(method)) throw new Error("Unknown save operation.");
      return launcher.saveService[method](currentEntry(entry), ...args);
    },
    async patcher(entry, family, action, options = {}) {
      if (!["cheats", "libs"].includes(family) || !["status", "patch", "unpatch", "updateVisibility"].includes(action)) throw new Error("Unknown patch operation.");
      entry = entry.gameId ? await refreshedEntry(entry) : { ...entry, ...await registry.detectGameAsync(entry.importPath || entry.gamePath, { workerMode: "inline" }) };
      const moduleId = resolveModuleId(entry), mod = registry.getModule(moduleId), info = registry.getModuleInfo(moduleId);
      const original = entry;
      entry = prepareModuleInput(entry, registry, { ...context(launcher.loadSettings()), readOnly: action === "status" });
      if (action !== "status") launcher.persistEntry(original);
      const patcher = family === "cheats" && info.supports?.cheatsPatcher ? mod?.cheats?.patcher : family === "libs" ? mod?.libs?.patcher : null;
      if (!patcher) return null;
      const selections = {};
      for (const dependency of mod?.libs?.catalog?.listDependencies?.() || []) {
        if (dependency.engine && dependency.engine !== moduleId) continue;
        const override = entry.moduleData?.libVersions?.[dependency.id];
        selections[dependency.id] = override && mod.libs.catalog.getVersion(dependency.id, override) ? override : dependency.versions?.[0]?.id;
      }
      if (action === "status") return family === "libs" ? patcher.getPatchStatus(entry, selections) : patcher.getPatchStatus(entry);
      if (action === "unpatch") return patcher.unpatchGame(entry);
      if (action === "updateVisibility") {
        const status = await patcher.getPatchStatus(entry);
        if (!status?.patched) return false;
        await patcher.unpatchGame(entry);
      }
      return patcher.patchGame(entry, family === "libs" ? { selections, appVersion: appInfo.version || null } : {
        appVersion: appInfo.version || null, toolsButtonVisible: options.toolsButtonVisible ?? launcher.resolveToolsButtonVisible(entry, launcher.loadSettings())
      });
    },
    cancelDownload: id => downloads.cancel(id)
  };
  for (const method of ["launchEntry", "moduleAction", "refreshSaveLocations", "saveInfo", "selectSaveLocation", "save", "patcher"]) {
    const operation = operations[method];
    operations[method] = (entry, ...args) => gameLifecycle.use(entry, () => operation(entry, ...args));
  }
  return operations;
}

module.exports = { createBackendOperations, listRuntimeManagers };
