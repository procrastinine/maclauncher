const fs = require("node:fs");
const ReShade = require("../modules/shared/reshade");
const warnGraphics = require("../modules/shared/graphics-warning");
const os = require("node:os");
const path = require("node:path");
const Modules = require("../modules/registry");
const GameData = require("../modules/shared/game-data");
const AppBundle = require("../modules/shared/runtime/app-bundle");
const LaunchScript = require("../modules/shared/runtime/launch-script");
const LaunchArguments = require("../modules/shared/runtime/launch-arguments");
const GameStore = require("./game-store");
const NetworkAccess = require("./network-access");
const LibraryState = require("./library-state");
const { pickRuntimeId } = require("./runtime-utils");
const { canLaunchEntry, resolveRuntimeSupportForEntry } = require("./launch-capability");
const { mergeDetectedEntry, detectedNativeRuntime } = require("./launch-utils");
const { hydrateGameSaveLocations, saveDirectoryForEntry } = require("./save-locations");
const { createRuntimeSettingsStore } = require("./runtime-settings");
const { createProcessLauncher } = require("./processes");
const Rosetta = require("../modules/shared/runtime/rosetta");
const { readJsonObject, writeJsonAtomic } = require("./json-files");
const { createSaveService } = require("./save-service");
const { prepareForLaunch, listRuntimeManagers } = require("./runtime-preparation");
const { coordinatorFor } = require("./runtime-coordinator");
const { instrumentRuntimeManagers, withRuntimeCoordinator, withRuntimeUseScope, withRuntimeMutation, createRuntimeUseScope } = require("./coordinated-runtime-managers");
const { mergeSettingsChanges } = require("./settings-merge");
const AppMaintenance = require("../modules/shared/runtime/app-maintenance");
const SteamApi = require("../modules/shared/runtime/steamworks/automatic");
const SteamClient = require("../modules/shared/runtime/steamworks/installed-client");
const Installers = require("../modules/shared/installers");
const { prepareModuleInput, applyInputChanges } = require("../modules/shared/writable-input");
const { isAbortError } = require("../modules/shared/runtime/download-utils");
const { afterProcessStop, waitForProcessStop } = require("./process-lifecycle");

const isRecord = value => Boolean(value && typeof value === "object" && !Array.isArray(value));
const defaultUserDataDir = () => path.join(os.homedir(), "Library", "Application Support", "maclauncher");

function resolveModuleId(entry) {
  const moduleId = typeof entry?.moduleId === "string" ? entry.moduleId.trim() : "";
  const engine = typeof entry?.engine === "string" ? entry.engine.trim() : "";
  if ((moduleId === "web" || moduleId === "unknown") && engine && engine !== moduleId) return engine;
  return moduleId || engine || "unknown";
}

function resolveHostedRuntimeInfo(info) {
  const hosted = info?.runtime?.hosted;
  if (typeof hosted === "string") return hosted.trim() ? { id: hosted.trim() } : null;
  return isRecord(hosted) && typeof hosted.id === "string" && hosted.id.trim()
    ? { ...hosted, id: hosted.id.trim() } : null;
}

function resolveNativeLaunchPath(entry) {
  for (const value of [entry?.nativeAppPath, entry?.gamePath]) {
    if (typeof value !== "string") continue;
    try {
      if (fs.statSync(value).isDirectory() && (value.toLowerCase().endsWith(".app") || AppBundle.inspectApplicationBundle(value))) return value;
    } catch {}
  }
  return null;
}

function resolveModuleSettings(settings, moduleId) {
  return isRecord(settings?.modules?.[moduleId]) ? settings.modules[moduleId] : {};
}

