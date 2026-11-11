const fs = require("node:fs");
const path = require("node:path");
const { isDeepStrictEqual } = require("node:util");
const Modules = require("../modules/registry");
const GameStore = require("./game-store");
const GameAvailability = require("./game-availability");
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
const { snapshotRuntimeState } = require("./runtime-state-snapshot.mjs");
const { withRunnableBuilds } = require("../modules/shared/runtime/host-settings");
const { entryModuleLabels } = require("./entry-labels");

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
  getRunning = () => ({}), runtimeCoordinator,
  whenIdle = () => new Promise(resolve => setImmediate(resolve)) } = {}) {
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
  ui.followProcessActivation = (request, { signal } = {}) => callHost.withSignal
    ? callHost.withSignal(signal, "followProcessActivation", request) : callHost("followProcessActivation", request);
  const downloads = new DownloadManager({ onChange: () => {
    if (shuttingDown) for (const task of downloads.list()) if (task.status === "downloading") downloads.cancel(task.id);
    emit("downloads", downloads.list());
  } });
  const managers = listRuntimeManagers(registry);
  let components = null;
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
    confirmRuntimeInstall: (plan, entry, {signal} = {}) => signal && typeof callHost.withSignal === "function"
      ? callHost.withSignal(signal, "confirmRuntimeInstall", plan, entry) : callHost("confirmRuntimeInstall", plan, entry),
    onPreparationChange: state => emit("preparation", state),
    onRuntimeStateChange: change => emit("runtimeChanged", change || {}),
    onSessionEvent: (entry, event) => emit("sessionEvent", { gameId: entry.gameId, gamePath: entry.gamePath, event }),
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
  function context(settings) { return { settings, runtimeSettings: settings?.runtimes, userDataDir, logger, app, ui, fs, path, downloads }; }
  // A state whose installed and included rows differ from the last one this
  // lane reported is an inventory change; other lanes then read runtimes again.
  // A manager's first report has nothing to differ from: the other lanes read
  // the same files, and changes made since then report their own events.
  const inventoryFingerprints = new Map();
  function emitRuntimeState(manager, state) {
    emit("runtimeState", { id: manager.id, state });
    const fingerprint = JSON.stringify([state.installed, state.references, state.sections?.map(section => [section.installed, section.references])]);
    const previous = inventoryFingerprints.get(manager.id);
    inventoryFingerprints.set(manager.id, fingerprint);
    if (previous !== undefined && previous !== fingerprint) emit("runtimeInventoryChanged", { managerId: manager.id });
  }
  function managerState(manager, settings, referenceStates) {
    try {
      const state = manager.getState({ settings: settings?.runtimes?.[manager.id], runtimeSettings: settings?.runtimes, userDataDir, logger, referenceStates });
      // States leave the lane encoded and limited to builds this Mac can run, so
      // the main process stores and sends them without encoding them again.
      return snapshotRuntimeState(withRunnableBuilds({ label: manager.label || manager.id, ...state, id: manager.id,
        ui: registry.getRuntimeManagerUi(manager.id) || state.ui || manager.ui || undefined }));
    } catch (error) {
      logger.error(`[runtime:${manager.id}] state failed`, error.message);
      return { id: manager.id, label: manager.label || manager.id, installed: [],
        catalog: { versions: [], loading: false, error: error.message } };
    }
  }
  const metadata = require("./game-metadata").createGameMetadataService({ userDataDir, registry, app, ui, logger, runtimeCoordinator, downloads,
    resolveRuntimeId: (entry, settings) => launcher.resolveEntryRuntimeId(entry, settings),
    confirmRuntimeInstall: plan => callHost("confirmRuntimeInstall", plan),
    onRuntimeStateChange: change => emit("runtimeChanged", change || {}) });
  const relocation = require("./game-relocation").createGameRelocation({ userDataDir, registry, metadata,
    choose: descriptor => callHost("chooseImportPath", descriptor) });
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
      const localPreparations = [], referenceStates = new Map();
      for (const manager of managers) {
        if (ids?.length && !ids.includes(manager.id) && !manager.referenceManagerIds?.some(id => ids.includes(id)) || typeof manager.getState !== "function") continue;
        if (typeof manager.prepareLocalState === "function") {
          localPreparations.push(Promise.resolve().then(() => manager.prepareLocalState({...context(settings), settings: settings?.runtimes?.[manager.id], referenceStates}))
            .catch(error => logger.warn(`[runtime:${manager.id}] local state could not be prepared`, error.message))
            .then(() => emitRuntimeState(manager, managerState(manager, settings, referenceStates))));
          continue;
        }
        emitRuntimeState(manager, managerState(manager, settings, referenceStates));
        // Cancellation and new jobs get an opportunity between independent inventories.
        await new Promise(resolve => setImmediate(resolve));
      }
      await Promise.allSettled(localPreparations);
      return true;
    },
    // The inspector worker lets each module read what its games share, such as
    // installed runtimes, before the first game is selected.
    // The launcher's graphics catalog (src/main/graphics-catalog.js).
    graphicsCatalog(settings) {
      return require("../modules/shared/reshade").getState({ app: null, userDataDir, settings });
    },
    // The graphics editor's discovery and catalog for a game that is not
    // running, from main's data options; module callbacks stay with main.
    gameEffectsInfo(entry, options) {
      return require("../modules/shared/effects/runtime").info(entry, { ...options, userDataDir, app: null });
    },
    // The graphics menu's chain templates for a game that is not running.
    gameEffectTemplates(entry, options) {
      return require("../modules/shared/effects/runtime").templates(entry, { ...options, userDataDir, app: null });
    },
    // A shader row's parameters. Describing verifies the included graphics
    // runtime's files and compiles the shader, which stays off main.
    gameEffectParameters(entry, nodeId, draft, options) {
      return require("../modules/shared/effects/runtime").describe(entry, nodeId, draft, { ...options, userDataDir, app: null });
    },
    // Modules prepare in the given order, then in registry order.
    async warmInspectorLane(settings, order = []) {
      const rank = id => { const index = order.indexOf(id); return index < 0 ? order.length : index; };
      for (const id of registry.listModuleIds().sort((a, b) => rank(a) - rank(b))) {
        const warm = registry.getModule(id)?.warmBackendLane;
        if (typeof warm !== "function") continue;
        try { await warm({ settings, userDataDir, logger, whenIdle }); }
        catch (error) { logger.debug?.(`[backend] ${id} lane preparation failed`, error.message); }
        // Requests that arrived during one module's preparation finish before the next module's starts.
        await whenIdle();
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
      const pending = { controller: new AbortController(),graphics:require('./graphics-preparation').createGraphicsPreparation(), children: new Set(), stops: [], promise: null };
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
          const result = await launcher.launchEntry(active, { ...options, signal: pending.controller.signal,graphicsPreparation:pending.graphics });
          emit("entryChanged", { gameId: active.gameId, gamePath: active.gamePath });
          if (pending.controller.signal.aborted) return { kind: "cancelled", runtimeId: result.runtimeId };
          if (result.kind !== "process") return result;
          return { kind: result.kind, runtimeId: result.runtimeId, process: trackProcess(result.child),
            ...(result.graphicsWarnings?.length ? {graphicsWarnings: result.graphicsWarnings} : {}),
            ...(result.launchNotices?.length ? {launchNotices: result.launchNotices} : {}) };
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
    invalidateGraphicsPreparation(entry){const pending=launching.get(entry.gameId||entry.gamePath);return pending?.graphics.invalidate()||false;},
    stopProcess({ id, pid, stopToken } = {}) {
      const child = processes.get(id), binding = child && processStopBinding(child);
      if (!binding || child.pid !== pid || binding.token !== stopToken) return false;
      return requestProcessStop(child);
    },
    // `internal` carries backend-only inputs, such as a local archive that a
    // Components action chose; the launcher IPC never supplies it.
    async runtimeAction(managerId, action, payload, internal = {}) {
      const manager = managers.find(item => item.id === managerId);
      if (!manager) throw new Error("Runtime manager not found.");
      if (internal?.archiveFile) payload = { ...payload, archiveFile: internal.archiveFile };
      // Installs, removals, registrations and refreshed catalogs change what
      // translator choices list, whether or not the action succeeds.
      try {
        return await runRuntimeManagerAction({ manager, action, payload, userDataDir, logger, downloads, runtimeCoordinator,
          prerequisiteContext: { settings: launcher.loadSettings(), confirmRuntimeInstall: plan => callHost("confirmRuntimeInstall", plan) },
          readSettings: () => launcher.loadSettings().runtimes?.[managerId],
          saveSettings: async (next, previous) => {
            const before = launcher.loadSettings().runtimes;
            await runtimeCoordinator.applySettings({ runtimes: { [managerId]: previous } }, { runtimes: { [managerId]: next } });
            emit("settingsChanged", { managerId });
            if (!isDeepStrictEqual(before, launcher.loadSettings().runtimes)) emit("runtimeChanged", {});
          },
          chooseImportPath: () => {
            if (action === "registerCustom") return callHost("chooseImportPath", {
              label: `Register ${manager.label || manager.id}`, kinds: ["file", "directory"], extensions: [], buttonLabel: "Register"
            });
            const state = managerState(manager, launcher.loadSettings());
            const catalog = state.sections?.find(section => section.id === (payload?.sectionId || "default"))?.catalog || state.catalog || {};
            return callHost("chooseImportPath", { label: catalog.importLabel || manager.importLabel || `Import ${manager.label || manager.id}`,
              kinds: catalog.importInputKinds || manager.importInputKinds || ["directory"],
              extensions: catalog.importExtensions || manager.importExtensions || [] });
          },
          chooseInstalledActionInput: descriptor => callHost("chooseInstalledActionInput", descriptor),
          onStateChange: () => operations.runtimeStates(launcher.loadSettings(), [managerId])
        });
      } finally { emit("runtimeInventoryChanged", { managerId }); }
    },
    // Runtimes → Components: list, remove, import and reveal; see component-service.js.
    async componentAction(action, payload) {
      if (!["list", "remove", "import", "reveal", "sizes", "refresh"].includes(action)) throw new Error("Unknown component action.");
      if (shuttingDown) throw createAbortError("Launcher is closing.");
      components ||= require("./component-service").createComponentService({ userDataDir, registry, logger, callHost, downloads,
        confirmRuntimeInstall: plan => callHost("confirmRuntimeInstall", plan),
        settings: () => launcher.loadSettings(), running: getRunning,
        runtimeAction: (managerId, runtimeActionName, data, internal) => operations.runtimeAction(managerId, runtimeActionName, data, internal) });
      try { return await components[action](payload && typeof payload === "object" ? payload : {}); }
      finally { if (action === "remove" || action === "import") emit("runtimeInventoryChanged", {}); }
    },
    async moduleAction(entry, action, payload, settings, options = {}) {
      if (shuttingDown) throw createAbortError("Launcher is closing.");
      // Read-only and lock-free, so the inspector's Automatic label never waits
      // on or delays a game action, Play or an install.
      if (action === "runtimeAutomaticVersion") return launcher.automaticVersion(entry, settings || launcher.loadSettings());
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
            settings: settings || launcher.loadSettings(), signal: pending?.controller.signal, runtimeId: options?.runtimeId
          });
          if (JSON.stringify(GameStore.readGameRecord(userDataDir, entry.gameId)) !== before) emit("entryChanged", { gameId: entry.gameId, gamePath: entry.gamePath });
          // Local graphics callbacks stay inside the process; inspector IPC
          // carries only the selected runtime and its serializable capabilities.
          if (action === "graphicsInputs") return {runtimeId: result.runtimeId, graphicsInputs: result.graphicsInputs,
            ...(result.filesUnavailable ? {filesUnavailable: true} : {})};
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
        onRuntimeStateChange: change => emit("runtimeChanged", change || {}),
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
    // Main owns availability. Refresh and runtime checks share this per-game
    // worker job, including the same positive or negative availability result.
    async libraryEntry(entry, settings, { availability, refreshMetadata = false } = {}) {
      if (typeof availability?.available !== "boolean") throw new Error("Library work requires an availability result.");
      let fresh = entry, metadataError = null;
      if (refreshMetadata && availability.available) {
        try { fresh = await metadata.refreshEntry(currentEntry(entry), settings, { availability, persist: false }); }
        catch (error) { metadataError = error.message; }
      }
      if (shuttingDown) return null;
      const checks = launcher.resolveEntryChecks(fresh, settings, { availability: availability.available ? null : availability });
      return { entry: fresh, checks, metadataError };
    },
    async refreshSaveLocations(entry, settings) {
      // Engines read save locations from game files. Without them the stored
      // locations stay, rather than ones resolved from absent configuration.
      if (!(await GameAvailability.checkGameAvailability(currentEntry(entry), { userDataDir })).available) return currentEntry(entry);
      // The record is read after the check, so a runtime chosen while it ran
      // is the one whose locations are written.
      const hydrated = hydrateGameSaveLocations(currentEntry(entry), registry, { settings, userDataDir });
      GameStore.writeGameRecord(userDataDir, hydrated);
      emit("entryChanged", { gameId: hydrated.gameId, gamePath: hydrated.gamePath });
      return hydrated;
    },
    // Main applies the result: it moves its own state for the game's path and
    // checks availability before the library updates.
    async relocateEntry(entry, settings) {
      if (shuttingDown) throw createAbortError("Launcher is closing.");
      return relocation.relocate(entry, settings || launcher.loadSettings());
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
      let availability = { available: true };
      try {
        entry = await refreshedEntry(entry, settings);
        emit("entryChanged", { gameId: entry.gameId, gamePath: entry.gamePath });
      } catch (error) {
        if (error.code !== GameAvailability.CODE) throw error;
        // Saves kept outside the game's files stay usable from the stored record.
        entry = currentEntry(entry); availability = error.availability;
      }
      const moduleId = resolveModuleId(entry), info = registry.getModuleInfo(moduleId);
      if (registry.getModule(moduleId)?.getRuntimeProvider?.(entry.runtimeId)?.supports?.saveLocation === false) throw new Error("Save tools are unavailable for this runtime.");
      if (availability.available) await registry.getModule(moduleId)?.prepareSaveLocation?.(entry, { userDataDir });
      const saveDir = saveDirectoryForEntry(entry, registry);
      if (!saveDir) throw new Error(`Save directory is not available for ${info.label}.`);
      // Creating a save folder inside the missing location would recreate an
      // empty copy of the game folder in its place.
      if (GameAvailability.affectsPath(availability, saveDir)) throw GameAvailability.unavailableError(availability, "This game's saves are unavailable.");
      fs.mkdirSync(saveDir, { recursive: true });
      const labels = entryModuleLabels(info, entry);
      return { saveDir, directoryChoices: entry.saveLocations || [], moduleId,
        moduleLabel: labels.label, moduleShortLabel: labels.shortLabel, name: entry.name,
        canEditJson: info.supports?.saveEditing === true, structuredActions: registry.getModule(moduleId)?.save?.structured || null };
    },
    async selectSaveLocation(entry, directory, settings) {
      // Detected save locations come from the game's files.
      await GameAvailability.assertGameAvailable(currentEntry(entry), { userDataDir });
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
      return patcher.patchGame(entry, family === "libs" ? { selections, appVersion: appInfo.version || null, context: context(launcher.loadSettings()) } : {
        appVersion: appInfo.version || null, toolsButtonVisible: options.toolsButtonVisible ?? launcher.resolveToolsButtonVisible(entry, launcher.loadSettings())
      });
    },
    cancelDownload: id => downloads.cancel(id),
    // The game's running session lives in this lane, so settings that apply
    // live reach its module here.
    runtimeSettingsChanged(entry, runtimeId, settings) {
      return registry.getModule(resolveModuleId(entry))?.runtimeSettingsChanged?.(entry, runtimeId, settings) === true;
    },
    // Settles runtime removals that an exit interrupted, removes derived data
    // that modules and core services declare, then superseded runtime versions that Play installed on its own, through
    // Runtimes' removal. Never runs while a game runs and never fails the caller.
    async maintainStorage() {
      if (shuttingDown) return null;
      const StorageMaintenance = require("./storage-maintenance");
      // The launcher answers for preparations and downloads in other lanes; a
      // launcher that cannot answer counts as busy.
      const busy = async () => shuttingDown || Object.keys(getRunning() || {}).length > 0 ||
        await callHost("storageUpkeepBusy").then(value => value !== false, () => true);
      if (!await busy()) require("./coordinated-runtime-managers").settleInterruptedRemovals({ userDataDir, managers });
      const summary = await StorageMaintenance.maintainStorage({ userDataDir, stores: StorageMaintenance.listStores(registry), running: getRunning(), busy, logger });
      if (summary.skipped || summary.interrupted || await busy()) return summary;
      const { removed } = await require("./runtime-install-origins").pruneSuperseded({ userDataDir, managers, settings: launcher.loadSettings(),
        gameIds: GameStore.listGameIds(userDataDir), isRunning: busy, logger,
        remove: ({ managerId, ...payload }) => operations.runtimeAction(managerId, "uninstall", payload) });
      return { ...summary, runtimes: removed };
    }
  };
  for (const method of ["launchEntry", "refreshSaveLocations", "saveInfo", "selectSaveLocation", "save", "patcher"]) {
    const operation = operations[method];
    operations[method] = (entry, ...args) => gameLifecycle.use(entry, () => operation(entry, ...args));
  }
  return operations;
}

module.exports = { createBackendOperations, listRuntimeManagers };
