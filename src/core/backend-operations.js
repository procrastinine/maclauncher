const fs = require("node:fs");
const path = require("node:path");
const Modules = require("../modules/registry");
const GameStore = require("./game-store");
const { createLauncher, resolveModuleId } = require("./launcher");
const { createProcessLauncher } = require("./processes");
const { runRuntimeManagerAction } = require("./runtime-manager-service");
const { hydrateGameSaveLocations, selectKnownSaveLocation, saveDirectoryForEntry } = require("./save-locations");
const { prepareModuleInput } = require("../modules/shared/writable-input");
const { DownloadManager } = require("../modules/shared/runtime/download-manager");
const { errorRecord } = require("./backend-worker-client");
const { coordinatorFor } = require("./runtime-coordinator");
const { stopProcessTree } = require("./process-stop");
const { processStopBinding, requestProcessStop, afterProcessStop } = require("./process-lifecycle");
const { createAbortError } = require("../modules/shared/runtime/download-utils");
const { COMPLETION_DIAGNOSTIC_WAIT_MS } = require("./game-process-events");

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
  let shuttingDown = false;
  const logger = Object.fromEntries(["debug", "info", "warn", "error"].map(level => [level, (...args) => emit("log", { level,
    args: [require("node:util").formatWithOptions({ depth: 3, maxArrayLength: 30, maxStringLength: 4096 }, ...args).slice(0, 8192)] })]));
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
  const downloads = new DownloadManager({ onChange: () => {
    if (shuttingDown) for (const task of downloads.list()) if (task.status === "downloading") downloads.cancel(task.id);
    emit("downloads", downloads.list());
  } });
  const managers = listRuntimeManagers(registry);
  const processes = new Map();
  const launching = new Map();
  const moduleActions = new Map();
  const processIds = new WeakMap();
  let nextProcess = 0;
  function processRecord(id, child) { return { id, pid: child.pid, stopRequested: child.stopRequested === true, exitCode: child.exitCode ?? null, signalCode: child.signalCode ?? null,
    ...(processStopBinding(child) ? { stopToken: processStopBinding(child).token } : {}),
    ...(child.completionDiagnostics ? { completionDiagnostics: {
      pending: child.completionDiagnostics.pending === true,
      message: String(child.completionDiagnostics.message || "").slice(0, 2048),
      logFile: String(child.completionDiagnostics.logFile || "").slice(0, 4096)
    } } : {}) }; }
  function trackProcess(child) {
    const existing = processIds.get(child);
    if (existing) return processRecord(existing, child);
    const id = String(++nextProcess);
    processIds.set(child, id);
    processes.set(id, child); emit("activity", { processes: processes.size });
    let finished = false, terminal = false, diagnosticTimer, releasing;
    const release = () => {
      if (finished || releasing) return;
      releasing = afterProcessStop(child, () => {
        finished = true;clearTimeout(diagnosticTimer);child.removeListener("diagnostics", diagnosed);
        processes.delete(id);emit("activity", {processes: processes.size});
      });
      void releasing.catch(error => logger.warn("Runtime cleanup failed: " + error.message));
    };
    const finish = () => {
      if (finished) return;
      terminal = true;
      // This count retains the worker, not the frontend's running-game state.
      // Keep its original pipe owner until completion or the existing UI bound.
      if (child.completionDiagnostics?.pending === true) {
        if (!diagnosticTimer) {diagnosticTimer = setTimeout(release, COMPLETION_DIAGNOSTIC_WAIT_MS);diagnosticTimer.unref?.();}
      } else release();
    };
    const diagnosed = () => {
      emit("process", {process: processRecord(id, child), event: "diagnostics"});
      if (terminal && child.completionDiagnostics?.pending !== true) release();
    };
    child.on("diagnostics", diagnosed);
    child.once("stopRequested", () => emit("process", { process: processRecord(id, child), event: "stopRequested" }));
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
    const directory = saveDirectoryForEntry(entry, registry);
    if (typeof directory !== "string" || !path.isAbsolute(directory)) return false;
    const canonical = value => { try { return fs.realpathSync(value); } catch { return path.resolve(value); } };
    const root = canonical(directory);
    return (running.saveRoots || []).some(value => {
      const active = canonical(value);
      return root === active || root.startsWith(active + path.sep) || active.startsWith(root + path.sep);
    });
  }
  const launcher = createLauncher({ userDataDir, registry, logger, app, ui, downloads, runtimeCoordinator,
    onGameProcessSpawn: (entry, child, runtimeId) => {
      if (!Number.isSafeInteger(child.pid) || child.pid < 1) return;
      const pending = launching.get(entry.gameId || entry.gamePath);
      if (pending) {
        pending.children.add(child);
        child.once("close", () => pending.children.delete(child));
        if (pending.controller.signal.aborted) {
          const stopping = requestProcessStop(child);pending.stops.push(stopping);void stopping.catch(error => logger.error(error.message));throw createAbortError();
        }
      }
      emit("gameProcess", { gamePath: entry.gamePath, runtimeId, process: trackProcess(child) });
    },
    onToolProcessSpawn: (child, options, identity) => {
      const record = trackProcess(child);
      const stopOnLauncherExit = options?.stopOnLauncherExit === true;
      const shutdownGraceMs = stopOnLauncherExit ? require("./process-stop").normalizeShutdownGraceMs(options.shutdownGraceMs) : undefined;
      const ownerName = typeof options?.ownerName === "string" && /^[a-zA-Z0-9._-]{1,128}$/.test(options.ownerName) ? options.ownerName : undefined;
      const ids = Object.fromEntries(Object.entries({ gameId: identity?.gameId, moduleId: identity?.moduleId, runtimeId: identity?.runtimeId })
        .filter(([, value]) => typeof value === "string" && /^[a-zA-Z0-9._:-]{1,128}$/.test(value)));
      emit("toolProcess", { process: record, stopOnLauncherExit, ...(stopOnLauncherExit ? { shutdownGraceMs } : {}),
        ...(ownerName ? { ownerName } : {}), ...ids });
      if (stopOnLauncherExit) {
        if (shuttingDown) { stopProcessTree(child.pid, {graceMs: shutdownGraceMs}); throw createAbortError("Launcher is closing."); }
      }
    },
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
    launchHosted: async (entry, runtimeId, context) => {
      const { createElectronHostLaunch, resolveElectronBinary } = require("./electron-binary");
      const launch = createElectronHostLaunch({ executable: appInfo.execPath || resolveElectronBinary(),
        appPath: appInfo.bootstrapPath || appInfo.appPath || path.resolve(__dirname, "../main/bootstrap.js"),
        gamePath: entry.importPath || entry.gamePath, runtimeId, userDataDir, gameArguments: context.gameArguments,
        env: await context.applyGameEnvironment(process.env) });
      return require("../modules/shared/web/runtime/isolated-host").launchIsolatedHost({ ...launch,
        spawn: nativeProcesses.spawnDetachedChecked, logger }, entry, context);
    }
  });
  function context(settings) { return { settings, userDataDir, logger, app, ui, fs, path, downloads }; }
  function managerState(manager, settings) {
    try {
      const state = manager.getState({ settings: settings?.runtimes?.[manager.id], userDataDir, logger });
      return { label: manager.label || manager.id, ...state, id: manager.id,
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
  const importProgress = require("./progress-reporter").createProgressReporter(state => emit("importProgress", state));
  function currentEntry(entry) {
    return entry.gameId && GameStore.readGameRecord(userDataDir, entry.gameId) || entry;
  }
  async function refreshedEntry(entry, settings = launcher.loadSettings(), options) {
    return metadata.refreshEntry(currentEntry(entry), settings, options);
  }

  const operations = {
    extractIcon: (sourcePath, source) => require("./icon-extraction").extractIcon(sourcePath, source),
    async resolveModuleIcon(entry) {
      const mod = registry.getModule(resolveModuleId(entry));
      return typeof mod?.resolveGameIcon === "function" ? await mod.resolveGameIcon(entry, context()) : null;
    },
    beginShutdown() {
      shuttingDown = true;
      importProgress.clear();
      for (const task of downloads.list()) downloads.cancel(task.id);
      for (const controller of pendingImports.values()) controller.abort();
      for (const pending of launching.values()) pending.controller.abort();
      for (const pending of moduleActions.values()) pending.controller.abort();
    },
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
      const key = entry.gameId || entry.gamePath;
      if (launching.has(key)) return launching.get(key).promise;
      const pending = { controller: new AbortController(), children: new Set(), stops: [], promise: null };
      pending.controller.signal.addEventListener("abort", () => {
        for (const child of pending.children) if (child.exitCode == null && child.signalCode == null) {
          const stopping = requestProcessStop(child);pending.stops.push(stopping);void stopping.catch(() => {});
        }
      }, { once: true });
      launching.set(key, pending);
      pending.promise = (async () => {
        try {
          const active = await refreshedEntry(entry, options.settings, { signal: pending.controller.signal });
          pending.controller.signal.throwIfAborted();
          const result = await launcher.launchEntry(active, { ...options, signal: pending.controller.signal });
          emit("entryChanged", { gameId: active.gameId, gamePath: active.gamePath });
          if (pending.controller.signal.aborted) return { kind: "cancelled", runtimeId: result.runtimeId };
          if (result.kind !== "process") return result;
          return { kind: result.kind, runtimeId: result.runtimeId, process: trackProcess(result.child),
            ...(result.graphicsWarnings?.length ? {graphicsWarnings: result.graphicsWarnings} : {}) };
        } catch (error) {
          if (pending.controller.signal.aborted) return { kind: "cancelled", runtimeId: options.runtimeId || entry.runtimeId };
          throw error;
        } finally {
          try {await Promise.all(pending.stops);}
          finally {
            launching.delete(key); pending.children.clear();
            emit("preparation", { gamePath: entry.gamePath, phase: "done" });
          }
        }
      })();
      return pending.promise;
    },
    cancelLaunch(entry) {
      const pending = launching.get(entry.gameId || entry.gamePath);
      if (!pending) return false;
      pending.controller.abort();return true;
    },
    stopProcess({ id, pid, stopToken } = {}) {
      const child = processes.get(id), binding = child && processStopBinding(child);
      if (!binding || child.pid !== pid || binding.token !== stopToken) return false;
      return requestProcessStop(child);
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
    async moduleAction(entry, action, payload, settings, options = {}) {
      if (shuttingDown) throw createAbortError("Launcher is closing.");
      const requestId = options.requestId;
      let pending, finish;
      if (requestId !== undefined) {
        if (typeof requestId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(requestId)) throw new Error("Invalid action request.");
        if (moduleActions.has(requestId)) throw new Error("This action request is already running.");
        pending = { controller: new AbortController(), finished: new Promise(resolve => { finish = resolve; }) };
        moduleActions.set(requestId, pending);
      }
      try {
        return await gameLifecycle.use(entry, async () => {
          pending?.controller.signal.throwIfAborted();
          entry = currentEntry(entry);
          const before = JSON.stringify(entry);
          const result = await launcher.runAction(entry, action, payload, {
            settings: settings || launcher.loadSettings(), signal: pending?.controller.signal
          });
          if (JSON.stringify(GameStore.readGameRecord(userDataDir, entry.gameId)) !== before) emit("entryChanged", { gameId: entry.gameId, gamePath: entry.gamePath });
          // Local graphics callbacks stay inside the process; inspector IPC
          // carries only the selected runtime and its serializable capabilities.
          if (action === "graphicsInputs") return {runtimeId: result.runtimeId, graphicsInputs: result.graphicsInputs};
          return result ?? true;
        });
      } finally {
        if (pending) { moduleActions.delete(requestId); finish(); }
      }
    },
    async cancelModuleAction(requestId) {
      const pending = moduleActions.get(requestId);
      if (!pending) return false;
      pending.controller.abort(createAbortError("Action canceled."));
      await pending.finished;
      return true;
    },
    async moduleSettingsAction(moduleId, action, payload) {
      const actions = registry.getModule(moduleId)?.settingsActions;
      if (!actions || !Object.hasOwn(actions, action) || typeof actions[action] !== "function")
        throw new Error("Module settings action is unavailable.");
      if (shuttingDown) throw createAbortError("Launcher is closing.");
      return actions[action](payload, { userDataDir, settings: launcher.loadSettings(), logger, app, ui, downloads,
        confirmRuntimeInstall: plan => callHost("confirmRuntimeInstall", plan),
        onToolProcessSpawn(child, options) {
          const record = trackProcess(child);
          if (options?.stopOnLauncherExit === true) {
            const shutdownGraceMs = require("./process-stop").normalizeShutdownGraceMs(options.shutdownGraceMs);
            emit("toolProcess", { process: record, stopOnLauncherExit: true, shutdownGraceMs });
            if (shuttingDown) { stopProcessTree(child.pid, {graceMs: shutdownGraceMs}); throw createAbortError("Launcher is closing."); }
          }
        } });
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
          onProgress: progress => importProgress.report(key, { inputPath: key, ...progress }) });
      } finally { pendingImports.delete(key); importProgress.report(key, { inputPath: key, phase: "done" }); finished(); }
    },
    async cancelImport(inputPath) { const controller = pendingImports.get(path.resolve(inputPath)); if (!controller) return false; controller.abort(); await controller.finished; return true; },
    async saveInfo(entry, settings) {
      entry = await refreshedEntry(entry, settings);
      emit("entryChanged", { gameId: entry.gameId, gamePath: entry.gamePath });
      const moduleId = resolveModuleId(entry), info = registry.getModuleInfo(moduleId);
      if (registry.getModule(moduleId)?.getRuntimeProvider?.(entry.runtimeId)?.supports?.saveLocation === false) throw new Error("Save tools are unavailable for this runtime.");
      await registry.getModule(moduleId)?.prepareSaveLocation?.(entry, { userDataDir });
      const saveDir = saveDirectoryForEntry(entry, registry);
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
  for (const method of ["launchEntry", "refreshSaveLocations", "saveInfo", "selectSaveLocation", "save", "patcher"]) {
    const operation = operations[method];
    operations[method] = (entry, ...args) => gameLifecycle.use(entry, () => operation(entry, ...args));
  }
  return operations;
}

module.exports = { createBackendOperations, listRuntimeManagers };