/** Shared application services. No Electron dependency, UI creation, or implicit downloads. */
function createLauncher({
  userDataDir = defaultUserDataDir(), registry = Modules, logger = console, ui,
  app, processOptions = {}, spawn, launchHosted, onEntryChange, onRuntimeStateChange,
  writeCheatsFile: writeCheatsOverride, isGameRunning, downloads, onPreparationChange, confirmRuntimeInstall,
  rosetta = Rosetta, onToolLaunch, onToolProcessSpawn, onGameProcessSpawn, runtimeCoordinator, steamApiService = SteamApi.prepareAutomaticLaunch,
  steamClientService = SteamClient.prepareNativeLaunch,
  inputPreparation = Installers.prepareInput, getRuntimeManagerState
} = {}) {
  userDataDir = path.resolve(userDataDir);
  const preparationProgress = require("./progress-reporter").createProgressReporter(onPreparationChange);
  const reportPreparation = state => preparationProgress.report(state.gamePath, state);
  runtimeCoordinator ||= coordinatorFor(userDataDir).client();
  const gameLifecycle = require("./game-lifecycle").createGameLifecycle({ userDataDir, coordinator: runtimeCoordinator });
  let runtimeManagers;
  function managedRuntimes() {
    if (!runtimeManagers) { runtimeManagers = listRuntimeManagers(registry); instrumentRuntimeManagers(runtimeManagers); }
    return runtimeManagers;
  }
  const runtimeSettingsStore = createRuntimeSettingsStore({ userDataDir });
  const processes = createProcessLauncher({ spawn, rosetta });
  const activeRuns = new Map();
  const pendingLaunches = new Map();
  const activeSaveRoots = new Map();
  function saveIdentity(entry, runtimeId = entry.runtimeId) {
    const directory = saveDirectoryForEntry(entry, registry, runtimeId);
    if (typeof directory !== "string" || !path.isAbsolute(directory)) return null;
    try { return fs.realpathSync(directory); } catch { return path.resolve(directory); }
  }
  const saveService = createSaveService({ userDataDir, registry,
    isGameRunning: entry => {
      if (isGameRunning?.(entry) || activeRuns.get(entry.gameId || entry.gamePath)) return true;
      const root = saveIdentity(entry);
      return root && [...activeSaveRoots.keys()].some(active => active === root || active.startsWith(root + path.sep) || root.startsWith(active + path.sep));
    } });
  const spawnDetachedChecked = (cmd, args, options, needsRosetta, context) =>
    processes.spawnDetachedChecked(cmd, args, { ...options, ...processOptions }, needsRosetta, context);

  function loadSettings() {
    const raw = readJsonObject(path.join(userDataDir, "settings.json")) || {};
    const modules = isRecord(raw.modules) ? { ...raw.modules } : {};
    for (const info of registry.listModules()) {
      modules[info.id] = {
        ...(isRecord(info.settingsDefaults) ? info.settingsDefaults : {}),
        ...(isRecord(modules[info.id]) ? modules[info.id] : {})
      };
    }
    const launcher = isRecord(raw.launcher) ? raw.launcher : {};
    return {
      modules,
      runtimes: isRecord(raw.runtimes) ? raw.runtimes : {},
      launcher: {
        showIcons: true, showNonDefaultTags: true, ...launcher, networkAccess: launcher.networkAccess === true,
        library: LibraryState.normalizeLibraryState(launcher.library)
      }
    };
  }

  function resolveModuleNativeLaunchPath(entry, mod) {
    return typeof mod?.resolveNativeLaunchPath === "function"
      ? mod.resolveNativeLaunchPath(entry, { resolveNativeLaunchPath, app, fs, path, userDataDir })
      : resolveNativeLaunchPath(entry);
  }

  function resolveDefaultRuntimeForModule(mod, info, moduleSettings, settings, entry) {
    const configured = typeof moduleSettings?.defaultRuntime === "string"
      ? moduleSettings.defaultRuntime.trim().toLowerCase() : "";
    if (configured) return configured;
    const preferred = typeof mod?.resolveDefaultRuntime === "function"
      ? mod.resolveDefaultRuntime(entry, moduleSettings, { app, userDataDir, settings, getRuntimeManagerState }) : null;
    return String(preferred || info.runtime?.default || resolveHostedRuntimeInfo(info)?.id || "")
      .trim().toLowerCase();
  }

  // Display effective defaults without persisting automatic choices as overrides.
  function getResolvedModuleSettings(settings = loadSettings()) {
    const modules = { ...settings.modules };
    for (const info of registry.listModules()) {
      const mod = registry.getModule(info.id);
      if (typeof mod?.resolveDefaultRuntime !== "function") continue;
      const moduleSettings = resolveModuleSettings(settings, info.id);
      modules[info.id] = { ...moduleSettings,
        defaultRuntime: resolveDefaultRuntimeForModule(mod, info, moduleSettings, settings) };
    }
    return modules;
  }

  function resolveRuntimeForEntry(requested, mod, info, entry, moduleSettings, settings, { strict = false } = {}) {
    const normalized = typeof requested === "string" ? requested.trim().toLowerCase() : "";
    const context = { app, userDataDir, settings };
    const supported = resolveRuntimeSupportForEntry(mod, info, entry, moduleSettings, context);
    if (strict && normalized && !supported.includes(normalized)) {
      throw new Error(`Runtime ${normalized} is not supported for ${info.label || info.id}. Supported: ${supported.join(", ")}`);
    }
    const nativePath = resolveModuleNativeLaunchPath(entry, mod);
    if (strict && normalized === "native" && !nativePath) throw new Error("Native app bundle not found.");
    if (strict && normalized && typeof mod?.canLaunchRuntime === "function" &&
        !mod.canLaunchRuntime(normalized, entry, moduleSettings, context)) {
      throw new Error(`Runtime ${normalized} cannot launch this game. Check its runtime and content configuration.`);
    }
    if (strict && normalized) return normalized;
    const defaultRuntime = normalized && supported.includes(normalized) &&
      (normalized !== "native" || nativePath)
      ? String(moduleSettings.defaultRuntime || info.runtime?.default ||
          resolveHostedRuntimeInfo(info)?.id || "").trim().toLowerCase()
      : resolveDefaultRuntimeForModule(mod, info, moduleSettings, settings, entry);
    const automaticSupported = supported.filter(id => !info.runtime?.entries?.[id]?.runtimeProvider ||
      id === defaultRuntime || id === info.runtime?.default || id === moduleSettings.defaultRuntime || id === normalized);
    return pickRuntimeId({
      requestedRuntime: requested, supported: automaticSupported, defaultRuntime, nativePath,
      canLaunchRuntime: mod?.canLaunchRuntime, entry, moduleSettings, context
    });
  }

  function getModuleCheats(moduleId) {
    const cheats = registry.getModule(moduleId)?.cheats;
    return registry.getModuleInfo(moduleId)?.supports?.cheats && typeof cheats?.normalize === "function"
      ? cheats : null;
  }
  function normalizeCheatsForModule(moduleId, value) {
    return getModuleCheats(moduleId)?.normalize(value) || null;
  }
  function writeCheatsFile(gameId, moduleId, value) {
    if (writeCheatsOverride) return writeCheatsOverride(gameId, moduleId, value);
    const cheats = normalizeCheatsForModule(moduleId, value);
    if (!cheats || !gameId) return null;
    const filePath = GameData.resolveGameCheatsPath(userDataDir, gameId);
    // Avoid waking watchers when the stored settings have not changed.
    const stored = readJsonObject(filePath);
    if (JSON.stringify(stored) !== JSON.stringify(cheats)) writeJsonAtomic(filePath, cheats);
    return filePath;
  }
  function resolveToolsButtonVisible(entry, settings) {
    const moduleId = resolveModuleId(entry);
    if (!getModuleCheats(moduleId)) return false;
    const override = entry.moduleData?.toolsButtonVisibleOverride;
    const defaultValue = resolveModuleSettings(settings, moduleId).toolsButtonVisible;
    return typeof override === "boolean" ? override : defaultValue !== false;
  }

  function persistEntry(entry) {
    const current = GameStore.readGameRecord(userDataDir, entry.gameId);
    if (JSON.stringify(current) === JSON.stringify(entry)) return null;
    return GameStore.writeGameRecord(userDataDir, entry);
  }

  function getLaunchContext(entry, settings = loadSettings(), options = {}) {
    const moduleId = resolveModuleId(entry);
    const mod = registry.getModule(moduleId);
    const info = registry.getModuleInfo(moduleId);
    const runtimeId = options.runtimeId || entry.runtimeId;
    const context = {
      settings, moduleSettings: resolveModuleSettings(settings, moduleId), userDataDir, logger, ui, app,
      signal: options.signal,
      downloads: typeof downloads === "function" ? downloads() : downloads,
      autoInstallRuntime: options.autoInstallRuntime === true,
      confirmRuntimeInstall: typeof confirmRuntimeInstall === "function"
        ? plan => confirmRuntimeInstall(plan, entry) : undefined,
      toolsButtonVisible: options.toolsButtonVisible ?? resolveToolsButtonVisible(entry, settings),
      cheatsFilePath: options.cheatsFilePath ?? writeCheatsFile(entry.gameId, moduleId, entry.cheats),
      runtimeId,
      moduleLaunchOptions: options.moduleOptions,
      isGameRunning: () => Boolean(isGameRunning?.(entry) || activeRuns.get(entry.gameId || entry.gamePath)),
      onProgress: state => {
        options.onProgress?.(state);
        if (options.reportPreparation === true) reportPreparation({ gamePath: entry.gamePath, ...state });
      },
      assertSaveWriteAllowed: () => saveService.assertWriteAllowed(entry),
      snapshotSaves: payload => saveService.createSnapshot(entry, payload),
      runtimeSettings: options.runtimeSettings ?? runtimeSettingsStore.resolveForEntry(entry, settings, info, runtimeId),
      ...(options.runtimeSettings != null ? { runtimeSettingsOverrides: options.runtimeSettingsOverrides ?? options.runtimeSettings } : {}),
      onEntryChange: patch => {
        for (const key of ["contentRootDir", "defaultSaveDir", "moduleData", "runtimeData"]) {
          if (Object.hasOwn(patch || {}, key)) entry[key] = patch[key];
        }
        if (onEntryChange) onEntryChange(entry, patch);
        else if (entry.gameId) {
          const stored = GameStore.readGameRecord(userDataDir, entry.gameId);
          if (stored) {
            for (const key of ["contentRootDir", "defaultSaveDir", "moduleData", "runtimeData"]) {
              if (Object.hasOwn(patch || {}, key)) stored[key] = patch[key];
            }
            persistEntry(stored);
          }
        }
      },
      onRuntimeStateChange,
      onToolProcessSpawn: async (child, options) => {
        // Register temporary ownership before an asynchronous reservation bind,
        // so shutdown can see a helper as soon as the module has spawned it.
        const identity = Object.fromEntries(Object.entries({ gameId: entry.gameId, moduleId, runtimeId })
          .filter(([, value]) => typeof value === "string" && /^[a-zA-Z0-9._:-]{1,128}$/.test(value)));
        await onToolProcessSpawn?.(child, options, identity);
        await gameLifecycle.bindProcess(child);
      }
    };
    context.networkAllowed = NetworkAccess.allowedForEntry(entry, settings, info, runtimeId);
    context.runtimeSettings = { ...context.runtimeSettings, networkIsolation: !context.networkAllowed };
    context.gameArguments = options.gameEffects === true
      ? (options.gameArguments != null ? LaunchArguments.validate(options.gameArguments)
        : LaunchArguments.parse(entry.launchArguments || "")) : [];
    const graphicsDiagnostics = Object.fromEntries(["diagnostics", "capture", "gpuTiming", "trace"]
      .filter(key => typeof options.graphicsDiagnostics?.[key] === "boolean")
      .map(key => [key, options.graphicsDiagnostics[key]]));
    let gameEffects, preparedGraphics, graphicsProcessBound = false;
    context.bindGameEffectsProcess = child => {
      if (!preparedGraphics || graphicsProcessBound || !Number.isSafeInteger(child?.pid) || child.pid < 1) return;
      graphicsProcessBound = true;
      try { ReShade.bindLaunchProcess(entry, child.pid, {userDataDir}); }
      catch (error) { warnGraphics(logger, "Graphics live controls are unavailable for this launch.", error.message); }
    };
    const prepareGameEffects = graphicsArchitecture => options.gameEffects === true
      ? (async () => {
        preparedGraphics = undefined;
        delete context.graphicsPreparationFailure;
        const diagnosticRequest = (graphicsDiagnostics.diagnostics ?? process.env.MACLAUNCHER_RESHADE_DIAGNOSTICS === "1") &&
          ((graphicsDiagnostics.capture ?? process.env.MACLAUNCHER_RESHADE_CAPTURE === "1") ||
            (graphicsDiagnostics.gpuTiming ?? process.env.MACLAUNCHER_RESHADE_GPU_TIMING === "1"));
        const processorNeeded = ReShade.executionRequirements(context.effectsEntry || entry, {diagnostics: diagnosticRequest}).needed.processor;
        const graphicsHost = info.runtime?.entries?.[runtimeId]?.graphicsHost || null;
        const LiveResources = require("../modules/shared/reshade/live-resources");
        if (!processorNeeded && !LiveResources.supportsHost(graphicsHost)) return {};
        const graphicsRoot = options.graphicsRuntimeRoot || (options.presentationLibrary ? path.dirname(options.presentationLibrary) : undefined);
        if (!processorNeeded && !LiveResources.supported(graphicsRoot || ReShade.runtimeRoot(app), graphicsHost)) return {};
        if (!Object.hasOwn(context, "graphicsInputs")) context.graphicsInputs = await mod?.resolveGraphicsInputs?.(entry, context) || null;
        context.graphicsInputs = require("../modules/shared/runtime/native-graphics-inputs").withInputs(entry, {
          runtimeId, graphicsInputs: context.graphicsInputs,
          declaredArchitecture: info.runtime?.entries?.[runtimeId]?.graphicsArchitecture });
        if (graphicsArchitecture) context.graphicsInputs = {...context.graphicsInputs, architecture: graphicsArchitecture};
        const environment = await ReShade.prepare(context.effectsEntry || entry, { userDataDir, app, signal: options.signal, runtimeId, logger, settings,
        ...(graphicsRoot ? { root: fs.realpathSync(graphicsRoot) } : {}), ...graphicsDiagnostics,
        graphicsInputs: context.graphicsInputs,
        graphicsArchitecture: context.graphicsInputs?.architecture || info.runtime?.entries?.[runtimeId]?.graphicsArchitecture,
        explicitHost: info.runtime?.entries?.[runtimeId]?.graphicsHost === "explicit",
        graphicsHost,
        useModel: version => options.runtimeUseScope?.useRuntime({ managerId: "graphics-models", version }),
        useRuntime: identity => options.runtimeUseScope?.useRuntime(identity) });
        // Component development can pair a checked processor with a separately
        // verified asset root. Preparation and the final merge remain shared.
        if (environment.DYLD_INSERT_LIBRARIES && options.presentationLibrary) {
          const library = fs.realpathSync(options.presentationLibrary);
          if (!fs.statSync(library).isFile()) throw new Error("The graphics processor must be a regular file.");
          const MachO = require("../modules/shared/runtime/macho-load-commands");
          MachO.assertSystemLibraryClosure(MachO.readMachOLoadCommands(library, { architecture: process.arch }),
            { fileType: 6, maximumMacOS: require("../modules/shared/runtime/bundled-native").systemVersionSync() });
          environment.DYLD_INSERT_LIBRARIES = library;
        }
        if (environment.DYLD_INSERT_LIBRARIES) preparedGraphics = environment;
        return environment;
      })().catch(error => {
        if (options.signal?.aborted || isAbortError(error)) throw error;
        // Graphics preparation is additive. A missing shader, provider or
        // allocation must not prevent the original game from starting.
        context.graphicsPreparationFailure = {reason: error?.message || String(error)};
        warnGraphics(logger, "Graphics processing could not be prepared. Starting with the game's original rendering.",
          context.graphicsPreparationFailure.reason);
        return {};
      }) : Promise.resolve({});
    let graphicsProcessArchitecture;
    context.getGameEffectsEnvironment = ({needsRosetta} = {}) => {
      if (needsRosetta === true && graphicsProcessArchitecture !== "x86_64") {
        // Scripts can select their real executable after an initial inspection.
        // Complete earlier preparation before replacing its unused publication.
        const previous = gameEffects;graphicsProcessArchitecture = "x86_64";
        gameEffects = (async () => {
          if (previous) await previous.catch(() => {});
          if (graphicsProcessBound) throw new Error("The running graphics process cannot change architecture.");
          return prepareGameEffects("x86_64");
        })();
      }
      return gameEffects ||= prepareGameEffects(graphicsProcessArchitecture);
    };
    context.applyGameEnvironment = async (base, { gameArguments = true, needsRosetta } = {}) => {
      const environment = ReShade.mergeEnvironment(base || process.env, await context.getGameEffectsEnvironment({needsRosetta}));
      if (options.gameEffects === true && gameArguments !== false && context.gameArguments.length)
        environment.MACLAUNCHER_GAME_ARGUMENTS = JSON.stringify(context.gameArguments);
      else delete environment.MACLAUNCHER_GAME_ARGUMENTS;
      return environment;
    };
    context.prepareSteamApi = (request, { baseEnvironment = process.env } = {}) => steamApiService({
      ...request,
      ownedDirectory: request?.ownedDirectory || path.join(GameData.resolveGameModuleDir(userDataDir, entry.gameId, moduleId), "steam")
    }, { userDataDir, resourcesRoot: app?.isPackaged ? process.resourcesPath : undefined, baseEnvironment });
    context.withRuntimeMutation = (identity, fn) => {
      if (!managedRuntimes().some(manager => manager.id === identity?.managerId)) throw new Error("Runtime mutation must identify a registered manager.");
      if (typeof fn !== "function") throw new TypeError("Runtime mutation needs an asynchronous operation.");
      const mutate = () => withRuntimeCoordinator(runtimeCoordinator, userDataDir, () => withRuntimeMutation(identity, fn));
      return options.runtimeUseScope ? options.runtimeUseScope.withMutablePreparation(identity, mutate) : mutate();
    };
    const scope = options.runtimeUseScope;
    if (scope) {
      context.useRuntime = identity => scope.useRuntime(identity);
      context.recordRuntimeUse = identity => scope.recordSelection(identity);
      context.flushRuntimeUses = () => scope.flushSelections();
    }
    context.onProcessSpawn = async child => {
      options.ownedProcesses?.add(child);
      // Publish the owned PID before awaiting lease IPC or module readiness.
      if (options.reportPreparation === true) onGameProcessSpawn?.(entry, child, runtimeId);
      options.signal?.throwIfAborted();
      context.bindGameEffectsProcess(child);
      await scope?.bind(child.pid);
    };
    const processAdapter = options.processAdapter;
    if (processAdapter != null && typeof processAdapter !== "function") throw new TypeError("A process adapter must be a function.");
    context.spawnDetachedChecked = async (cmd, args, options, needsRosetta) => {
      context.signal?.throwIfAborted();
      if (typeof mod?.getSteamApiRequirement === "function") {
        const plan = { cmd, args, options: options || {} };
        const request = await mod.getSteamApiRequirement(entry, context, plan);
        if (request?.required === true) {
          const prepared = await context.prepareSteamApi(request, { baseEnvironment: plan.options.env || process.env });
          options = { ...plan.options, env: prepared.environment };
          if (typeof mod.applySteamApi === "function") {
            const applied = await mod.applySteamApi(entry, prepared, context, { ...plan, options });
            if (applied) { cmd = applied.cmd || cmd; args = applied.args || args; options = applied.options || options; }
          }
        }
      }
      if (scope) {
        await scope.flushSelections();
        const ids = new Set([info.runtime?.manager?.[runtimeId], ...(info.runtime?.prerequisites?.[runtimeId] || []).map(item => item.managerId)].filter(Boolean));
        await scope.useProcessArtifacts(cmd, args, managedRuntimes().filter(manager => ids.has(manager.id)));
      }
      options = { ...options, env: await context.applyGameEnvironment(options?.env, { gameArguments: options?.gameArguments, needsRosetta }),
        networkIsolation: context.networkAllowed === false };
      context.signal?.throwIfAborted();
      // Instrumentation wraps the same final handoff used by Play and the CLI.
      // It cannot replace lazy graphics preparation or omit its scoped merge.
      if (!processAdapter) return spawnDetachedChecked(cmd, args, options, needsRosetta, context);
      const launch = async (command, parameters, spawnOptions, translation = needsRosetta) =>
        spawnDetachedChecked(command, parameters,
          { ...spawnOptions, env: await context.applyGameEnvironment(spawnOptions?.env, { gameArguments: spawnOptions?.gameArguments, needsRosetta: translation }),
            networkIsolation: context.networkAllowed === false }, translation, context);
      return processAdapter(cmd, args, options, needsRosetta, launch);
    };
    context.spawnOwnedChecked = (cmd, args, options, needsRosetta) =>
      context.spawnDetachedChecked(cmd, args, { ...options, detached: false }, needsRosetta);
    context.launchForTools = async toolOptions => {
      if (context.isGameRunning()) throw new Error("Quit the game before starting these tools.");
      const result = await launchEntry(entry, { ...toolOptions, strict: true });
      if (result.kind === "process") await onToolLaunch?.(entry, result);
      return result;
    };
    context.ensureRosetta = options => rosetta.ensure({ ...context, ...options });
    return context;
  }

  function getGameLaunchContext(entry, settings, options = {}) {
    return getLaunchContext(entry, settings, { ...options, gameEffects: true });
  }

  async function resolveEntry(inputPath, { runtimeId, persist = true, settings = loadSettings(), detectionReport, signal, onProgress } = {}) {
    if (typeof inputPath !== "string" || !inputPath.trim()) throw new Error("Missing game path.");
    const input = path.resolve(inputPath);
    const games = GameStore.loadGames(userDataDir);
    let existing = games.find(entry => [entry.importPath, entry.gamePath].some(value =>
      typeof value === "string" && path.resolve(value) === input));
    const sourcePath = existing?.importPath && fs.existsSync(existing.importPath) ? existing.importPath : input;
    const gameId = existing?.gameId || Installers.findCachedInputGameId(userDataDir, sourcePath) || GameData.createGameId();
    return gameLifecycle.use({ gameId, gamePath: existing?.gamePath || input }, async () => {
      const prepared = await inputPreparation(sourcePath, { userDataDir, gameId, signal, onProgress, readOnly: !persist });
      const detectPath = prepared.inputPath;
      const detected = detectionReport?.detected && !detectionReport.error &&
        path.resolve(detectionReport.input?.requestedPath || "") === path.resolve(detectPath)
        ? detectionReport.detected
        : typeof registry.detectGameAsync === "function" ? await registry.detectGameAsync(detectPath) : registry.detectGame(detectPath);
      // A folder, its executable and its index can identify the same detected game.
      // Match again after detection to retain its ID, save overrides and settings.
      existing ||= games.find(entry => typeof entry.gamePath === "string" &&
        typeof detected.gamePath === "string" && path.resolve(entry.gamePath) === path.resolve(detected.gamePath));
      let entry = mergeDetectedEntry(existing, detected, { now: existing?.lastPlayedAt || 0 });
      entry.gameId = existing?.gameId || gameId;
      await gameLifecycle.claim(entry);
      entry.importPath = existing?.importPath || input;
      if (prepared.containerData) entry.containerData = prepared.containerData;
      entry.moduleId = resolveModuleId(entry);
      const mod = registry.getModule(entry.moduleId);
      const info = registry.getModuleInfo(entry.moduleId);
      if (typeof mod?.mergeEntry === "function") entry = mod.mergeEntry(existing, entry, settings);
      prepareModuleInput(entry, registry, { settings, userDataDir, logger, ui, app, signal, onProgress, readOnly: !persist });
      entry = hydrateGameSaveLocations(entry, registry, { settings, userDataDir });
      entry.gameType ??= info.gameType;
      entry.contentRootDir ??= entry.gamePath;
      entry.createdAt = existing?.createdAt || Date.now();
      entry.updatedAt = Date.now();
      entry.schemaVersion ??= 1;
      const moduleSettings = resolveModuleSettings(settings, entry.moduleId);
      const savedDefault = readJsonObject(path.join(userDataDir, "settings.json"))?.modules?.[entry.moduleId]?.defaultRuntime;
      // Older settings snapshots materialized every module's shipped default.
      // Such a value must not replace a detected publisher-provided Mac app.
      const originalNative = !runtimeId && resolveModuleNativeLaunchPath(entry, mod)
        ? detectedNativeRuntime(existing, detected, info, { defaultRuntime: savedDefault }) : null;
      entry.runtimeId = resolveRuntimeForEntry(runtimeId ?? originalNative ?? entry.runtimeId, mod, info, entry,
        moduleSettings, settings, { strict: Boolean(runtimeId) });
      entry.networkAccess = NetworkAccess.preferenceForEntry(existing || {}, settings, entry.runtimeId);
      const cheatsPath = existing?.gameId && GameData.resolveGameCheatsPath(userDataDir, existing.gameId);
      entry.cheats = normalizeCheatsForModule(entry.moduleId, (cheatsPath && readJsonObject(cheatsPath)) || entry.cheats);
      if (persist) {
        if (!existing && typeof mod?.onImport === "function") {
          await mod.onImport(entry, { settings, userDataDir, logger, ui, app });
        }
        persistEntry(entry);
      }
      return entry;
    });
  }

  async function launchEntry(entry, options = {}) {
    const key = entry.gameId || entry.gamePath;
    if (pendingLaunches.has(key)) return pendingLaunches.get(key);
    const pending = gameLifecycle.use(entry, () => withRuntimeCoordinator(runtimeCoordinator, userDataDir, async () => {
      try { return await launchEntryOnce(entry, options); }
      catch (error) {
        if (error.code !== "RUNTIME_CHANGED") throw error;
        // A concurrent install/removal can finish between selection and its lease.
        // Resolve the module's actual selection afresh once, rather than launch stale files.
        return launchEntryOnce(entry, options);
      }
    })).catch(error => {
      if (isAbortError(error)) return { kind: "cancelled", runtimeId: options.runtimeId || entry.runtimeId };
      throw error;
    });
    pendingLaunches.set(key, pending);
    try { return await pending; }
    finally { pendingLaunches.delete(key); reportPreparation({ gamePath: entry.gamePath, phase: "done" }); }
  }

  async function launchEntryOnce(entry, options = {}) {
    const settings = options.settings || loadSettings();
    const moduleId = resolveModuleId(entry);
    const mod = registry.getModule(moduleId);
    const info = registry.getModuleInfo(moduleId);
    const runtimeId = resolveRuntimeForEntry(options.runtimeId ?? entry.runtimeId, mod, info, entry,
      resolveModuleSettings(settings, moduleId), settings, { strict: options.strict === true });
    if (!runtimeId) throw new Error(`No supported runtime for ${info.label || moduleId}.`);
    if (typeof entry.networkAccess !== "boolean") {
      entry.networkAccess = NetworkAccess.preferenceForEntry(entry, settings, runtimeId);
      const stored = entry.gameId && GameStore.readGameRecord(userDataDir, entry.gameId);
      if (typeof stored?.networkAccess === "boolean") entry.networkAccess = stored.networkAccess;
      else if (stored) {
        try { GameStore.setGameNetworkAccess(userDataDir, entry.gameId, entry.networkAccess); }
        catch (error) { try { Promise.resolve(logger?.warn?.("The game's network setting could not be saved.", error.message)).catch(() => {}); } catch {} }
      }
    }
    if (!canLaunchEntry({ mod, info, entry, runtimeId,
      moduleSettings: resolveModuleSettings(settings, moduleId), context: { app, userDataDir, settings } })) {
      throw new Error(`Runtime ${runtimeId} cannot launch this game. Inspect its format and runtime settings.`);
    }
    const runtimeUseScope = createRuntimeUseScope({ coordinator: runtimeCoordinator, managers: managedRuntimes(), userDataDir, readSettings: loadSettings });
    const ownedProcesses = new Set();options = {...options, ownedProcesses};
    let retained = false;
    try {
      return await withRuntimeUseScope(runtimeUseScope, async () => {
        const context = getGameLaunchContext(entry, settings, { ...options, runtimeId, runtimeUseScope, reportPreparation: true, autoInstallRuntime: options.autoInstallRuntime !== false });
        const entryBeforePreparation = structuredClone(entry);
        if (entry.moduleData?.runtimeProviderSaveLocations && !mod?.getRuntimeProvider?.(runtimeId)) {
          Object.assign(entry, hydrateGameSaveLocations(entry, registry, { settings, userDataDir, runtimeId }));
        }
        prepareModuleInput(entry, registry, context);
        if (options.autoInstallRuntime !== false) {
          reportPreparation({ gamePath: entry.gamePath, phase: "check", label: "Starting game…" });
          const prepared = await prepareForLaunch({ entry, mod, info, context, registry,
            report: state => reportPreparation({ gamePath: entry.gamePath, ...state }),
            runAction: action => runAction(entry, action, {}, { settings: context.settings }),
            install: async (manager, payload, labels = {}) => {
              // Runtime-local stages such as copy/ready are still part of installation.
              // Preserve the selected manager/version and forward only real progress.
              let reportedPercent;
              const onProgress = state => {
                const percent = typeof state?.percent === "number" && Number.isFinite(state.percent)
                  ? Math.max(0, Math.min(100, Math.round(state.percent))) : undefined;
                if (percent === undefined || percent === reportedPercent) return;
                reportedPercent = percent;
                reportPreparation({ gamePath: entry.gamePath, phase: "install",
                  label: labels.progressLabel || `Installing ${labels.label || manager.label || manager.id}…`, managerId: manager.id,
                  version: payload.version, percent });
              };
              const result = await manager.installRuntime({ ...context, ...payload, userDataDir, logger, downloads: context.downloads, onProgress });
              const fresh = loadSettings();
              Object.assign(context, getGameLaunchContext(entry, fresh, { ...options, runtimeId, runtimeUseScope, reportPreparation: true, autoInstallRuntime: true }));
              onRuntimeStateChange?.({ managerId: manager.id });
              return result;
            }
          });
          if (!prepared) return { kind: "cancelled", runtimeId };
          prepareModuleInput(entry, registry, context);
          Object.assign(entry, hydrateGameSaveLocations(entry, registry, { settings: context.settings, userDataDir, runtimeId }));
          const stored = entry.gameId && GameStore.readGameRecord(userDataDir, entry.gameId);
          if (stored) persistEntry(mergeSettingsChanges(entryBeforePreparation, entry, stored));
          reportPreparation({ gamePath: entry.gamePath, phase: "launch", label: "Starting game…" });
        }
        const hosted = resolveHostedRuntimeInfo(info)?.id;
        async function track(result, launchContext = context) {
          if (result.child) launchContext.bindGameEffectsProcess?.(result.child);
          if (launchContext.graphicsPreparationFailure) result = {...result, graphicsWarnings: [
            "Graphics processing is unavailable. The game is using its original rendering. " + launchContext.graphicsPreparationFailure.reason
          ]};
          const target = result.child || result.win;
          if (typeof target?.once !== "function") return result;
          if (result.child && Number.isSafeInteger(result.child.pid)) await runtimeUseScope.bind(result.child.pid);
          retained = true;
          const key = entry.gameId || entry.gamePath;
          activeRuns.set(key, (activeRuns.get(key) || 0) + 1);
          const saveRoot = saveIdentity(entry, runtimeId);
          if (saveRoot) activeSaveRoots.set(saveRoot, (activeSaveRoots.get(saveRoot) || 0) + 1);
          let finished = false;
          const releaseOwnership = () => {
            if (finished) return;
            finished = true;
            const remaining = (activeRuns.get(key) || 1) - 1;
            if (remaining) activeRuns.set(key, remaining); else activeRuns.delete(key);
            if (saveRoot) {
              const rootsRemaining = (activeSaveRoots.get(saveRoot) || 1) - 1;
              if (rootsRemaining) activeSaveRoots.set(saveRoot, rootsRemaining); else activeSaveRoots.delete(saveRoot);
            }
            void runtimeUseScope.release().catch(error => warnGraphics(logger, "[runtime] lease release failed", error.message));
          };
          const release = () => afterProcessStop(target, releaseOwnership);
          target.once(result.win ? "closed" : "exit", release);
          if (result.child) {
            target.once("error", () => { if (!target.pid || target.exitCode != null || target.signalCode != null) release(); });
            target.once("close", release);
          }
          if (result.child?.exitCode != null || result.child?.signalCode != null) release();
          return result;
        }
        async function runHosted(id) {
          if (entry.gameType && entry.gameType !== "web") throw new Error(`${id} requires a web game.`);
          if (!entry.indexHtml) throw new Error(`Missing index.html; ${id} requires a web game.`);
          if (!launchHosted) throw new Error(`Runtime ${id} requires a game host. Provide launchHosted or use the command-line runner.`);
          const hostedContext = id === runtimeId ? context : getGameLaunchContext(entry, settings, { ...options, runtimeId: id, runtimeUseScope });
          const result = await launchHosted(prepareModuleInput(entry, registry, hostedContext), id, hostedContext);
          return track({ kind: result?.win ? "window" : "process", runtimeId: id,
            ...(result?.win ? result : { child: result?.child || result }) }, hostedContext);
        }
        if (hosted && runtimeId === hosted) return runHosted(runtimeId);
        if (runtimeId === "native") {
          if (process.platform !== "darwin") throw new Error("Native macOS games require macOS.");
          if (typeof mod?.launchNativeRuntime === "function") {
            const child = await mod.launchNativeRuntime(entry, context);
            if (child) return track({ kind: "process", runtimeId, child });
          }
          const appPath = resolveModuleNativeLaunchPath(entry, mod);
          if (!appPath) throw new Error("Native app bundle not found.");
          const executable = AppBundle.resolveAppBundleExecutablePath(appPath);
          if (!executable) throw new Error("Native app executable not found.");
          const steam = await steamClientService(appPath, { signal: context.signal });
          const prepared = await mod?.prepareNativeLaunch?.(entry, context, { appPath, executable });
          const launchOptions = { cwd: path.dirname(executable),
            env: prepared?.environment ? { ...process.env, ...steam.environment, ...prepared.environment } : steam.environment };
          const args = [...(prepared?.args || []), ...context.gameArguments];
          const child = LaunchScript.isShellScript(executable)
            ? await LaunchScript.launchScript(executable, args, launchOptions, false, context)
            : await context.spawnDetachedChecked(executable, args, launchOptions);
          return track({ kind: "process", runtimeId, child });
        }
        if (typeof mod?.launchRuntime === "function") {
          await runtimeUseScope.flushSelections();
          const input = prepareModuleInput(entry, registry, context);
          const child = await mod.launchRuntime(runtimeId, input, context);
          applyInputChanges(entry, input);
          if (child) return track({ kind: "process", runtimeId, child });
        }
        if (hosted && options.strict !== true) return runHosted(hosted);
        throw new Error(`Runtime ${runtimeId} is not supported for ${info.label || moduleId}.`);
      });
    } finally { if (!retained) {
      try {await Promise.all([...ownedProcesses].map(waitForProcessStop));}
      finally {await runtimeUseScope.release();}
    } }
  }

  function runAction(entry, actionId, payload, options) {
    return gameLifecycle.use(entry, () => runActionOnce(entry, actionId, payload, options));
  }

  async function runActionOnce(entry, actionId, payload = {}, { settings = loadSettings(), signal } = {}) {
    signal?.throwIfAborted();
    if (actionId === "graphicsInputs") {
      const effective = structuredClone(entry), moduleId = resolveModuleId(effective);
      const mod = registry.getModule(moduleId), info = registry.getModuleInfo(moduleId);
      const runtimeId = resolveRuntimeForEntry(effective.runtimeId, mod, info, effective,
        resolveModuleSettings(settings, moduleId), settings);
      effective.runtimeId = runtimeId;
      const context = getLaunchContext(effective, settings, { runtimeId });
      const prepared = prepareModuleInput(effective, registry, context);
      const graphicsInputs = require("../modules/shared/runtime/native-graphics-inputs").withInputs(prepared, {
        runtimeId, graphicsInputs: await mod?.resolveGraphicsInputs?.(prepared, context) || null,
        declaredArchitecture: info.runtime?.entries?.[runtimeId]?.graphicsArchitecture });
      return { runtimeId, graphicsInputs,
        ...(typeof mod?.prepareEffectsEntry === "function" ? {prepareEffectsEntry: value => mod.prepareEffectsEntry(value, context)} : {}),
        ...(typeof mod?.withGraphicsUpdate === "function" ? {
          withGraphicsUpdate: (value, options, publish) => mod.withGraphicsUpdate(value, context, options, publish)
        } : {}) };
    }
    if (actionId === "setGameNotes") {
      const updated = GameStore.setGameNotes(userDataDir, entry.gameId, payload.notes);
      Object.assign(entry, { notes: updated.notes, updatedAt: updated.updatedAt });
      return { notes: updated.notes, updatedAt: updated.updatedAt };
    }
    if (actionId === "setGameLaunchArguments") {
      const updated = GameStore.setGameLaunchArguments(userDataDir, entry.gameId, payload.launchArguments);
      Object.assign(entry, { launchArguments: updated.launchArguments, updatedAt: updated.updatedAt });
      return { launchArguments: updated.launchArguments, updatedAt: updated.updatedAt };
    }
    if (actionId === "setGameNetworkAccess") {
      const updated = GameStore.setGameNetworkAccess(userDataDir, entry.gameId, payload.networkAccess);
      Object.assign(entry, { networkAccess: updated.networkAccess, updatedAt: updated.updatedAt });
      return { networkAccess: updated.networkAccess, updatedAt: updated.updatedAt };
    }
    if (actionId === "explainDetection") {
      const detectPath = entry.importPath && fs.existsSync(entry.importPath) ? entry.importPath : entry.gamePath;
      const report = typeof registry.explainDetectionAsync === "function"
        ? await registry.explainDetectionAsync(detectPath) : registry.explainDetection(detectPath);
      return { ...report, summary: report.error?.message || `${report.selectedModuleId}: ${report.candidates.length} candidate(s), ${report.metrics.probes} probe(s).` };
    }
    if (actionId === "removeAppQuarantine") return AppMaintenance.removeQuarantine(entry);
    if (saveService.hasAction(actionId)) return saveService.runAction(entry, actionId, payload);
    const action = registry.getModule(resolveModuleId(entry))?.actions?.[actionId];
    if (typeof action !== "function") throw new Error(`Unknown module action: ${actionId}`);
    const before = structuredClone(settings);
    const entryBefore = structuredClone(entry);
    managedRuntimes();
    const context = getLaunchContext(entry, settings, { signal });
    const input = prepareModuleInput(entry, registry, context);
    const result = await withRuntimeCoordinator(runtimeCoordinator, userDataDir, () => action(input, payload, context));
    applyInputChanges(entry, input);
    const stored = GameStore.readGameRecord(userDataDir, entry.gameId);
    persistEntry(stored ? mergeSettingsChanges(entryBefore, entry, stored) : entry);
    if (JSON.stringify(before) !== JSON.stringify(settings)) {
      // An extraction/download action may take minutes. Apply only its changes
      // to current disk settings so preferences edited elsewhere survive it.
      const previous = structuredClone(before), next = structuredClone(settings);
      for (const manager of managedRuntimes()) {
        if (typeof manager.normalizeSettings !== "function" || !Object.hasOwn(next.runtimes || {}, manager.id) ||
            JSON.stringify(previous.runtimes?.[manager.id]) === JSON.stringify(next.runtimes[manager.id])) continue;
        previous.runtimes ||= {};
        previous.runtimes[manager.id] = manager.normalizeSettings(previous.runtimes[manager.id]);
        next.runtimes[manager.id] = manager.normalizeSettings(next.runtimes[manager.id]);
      }
      await runtimeCoordinator.applySettings(previous, next);
    }
    return result;
  }

  return {
    userDataDir, loadSettings, resolveEntry, launchEntry, runAction, getLaunchContext, getGameLaunchContext, persistEntry,
    resolveModuleNativeLaunchPath, resolveRuntimeForEntry, resolveRuntimeSupportForEntry,
    getResolvedModuleSettings,
    resolveModuleSettings, resolveToolsButtonVisible, normalizeCheatsForModule, writeCheatsFile,
    runtimeSettingsStore, saveService
  };
}

module.exports = {
  createLauncher, defaultUserDataDir, resolveModuleId, resolveHostedRuntimeInfo,
  resolveNativeLaunchPath, resolveModuleSettings, resolveRuntimeSupportForEntry, mergeSettingsChanges
};
