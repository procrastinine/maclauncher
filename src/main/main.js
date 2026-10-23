const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow, dialog, ipcMain, Menu, shell, session, nativeImage, screen, systemPreferences, safeStorage } = require("electron");

const Modules = require("../modules/registry");
const GameData = require("../modules/shared/game-data");
const IconUtils = require("./icon-utils");
const GameStore = require("./game-store");
const NetworkAccess = require("../core/network-access");
const CleanupUtils = require("./cleanup-utils");
const LibraryState = require("./library-state");
const { sanitizeFileName, writeGameCommand } = require("./game-command");
const { gameImports, configureLauncherData } = require("./file-open");
const LibraryMaintenance = require("../core/library-maintenance");
const { createLauncher, resolveModuleId, resolveHostedRuntimeInfo,
  resolveNativeLaunchPath, resolveModuleSettings, resolveRuntimeSupportForEntry, mergeSettingsChanges } = require("../core/launcher");
const { createElectronHostLaunch } = require("../core/electron-binary");
const { launchHostedProcess } = require("../core/hosted-process");
const { stopProcessTree } = require("../core/process-stop");
const { requestProcessStop, afterProcessStop } = require("../core/process-lifecycle");
const { observeGameProcess } = require("../core/game-process-events");
const { canLaunchEntry } = require("../core/launch-capability");
const { readJsonObject, writeJsonAtomic } = require("../core/json-files");
const { coordinatorFor } = require("../core/runtime-coordinator");
const { createSettingsSnapshots } = require("../core/settings-snapshots");
const { createUtilityWindowController } = require("./utility-windows");
const { runRuntimeManagerAction } = require("../core/runtime-manager-service");
const { createBackendService } = require("../core/backend-worker-client");
const { createModuleActionRequests } = require("./module-action-requests");
const { loadLocalView } = require("../core/view-loading");
const { hydrateGameSaveLocations, selectKnownSaveLocation, saveDirectoryForEntry, canOverrideSaveLocation } = require("../core/save-locations");
const { watchFileChanges } = require("../core/watch-files");
const { resolveRuntimeSettingsSchema, buildRuntimeSettingsDefaults, normalizeRuntimeSettings,
  mergeRuntimeSettingsMap } = require("../core/runtime-settings");
const { createElectronGameHost } = require("../modules/shared/web/runtime/electron-host");
const { mergeDetectedEntry } = require("./launch-utils");
const { DownloadManager } = require("../modules/shared/runtime/download-manager");
const { isAbortError } = require("../modules/shared/runtime/download-utils");
const ReShade = require("../modules/shared/reshade");
const ReShadeFilters = require("../modules/shared/reshade/filter-library");
const GraphicsImports = require("../modules/shared/reshade/imports");
const GraphicsSettings = require("../modules/shared/reshade/graphics-settings");
const EffectsPlan = require("../modules/shared/effects/plan");
const EffectsRuntime = require("../modules/shared/effects/runtime");

const APP_NAME = "MacLauncher";

configureLauncherData(app, process.argv);
const userDataDir = app.getPath("userData");
const settingsCoordinator = coordinatorFor(userDataDir).client();
const settingsSnapshots = createSettingsSnapshots({
  readSettings: () => readJsonObject(settingsPath()),
  normalize: normalizeSettings,
  commitSettings: (before, next) => settingsCoordinator.applySettings(before, next)
});

const isDebug = process.env.MACLAUNCHER_DEBUG === "1";
const devtoolsEnv = process.env.MACLAUNCHER_DEVTOOLS;
const devtoolsEnabled = devtoolsEnv === "1" || (devtoolsEnv == null && (isDebug || !app.isPackaged));
const devtoolsAuto = devtoolsEnabled && process.env.MACLAUNCHER_DEVTOOLS_AUTO === "1";
const isSmoke = process.argv.includes("--maclauncher-smoke");
// Child game instances avoid launcher state writes to prevent cross-process races.
const isChildGame = process.argv.includes("--maclauncher-game-child");

const DEFAULT_LAUNCHER_SETTINGS = {
  showIcons: true,
  networkAccess: false,
  showNonDefaultTags: true,
  library: LibraryState.DEFAULT_LIBRARY_STATE
};

const GAME_SCHEMA_VERSION = 1;

const ICON_EXTRACTION_ENABLED = process.env.MACLAUNCHER_ICON_EXTRACT !== "0";

const ICON_SOURCES = {
  MODULE: "module",
  APP: "app",
  EXE: "exe",
  MODULE_DEFAULT: "module-default"
};

const NWJS_VERSION_TOKEN = "{nwjsVersion}";

if (isDebug || isSmoke) {
  app.commandLine.appendSwitch("enable-logging");
  app.commandLine.appendSwitch("enable-crash-reporter");
}

function getArgValue(prefix) {
  const hit = process.argv.find(a => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

function resolveAppBundlePath(execPath) {
  if (!execPath) return null;
  const marker = `${path.sep}Contents${path.sep}MacOS${path.sep}`;
  const idx = execPath.indexOf(marker);
  if (idx < 0) return null;
  return execPath.slice(0, idx);
}

function resolveAppBundleFromPath(value) {
  if (!value) return null;
  const resolved = path.resolve(value);
  const parts = resolved.split(path.sep);
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const part = parts[i];
    if (!part || !part.toLowerCase().endsWith(".app")) continue;
    const candidate = parts.slice(0, i + 1).join(path.sep);
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        return candidate;
      }
    } catch {}
  }
  return null;
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function shallowEqual(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    const av = a[key];
    const bv = b[key];
    if (Array.isArray(av) || Array.isArray(bv)) {
      if (!Array.isArray(av) || !Array.isArray(bv)) return false;
      if (av.length !== bv.length) return false;
      for (let i = 0; i < av.length; i++) {
        if (av[i] !== bv[i]) return false;
      }
      continue;
    }
    if (av !== bv) return false;
  }
  return true;
}

function createLogger() {
  const logDir = path.join(app.getPath("userData"), "logs");
  ensureDir(logDir);
  const logPath = path.join(logDir, "main.log");
  const sink = require("../core/buffered-log").createBufferedLog(logPath);

  function write(level, ...args) {
    const ts = new Date().toISOString();
    const message = require("node:util").formatWithOptions({ depth: 3, maxArrayLength: 30, maxStringLength: 4096 }, ...args).slice(0, 8192);
    sink.write(`[${ts}] [${level}] ${message}\n`);
    if (isDebug || level !== "debug") {
      // eslint-disable-next-line no-console
      console[level === "debug" ? "log" : level]?.(message);
    }
  }

  return {
    path: logPath,
    flush: sink.flush,
    hasPending: sink.hasPending,
    debug: (...a) => write("debug", ...a),
    info: (...a) => write("info", ...a),
    warn: (...a) => write("warn", ...a),
    error: (...a) => write("error", ...a)
  };
}

const logger = createLogger();
const gamePreparations = new Map();
const gameRemovals = new Map();
const importProgress = new Map();
const graphicsImportControllers = new Map();
const graphicsLaunchWarnings = new Map();
let graphicsImportsClosing = false;
const runtimeStateSnapshots = {};
let runtimeInventoryRevision = 0;
const moduleStateSnapshots = {};
let snapshotSaveTimer;
let snapshotWrite = Promise.resolve();
const snapshotFile = path.join(userDataDir, "ui-state-cache.json");
try {
  const stat = fs.lstatSync(snapshotFile);
  if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= 8 * 1024 ** 2) {
    const cached = JSON.parse(fs.readFileSync(snapshotFile, "utf8"));
    if (cached.platform === process.platform && cached.arch === process.arch && cached.version === app.getVersion()) {
      Object.assign(runtimeStateSnapshots, cached.runtimeManagers || {});
      Object.assign(moduleStateSnapshots, cached.moduleStates || {});
    }
  }
} catch {}
function saveStateSnapshotsSoon() {
  clearTimeout(snapshotSaveTimer);
  snapshotSaveTimer = setTimeout(() => {
    const value = JSON.stringify({ platform: process.platform, arch: process.arch, version: app.getVersion(),
      runtimeManagers: runtimeStateSnapshots, moduleStates: moduleStateSnapshots });
    snapshotWrite = snapshotWrite.catch(() => {}).then(async () => {
      const temporary = snapshotFile + ".tmp";
      await fs.promises.mkdir(userDataDir, { recursive: true });
      try { await fs.promises.writeFile(temporary, value, { mode: 0o600 }); await fs.promises.rename(temporary, snapshotFile); }
      finally { await fs.promises.rm(temporary, { force: true }); }
    }).catch(error => logger.debug("[state] cache write failed", error.message));
  }, 250);
  snapshotSaveTimer.unref();
}
function refreshRuntimeSnapshots(ids) {
  return backendService.request("state", "runtimeStates", loadSettings(), ids)
    .catch(error => logger.warn("[runtime] background inventory failed", error.message));
}
function refreshModuleSnapshots() {
  return backendService.request("state", "moduleStates", loadSettings())
    .catch(error => logger.warn("[modules] background state failed", error.message));
}
const backendService = createBackendService({ userDataDir,
  appInfo: { appPath: app.getAppPath(), isPackaged: app.isPackaged, version: app.getVersion(),
    bootstrapPath: path.resolve(__dirname, "bootstrap.js"),
    execPath: process.execPath, resourcesPath: process.resourcesPath,
    paths: Object.fromEntries(["home", "appData", "desktop", "documents", "downloads", "temp"].map(name => [name, app.getPath(name)])) },
  callbacks: {
    openLiveVariableEditor: options => createLiveVariableEditorWindow(options),
    confirmRuntimeInstall: (plan, entry) => confirmRuntimeInstallation(plan, entry),
    ...Object.fromEntries(["showOpenDialog", "showSaveDialog", "showMessageBox"].map(method => [`dialog.${method}`, (...args) => {
      const options = args.at(-1);
      const owner = getLauncherDialogOwner();
      return owner ? dialog[method](owner, options) : dialog[method](options);
    }])),
    ...Object.fromEntries(["showItemInFolder", "openPath", "openExternal", "trashItem"].map(method => [`shell.${method}`, (...args) => shell[method](...args)])),
    chooseImportPath: async descriptor => {
      const options = { title: descriptor.label, buttonLabel: "Import",
        properties: [ ...(descriptor.kinds.includes("file") ? ["openFile"] : []), ...(descriptor.kinds.includes("directory") ? ["openDirectory"] : []) ],
        ...(descriptor.extensions.length ? { filters: [{ name: "Runtime", extensions: descriptor.extensions }] } : {}) };
      const owner = getLauncherDialogOwner();
      const selected = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
      return selected.canceled ? null : selected.filePaths[0] || null;
    },
    chooseInstalledActionInput: async descriptor => {
      const options = { title: descriptor.label, buttonLabel: "Import", properties: ["openFile"],
        ...(descriptor.extensions?.length ? { filters: [{ name: descriptor.label, extensions: descriptor.extensions }] } : {}) };
      const owner = getLauncherDialogOwner();
      const selected = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
      return selected.canceled || !selected.filePaths.length ? null : { filePaths: selected.filePaths, archivePath: selected.filePaths[0] };
    }
  },
  onEvent: (event, payload, lane) => {
    if (event === "toolLaunch" || event === "gameProcess") { registerProcessRun(payload.gamePath, payload.child, payload.runtimeId); return; }
    if (event === "toolProcess") { logRuntimeToolSpawn(payload.process, payload, payload); return; }
    if (event === "log") { logger[payload.level]?.(...payload.args); return; }
    if (event === "runtimeState" || event === "moduleState") {
      const snapshots = event === "runtimeState" ? runtimeStateSnapshots : moduleStateSnapshots;
      if (JSON.stringify(snapshots[payload.id]) === JSON.stringify(payload.state)) return;
      if (event === "runtimeState") {
        const inventory = state => [state?.installed, state?.sections?.map(section => [section.id, section.installed])];
        if (JSON.stringify(inventory(snapshots[payload.id])) !== JSON.stringify(inventory(payload.state))) runtimeInventoryRevision += 1;
      }
      snapshots[payload.id] = payload.state;
      if (cachedState) {
        const settings = loadSettings();
        cachedState = { ...cachedState, ...(event === "runtimeState"
          ? { recents: orderGames(loadGamesHydrated({ persist: false }), settings?.launcher?.library).map(entry => decorateRecentEntry(entry, settings)),
            runtimeManagers: buildRuntimeManagerState(settings),
            moduleSettings: launcherService.getResolvedModuleSettings(settings) }
          : { moduleStates: buildModuleState(settings) }) };
      }
      saveStateSnapshotsSoon(); broadcastState(); return;
    }
    if (event === "preparation") {
      if (payload.phase === "done") gamePreparations.delete(payload.gamePath);
      else gamePreparations.set(payload.gamePath, payload);
      broadcastActivity(); return;
    }
    if (event === "importProgress") {
      if (payload.phase === "done") importProgress.delete(payload.inputPath);
      else importProgress.set(payload.inputPath, payload);
      broadcastActivity(); return;
    }
    if (event === "entryChanged") {
      const record = GameStore.readGameRecord(userDataDir, payload.gameId);
      if (record && gameRecordsCache) {
        const index = gameRecordsCache.findIndex(entry => entry.gameId === payload.gameId);
        if (index >= 0) gameRecordsCache[index] = record;
      }
      if (cachedState) cachedState = buildState(loadSettings(), loadGamesHydrated({ persist: false }));
      broadcastState(); return;
    }
    if (event === "runtimeChanged") {
      const entry = lane.startsWith("game:") && loadGamesHydrated({ persist: false }).find(game => `game:${game.gameId || game.gamePath}` === lane);
      const mod = entry && Modules.getModule(resolveModuleId(entry));
      const ids = payload.managerId ? [payload.managerId] : (mod?.runtimeManagers || []).map(manager => manager.id);
      void refreshRuntimeSnapshots(ids.length ? ids : undefined); return;
    }
    if (event === "settingsChanged") {
      if (cachedState) cachedState = buildState(loadSettings(), loadGamesHydrated({ persist: false }));
      broadcastState(); return;
    }
    if (event === "downloads") broadcastActivity();
  }
});
async function confirmRuntimeInstallation(plan, entry) {
  const versionLabel = [plan.label, plan.versionLabel || plan.version].filter(Boolean).join(" ");
  const options = { type: "question", buttons: [plan.confirmLabel || "Download and Play", "Cancel"], defaultId: 0, cancelId: 1,
    message: plan.message || `${plan.kind === "prerequisite" ? "Install" : "Download"} ${versionLabel}?`,
    detail: plan.detail || (entry ? `Required to run ${entry.name || path.basename(entry.gamePath)}.` : "Required by this runtime.") };
  const owner = getLauncherDialogOwner();
  const choice = owner ? await dialog.showMessageBox(owner, options) : await dialog.showMessageBox(options);
  return choice.response === 0 ? plan.licenseRequired ? { approved: true, licenseAccepted: true } : true : false;
}
function logRuntimeToolSpawn(child, metadata, identity) {
  try {
    const pid = child?.pid, owner = metadata?.ownerName;
    const validId = value => typeof value === "string" && /^[a-zA-Z0-9._:-]{1,128}$/.test(value);
    if (!Number.isSafeInteger(pid) || pid <= 0 || typeof owner !== "string" || !/^[a-zA-Z0-9._-]{1,128}$/.test(owner) ||
        !validId(identity?.gameId) || !validId(identity?.moduleId) || !Modules.getModule(identity.moduleId)) return;
    logger.info("[runtime-tool] %s", JSON.stringify({ event: "spawn", pid, owner, gameId: identity.gameId,
      moduleId: identity.moduleId, ...(validId(identity.runtimeId) ? { runtimeId: identity.runtimeId } : {}) }));
  } catch { /* Logging cannot change tool launch or process ownership. */ }
}
const launcherService = createLauncher({
  userDataDir, logger, app, ui: { shell, dialog, nativeImage, systemPreferences }, writeCheatsFile,
  getRuntimeManagerState: id => runtimeStateSnapshots[id] || { installed: [] },
  downloads: () => downloadManager,
  confirmRuntimeInstall: confirmRuntimeInstallation,
  onToolProcessSpawn: logRuntimeToolSpawn,
  onPreparationChange: preparation => {
    if (preparation.phase === "done") gamePreparations.delete(preparation.gamePath);
    else gamePreparations.set(preparation.gamePath, preparation);
    broadcastActivity();
  },
  isGameRunning: entry => Boolean(runningGameSessions.get(entry.gamePath)?.size),
  launchHosted: (entry, runtimeId, context) => launchHostedRuntimeChild(entry, runtimeId, context),
  onEntryChange: (entry, patch) => {
    const games = loadGamesHydrated({ persist: false });
    const stored = games.find(game => game.gameId === entry.gameId);
    if (!stored) return;
    for (const key of ["contentRootDir", "defaultSaveDir", "moduleData", "runtimeData"]) {
      if (Object.hasOwn(patch || {}, key)) stored[key] = patch[key];
    }
    saveGameRecords(games);
    cachedState = buildState(loadSettings(), games);
    broadcastState();
  },
  onRuntimeStateChange: () => {
    cachedState = buildState(loadSettings(), loadGamesHydrated({ persist: false }));
    broadcastState();
  }
});

function getModuleCheats(moduleId) {
  const moduleInfo = Modules.getModuleInfo(moduleId);
  if (!moduleInfo?.supports?.cheats) return null;
  const mod = Modules.getModule(moduleId);
  const cheats = mod?.cheats;
  if (!cheats || typeof cheats.normalize !== "function") return null;
  if (!cheats.defaults || typeof cheats.defaults !== "object") return null;
  return cheats;
}

function getCheatsPatcherIfSupported(moduleId) {
  const moduleInfo = Modules.getModuleInfo(moduleId);
  if (!moduleInfo?.supports?.cheatsPatcher) return null;
  if (!getModuleCheats(moduleId)) return null;
  const mod = Modules.getModule(moduleId);
  return mod?.cheats?.patcher || null;
}

function normalizeCheatsForModule(moduleId, input) {
  const cheats = getModuleCheats(moduleId);
  if (!cheats) return null;
  return cheats.normalize(input);
}

function cheatsEqualForModule(moduleId, a, b) {
  const cheats = getModuleCheats(moduleId);
  if (!cheats) return true;
  if (typeof cheats.equals === "function") return cheats.equals(a, b);
  const aa = cheats.normalize(a);
  const bb = cheats.normalize(b);
  for (const key of Object.keys(cheats.defaults || {})) {
    if (aa[key] !== bb[key]) return false;
  }
  return true;
}

function attachWebContentsLogging(wc, label) {
  wc.on("console-message", event => {
    const level = event?.level ?? event?.severity;
    const message = event?.message ?? event?.text;
    const line = event?.line ?? event?.lineNumber;
    const sourceId = event?.sourceId ?? event?.sourceURL ?? event?.source;

    const msg = String(message ?? "");
    if (/Electron Security Warning \(Insecure Content-Security-Policy\)/.test(msg)) return;
    if (/Canvas2D: .*willReadFrequently/i.test(msg)) return;
    if (/CanvasTextAlign/i.test(msg) && /not a valid enum value/i.test(msg)) return;

    logger.info(`[${label}] console(${level}) ${message} (${sourceId}:${line})`);
  });
  wc.on("render-process-gone", (_event, details) => {
    logger.error(`[${label}] render-process-gone`, details);
  });
  wc.on("unresponsive", () => {
    logger.warn(`[${label}] unresponsive`);
  });
}

function settingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

function buildDefaultModuleSettings() {
  const out = {};
  for (const mod of Modules.listModules()) {
    const defaults =
      mod && typeof mod === "object" && mod.settingsDefaults && typeof mod.settingsDefaults === "object"
        ? mod.settingsDefaults
        : {};
    out[mod.id] = { ...defaults };
  }
  return out;
}

function normalizeModuleSettings(settings) {
  const defaults = buildDefaultModuleSettings();
  const moduleSettings = settings.modules && typeof settings.modules === "object" ? settings.modules : {};
  const merged = {};

  for (const [id, base] of Object.entries(defaults)) {
    const incoming = moduleSettings[id] && typeof moduleSettings[id] === "object" ? moduleSettings[id] : {};
    merged[id] = { ...base, ...incoming };
  }

  for (const [id, incoming] of Object.entries(moduleSettings)) {
    if (merged[id]) continue;
    merged[id] = incoming && typeof incoming === "object" ? { ...incoming } : {};
  }

  settings.modules = merged;
}

function normalizeLauncherSettings(settings) {
  const current = settings.launcher && typeof settings.launcher === "object" ? settings.launcher : {};
  const library = LibraryState.normalizeLibraryState(current.library);
  settings.launcher = { ...DEFAULT_LAUNCHER_SETTINGS, ...current, networkAccess: current.networkAccess === true, library };
}

function pruneRuntimeSettingsDefaults(settings) {
  let changed = false;
  const modules = settings?.modules && typeof settings.modules === "object" ? settings.modules : {};
  for (const [moduleId, moduleSettings] of Object.entries(modules)) {
    if (!moduleSettings || typeof moduleSettings !== "object") continue;
    const moduleInfo = Modules.getModuleInfo(moduleId);
    const runtimeSettings =
      moduleSettings.runtimeSettings && typeof moduleSettings.runtimeSettings === "object"
        ? moduleSettings.runtimeSettings
        : null;
    if (!runtimeSettings) continue;
    for (const [runtimeId, runtimeOverride] of Object.entries(runtimeSettings)) {
      const schema = resolveRuntimeSettingsSchema(moduleInfo, runtimeId);
      if (!schema) {
        delete runtimeSettings[runtimeId];
        changed = true;
        continue;
      }
      const globalDefaults = readRuntimeDefaults(runtimeId, moduleInfo) || buildRuntimeSettingsDefaults(schema);
      const normalized = normalizeRuntimeSettings(schema, runtimeOverride, globalDefaults);
      if (shallowEqual(normalized, globalDefaults)) {
        delete runtimeSettings[runtimeId];
        changed = true;
        continue;
      }
      if (!shallowEqual(normalized, runtimeOverride)) {
        runtimeSettings[runtimeId] = normalized;
        changed = true;
      }
    }
    if (Object.keys(runtimeSettings).length === 0) {
      delete moduleSettings.runtimeSettings;
      changed = true;
    }
  }

  return changed;
}

function resolveDefaultRuntimeForModule(moduleInfo, moduleSettings) {
  const hostedId = resolveHostedRuntimeInfo(moduleInfo)?.id;
  const fallback = moduleInfo?.runtime?.default || hostedId || "";
  const value = typeof moduleSettings?.defaultRuntime === "string" ? moduleSettings.defaultRuntime : "";
  const normalized = value.trim().toLowerCase();
  return normalized || fallback;
}

function resolveToolsButtonVisible(entry, settings) {
  const moduleId = resolveModuleId(entry);
  const moduleInfo = Modules.getModuleInfo(moduleId);
  if (!getModuleCheats(moduleId)) return false;

  const moduleSettings = resolveModuleSettings(settings, moduleId);
  const moduleData = entry?.moduleData && typeof entry.moduleData === "object" ? entry.moduleData : {};

  if (typeof moduleData.toolsButtonVisibleOverride === "boolean") {
    return moduleData.toolsButtonVisibleOverride;
  }
  if (typeof moduleSettings.toolsButtonVisible === "boolean") {
    return moduleSettings.toolsButtonVisible;
  }
  return true;
}

function listRuntimeManagers() {
  const seen = new Map();
  for (const id of Modules.listModuleIds()) {
    const mod = Modules.getModule(id);
    const managers = Array.isArray(mod?.runtimeManagers) ? mod.runtimeManagers : [];
    for (const manager of managers) {
      if (!manager || !manager.id) continue;
      if (!seen.has(manager.id)) seen.set(manager.id, manager);
    }
  }
  for (const manager of Modules.listSharedRuntimeManagers()) {
    if (!manager || !manager.id) continue;
    if (!seen.has(manager.id)) seen.set(manager.id, manager);
  }
  return Array.from(seen.values());
}

function getRuntimeManager(managerId) {
  return listRuntimeManagers().find(manager => manager.id === managerId) || null;
}

function resolvePreferredNwjsVersion(settings, userDataDir) {
  const manager = getRuntimeManager("nwjs");
  return manager?.resolveRuntimeConfig?.({ userDataDir })?.version || null;
}

function resolveUserAgentSuffix(rawSuffix, { settings, userDataDir, nwjsVersion } = {}) {
  const suffix = typeof rawSuffix === "string" ? rawSuffix.trim() : "";
  if (!suffix) return "";
  if (!suffix.includes(NWJS_VERSION_TOKEN)) return suffix;
  const resolvedVersion = nwjsVersion || resolvePreferredNwjsVersion(settings, userDataDir);
  if (!resolvedVersion) return "";
  return suffix.split(NWJS_VERSION_TOKEN).join(resolvedVersion);
}

function resolveRuntimeLabel(runtimeId, moduleInfo) {
  const entryLabel = resolveRuntimeEntry(moduleInfo, runtimeId)?.label;
  if (entryLabel) return entryLabel;
  const moduleLabel = moduleInfo?.runtime?.labels?.[runtimeId];
  if (moduleLabel) return moduleLabel;
  if (runtimeId === "native") return "Native app";
  const manager = getRuntimeManager(runtimeId);
  if (manager?.label) return manager.label;
  if (typeof runtimeId === "string" && runtimeId) {
    return runtimeId.charAt(0).toUpperCase() + runtimeId.slice(1);
  }
  return "Runtime";
}

function resolveRuntimeName(runtimeId, moduleInfo) {
  const label = resolveRuntimeLabel(runtimeId, moduleInfo);
  if (!label) return "Runtime";
  return label.toLowerCase().includes("runtime") ? label : `${label} runtime`;
}

function resolveRuntimeEntry(moduleInfo, runtimeId) {
  const entries = moduleInfo?.runtime?.entries;
  if (!entries || typeof entries !== "object") return null;
  const entry = entries[runtimeId];
  return entry && typeof entry === "object" ? entry : null;
}

function readRuntimeDefaults(runtimeId, moduleInfo) {
  return launcherService.runtimeSettingsStore.readDefaults(runtimeId, moduleInfo);
}

function resolveModuleRuntimeSettings(settings, moduleId, moduleInfo, runtimeId) {
  return launcherService.runtimeSettingsStore.resolveForModule(settings, moduleId, moduleInfo, runtimeId);
}

function resolveRuntimeSettingsForEntry(entry, settings, moduleInfo, runtimeId) {
  return launcherService.runtimeSettingsStore.resolveForEntry(entry, settings, moduleInfo, runtimeId);
}

function loadSettings() {
  return settingsSnapshots.load();
}

function normalizeSettings(settings) {
  if (!settings.modules || typeof settings.modules !== "object") settings.modules = {};
  if (!settings.runtimes || typeof settings.runtimes !== "object") settings.runtimes = {};
  if (!settings.launcher || typeof settings.launcher !== "object") settings.launcher = {};

  normalizeModuleSettings(settings);
  normalizeLauncherSettings(settings);
  lastRuntimeSettingsMigration = pruneRuntimeSettingsDefaults(settings);

  const keep = new Set(["modules", "runtimes", "launcher"]);
  for (const key of Object.keys(settings)) {
    if (!keep.has(key)) delete settings[key];
  }
  return settings;
}

function loadSettingsHydrated({ persist = true } = {}) {
  const settings = loadSettings();
  if (lastRuntimeSettingsMigration && persist) saveSettings(settings);
  return settings;
}

function saveSettings(next) {
  return settingsSnapshots.save(next);
}

function serializeGameEntry(entry) {
  if (!entry || typeof entry !== "object") throw new Error("Missing game entry.");
  const gameId = entry.gameId;
  if (!gameId) throw new Error("Missing gameId.");
  return {
    schemaVersion: GAME_SCHEMA_VERSION,
    gameId,
    order: Number.isFinite(entry.order) ? entry.order : null,
    createdAt: Number.isFinite(entry.createdAt) ? entry.createdAt : null,
    updatedAt: Number.isFinite(entry.updatedAt) ? entry.updatedAt : null,
    gamePath: entry.gamePath || null,
    importPath: entry.importPath || null,
    name: entry.name || null,
    notes: typeof entry.notes === "string" ? entry.notes : "",
    launchArguments: typeof entry.launchArguments === "string" ? entry.launchArguments : "",
    networkAccess: typeof entry.networkAccess === "boolean" ? entry.networkAccess :
      NetworkAccess.preferenceForEntry(entry, loadSettings(), entry.runtimeId),
    reshade: ReShade.normalizeSettings(entry.reshade),
    graphics: GraphicsSettings.normalizeSettings(entry.graphics),
    effects: EffectsPlan.normalize(entry.effects),
    moduleId: entry.moduleId || null,
    gameType: entry.gameType ?? null,
    indexDir: entry.indexDir || null,
    indexHtml: entry.indexHtml || null,
    contentRootDir: entry.contentRootDir || null,
    defaultSaveDir: entry.defaultSaveDir || null,
    saveLocations: Array.isArray(entry.saveLocations) ? entry.saveLocations : [],
    saveDirOverride: entry.saveDirOverride ?? null,
    nativeAppPath: entry.nativeAppPath || null,
    runtimeId: entry.runtimeId || null,
    runtimeData: entry.runtimeData && typeof entry.runtimeData === "object" ? entry.runtimeData : {},
    runtimeSettings:
      entry.runtimeSettings && typeof entry.runtimeSettings === "object" ? entry.runtimeSettings : {},
    moduleData: entry.moduleData && typeof entry.moduleData === "object" ? entry.moduleData : {},
    cheats: entry.cheats ?? null,
    iconPath: entry.iconPath || null,
    iconSource: entry.iconSource || null,
    lastPlayedAt: entry.lastPlayedAt ?? null,
    lastBuiltAt: entry.lastBuiltAt ?? null
  };
}

function isGameRemoving(entry) {
  return gameRemovals.has(entry?.gamePath) || [...gameRemovals.values()].some(item => item.gameId === entry?.gameId);
}

function assertGameNotRemoving(entry) {
  if (isGameRemoving(entry)) throw Object.assign(new Error("Game removal is in progress. Try again when it finishes."), { code: "GAME_IN_USE" });
}

function saveGameRecord(entry) {
  assertGameNotRemoving(entry);
  const record = serializeGameEntry(entry);
  const index = gameRecordsCache?.findIndex(game => game.gameId === record.gameId) ?? -1;
  if (index >= 0 && JSON.stringify(gameRecordsCache[index]) === JSON.stringify(record)) return;
  GameStore.writeGameRecord(app.getPath("userData"), record);
  if (gameRecordsCache) {
    if (index >= 0) gameRecordsCache[index] = record;
    else gameRecordsCache.push(record);
  }
}

function saveGameRecords(entries) {
  for (const entry of entries || []) {
    if (!isGameRemoving(entry)) saveGameRecord(entry);
  }
  gameRecordsCache = (entries || []).map(serializeGameEntry);
}

function persistGames(entries) {
  saveGameRecords(entries);
  syncCheatsFiles(entries);
}

let gameRecordsCache = null;
function loadGamesHydrated({ persist = true } = {}) {
  if (gameRecordsCache) return structuredClone(gameRecordsCache);
  const games = GameStore.loadGames(app.getPath("userData"));
  let changed = false;
  try {
    if (hydrateCheatsFromFiles(games)) changed = true;
  } catch {}
  if (changed && persist) saveGameRecords(games);
  gameRecordsCache = games;
  return games;
}

function orderGames(games, library) {
  return LibraryState.buildOrderedGames(games, library).ordered;
}

function assignGameOrder(games) {
  return LibraryState.applyOrderToEntries(games);
}

function findGameByPath(games, gamePath) {
  const target = typeof gamePath === "string" ? gamePath : "";
  if (!target) return null;
  return (games || []).find(entry => entry?.gamePath === target) || null;
}

function cheatsFilePathForGame(gameId) {
  if (!gameId) return null;
  if ([...gameRemovals.values()].some(item => item.gameId === gameId)) return null;
  const dir = GameData.resolveGameDir(app.getPath("userData"), gameId);
  if (!dir) return null;
  ensureDir(dir);
  return GameData.resolveGameCheatsPath(app.getPath("userData"), gameId);
}

const cheatsFileLastWritten = new Map();
const cheatsFileWatchers = new Map();
const cheatsFileDebounceTimers = new Map();
const cheatsFileToGameId = new Map();
const cheatsFileToModuleId = new Map();

function writeCheatsFile(gameId, moduleId, cheats) {
  const normalized = normalizeCheatsForModule(moduleId, cheats);
  if (!normalized) return null;
  const p = cheatsFilePathForGame(gameId);
  if (!p) return null;
  const json = JSON.stringify(normalized, null, 2);
  if (cheatsFileLastWritten.get(p) === json) return p;
  try {
    writeJsonAtomic(p, normalized);
    cheatsFileLastWritten.set(p, json);
  } catch (error) {
    logger.error("[cheats] write failed", String(error?.message || error));
    throw error;
  }
  return p;
}

function readCheatsFile(gameId, moduleId) {
  const p = cheatsFilePathForGame(gameId);
  if (!p) return null;
  if (!fs.existsSync(p)) return null;
  try {
    const raw = fs.readFileSync(p, "utf8");
    const parsed = JSON.parse(raw);
    return normalizeCheatsForModule(moduleId, parsed);
  } catch {
    return null;
  }
}

function hydrateCheatsFromFiles(games) {
  const recents = Array.isArray(games) ? games : [];
  let changed = false;
  for (const entry of recents) {
    if (!entry || !entry.gameId) continue;
    const moduleId = resolveModuleId(entry);
    if (!getModuleCheats(moduleId)) continue;
    const fromFile = readCheatsFile(entry.gameId, moduleId);
    if (!fromFile) continue;
    if (cheatsEqualForModule(moduleId, entry.cheats, fromFile)) continue;
    entry.cheats = fromFile;
    changed = true;
  }
  return changed;
}

function scheduleCheatsFileRead(filePath) {
  const existing = cheatsFileDebounceTimers.get(filePath);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    cheatsFileDebounceTimers.delete(filePath);
    applyCheatsFileUpdate(filePath);
  }, 75);
  cheatsFileDebounceTimers.set(filePath, t);
}

function applyCheatsFileUpdate(filePath) {
  const gameId = cheatsFileToGameId.get(filePath);
  const moduleId = cheatsFileToModuleId.get(filePath);
  if (!gameId) return;
  if (!moduleId) return;

  let raw = null;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return;
  }

  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }

  const nextCheats = normalizeCheatsForModule(moduleId, parsed);
  if (!nextCheats) return;

  const games = loadGamesHydrated({ persist: false });
  const entry = games.find(r => r.gameId === gameId);
  if (!entry || isGameRemoving(entry)) return;

  if (cheatsEqualForModule(moduleId, entry.cheats, nextCheats)) return;
  entry.cheats = nextCheats;
  entry.updatedAt = Date.now();
  saveGameRecord(entry);
  cachedState = buildState(loadSettings(), games);
  broadcastState();
}

function syncCheatsFiles(games) {
  const recents = Array.isArray(games) ? games : [];
  const wanted = new Map();

  for (const entry of recents) {
    if (!entry || !entry.gameId || isGameRemoving(entry)) continue;
    const moduleId = resolveModuleId(entry);
    if (!getModuleCheats(moduleId)) continue;
    const gameId = entry.gameId;
    const p = cheatsFilePathForGame(gameId);
    if (!p) continue;
    wanted.set(p, gameId);
    cheatsFileToGameId.set(p, gameId);
    cheatsFileToModuleId.set(p, moduleId);
    writeCheatsFile(gameId, moduleId, entry.cheats);

    if (!cheatsFileWatchers.has(p)) {
      try {
        const watcher = watchFileChanges(p, () => scheduleCheatsFileRead(p));
        cheatsFileWatchers.set(p, watcher);
      } catch {}
    }
  }

  for (const p of cheatsFileToGameId.keys()) {
    if (wanted.has(p)) continue;
    try {
      cheatsFileWatchers.get(p)?.close();
    } catch {}
    cheatsFileWatchers.delete(p);
    clearTimeout(cheatsFileDebounceTimers.get(p));
    cheatsFileDebounceTimers.delete(p);
    cheatsFileToGameId.delete(p);
    cheatsFileToModuleId.delete(p);
    cheatsFileLastWritten.delete(p);
  }
}

function resolveModuleNativeLaunchPath(entry, mod) {
  return launcherService.resolveModuleNativeLaunchPath(entry, mod);
}

function resolveRuntimeForEntry(requestedRuntime, mod, moduleInfo, entry, moduleSettings, settings) {
  return launcherService.resolveRuntimeForEntry(requestedRuntime, mod, moduleInfo, entry, moduleSettings, settings);
}

function normalizeIconPath(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    if (!fs.existsSync(trimmed)) return null;
    if (!fs.statSync(trimmed).isFile()) return null;
  } catch {
    return null;
  }
  return trimmed;
}

function resolveImportPath(entry) {
  const raw = typeof entry?.importPath === "string" ? entry.importPath.trim() : "";
  if (raw) return raw;
  const gamePath = typeof entry?.gamePath === "string" ? entry.gamePath.trim() : "";
  if (gamePath && gamePath.toLowerCase().endsWith(".app")) return gamePath;
  return null;
}

function resolveDetectPath(entry) {
  const importPath = resolveImportPath(entry);
  if (importPath) {
    try {
      if (fs.existsSync(importPath)) return importPath;
    } catch {}
  }
  return typeof entry?.gamePath === "string" ? entry.gamePath : "";
}

async function resolveModuleIconPath(mod, entry) {
  if (typeof mod?.resolveGameIcon !== "function") return null;
  try {
    return normalizeIconPath(await backendService.request("icons", "resolveModuleIcon", entry));
  } catch {
    return null;
  }
}

function resolveModuleDefaultIconPath(moduleId) {
  const moduleDir = Modules.getModuleDir(moduleId);
  if (!moduleDir) return null;
  return normalizeIconPath(path.join(moduleDir, "resources", "icon.png"));
}

function resolveDefaultIconCandidate(entry) {
  return require("../core/game-icons").resolveIconCandidates(entry)[0] || null;
}

function resolveExeFallbackName(gamePath, hintName) {
  if (!gamePath) return null;
  try {
    if (!fs.existsSync(gamePath) || !fs.statSync(gamePath).isDirectory()) return null;
  } catch {
    return null;
  }
  const exePath = IconUtils.findBestExePath(gamePath, hintName);
  if (!exePath) return null;
  return path.basename(exePath, path.extname(exePath));
}

function resolveEntryDisplayName(entry) {
  const gamePath = typeof entry?.gamePath === "string" ? entry.gamePath : "";
  const folderName = gamePath ? path.basename(gamePath) : "";
  const rawName = typeof entry?.name === "string" ? entry.name.trim() : "";
  const shouldFallback = !rawName || (folderName && rawName === folderName);
  if (shouldFallback) {
    const exeName = resolveExeFallbackName(gamePath, rawName || folderName);
    if (exeName) return exeName;
  }
  return rawName || folderName;
}

const iconDataUrlCache = new Map();

function iconUrlForPath(iconPath) {
  if (!iconPath) return null;
  try {
    const stat = fs.statSync(iconPath);
    if (!stat.isFile()) return null;
    const cached = iconDataUrlCache.get(iconPath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.ctimeMs === stat.ctimeMs && cached.ino === stat.ino && cached.size === stat.size) {
      iconDataUrlCache.delete(iconPath); iconDataUrlCache.set(iconPath, cached);
      return cached.url;
    }
    const img = nativeImage.createFromPath(iconPath);
    if (!img || img.isEmpty()) return null;
    const size = img.getSize();
    const longest = Math.max(size.width, size.height);
    const preview = longest > 128 ? img.resize({
      width: Math.max(1, Math.round(size.width * 128 / longest)),
      height: Math.max(1, Math.round(size.height * 128 / longest)),
      quality: "best"
    }) : img;
    const url = preview.toDataURL();
    if (!url || typeof url !== "string") return null;
    iconDataUrlCache.set(iconPath, { mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, ino: stat.ino, size: stat.size, url });
    while (iconDataUrlCache.size > 256) iconDataUrlCache.delete(iconDataUrlCache.keys().next().value);
    return url;
  } catch {
    iconDataUrlCache.delete(iconPath);
    return null;
  }
}

function canRenderIconPath(iconPath) {
  return Boolean(iconUrlForPath(iconPath));
}

function normalizeGameEntry(entry, settings) {
  const moduleId = resolveModuleId(entry);
  const mod = Modules.getModule(moduleId);
  const moduleInfo = Modules.getModuleInfo(moduleId);
  const moduleSettings = settings?.modules?.[moduleId] || {};
  const moduleData =
    entry.moduleData && typeof entry.moduleData === "object" ? { ...entry.moduleData } : {};
  const runtimeData =
    entry.runtimeData && typeof entry.runtimeData === "object" ? { ...entry.runtimeData } : {};
  const runtimeSettings =
    entry.runtimeSettings && typeof entry.runtimeSettings === "object"
      ? mergeRuntimeSettingsMap({}, entry.runtimeSettings)
      : {};

  const rawRuntimeRequested =
    typeof entry.runtimeId === "string" && entry.runtimeId.trim() ? entry.runtimeId : null;
  const runtimeRequested =
    rawRuntimeRequested && typeof mod?.normalizeRuntimeId === "function"
      ? mod.normalizeRuntimeId(rawRuntimeRequested)
      : rawRuntimeRequested;

  const entryContext = { ...entry, moduleId, moduleData, runtimeData };
  const runtimeId = resolveRuntimeForEntry(
    runtimeRequested,
    mod,
    moduleInfo,
    entryContext,
    moduleSettings,
    settings
  );
  if (typeof entry.networkAccess !== "boolean") {
    entry.networkAccess = NetworkAccess.preferenceForEntry(entry, settings, runtimeId);
    if (entry.gameId && !isChildGame) {
      try {
        const stored = GameStore.readGameRecord(userDataDir, entry.gameId);
        if (typeof stored?.networkAccess === "boolean") entry.networkAccess = stored.networkAccess;
        else if (stored)
          GameStore.setGameNetworkAccess(userDataDir, entry.gameId, entry.networkAccess);
        const cached = gameRecordsCache?.find(game => game.gameId === entry.gameId);
        if (cached) cached.networkAccess = entry.networkAccess;
      } catch (error) { try { Promise.resolve(logger.warn("The game's network setting could not be saved.", error.message)).catch(() => {}); } catch {} }
    }
  }
  const runtimeSupports = mod?.getRuntimeProvider?.(runtimeId)?.supports || {};
  const supports = key => (runtimeSupports[key] ?? moduleInfo.supports?.[key]) === true;
  const saveLocationOverride = (runtimeSupports.saveLocationOverride ?? moduleInfo.supports?.saveLocationOverride) !== false;
  const resolvedNativeAppPath =
    typeof entry?.nativeAppPath === "string" && entry.nativeAppPath.trim()
      ? entry.nativeAppPath.trim()
      : (entry.gamePath?.toLowerCase().endsWith(".app") ? entry.gamePath : null);

  const defaultSaveDir =
    typeof entry.defaultSaveDir === "string" && entry.defaultSaveDir
      ? entry.defaultSaveDir
      : null;

  const cheats = getModuleCheats(moduleId)
    ? normalizeCheatsForModule(moduleId, entry.cheats)
    : null;

  const importPath = resolveImportPath(entry);
  const defaultCandidate = resolveModuleDefaultIconPath(moduleId);
  const moduleDefaultIconPath = defaultCandidate && canRenderIconPath(defaultCandidate) ? defaultCandidate : null;
  const rawCandidate = normalizeIconPath(entry.iconPath);
  const rawIconPath = rawCandidate && canRenderIconPath(rawCandidate) ? rawCandidate : null;
  let iconPath = rawIconPath;
  let iconSource =
    typeof entry.iconSource === "string" && entry.iconSource.trim()
      ? entry.iconSource.trim()
      : null;
  if (moduleDefaultIconPath && iconPath === moduleDefaultIconPath) {
    iconSource = ICON_SOURCES.MODULE_DEFAULT;
  }
  if (!iconPath && moduleDefaultIconPath) {
    iconPath = moduleDefaultIconPath;
    iconSource = ICON_SOURCES.MODULE_DEFAULT;
  }
  if (!iconPath) iconSource = null;

  return {
    gameId: entry.gameId || null,
    order: Number.isFinite(entry.order) ? entry.order : null,
    createdAt: Number.isFinite(entry.createdAt) ? entry.createdAt : null,
    updatedAt: Number.isFinite(entry.updatedAt) ? entry.updatedAt : null,
    schemaVersion: Number.isFinite(entry.schemaVersion) ? entry.schemaVersion : GAME_SCHEMA_VERSION,
    gamePath: entry.gamePath,
    importPath,
    name: entry.name || path.basename(entry.gamePath || ""),
    notes: typeof entry.notes === "string" ? entry.notes : "",
    launchArguments: typeof entry.launchArguments === "string" ? entry.launchArguments : "",
    networkAccess: entry.networkAccess,
    reshade: ReShade.normalizeSettings(entry.reshade),
    graphics: GraphicsSettings.normalizeSettings(entry.graphics),
    effects: EffectsPlan.normalize(entry.effects),
    moduleId,
    gameType: entry.gameType ?? moduleInfo.gameType ?? null,
    indexDir: entry.indexDir,
    indexHtml: entry.indexHtml,
    contentRootDir: entry.contentRootDir ?? entry.gamePath,
    defaultSaveDir,
    saveLocations: entry.saveLocations || [],
    saveDirOverride: saveLocationOverride ? entry.saveDirOverride ?? null : null,
    nativeAppPath: resolvedNativeAppPath ?? null,
    lastBuiltAt: entry.lastBuiltAt ?? null,
    runtimeId,
    runtimeData,
    runtimeSettings,
    moduleData,
    cheats,
    iconPath,
    iconSource,
    lastPlayedAt: entry.lastPlayedAt ?? null,
    moduleFamily: moduleInfo.family,
    moduleLabel: moduleInfo.label,
    moduleShortLabel: moduleInfo.shortLabel,
    moduleRuntimeSupport: resolveRuntimeSupportForEntry(mod, moduleInfo, entryContext, moduleSettings,
      { app, userDataDir, settings, getRuntimeManagerState: id => runtimeStateSnapshots[id] || { installed: [] } }),
    moduleSupports: {
      launch: canLaunchEntry({ mod, info: moduleInfo, entry: entryContext, runtimeId, moduleSettings,
        context: { app, userDataDir, settings } }),
      cheats: supports("cheats"),
      cheatsPatcher: supports("cheatsPatcher"),
      saveEditing: supports("saveEditing"),
      saveLocation: supports("saveLocation"),
      saveLocationOverride
    }
  };
}

function buildModuleLaunchContext(entry, settings, options = {}) {
  return launcherService.getLaunchContext(entry, settings, options);
}

function updateEntryModuleData(entry, patch) {
  const current = entry?.moduleData && typeof entry.moduleData === "object" ? entry.moduleData : {};
  const next = { ...current };
  for (const [key, value] of Object.entries(patch || {})) {
    if (value === null || value === undefined) delete next[key];
    else next[key] = value;
  }
  entry.moduleData = next;
}

function updateEntryRuntimeData(entry, runtimeId, patch) {
  const runtimeData =
    entry?.runtimeData && typeof entry.runtimeData === "object" ? entry.runtimeData : {};
  const existing = runtimeData[runtimeId] && typeof runtimeData[runtimeId] === "object"
    ? runtimeData[runtimeId]
    : {};
  if (patch === null) {
    delete runtimeData[runtimeId];
    entry.runtimeData = { ...runtimeData };
    return;
  }
  runtimeData[runtimeId] = { ...existing, ...(patch || {}) };
  entry.runtimeData = { ...runtimeData };
}

function setEntryRuntimeSettings(entry, runtimeId, settings) {
  const runtimeSettings =
    entry?.runtimeSettings && typeof entry.runtimeSettings === "object"
      ? entry.runtimeSettings
      : {};
  if (settings === null) {
    delete runtimeSettings[runtimeId];
    entry.runtimeSettings = { ...runtimeSettings };
    return;
  }
  runtimeSettings[runtimeId] = settings && typeof settings === "object" ? { ...settings } : {};
  entry.runtimeSettings = { ...runtimeSettings };
}

function resolveModuleLibSelections(entry, mod) {
  if (!mod?.libs?.catalog || typeof mod.libs.catalog.listDependencies !== "function") return null;
  const overrides =
    entry?.moduleData && typeof entry.moduleData === "object" && entry.moduleData.libVersions
      ? entry.moduleData.libVersions
      : {};
  const deps = mod.libs.catalog.listDependencies();
  const selections = {};
  const moduleId = mod.manifest?.id;

  for (const dep of deps) {
    if (dep.engine && moduleId && dep.engine !== moduleId) continue;
    const override = overrides[dep.id];
    if (override && mod.libs.catalog.getVersion(dep.id, override)) {
      selections[dep.id] = override;
      continue;
    }
    if (Array.isArray(dep.versions) && dep.versions.length > 0) {
      selections[dep.id] = dep.versions[0].id;
    }
  }

  return selections;
}

const recentDecorationCache = new Map();
function decorateRecentEntry(entry, settings) {
  const graphicsWarnings = graphicsLaunchWarnings.get(entry.gamePath);
  const key = JSON.stringify([entry, settings?.modules?.[resolveModuleId(entry)], settings?.runtimes, runtimeInventoryRevision, graphicsWarnings]);
  const previous = recentDecorationCache.get(entry.gameId || entry.gamePath);
  if (previous?.key === key) return previous.value;
  const normalized = normalizeGameEntry(entry, settings);
  const value = { ...normalized, iconUrl: iconUrlForPath(normalized.iconPath), ...(graphicsWarnings?.length ? {graphicsWarnings} : {}) };
  recentDecorationCache.set(entry.gameId || entry.gamePath, { key, value });
  return value;
}

function resolveSaveContext(gamePath) {
  const settings = loadSettings();
  const games = loadGamesHydrated({ persist: false });
  const entry = findGameByPath(games, gamePath);
  if (!entry) throw new Error("Game not found in library");

  const detected = entry;
  const saveDir = saveDirectoryForEntry(entry, Modules);
  if (!saveDir) {
    const info = Modules.getModuleInfo(resolveModuleId(detected));
    throw new Error(`Save directory is not available for ${info.label}.`);
  }
  return { entry, detected, saveDir, settings };
}


function getCheatsPatcherForModule(moduleId) {
  const patcher = getCheatsPatcherIfSupported(moduleId);
  if (patcher) return patcher;
  const info = Modules.getModuleInfo(moduleId);
  throw new Error(`Cheats patching is not supported for ${info.label}.`);
}




function listKnownSaveExtensions() {
  const out = new Set();
  for (const mod of Modules.listModuleIds()) {
    const entry = Modules.getModule(mod);
    const exts = Array.isArray(entry?.save?.extensions) ? entry.save.extensions : [];
    for (const ext of exts) {
      if (ext) out.add(String(ext));
    }
  }
  return Array.from(out);
}

function sanitizeFileSegment(input) {
  return String(input || "game")
    .trim()
    .replace(/[^a-zA-Z0-9._ -]+/g, "_")
    .replace(/\s+/g, " ")
    .slice(0, 80)
    .trim();
}

function timestampForPath() {
  const d = new Date();
  const pad2 = n => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` +
    `_${pad2(d.getHours())}-${pad2(d.getMinutes())}-${pad2(d.getSeconds())}`
  );
}


function stablePartitionId(gameId, mode = "protected") {
  const id = String(gameId || "").replace(/[^0-9A-Za-z_-]+/g, "");
  const suffix = mode === "unrestricted" ? "unrestricted-" : "";
  return `persist:maclauncher-game-${suffix}${id || "unknown"}`;
}


function iconCacheDir(gameId) {
  if (!gameId) return null;
  const dir = GameData.resolveGameIconsDir(app.getPath("userData"), gameId);
  ensureDir(dir);
  return dir;
}

function iconCachePath(gameId, source) {
  const dir = iconCacheDir(gameId);
  if (!dir) return null;
  const safeSource = String(source || "icon").replace(/[^a-z0-9-]+/gi, "");
  const fileName = safeSource ? `icon-${safeSource}.png` : "icon.png";
  return path.join(dir, fileName);
}

function writePngToCache(cachePath, pngBuffer) {
  if (!cachePath || !pngBuffer || pngBuffer.length === 0) return null;
  try {
    ensureDir(path.dirname(cachePath));
    try { if (fs.lstatSync(cachePath).isSymbolicLink()) return null; } catch (error) { if (error.code !== "ENOENT") return null; }
    fs.writeFileSync(cachePath, pngBuffer);
    return cachePath;
  } catch {
    return null;
  }
}

async function extractIconToCache(sourcePath, source, cachePath) {
  let extracted;
  try { extracted = await backendService.request("icons", "extractIcon", sourcePath, source); }
  catch { return null; }
  if (extracted?.png) return writePngToCache(cachePath, extracted.png);
  if (!extracted?.fallbackPath) return null;
  try {
    const img = nativeImage.createFromPath(extracted.fallbackPath);
    if (img && !img.isEmpty()) {
      return writePngToCache(cachePath, img.toPNG());
    }
  } catch {}

  return null;
}

const iconExtractionFailures = new Map();

async function ensureCachedIcon(entry, sourcePath, source) {
  if (!ICON_EXTRACTION_ENABLED) return null;
  if (!entry?.gameId || !sourcePath || !source) return null;
  try {
    if (!fs.existsSync(sourcePath)) return null;
  } catch {
    return null;
  }

  const cachePath = iconCachePath(entry.gameId, source);
  if (!cachePath) return null;
  const fingerprint = require("../core/game-icons").sourceFingerprint({ path: sourcePath, source });
  if (!fingerprint || iconExtractionFailures.has(fingerprint)) return null;
  const recordPath = cachePath + ".source.json";
  try {
    for (const file of [cachePath, recordPath]) {
      try { if (fs.lstatSync(file).isSymbolicLink()) return null; } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  } catch { return null; }
  try {
    if (fs.existsSync(cachePath)) {
      const stat = fs.statSync(cachePath);
      let record;
      try { record = JSON.parse(fs.readFileSync(recordPath, "utf8")); } catch {}
      if (stat.isFile() && stat.size > 0 && record?.fingerprint === fingerprint && canRenderIconPath(cachePath)) return cachePath;
      fs.rmSync(cachePath, { force: true });
    }
  } catch {}

  let result;
  if (source === ICON_SOURCES.APP) {
    const appPath = resolveAppBundleFromPath(sourcePath) || sourcePath;
    result = await extractIconToCache(appPath, source, cachePath);
  } else if (source === ICON_SOURCES.EXE) result = await extractIconToCache(sourcePath, source, cachePath);
  if (result && canRenderIconPath(result)) {
    try { fs.writeFileSync(recordPath, JSON.stringify({ fingerprint }) + "\n"); return result; } catch { return null; }
  }
  iconExtractionFailures.set(fingerprint, true);
  while (iconExtractionFailures.size > 512) iconExtractionFailures.delete(iconExtractionFailures.keys().next().value);
  return null;
}

function applyIconFields(entry, iconPath, iconSource) {
  const nextPath = iconPath || null;
  const nextSource = nextPath ? iconSource || null : null;
  const prevPath = entry.iconPath || null;
  const prevSource = entry.iconSource || null;
  if (prevPath === nextPath && prevSource === nextSource) return false;
  entry.iconPath = nextPath;
  entry.iconSource = nextSource;
  return true;
}

async function ensureIconForEntry(entry) {
  if (!entry || typeof entry !== "object") return false;
  const moduleId = resolveModuleId(entry);
  const mod = Modules.getModule(moduleId);

  const selected = await require("../core/game-icons").selectIconForEntry({ entry,
    moduleIconPath: await resolveModuleIconPath(mod, entry), moduleDefaultIconPath: resolveModuleDefaultIconPath(moduleId),
    canRenderPath: canRenderIconPath,
    extractCandidate: candidate => ensureCachedIcon(entry, candidate.path, candidate.source) });
  return applyIconFields(entry, selected.path, selected.source);
}

let iconRefreshPromise = null;

async function ensureIconsForRecents(games, settings) {
  if (iconRefreshPromise) return iconRefreshPromise;
  iconRefreshPromise = (async () => {
    let changed = false;
    for (const entry of games || []) {
      // eslint-disable-next-line no-await-in-loop
      if (await ensureIconForEntry(entry)) {
        entry.updatedAt = Date.now();
        changed = true;
      }
    }
    if (changed) {
      saveGameRecords(games);
      cachedState = buildState(settings, games);
      broadcastState();
    }
  })();
  try {
    await iconRefreshPromise;
  } finally {
    iconRefreshPromise = null;
  }
}

async function refreshLibraryMetadata(games, settings) {
  for (const entry of games) {
    try {
      const fresh = await backendService.request("library", "refreshEntry", entry, settings);
      const current = gameRecordsCache?.find(game => game.gameId === entry.gameId);
      if (!current) continue;
      const merged = mergeSettingsChanges(entry, fresh, current);
      if (JSON.stringify(current) === JSON.stringify(serializeGameEntry(merged))) continue;
      saveGameRecord(merged);
      cachedState = buildState(loadSettings(), loadGamesHydrated({ persist: false }));
      broadcastState();
    } catch (error) { logger.debug(`[library] metadata unavailable for ${entry.name || entry.gamePath}`, error.message); }
  }
}

async function applyGameDockIdentity(entry) {
  if (process.platform !== "darwin") return;
  if (!entry || typeof entry !== "object") return;
  const title = typeof entry.name === "string" ? entry.name.trim() : "";
  if (title) {
    try {
      app.setName(title);
    } catch {}
  }
  const iconPath = normalizeIconPath(entry.iconPath);
  if (iconPath) {
    try {
      const dockIcon = await require("../modules/shared/dock-icon").prepare(iconPath, GameData.resolveGameIconsDir(userDataDir, entry.gameId));
      const img = nativeImage.createFromPath(dockIcon);
      if (img && !img.isEmpty()) app.dock.setIcon(img);
    } catch {}
  }
}

const gamePoliciesByWebContentsId = new Map();
const runningGameSessions = new Map();
const pendingGameCompletions = new Map();
let nextRunSessionId = 1;
const pendingRuntimeRecoveryPrompts = new Set();

function resolveLauncherDialogWindow() {
  if (mainWindow) return mainWindow;
  for (const win of launcherWindows) {
    if (win && !win.isDestroyed()) return win;
  }
  return null;
}

async function maybeOfferRuntimeRecoveryAfterCrash(gamePath, runtimeId, signal) {
  if (!signal || !gamePath || pendingRuntimeRecoveryPrompts.has(gamePath)) return;
  const settings = loadSettings();
  const games = loadGamesHydrated({ persist: false });
  const entry = findGameByPath(games, gamePath);
  if (!entry) return;
  const mod = Modules.getModule(resolveModuleId(entry));
  if (typeof mod?.onRuntimeCrash !== "function") return;
  pendingRuntimeRecoveryPrompts.add(gamePath);
  try {
    const changed = await mod.onRuntimeCrash(entry, { runtimeId, signal }, {
      ...buildModuleLaunchContext(entry, settings, { runtimeId }),
      dialogWindow: resolveLauncherDialogWindow()
    });
    if (!changed) return;
    entry.updatedAt = Date.now();
    saveGameRecord(entry);
    cachedState = buildState(settings, games);
    broadcastState();
  } catch (error) {
    logger.error("[runtime] recovery failed", String(error?.message || error));
  } finally {
    pendingRuntimeRecoveryPrompts.delete(gamePath);
  }
}

function buildRunningState() {
  const running = {};
  for (const [gamePath, runs] of runningGameSessions.entries()) {
    if (!runs || runs.size === 0) continue;
    running[gamePath] = runs.size;
  }
  return running;
}

function registerGameRun(gamePath, session) {
  pendingGameCompletions.delete(gamePath);
  const id = nextRunSessionId++;
  const runs = runningGameSessions.get(gamePath) || new Map();
  runs.set(id, { id, ...session });
  runningGameSessions.set(gamePath, runs);
  broadcastActivity({ runningChanged: true });
  return id;
}

function unregisterGameRun(gamePath, runId) {
  const runs = runningGameSessions.get(gamePath);
  if (!runs) return;
  const graphicsRuntimeUse = runs.get(runId)?.graphicsRuntimeUse;
  runs.delete(runId);
  if (graphicsRuntimeUse) void graphicsRuntimeUse.release().catch(error => logger.warn("[graphics] Model release failed:", error.message));
  if (runs.size === 0) runningGameSessions.delete(gamePath);
  broadcastActivity({ runningChanged: true });
}

function registerGameWindowRun(gamePath, win, runtimeId) {
  if (!win) return null;
  const runId = registerGameRun(gamePath, { kind: "window", runtimeId, win });
  win.once("closed", () => unregisterGameRun(gamePath, runId));
  return runId;
}

const observedProcessRuns = new WeakMap();
function registerProcessRun(gamePath, child, runtimeId) {
  if (!child || !child.pid) return null;
  if (observedProcessRuns.has(child)) return observedProcessRuns.get(child);
  const runId = child.exitCode != null || child.signalCode != null ? null
    : registerGameRun(gamePath, { kind: "process", pid: child.pid, runtimeId });
  observedProcessRuns.set(child, runId);
  const session = runningGameSessions.get(gamePath)?.get(runId);
  if (session) {
    const pid = child.pid;
    session.stopProcess = () => requestProcessStop(child, {isCurrent: () =>
      runningGameSessions.get(gamePath)?.get(runId) === session && session.pid === pid && child.pid === pid});
  }
  const observation = {};
  pendingGameCompletions.set(gamePath, observation);
  observeGameProcess(child, {
    isStopping: () => session?.stopRequested === true || child.stopRequested === true,
    onExit: () => { if (runId != null) void afterProcessStop(child, () => unregisterGameRun(gamePath, runId)); },
    onFailure: ({ code, signal, error, diagnostics }) => {
      const entry = findGameByPath(gameRecordsCache || [], gamePath);
      const name = entry?.name || path.basename(gamePath);
      const reason = error ? String(error.message || error) : signal || `exit ${code}`;
      const detail = diagnostics?.message ? `\n${diagnostics.message}` : "";
      const message = `${name} stopped unexpectedly (${reason}).${detail}`;
      logger.error(`[game] ${gamePath}: ${reason}${detail}`);
      // A replacement launch owns the current UI. Retain the old error in the
      // log without presenting it as a failure of the new run or recovering it.
      if (pendingGameCompletions.get(gamePath) !== observation) return;
      for (const win of launcherWindows) {
        try { win.webContents.send("launcher:gameFailed", { gamePath, message }); } catch {}
      }
      if (signal) void maybeOfferRuntimeRecoveryAfterCrash(gamePath, runtimeId, signal);
    },
    onComplete: () => {
      if (pendingGameCompletions.get(gamePath) === observation) pendingGameCompletions.delete(gamePath);
    }
  });
  return runId;
}

async function stopRunSession(session) {
  if (!session) return false;
  session.stopRequested = true;
  if (session.win && !session.win.isDestroyed()) {
    try {
      session.win.close();
      return true;
    } catch {
      return false;
    }
  }
  if (session.pid) {
    if (session.stopProcess) return session.stopProcess();
    return stopProcessTree(session.pid);
  }
  return false;
}

async function stopGameRuns(gamePath) {
  const sessions = Array.from(runningGameSessions.get(gamePath)?.values() || []);
  // Mark stop intent before cancellation can deliver a process exit event.
  for (const session of sessions) session.stopRequested = true;
  cancelGraphicsEdits(gamePath);
  const entry = findGameByPath(gameRecordsCache || loadGamesHydrated({ persist: false }), gamePath);
  const cancelled = entry ? backendService.cancelLaunch(entry) : Promise.resolve(false);
  const results = await Promise.allSettled([cancelled, ...sessions.map(session => stopRunSession(session))]);
  const failed = results.find(result => result.status === "rejected");
  if (failed) throw failed.reason;
  return Boolean(results[0].value) || sessions.length > 0;
}

function buildRuntimeManagerState(settings) {
  const out = {};
  for (const manager of listRuntimeManagers()) {
    if (!manager || typeof manager.getState !== "function") continue;
    const state = runtimeStateSnapshots[manager.id] || { installed: [], catalog: { versions: [], loading: true } };
    out[manager.id] = {
      label: manager.label || manager.id,
      ...state,
      id: manager.id,
      ui: Modules.getRuntimeManagerUi(manager.id) || state.ui || manager.ui || undefined
    };
  }
  return out;
}

function buildRuntimeDefaultsState() {
  const out = {};
  for (const moduleInfo of Modules.listModules()) {
    const supported = Array.isArray(moduleInfo?.runtime?.supported)
      ? moduleInfo.runtime.supported
      : [];
    for (const runtimeId of supported) {
      if (out[runtimeId]) continue;
      const defaults = readRuntimeDefaults(runtimeId, moduleInfo);
      if (defaults) out[runtimeId] = defaults;
    }
  }
  return out;
}

function buildModuleState(settings) {
  const out = {};
  for (const id of Modules.listModuleIds()) {
    const mod = Modules.getModule(id);
    if (!mod) continue;
    const state = moduleStateSnapshots[id];
    const next = state && typeof state === "object" ? { ...state } : {};
    const cheats = getModuleCheats(id);
    if (!next.cheats && cheats?.schema) {
      next.cheats = {
        schema: cheats.schema,
        defaults:
          cheats.defaults && typeof cheats.defaults === "object"
            ? { ...cheats.defaults }
            : {}
      };
    }
    if (Object.keys(next).length > 0) out[id] = next;
  }
  return out;
}

let mainWindow = null;
let mainWindowOpening = null;
let cachedState = null;
let lastRuntimeSettingsMigration = false;
const launcherWindows = new Set();
const activityDelivery = require("./activity-delivery").createActivityDelivery((win, message) =>
  win.webContents.send("launcher:activity", message));
const saveEditorWindows = new Map();
const utilityWindows = createUtilityWindowController({
  createWindow: options => {
    const workArea = screen.getPrimaryDisplay().workAreaSize;
    return new BrowserWindow({ ...options,
      width: Math.min(options.width, Math.max(options.minWidth, workArea.width - 48)),
      height: Math.min(options.height, Math.max(options.minHeight, workArea.height - 48)),
      backgroundColor: "#111318",
      webPreferences: { preload: path.resolve(__dirname, "../modules/shared/web/preload/launcher.js"),
        nodeIntegration: false, contextIsolation: true, sandbox: false, devTools: devtoolsEnabled }
    });
  },
  loadView: (win, request) => loadLauncherView(win, request),
  registerWindow: (win, view) => {
    win.__maclauncherWindowType = view;
    registerLauncherWindow(win);
    attachWebContentsLogging(win.webContents, view);
    attachDevToolsShortcut(win);
    attachDevToolsAutoOpen(win, view);
  },
  onContextChange: () => broadcastState()
});
const downloadManager = new DownloadManager({
  onChange: () => {
    if (!cachedState) return;
    broadcastActivity();
  }
});
const steamWindow = require("./steam-window-service").createSteamWindowService({
  userDataDir,
  confirmDuplicate: confirmDuplicateDownload,
  readGames: () => loadGamesHydrated({ persist: false }),
  importGame: (input, options) => gameImports.import(input, options),
  ...require("./steam-session").createSteamSessionStorage({ userDataDir, safeStorage }),
  onChange: state => {
    for (const win of launcherWindows) {
      if (win.isDestroyed() || win.__maclauncherWindowType !== "external") continue;
      try { win.webContents.send("launcher:steamState", state); } catch {}
    }
  }
});

function steamHandle(action, handler) {
  ipcMain.handle(`launcher:steam${action}`, (event, ...args) => {
    if (!launcherWindows.has(BrowserWindow.fromWebContents(event.sender)))
      throw new Error("Open External from the MacLauncher library.");
    return handler(...args);
  });
}
steamHandle("State", () => steamWindow.initialize());
steamHandle("Scan", () => steamWindow.scan());
steamHandle("Import", ids => steamWindow.importInstalled(ids));
steamHandle("ImportDownload", id => steamWindow.importDownload(id));
steamHandle("Connect", credentials => steamWindow.connect(credentials));
steamHandle("SelectAccount", id => steamWindow.selectAccount(id));
steamHandle("RemoveAccount", id => steamWindow.removeAccount(id));
steamHandle("Auth", response => steamWindow.submitAuth(response));
steamHandle("Disconnect", () => steamWindow.disconnect());
steamHandle("Library", refresh => steamWindow.loadLibrary(refresh));
steamHandle("Versions", (appId, refresh) => steamWindow.getVersions(appId, refresh));
steamHandle("PreviousVersions", (appId, depotIds, refresh) => steamWindow.previousVersions(appId, depotIds, refresh));
steamHandle("OpenHistory", (appId, depotId) => shell.openExternal(require("../core/steam-version-history").historyUrl(appId, depotId)));
steamHandle("Download", selection => steamWindow.download(selection));
steamHandle("Cancel", id => steamWindow.cancel(id));
steamHandle("ChooseDirectory", async () => {
  const options = { title: "Download location", properties: ["openDirectory", "createDirectory"] };
  const owner = getLauncherDialogOwner();
  const result = await dialog.showOpenDialog(...(owner ? [owner, options] : [options]));
  return result.canceled ? null : result.filePaths[0] || null;
});
const googlePlayAuth = require("../modules/android/store/google-play-auth").createGooglePlayAuth({
  userDataDir,
  createWindow: options => new BrowserWindow({ ...options, parent: getLauncherDialogOwner() || undefined }),
  getSession: partition => session.fromPartition(partition)
});
const googleAccountProcesses = new Set();
const googleAccountController = new AbortController();
const microgAccounts = require("../modules/android/store/microg-accounts").createMicrogAccounts({
  getContext: ({ signal } = {}) => ({
    userDataDir, settings: loadSettings(), logger, app, ui: { shell, dialog, nativeImage, systemPreferences },
    downloads: downloadManager, confirmRuntimeInstall: confirmRuntimeInstallation,
    signal: signal ? AbortSignal.any([signal, googleAccountController.signal]) : googleAccountController.signal,
    onRuntimeStateChange: () => { void refreshRuntimeSnapshots(); },
    onToolProcessSpawn: (child, options) => {
      if (options?.stopOnLauncherExit !== true || !child?.pid) return;
      googleAccountProcesses.add(child);
      child.once("close", () => googleAccountProcesses.delete(child));
    }
  })
});
const googleSessionVault = require("./steam-session").createSteamSessionStorage({ userDataDir, safeStorage, namespace: "external/google-play" });
const googleAccountManager = require("../modules/android/store/google-account-manager").createGoogleAccountManager({
  browserAuth: googlePlayAuth, microg: microgAccounts, vault: googleSessionVault,
  onChanged: () => externalStores.accounts("google-play", false),
  onRemoved: account => externalStores.accountRemoved("google-play", account)
});
const hostAccountActions = require("./module-host-account-actions").createModuleHostAccountActions({
  getModule: id => Modules.getModule(id), managers: { "google-play": googleAccountManager }
});
const externalStores = require("./external-store-service").createExternalStoreService({
  userDataDir, confirmDuplicate: confirmDuplicateDownload, importGame: job => steamWindow.importExternal(job), openExternal: url => shell.openExternal(url),
  browserLogin: options => googleAccountManager.browserLogin(options),
  prepareAccountSession: options => googleAccountManager.prepareSavedSession(options),
  focusLogin: accountId => googlePlayAuth.focus(accountId),
  clearBrowserAccount: accountId => googleAccountManager.clearBrowserAccount(accountId),
  microgLogin: ({ accountId, ...options }) => microgAccounts.getToken({ id: accountId, ...options }),
  listAccounts: options => microgAccounts.list(options),
  openAccounts: () => utilityWindows.open({ view: "settings", sectionId: "module:android" }).then(() => true),
  createStorage: store => {
    if (store === "google-play") return { loadSession: () => googleAccountManager.loadActiveSession(), saveSession: value => googleAccountManager.saveActiveSession(value) };
    const vault = require("./steam-session").createSteamSessionStorage({ userDataDir, safeStorage, namespace: `external/${store}` });
    return { loadSession: async () => (await vault.loadSession(store))?.session || null,
      saveSession: session => vault.saveSession(session ? { accountName: store, session } : null, store) };
  },
  onChange: payload => {
    if (!payload.state) return;
    for (const win of launcherWindows) {
      if (win.isDestroyed() || win.__maclauncherWindowType !== "external") continue;
      try { win.webContents.send("launcher:externalState", payload); } catch {}
    }
  }
});
function externalHandle(action, handler) {
  ipcMain.handle(`launcher:external${action}`, (event, ...args) => {
    if (!launcherWindows.has(BrowserWindow.fromWebContents(event.sender))) throw new Error("Open External from the MacLauncher library.");
    return handler(...args);
  });
}
externalHandle("State", store => externalStores.snapshot(store));
externalHandle("Connect", (store, credentials) => externalStores.connect(store, credentials));
externalHandle("Auth", (store, response) => externalStores.auth(store, response));
externalHandle("Disconnect", store => externalStores.disconnect(store));
externalHandle("Forget", store => externalStores.forget(store));
externalHandle("OpenLogin", store => externalStores.openLogin(store));
externalHandle("Accounts", (store, refresh) => externalStores.accounts(store, refresh));
externalHandle("OpenAccounts", store => externalStores.openAccounts(store));
externalHandle("Library", (store, refresh) => externalStores.library(store, refresh));
externalHandle("Search", (store, query, options) => externalStores.search(store, query, options));
externalHandle("AddToLibrary", (store, id, options) => externalStores.addToLibrary(store, id, options));
externalHandle("AddGame", (store, url) => externalStores.addGame(store, url));
externalHandle("Versions", (store, id, refresh, options) => externalStores.versions(store, id, refresh, options));
externalHandle("Download", (store, selection) => externalStores.download(store, selection));
externalHandle("Cancel", (store, id) => externalStores.cancel(store, id));
externalHandle("ImportDownload", (store, id) => externalStores.importDownload(store, id));
externalHandle("Downloaded", () => steamWindow.listDownloaded());
externalHandle("ImportCopies", ids => steamWindow.importCopies(ids));
externalHandle("OpenDownloads", async store => {
  if (store != null && !require("../core/external-store-providers").downloadStoreIds.includes(store)) throw new Error("Choose an external game store.");
  const directory = path.join(userDataDir, "external", "downloads", ...(store ? [store] : []));
  await fs.promises.mkdir(directory, { recursive: true });
  const error = await shell.openPath(directory);
  if (error) throw new Error("The download location could not be opened in Finder.");
  return true;
});

async function confirmDuplicateDownload(existing, { signal } = {}) {
  const options = { type: "question", title: "Version already downloaded", message: "This exact version is already downloaded.",
    detail: `${existing.name || "Game"}${existing.versionName || existing.version ? ` · ${existing.versionName || existing.version}` : ""}${existing.language ? ` · ${existing.language}` : ""}\n${existing.path}`,
    buttons: ["Use existing copy", "Download again", "Cancel"], defaultId: 0, cancelId: 2, noLink: true, ...(signal ? { signal } : {}) };
  const owner = getLauncherDialogOwner();
  const { response } = await dialog.showMessageBox(...(owner ? [owner, options] : [options]));
  return ["use-existing", "download-again", "cancel"][response] || "cancel";
}

function getLauncherActivity() {
  return {
    running: buildRunningState(),
    preparing: { ...Object.fromEntries(gamePreparations), ...Object.fromEntries(gameRemovals) },
    importing: gameImports.list().map(job => ({ ...job, ...importProgress.get(job.inputPath) })),
    downloads: [...downloadManager.list(), ...backendService.listDownloads()]
  };
}

function getLauncherState() {
  return cachedState ? { ...cachedState, ...getLauncherActivity() } : cachedState;
}

function updateBackendRunning() {
  const running = buildRunningState();
  backendService.updateRunning({ games: running, saveRoots: (gameRecordsCache || []).filter(entry => running[entry.gamePath])
    .flatMap(entry => [...(runningGameSessions.get(entry.gamePath)?.values() || [])]
      .map(run => saveDirectoryForEntry(entry, Modules, run.runtimeId)))
    .filter(directory => typeof directory === "string" && path.isAbsolute(directory)) });
}

// Frequent progress must not serialize library records, runtime catalogs or
// inspector data through Electron and the context bridge on every update.
function broadcastActivity({ runningChanged = false } = {}) {
  if (runningChanged) updateBackendRunning();
  if (!cachedState || launcherWindows.size === 0) return;
  const activity = getLauncherActivity();
  for (const win of launcherWindows) {
    activityDelivery.publish(win, activity);
  }
}

function broadcastState() {
  if (launcherWindows.size === 0) return;
  updateBackendRunning();
  const state = getLauncherState();
  for (const win of launcherWindows) {
    try {
      activityDelivery.supersede(win);
      win.webContents.send("launcher:state", utilityWindows.stateForWindow(win, state));
    } catch {}
  }
}

function registerLauncherWindow(win) {
  if (!win) return;
  launcherWindows.add(win);
  win.on("closed", () => { launcherWindows.delete(win); activityDelivery.close(win); });
}

function openDevToolsForWindow(win, source = "unknown") {
  if (!win || !win.webContents) {
    logger.warn(`[devtools] open ignored; missing window (${source})`);
    return false;
  }
  const wc = win.webContents;
  const winType = win.__maclauncherWindowType || "unknown";
  if (wc.isDevToolsOpened()) {
    try {
      wc.focusDevTools();
    } catch {}
    logger.info(`[devtools] already open (${source}) type=${winType} id=${wc.id}`);
    return true;
  }
  logger.info(`[devtools] open request (${source}) type=${winType} id=${wc.id}`);
  try {
    wc.openDevTools({ mode: "detach" });
  } catch (e) {
    logger.warn(`[devtools] open failed (${source}) ${String(e?.message || e)}`);
    return false;
  }
  setTimeout(() => {
    if (wc.isDevToolsOpened()) {
      logger.info(`[devtools] opened (${source}) type=${winType} id=${wc.id}`);
      return;
    }
    try {
      wc.openDevTools({ mode: "right" });
    } catch (e) {
      logger.warn(`[devtools] fallback open failed (${source}) ${String(e?.message || e)}`);
      return;
    }
    setTimeout(() => {
      logger.info(
        `[devtools] opened=${String(wc.isDevToolsOpened())} (${source}) type=${winType} id=${wc.id}`
      );
    }, 150);
  }, 150);
  return true;
}

function attachDevToolsShortcut(win) {
  if (!devtoolsEnabled || !win || !win.webContents) return;
  if (win.__maclauncherDevToolsShortcutInstalled) return;
  win.__maclauncherDevToolsShortcutInstalled = true;

  win.webContents.on("before-input-event", (event, input) => {
    if (input.type && input.type !== "keyDown") return;
    const key = String(input.key || "").toLowerCase();
    const wantsDevTools =
      (process.platform === "darwin" && input.meta && input.alt && key === "i") ||
      (process.platform !== "darwin" && input.control && input.shift && key === "i");
    if (!wantsDevTools) return;
    try {
      event.preventDefault();
    } catch {}
    openDevToolsForWindow(win, "before-input-event");
  });

  win.webContents.on("devtools-opened", () => {
    logger.info(
      `[devtools] event opened type=${win.__maclauncherWindowType || "unknown"} id=${win.webContents.id}`
    );
  });
  win.webContents.on("devtools-closed", () => {
    logger.info(
      `[devtools] event closed type=${win.__maclauncherWindowType || "unknown"} id=${win.webContents.id}`
    );
  });
}

function attachDevToolsAutoOpen(win, source) {
  if (!devtoolsAuto || !win || !win.webContents) return;
  if (win.__maclauncherDevToolsAutoInstalled) return;
  win.__maclauncherDevToolsAutoInstalled = true;
  let opened = false;
  const openOnce = reason => {
    if (opened) return;
    opened = true;
    openDevToolsForWindow(win, reason);
  };
  win.webContents.once("did-finish-load", () => openOnce(`${source}:did-finish-load`));
  win.webContents.once("did-fail-load", () => openOnce(`${source}:did-fail-load`));
}

async function loadLauncherView(win, query = null) {
  const startUrl = process.env.ELECTRON_START_URL;
  const cleanedQuery = query
    ? Object.fromEntries(
        Object.entries(query).filter(([, value]) => value !== undefined && value !== null && value !== "")
      )
    : null;
  if (startUrl) {
    const url = new URL(startUrl);
    if (cleanedQuery) {
      for (const [key, value] of Object.entries(cleanedQuery)) {
        url.searchParams.set(key, String(value));
      }
    }
    await loadLocalView({ url: url.toString(), load: value => win.loadURL(value),
      isDestroyed: () => win.isDestroyed(), logger });
  } else {
    const indexPath = path.resolve(__dirname, "../../dist/renderer/index.html");
    if (cleanedQuery) {
      await win.loadFile(indexPath, { query: cleanedQuery });
    } else {
      await win.loadFile(indexPath);
    }
  }
}

async function createLauncherWindow() {
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  const launcherIcon = app.isPackaged ? path.join(process.resourcesPath, "maclauncher.png")
    : path.resolve(__dirname, "../resources/maclauncher.png");
  if (process.platform === "darwin") {
    const image = nativeImage.createFromPath(launcherIcon);
    if (!image.isEmpty()) app.dock.setIcon(image);
  }
  const win = new BrowserWindow({
    width: Math.min(1440, workArea.width - 48),
    title: APP_NAME,
    height: Math.min(900, workArea.height - 48),
    minWidth: 900,
    minHeight: 560,
    icon: launcherIcon,
    backgroundColor: "#111318",
    webPreferences: {
      preload: path.resolve(__dirname, "../modules/shared/web/preload/launcher.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      devTools: true
    }
  });
  win.__maclauncherWindowType = "launcher";
  registerLauncherWindow(win);

  attachWebContentsLogging(win.webContents, "launcher");
  attachDevToolsShortcut(win);
  attachDevToolsAutoOpen(win, "launcher");

  if (isDebug) openDevToolsForWindow(win, "debug");

  try {
    await loadLauncherView(win);
  } catch (error) {
    if (!win.isDestroyed()) win.destroy();
    throw error;
  }

  try {
    const hasBridge = await win.webContents.executeJavaScript(
      `Boolean(window.MacLauncher && window.MacLauncher.launcher)`,
      true
    );
    logger.info(`[launcher] preload bridge present: ${hasBridge}`);
  } catch (e) {
    logger.error("[launcher] preload bridge check failed", String(e?.stack || e));
  }

  return win;
}

async function ensureLauncherWindow() {
  let win = mainWindow;
  if (!win || win.isDestroyed()) {
    if (!mainWindowOpening) {
      mainWindowOpening = Promise.resolve().then(createLauncherWindow).then(next => {
        if (next.isDestroyed()) return null;
        mainWindow = next;
        next.once("closed", () => { if (mainWindow === next) mainWindow = null; });
        return next;
      }).finally(() => { mainWindowOpening = null; });
    }
    win = await mainWindowOpening;
  }
  if (!win || win.isDestroyed()) return null;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  return win;
}

async function createRuntimeSettingsWindow({ scope, moduleId, runtimeId, gamePath }) {
  const win = new BrowserWindow({
    width: 560,
    height: 600,
    backgroundColor: "#0b0f17",
    title: "Runtime settings",
    webPreferences: {
      preload: path.resolve(__dirname, "../modules/shared/web/preload/launcher.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      devTools: true
    }
  });
  win.__maclauncherWindowType = "runtime-settings";
  registerLauncherWindow(win);

  attachWebContentsLogging(win.webContents, "runtime-settings");
  attachDevToolsShortcut(win);
  attachDevToolsAutoOpen(win, "runtime-settings");

  if (isDebug) openDevToolsForWindow(win, "debug");

  await loadLauncherView(win, {
    view: "runtime-settings",
    scope,
    moduleId,
    runtimeId,
    ...(gamePath ? { gamePath } : {})
  });

  return win;
}

async function createSaveEditorWindow(entry) {
  const key = entry.gameId || entry.gamePath;
  const existing = saveEditorWindows.get(key);
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.focus();
    return existing;
  }
  const win = new BrowserWindow({
    width: 920, height: 720, minWidth: 700, minHeight: 480,
    backgroundColor: "#111318", title: `${entry.name || path.basename(entry.gamePath)} — Save editor`,
    webPreferences: { preload: path.resolve(__dirname, "../modules/shared/web/preload/launcher.js"),
      nodeIntegration: false, contextIsolation: true, sandbox: false, devTools: true }
  });
  win.__maclauncherWindowType = "save-editor";
  win.on("page-title-updated", event => event.preventDefault());
  saveEditorWindows.set(key, win);
  win.on("closed", () => { if (saveEditorWindows.get(key) === win) saveEditorWindows.delete(key); });
  registerLauncherWindow(win);
  attachWebContentsLogging(win.webContents, "save-editor");
  attachDevToolsShortcut(win);
  attachDevToolsAutoOpen(win, "save-editor");
  await loadLauncherView(win, { view: "save-editor", gamePath: entry.gamePath });
  return win;
}

const liveVariableEditorWindows = new Map();
async function createLiveVariableEditorWindow(options) {
  const entry = findGameByPath(loadGamesHydrated({ persist: false }), options?.gamePath);
  if (!entry || options.moduleId !== resolveModuleId(entry) ||
      typeof options.sessionId !== "string" || !options.sessionId || options.sessionId.includes("\0")) {
    throw new Error("Live-variable session is unavailable.");
  }
  const actions = options.actions;
  const mod = Modules.getModule(options.moduleId);
  for (const key of ["status", "list", "set", "pause", "resume", "close"]) {
    if (typeof actions?.[key] !== "string" || typeof mod?.actions?.[actions[key]] !== "function") {
      throw new Error("This module does not provide a live-variable editor.");
    }
  }
  const key = entry.gameId;
  const existing = liveVariableEditorWindows.get(key);
  if (existing && !existing.isDestroyed()) {
    if (existing.__maclauncherLiveVariableSession === options.sessionId) { existing.show(); existing.focus(); return true; }
    existing.destroy();
  }
  const win = new BrowserWindow({
    width: 620, height: 640, minWidth: 480, minHeight: 400,
    backgroundColor: "#111318", title: (entry.name || "Game") + " — Live variables",
    webPreferences: { preload: path.resolve(__dirname, "../modules/shared/web/preload/launcher.js"),
      nodeIntegration: false, contextIsolation: true, sandbox: false, devTools: devtoolsEnabled }
  });
  win.__maclauncherWindowType = "live-variable-editor";
  win.__maclauncherLiveVariableSession = options.sessionId;
  win.on("page-title-updated", event => event.preventDefault());
  liveVariableEditorWindows.set(key, win);
  win.on("closed", () => {
    if (liveVariableEditorWindows.get(key) === win) liveVariableEditorWindows.delete(key);
    void backendService.request("game:" + (entry.gameId || entry.gamePath), "moduleAction", entry, actions.close,
      { sessionId: options.sessionId }, loadSettings()).catch(error => logger.debug("[live variables]", error.message));
  });
  registerLauncherWindow(win);
  attachWebContentsLogging(win.webContents, "live-variable-editor");
  attachDevToolsShortcut(win);
  try {
    await loadLauncherView(win, { view: "live-variables", gamePath: entry.gamePath,
      sessionId: options.sessionId, actions: JSON.stringify(actions) });
    return true;
  } catch (error) { win.destroy(); throw error; }
}

let electronGameHost;
async function createGameWindow(gameEntry, options = {}) {
  if (!electronGameHost) {
    electronGameHost = createElectronGameHost({
      electron: { app, BrowserWindow, dialog, ipcMain, Menu, shell, session, nativeImage },
      userDataDir, logger, policies: gamePoliciesByWebContentsId,
      loadSettings, resolveRuntimeSettingsForEntry, resolveModuleSettings,
      resolveRuntimeSupportForEntry: (mod, info, entry, moduleSettings) => resolveRuntimeSupportForEntry(mod, info, entry, moduleSettings,
        { app, userDataDir, settings: loadSettings(), getRuntimeManagerState: id => runtimeStateSnapshots[id] || { installed: [] } }),
      resolveToolsButtonVisible,
      normalizeCheatsForModule, writeCheatsFile, resolvePreferredNwjsVersion,
      resolveUserAgentSuffix, buildModuleLaunchContext,
      onProcessRun: (entry, child, runtimeId) => registerProcessRun(entry.gamePath, child, runtimeId),
      applyDockIdentity: entry => { if (!mainWindow) return applyGameDockIdentity(entry); },
      attachWebContentsLogging, attachDevToolsShortcut, attachDevToolsAutoOpen, openDevToolsForWindow,
      isDebug, isSmoke
    });
  }
  return electronGameHost.createGameWindow(gameEntry, {
    ...options,
    context: buildModuleLaunchContext(gameEntry, loadSettings(), options)
  });
}

async function launchHostedRuntimeChild(gameEntry, runtimeId, context) {
  const launch = createElectronHostLaunch({ executable: process.execPath,
    appPath: path.resolve(__dirname, "bootstrap.js"),
    gamePath: gameEntry.importPath || gameEntry.gamePath, runtimeId, userDataDir,
    gameArguments: context?.gameArguments,
    env: context ? await context.applyGameEnvironment(process.env) : process.env });
  logger.info(`[hosted] launch ${runtimeId} ${gameEntry.gamePath}`);
  return require("../modules/shared/web/runtime/isolated-host").launchIsolatedHost({ ...launch, logger }, gameEntry, context);
}

async function runGameEntry(gameEntry, runtimeId, options = {}) {
  assertGameNotRemoving(gameEntry);
  if (graphicsLaunchWarnings.delete(gameEntry.gamePath) && cachedState) {
    cachedState = {...cachedState, recents: cachedState.recents.map(entry => {
      if (entry.gamePath !== gameEntry.gamePath) return entry;
      const {graphicsWarnings, ...rest} = entry;
      return rest;
    })};
    broadcastState();
  }
  const graphicsRequested = ReShade.executionRequirements(gameEntry).needed.processor;
  const previousGraphicsLaunchId = graphicsRequested
    ? require("../modules/shared/reshade/launch-binding").read(gameEntry, {userDataDir})?.launchId : null;
  pendingGameCompletions.delete(gameEntry.gamePath);
  gamePreparations.set(gameEntry.gamePath, { phase: "check", label: "Starting game…" });
  broadcastActivity();
  let result;
  try { result = await backendService.launchEntry(gameEntry, {
    ...options, runtimeId, settings: loadSettings()
  }); } finally { gamePreparations.delete(gameEntry.gamePath); broadcastActivity(); }
  if (result.kind === "cancelled") return false;
  if (graphicsRequested) {
    const warnings = require("./graphics-launch-status").warningsForLaunch(gameEntry,
      {userDataDir, previousLaunchId: previousGraphicsLaunchId, pid: result.child?.pid,
        preparationWarnings: result.graphicsWarnings});
    if (warnings.length) graphicsLaunchWarnings.set(gameEntry.gamePath, warnings);
  }
  if (result.kind === "window") registerGameWindowRun(gameEntry.gamePath, result.win, result.runtimeId);
  else registerProcessRun(gameEntry.gamePath, result.child, result.runtimeId);
  const games = loadGamesHydrated({ persist: false });
  const stored = findGameByPath(games, gameEntry.gamePath);
  if (stored) {
    stored.lastPlayedAt = Date.now();
    saveGameRecord(stored);
    cachedState = buildState(loadSettings(), games);
    broadcastState();
  }
  return true;
}

async function runGameByPath(gamePath, options = {}) {
  const games = loadGamesHydrated({ persist: false });
  const entry = findGameByPath(games, gamePath);
  if (!entry) throw new Error("Game not found in library");
  return runGameEntry(entry, options.runtimeOverride ?? entry.runtimeId);
}

function buildState(settings, games) {
  const ordered = orderGames(games || [], settings?.launcher?.library);
  const present = new Set(ordered.map(entry => entry.gameId || entry.gamePath));
  for (const key of recentDecorationCache.keys()) if (!present.has(key)) recentDecorationCache.delete(key);
  return {
    recents: ordered.map(entry => decorateRecentEntry(entry, settings)),
    modules: Modules.listModules(),
    moduleSettings: launcherService.getResolvedModuleSettings(settings),
    moduleStates: buildModuleState(settings),
    runtimeManagers: buildRuntimeManagerState(settings),
    runtimeDefaults: buildRuntimeDefaultsState(),
    reshade: ReShade.getState({ app, userDataDir, settings }),
    launcherSettings: settings.launcher || {},
    debug: isDebug,
    logPath: logger.path
  };
}

function isGameWindow(win) {
  return Boolean(win && win.__maclauncherWindowType === "game");
}

function isLauncherWindow(win) {
  return Boolean(win && win.__maclauncherWindowType === "launcher");
}

function getLauncherDialogOwner() {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && !focused.isDestroyed() && launcherWindows.has(focused)) return focused;
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
}

function openUtilityFromMenu(view) {
  void utilityWindows.open({ view }).catch(error => logger.error(`[${view}]`, error.message));
}

function sendToolsMenuEvent(action) {
  const win = BrowserWindow.getFocusedWindow();
  if (!isGameWindow(win)) return;
  try {
    win.webContents.send(`maclauncher:tools:${action}`);
  } catch {}
}

function setupAppMenu() {
  const toolsSubmenu = [
    {
      label: "Toggle Tools Panel",
      accelerator: "CmdOrCtrl+Shift+T",
      click: () => sendToolsMenuEvent("toggle")
    },
    {
      label: "Open Tools Panel",
      click: () => sendToolsMenuEvent("open")
    },
    {
      label: "Close Tools Panel",
      click: () => sendToolsMenuEvent("close")
    }
  ];

  const editSubmenu = [
    { role: "undo" },
    { role: "redo" },
    { type: "separator" },
    { role: "cut" },
    { role: "copy" },
    { role: "paste" }
  ];

  if (process.platform === "darwin") {
    editSubmenu.push({ role: "pasteAndMatchStyle" });
    editSubmenu.push({ role: "delete" });
    editSubmenu.push({ role: "selectAll" });
    editSubmenu.push({ type: "separator" });
    editSubmenu.push({ role: "speech" });
  } else {
    editSubmenu.push({ role: "delete" });
    editSubmenu.push({ type: "separator" });
    editSubmenu.push({ role: "selectAll" });
  }

  const viewSubmenu = [
    { label: "Library", click: () => void ensureLauncherWindow().catch(error => logger.error("[launcher]", error.message)) },
    { label: "External", click: () => openUtilityFromMenu("external") },
    { label: "Runtimes", click: () => openUtilityFromMenu("runtimes") },
    { type: "separator" },
    { role: "reload" },
    { role: "forceReload" },
    ...(devtoolsEnabled ? [{ role: "toggleDevTools" }] : []),
    { type: "separator" },
    { role: "resetZoom" },
    { role: "zoomIn" },
    { role: "zoomOut" },
    { type: "separator" },
    // macOS supplies the visible fullscreen command.
    // Preserve Control+Command+F without adding another visible item.
    process.platform === "darwin" ? {
      label: "Toggle Full Screen",
      accelerator: "Control+Command+F",
      visible: false,
      acceleratorWorksWhenHidden: true,
      click: (_item, win) => {
        if (win && !win.isDestroyed()) win.setFullScreen(!win.isFullScreen());
      }
    } : { role: "togglefullscreen" }
  ];

  const windowSubmenu = [
    { role: "minimize" },
    { role: "zoom" }
  ];

  if (process.platform === "darwin") {
    windowSubmenu.push({ type: "separator" });
    windowSubmenu.push({ role: "front" });
  } else {
    windowSubmenu.push({ type: "separator" });
    windowSubmenu.push({ role: "close" });
  }

  const template = [];

  if (process.platform === "darwin") {
    template.push({
      label: app.name,
      submenu: [
        { role: "about" },
        { label: "Credits", click: () => openUtilityFromMenu("credits") },
        { type: "separator" },
        {
          label: "Settings…",
          accelerator: "CmdOrCtrl+,",
          click: () => openUtilityFromMenu("settings")
        },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" }
      ]
    });
  }

  template.push(
    {
      label: "File",
      submenu: [
        { label: "Open…", accelerator: "CmdOrCtrl+O", click: () => void openGamesFromMenu() },
        { type: "separator" },
        ...(process.platform === "darwin" ? [{ role: "close" }] : [{ role: "quit" }])
      ]
    },
    { label: "Edit", submenu: editSubmenu },
    { label: "View", submenu: viewSubmenu },
    { label: "Tools", submenu: toolsSubmenu },
    { label: "Window", submenu: windowSubmenu }
  );

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function upsertGame(games, nextEntry, settings) {
  const { ordered, library } = LibraryState.syncLibraryStateWithGames(
    settings?.launcher?.library,
    games
  );
  if (settings?.launcher) settings.launcher.library = library;
  const existingIndex = ordered.findIndex(r => r.gamePath === nextEntry.gamePath);
  const existing = existingIndex >= 0 ? ordered[existingIndex] : null;
  const now = Date.now();
  const gameId = existing?.gameId || nextEntry.gameId || GameData.createGameId();
  const merged = { ...(existing || {}), ...nextEntry, gameId };
  merged.networkAccess = NetworkAccess.preferenceForEntry(existing || nextEntry, settings, merged.runtimeId);
  merged.createdAt = Number.isFinite(merged.createdAt)
    ? merged.createdAt
    : Number.isFinite(existing?.createdAt)
      ? existing.createdAt
      : now;
  merged.updatedAt = now;

  const normalized = normalizeGameEntry(merged, settings);
  normalized.gameId = gameId;
  normalized.createdAt = merged.createdAt;
  normalized.updatedAt = merged.updatedAt;
  normalized.schemaVersion = GAME_SCHEMA_VERSION;

  const nextGames = LibraryState.upsertLibraryEntry(ordered, normalized);
  const nextOrder = nextGames.map(entry => entry?.gameId).filter(Boolean);
  if (settings?.launcher) {
    settings.launcher.library = LibraryState.setLibraryOrder(settings.launcher.library, nextOrder).library;
  }
  return { games: nextGames, entry: normalized };
}

function removeGameByPath(games, gamePath, settings) {
  const { ordered, library } = LibraryState.syncLibraryStateWithGames(
    settings?.launcher?.library,
    games
  );
  if (settings?.launcher) settings.launcher.library = library;
  const idx = ordered.findIndex(r => r.gamePath === gamePath);
  const removed = idx >= 0 ? ordered[idx] : null;
  if (idx >= 0) ordered.splice(idx, 1);
  const nextGames = assignGameOrder(ordered);
  const nextOrder = nextGames.map(entry => entry?.gameId).filter(Boolean);
  if (settings?.launcher) {
    let nextLibrary = settings.launcher.library;
    if (removed?.gameId) {
      nextLibrary = LibraryState.removeFromLibrary(nextLibrary, removed.gameId).library;
    }
    settings.launcher.library = LibraryState.setLibraryOrder(nextLibrary, nextOrder).library;
  }
  return { games: nextGames, removed };
}

function moveGame(games, gamePath, delta, settings) {
  const { ordered, library } = LibraryState.syncLibraryStateWithGames(
    settings?.launcher?.library,
    games
  );
  if (settings?.launcher) settings.launcher.library = library;
  const display = LibraryState.sortLibraryGames(ordered, { mode: "custom" }, library.favorites);
  const idx = display.findIndex(r => r.gamePath === gamePath);
  if (idx < 0) throw new Error("Game not found in library");
  const nextIdx = idx + delta;
  return reorderGame(ordered, gamePath, nextIdx, settings);
}

function reorderGame(games, gamePath, toIndex, settings) {
  const { library } = LibraryState.syncLibraryStateWithGames(
    settings?.launcher?.library,
    games
  );
  if (settings?.launcher) settings.launcher.library = library;
  const result = LibraryState.reorderLibraryEntry(games, library, gamePath, toIndex);
  if (settings?.launcher) settings.launcher.library = result.library;
  return result.ordered;
}

async function init() {
  logger.info("MacLauncher starting");
  setupAppMenu();
  if (!isChildGame) {
    const removed = CleanupUtils.cleanupOrphanedPartitions({ userDataDir });
    if (removed > 0) {
      logger.info(`[cleanup] removed ${removed} orphaned partition links`);
    }
  }

  const settings = loadSettingsHydrated({ persist: !isChildGame });
  const games = loadGamesHydrated({ persist: !isChildGame });
  if (!isChildGame) {
    const synced = LibraryState.syncLibraryStateWithGames(settings?.launcher?.library, games);
    if (settings?.launcher) settings.launcher.library = synced.library;
    if (synced.changed) saveSettings(settings);
    cachedState = buildState(settings, games);
    syncCheatsFiles(games);
    // The window paints stored records immediately. Backend inventories and
    // metadata validation never delay opening Electron or handle selection.
    void refreshRuntimeSnapshots();
    void refreshModuleSnapshots();
    void refreshLibraryMetadata(games, settings);
  }

  const directGame = getArgValue("--maclauncher-game=");
  if (directGame) {
    const resolvedDirect = path.resolve(app.getAppPath(), directGame);
    const detected = isChildGame || isSmoke ? await Modules.detectGameAsync(resolvedDirect)
      : await backendService.request("library", "importEntry", resolvedDirect, settings);
    detected.importPath = resolvedDirect;
    const existing = findGameByPath(games, detected.gamePath);
    detected.gameId = existing?.gameId || GameData.createGameId();
    const moduleId = resolveModuleId(detected);
    const mod = Modules.getModule(moduleId);

    if (isSmoke) {
      const smokeSaveDir = path.join(
        os.tmpdir(),
        "maclauncher-smoke",
        stablePartitionId(detected.gameId).replace("persist:", ""),
        String(Date.now())
      );
      ensureDir(smokeSaveDir);
      detected.saveDirOverride = smokeSaveDir;
      const toolsButtonVisible = resolveToolsButtonVisible(detected, settings);
      const { win } = await createGameWindow(detected, { toolsButtonVisible });

      const smokeTimeoutMs = Number(getArgValue("--maclauncher-smoke-timeout-ms=") || "20000");

      const fail = async err => {
        logger.error("[smoke] FAIL", String(err?.stack || err));
        try {
          win.close();
        } catch {}
        setTimeout(() => app.exit(1), 250);
      };

      try {
        const start = Date.now();
        while (Date.now() - start < smokeTimeoutMs) {
          // eslint-disable-next-line no-await-in-loop
          const ready = await win.webContents.executeJavaScript(`
            Boolean(
              window.StorageManager &&
              window.StorageManager.__maclauncher_patched === true
            )
          `);
          if (ready) break;
          // eslint-disable-next-line no-await-in-loop
          await new Promise(r => setTimeout(r, 50));
        }

        const ready = await win.webContents.executeJavaScript(`
          Boolean(
            window.StorageManager &&
            window.StorageManager.__maclauncher_patched === true
          )
        `);
        if (!ready) {
          let diag = null;
          try {
            // eslint-disable-next-line no-await-in-loop
            diag = await win.webContents.executeJavaScript(`
              (() => {
                const SM = window.StorageManager;
                return {
                  hasMacLauncher: Boolean(window.MacLauncher),
                  macLauncherConfig: window.MacLauncher?.config || null,
                  hasStorageManager: Boolean(SM),
                  storagePatched: Boolean(SM && SM.__maclauncher_patched),
                  typeofStorageManager: typeof window.StorageManager,
                  typeofProcess: typeof process,
                  typeofRequire: typeof require,
                  processMainModuleFilename:
                    typeof process === "object" ? process?.mainModule?.filename ?? null : null
                };
              })()
            `);
          } catch (e) {
            diag = { error: String(e?.stack || e) };
          }
          logger.error("[smoke] patch diagnostics", diag);
          throw new Error("Timed out waiting for StorageManager save-dir patch");
        }

        const offline = await win.webContents.executeJavaScript(`
          Promise.race([
            fetch("https://example.com/", { cache: "no-store" })
              .then(() => "ALLOWED")
              .catch(() => "BLOCKED"),
            new Promise(r => setTimeout(() => r("TIMEOUT"), 2000))
          ])
        `);
        logger.info(`[smoke] offline fetch: ${offline}`);
        const asset = await win.webContents.executeJavaScript(`
          fetch("img/system/Window.png", { cache: "no-store" })
            .then(r => ({
              ok: r.ok,
              status: r.status,
              contentType: r.headers.get("content-type")
            }))
            .catch(e => ({ ok: false, error: String(e?.message || e) }))
        `);
        logger.info("[smoke] asset fetch", asset);
        if (!asset?.ok) {
          throw new Error(
            "Asset fetch failed at img/system/Window.png; check server root and offline rules"
          );
        }

        const smoke = mod?.smokeTest;
        if (!smoke || typeof smoke.script !== "string" || !Array.isArray(smoke.expectedFiles)) {
          throw new Error("Smoke test is not available for this module.");
        }
        await win.webContents.executeJavaScript(smoke.script);
        for (const relPath of smoke.expectedFiles) {
          const p = path.join(smokeSaveDir, relPath);
          if (!fs.existsSync(p)) throw new Error(`Expected save file missing: ${p}`);
          logger.info(`[smoke] save wrote: ${p}`);
        }

        logger.info("[smoke] PASS");
        try {
          win.close();
        } catch {}
        setTimeout(() => app.exit(0), 250);
      } catch (e) {
        await fail(e);
      }
      return;
    }

    const merged = mergeDetectedEntry(existing, detected, { now: existing?.lastPlayedAt || 0 });
    const normalized = normalizeGameEntry(merged, settings);

    if (!isChildGame) {
      const upserted = upsertGame(games, normalized, settings);
      persistGames(upserted.games);
      saveSettings(settings);
      cachedState = buildState(settings, upserted.games);
      broadcastState();
    }

    const toolsButtonVisible = resolveToolsButtonVisible(normalized, settings);
    if (isChildGame) {
      await createGameWindow(normalized, { toolsButtonVisible });
      return;
    }

    const normalizedModuleId = resolveModuleId(normalized);
    const normalizedMod = Modules.getModule(normalizedModuleId);
    const moduleInfo = Modules.getModuleInfo(normalizedModuleId);
    const moduleSettings = resolveModuleSettings(settings, normalizedModuleId);
    const runtimeId = resolveRuntimeForEntry(
      normalized.runtimeId,
      normalizedMod,
      moduleInfo,
      normalized,
      moduleSettings,
      settings
    );
    await runGameEntry(normalized, runtimeId, { toolsButtonVisible });
    return;
  }

  await ensureLauncherWindow();
  gameImports.setImporter(GraphicsImports.createImporter({ userDataDir, importGame: importGameIntoLibrary,
    importModel: importNeuralModelFile, onGraphicsImported: async () => {
      publishReShadeFilters(); await ensureLauncherWindow();
    } }), { onChange: () => broadcastActivity(), cancelImporter: inputPath => {
      const controller = graphicsImportControllers.get(inputPath);
      if (controller) { controller.abort(); return true; }
      return backendService.request("library", "cancelImport", inputPath);
    } });
}

ipcMain.handle("launcher:getState", event =>
  utilityWindows.stateForWindow(BrowserWindow.fromWebContents(event.sender), getLauncherState()));
ipcMain.on("launcher:activityReady", event => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (launcherWindows.has(win) && cachedState) activityDelivery.ready(win, getLauncherActivity());
});
ipcMain.on("launcher:activityAck", (event, sequence) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (launcherWindows.has(win)) activityDelivery.acknowledge(win, sequence);
});
ipcMain.on("launcher:activityStopped", event => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (launcherWindows.has(win)) activityDelivery.close(win);
});
ipcMain.handle("launcher:openUtilityWindow", async (_event, request) => {
  await utilityWindows.open(request);
  return true;
});

async function showGameOpenDialog() {
  const result = await dialog.showOpenDialog({
    title: "Open game",
    properties: ["openFile", "openDirectory", "multiSelections"],
    filters: [
      {
        name: "Games",
        extensions: Modules.listSupportedInputExtensions()
      },
      { name: "All Files", extensions: ["*"] }
    ]
  });
  return result.canceled ? [] : result.filePaths;
}

async function importGameIntoLibrary(resolved, options = {}) {
  const previous = loadGamesHydrated({ persist: false }).find(entry => [entry.gamePath, entry.importPath].includes(resolved));
  if (previous) assertGameNotRemoving(previous);
  const detected = await backendService.request("library", "importEntry", resolved, loadSettings());
  // Runtime/settings actions can finish during detection. Merge into their latest
  // state rather than replacing it with the snapshot captured before the worker.
  const settings = loadSettings();
  detected.importPath ||= resolved;
  const games = loadGamesHydrated({ persist: false });
  const existing = findGameByPath(games, detected.gamePath);
  assertGameNotRemoving(existing || detected);
  detected.gameId = existing?.gameId || detected.gameId || GameData.createGameId();
  const upserted = upsertGame(games, detected, settings);
  persistGames(upserted.games);
  saveSettings(settings);
  cachedState = buildState(settings, upserted.games);
  broadcastState();
  if (!options.background) {
    await ensureLauncherWindow();
    for (const win of BrowserWindow.getAllWindows()) {
      if (!isLauncherWindow(win) || win.isDestroyed()) continue;
      win.webContents.send("launcher:gameImported", upserted.entry.gamePath);
    }
  }
  return upserted.entry;
}

async function importNeuralModelFile(runtimePath) {
  if (graphicsImportsClosing) { const error = new Error("Model import canceled."); error.name = "AbortError"; throw error; }
  const sourcePath = fs.realpathSync(runtimePath);
  const previous = [...graphicsImportControllers.values()].find(controller => controller.sourcePath === sourcePath);
  if (previous) {
    previous.inputPaths.add(runtimePath); graphicsImportControllers.set(runtimePath, previous);
    return previous.promise;
  }
  const managerId = "graphics-neural-models", manager = getRuntimeManager(managerId), controller = new AbortController();
  controller.sourcePath = sourcePath;
  controller.inputPaths = new Set([runtimePath, sourcePath]);
  for (const input of controller.inputPaths) graphicsImportControllers.set(input, controller);
  // Register the complete operation before import callbacks can request quit.
  controller.promise = Promise.resolve().then(async () => {
    try {
      controller.signal.throwIfAborted();
      const result = await runRuntimeManagerAction({ manager, action: "import", userDataDir, payload: { runtimePath: sourcePath },
        prerequisiteContext: { signal: controller.signal, onProgress: progress => {
          if (!graphicsImportsClosing) { importProgress.set(runtimePath, { ...progress, phase: "verifying" }); broadcastActivity(); }
        } },
        readSettings: () => loadSettings().runtimes?.[managerId],
        saveSettings: (next, previous) => settingsCoordinator.applySettings({ runtimes: { [managerId]: previous } }, { runtimes: { [managerId]: next } }) });
      controller.signal.throwIfAborted();
      // Shutdown closes the backend worker admission before draining imports.
      if (!graphicsImportsClosing) await refreshRuntimeSnapshots([managerId]);
      return result;
    } finally {
      for (const input of controller.inputPaths) {
        if (graphicsImportControllers.get(input) === controller) graphicsImportControllers.delete(input);
        importProgress.delete(input);
      }
    }
  });
  controller.finished = controller.promise.then(() => {}, () => {});
  return controller.promise;
}

async function openGamesFromMenu() {
  try {
    for (const filePath of await showGameOpenDialog()) {
      try { await gameImports.import(filePath); }
      catch (error) {
        if (isAbortError(error)) continue;
        await dialog.showMessageBox({ type: "error", message: "Could not add game", detail: error.message });
      }
    }
  } catch (error) {
    logger.error("[open]", String(error?.stack || error));
  }
}

ipcMain.handle("launcher:openGameDialog", showGameOpenDialog);
ipcMain.handle("launcher:addRecent", (_event, inputPath) => gameImports.import(inputPath));
ipcMain.handle("launcher:cancelImport", (_event, inputPath) => gameImports.cancel(inputPath));

let quitCleanupPending = false, quitCleanupComplete = false;
app.on("before-quit", event => {
  if (quitCleanupComplete) return;
  if (quitCleanupPending) { event.preventDefault(); return; }
  const imports = gameImports.list();
  graphicsImportsClosing = true;
  const graphicsImports = [...new Set(graphicsImportControllers.values())];
  for (const controller of graphicsImports) controller.abort();
  const steamActive = externalStores.hasActive() || steamWindow.snapshot().downloads.some(job => ["queued", "preparing", "downloading"].includes(job.status));
  googleAccountController.abort();
  backendService.beginShutdown();
  if (!steamActive && !imports.length && !graphicsImports.length && !microgAccounts.hasPending() && !googleAccountProcesses.size && !backendService.hasTemporaryProcesses() && !backendService.hasPendingOperations() && !logger.hasPending()) {
    googlePlayAuth.dispose();
    void microgAccounts.dispose();
    void steamWindow.dispose();
    void externalStores.dispose();
    return;
  }
  event.preventDefault(); quitCleanupPending = true;
  // Cancellation waits for the owned helper to exit and its staging cleanup.
  void Promise.allSettled([
    Promise.resolve(googlePlayAuth.dispose()),
    microgAccounts.dispose(),
    steamWindow.dispose(),
    externalStores.dispose(),
    ...[...googleAccountProcesses].map(child => stopProcessTree(child.pid)),
    ...imports.map(job => gameImports.cancel(job.inputPath)),
    ...graphicsImports.map(controller => controller.finished),
    backendService.shutdownTemporaryProcesses()
  ]).finally(async () => {
    await logger.flush();
    quitCleanupPending = false; quitCleanupComplete = true;
    app.quit();
  });
});

ipcMain.handle("launcher:forgetGame", async (_event, gamePath) => {
  await removeLibraryEntry(gamePath);
  return true;
});

ipcMain.handle("launcher:findMissingGames", async (_event, gamePaths) => {
  return LibraryMaintenance.findMissingGames(loadGamesHydrated({ persist: false }), gamePaths);
});

function assertGameRemovalAvailable(entry, ownRemoval = false) {
  const inputs = new Set([entry.gamePath, entry.importPath].filter(Boolean));
  if (runningGameSessions.get(entry.gamePath)?.size || gamePreparations.has(entry.gamePath) ||
      !ownRemoval && gameRemovals.has(entry.gamePath) || gameImports.list().some(job => inputs.has(job.inputPath))) {
    throw Object.assign(new Error("Stop the game or wait for its current action to finish."), { code: "GAME_IN_USE" });
  }
}

async function removeLibraryEntry(gamePath, options = {}) {
  const entry = findGameByPath(loadGamesHydrated({ persist: false }), gamePath);
  if (!entry) throw new Error("Game not found in library.");
  assertGameRemovalAvailable(entry);
  gameRemovals.set(gamePath, { gamePath, gameId: entry.gameId, phase: "remove", label: "Removing" });
  broadcastState();
  try {
    await backendService.request(`game:${entry.gameId || gamePath}`, "removeGameData", entry, options);
    assertGameRemovalAvailable(entry, true);
    // Merge into current library/settings after cleanup, preserving unrelated
    // imports, notes and runtime changes that finished while the worker ran.
    const settings = loadSettings(), games = loadGamesHydrated({ persist: false });
    const result = removeGameByPath(games, gamePath, settings);
    persistGames(result.games); saveSettings(settings);
    cachedState = buildState(settings, result.games);
    return true;
  } finally { gameRemovals.delete(gamePath); broadcastState(); }
}

async function removeLibraryPaths(gamePaths, options) {
  const removedPaths = [], failures = [];
  for (const gamePath of gamePaths) {
    try { await removeLibraryEntry(gamePath, options); removedPaths.push(gamePath); }
    catch (error) { failures.push({ gamePath, error: String(error?.message || error) }); }
  }
  return { removedPaths, failures };
}

ipcMain.handle("launcher:forgetGames", async (_event, gamePaths) => {
  const entries = LibraryMaintenance.selectLibraryEntries(loadGamesHydrated({ persist: false }), gamePaths);
  return removeLibraryPaths(entries.map(entry => entry.gamePath));
});

ipcMain.handle("launcher:deleteGames", async (event, gamePaths) => {
  const entries = LibraryMaintenance.selectLibraryEntries(loadGamesHydrated({ persist: false }), gamePaths);
  if (!entries.length) return { removedPaths: [], failures: [] };
  const confirm = await dialog.showMessageBox(BrowserWindow.fromWebContents(event.sender), {
    type: "warning", buttons: ["Cancel", "Move to Trash"], defaultId: 0, cancelId: 0,
    message: `Move ${entries.length} selected ${entries.length === 1 ? "game" : "games"} to the Trash?`,
    detail: "Game files will be moved to the Trash and launcher data will be removed. Missing files will be forgotten.\n\n" +
      entries.map(entry => `${entry.name}\n${entry.gamePath}`).join("\n\n")
  });
  if (confirm.response !== 1) return { removedPaths: [], failures: [] };
  return removeLibraryPaths(entries.map(entry => entry.gamePath), { trash: true, ignoreMissingSource: true });
});

ipcMain.handle("launcher:setGameFavorite", async (_event, gamePath, favorite) => {
  const settings = loadSettings();
  const games = loadGamesHydrated({ persist: false });
  const entry = findGameByPath(games, gamePath);
  if (!entry) throw new Error("Game not found in library");
  settings.launcher.library = LibraryState.setLibraryFavorite(settings.launcher.library, entry.gameId, favorite === true);
  saveSettings(settings);
  cachedState = buildState(settings, games);
  broadcastState();
  return true;
});

ipcMain.handle("launcher:setGameNotes", async (_event, gamePath, notes) => {
  const settings = loadSettings();
  const games = loadGamesHydrated({ persist: false });
  const entry = findGameByPath(games, gamePath);
  if (!entry) throw new Error("Game not found in library.");
  await launcherService.runAction(entry, "setGameNotes", { notes });
  const index = gameRecordsCache?.findIndex(game => game.gameId === entry.gameId) ?? -1;
  if (index >= 0) gameRecordsCache[index] = { ...gameRecordsCache[index], notes: entry.notes, updatedAt: entry.updatedAt };
  cachedState = buildState(settings, games);
  broadcastState();
  return true;
});

ipcMain.handle("launcher:setGameLaunchArguments", async (_event, gamePath, launchArguments) => {
  const settings = loadSettings();
  const games = loadGamesHydrated({ persist: false });
  const entry = findGameByPath(games, gamePath);
  if (!entry) throw new Error("Game not found in library.");
  await launcherService.runAction(entry, "setGameLaunchArguments", { launchArguments });
  const index = gameRecordsCache?.findIndex(game => game.gameId === entry.gameId) ?? -1;
  if (index >= 0) gameRecordsCache[index] = { ...gameRecordsCache[index], launchArguments: entry.launchArguments, updatedAt: entry.updatedAt };
  cachedState = buildState(settings, games);
  broadcastState();
  return true;
});

ipcMain.handle("launcher:setGameNetworkAccess", async (_event, gamePath, networkAccess) => {
  const settings = loadSettings();
  const games = loadGamesHydrated({ persist: false });
  const entry = findGameByPath(games, gamePath);
  if (!entry) throw new Error("Game not found in library.");
  await launcherService.runAction(entry, "setGameNetworkAccess", { networkAccess });
  const index = gameRecordsCache?.findIndex(game => game.gameId === entry.gameId) ?? -1;
  if (index >= 0) gameRecordsCache[index] = { ...gameRecordsCache[index], networkAccess: entry.networkAccess, updatedAt: entry.updatedAt };
  cachedState = buildState(settings, games);
  broadcastState();
  return true;
});

require("../modules/shared/effects/presets-ipc").register({ ipcMain, userDataDir, app, loadSettings, pickFile: pickEffectFile });
const graphicsEdits = new Map();
const graphicsEditControllers = new Map();
function cancelGraphicsEdits(gamePath, reason) {
  for (const controller of graphicsEditControllers.get(gamePath) || []) controller.abort(reason);
}
function cancelNeuralGraphicsEdits(gamePath) {
  const reason = Object.assign(new Error("Neural reconstruction was disabled."),
    {name: "AbortError", code: "GRAPHICS_NEURAL_SUPERSEDED"});
  for (const operation of graphicsEditControllers.get(gamePath) || []) {
    if (operation.modelKind === "neural") operation.abort(reason);
    else if (operation.graphicsPatch || operation.neuralCandidate) {
      // Keep independent queued choices, but never let an older candidate
      // re-enable neural reconstruction after an explicit Off action.
      if (operation.graphicsPatch) operation.graphicsPatch = {...operation.graphicsPatch, neuralMethod: "off"};
      operation.neuralDisabled = true;
      operation.abort(reason);
    }
  }
}
function editGraphics(gamePath, edit, {reset = false, modelKind, graphicsPatch, neuralCandidate = false} = {}) {
  if (reset) cancelGraphicsEdits(gamePath, Object.assign(new Error("The graphics update was replaced by a reset."),
    {name: "AbortError", code: "GRAPHICS_RESET_SUPERSEDED"}));
  if (graphicsPatch?.neuralMethod === "off") cancelNeuralGraphicsEdits(gamePath);
  let controller = new AbortController(), interruption;
  const controllers = graphicsEditControllers.get(gamePath) || new Set();
  const operation = {modelKind, graphicsPatch, neuralCandidate, neuralDisabled: false, abort(reason) {interruption = reason;controller.abort(reason);}};
  controllers.add(operation);graphicsEditControllers.set(gamePath, controllers);
  const next = (graphicsEdits.get(gamePath) || Promise.resolve()).catch(() => {}).then(async () => {
    for (;;) {
      if (interruption?.code === "GRAPHICS_NEURAL_SUPERSEDED" && (operation.graphicsPatch || operation.neuralCandidate)) {
        controller = new AbortController();interruption = undefined;
      }
      try {return await edit(controller.signal, operation.graphicsPatch, operation.neuralDisabled);}
      catch (error) {
        if (interruption?.code !== "GRAPHICS_NEURAL_SUPERSEDED" || !(operation.graphicsPatch || operation.neuralCandidate) ||
            (error !== controller.signal.reason && error?.name !== "AbortError")) throw error;
        // The aborted publication has finished rollback before its remaining
        // patch is prepared again. Shader edits keep their ordinary FIFO slot.
      }
    }
  });
  graphicsEdits.set(gamePath, next);
  void next.finally(() => {
    controllers.delete(operation);
    if (!controllers.size && graphicsEditControllers.get(gamePath) === controllers) graphicsEditControllers.delete(gamePath);
    if (graphicsEdits.get(gamePath) === next) graphicsEdits.delete(gamePath);
  }).catch(() => {});
  return next;
}
function gameGraphicsLive(entry) {
  const runningPids = [...(runningGameSessions.get(entry.gamePath)?.values() || [])].map(session => session.pid).filter(pid => Number.isSafeInteger(pid) && pid > 0);
  const launch = require("../modules/shared/reshade/launch-binding").read(entry, {userDataDir, runningPids});
  return Boolean(launch && (launch.live || launch.effectPlanAPI === 1));
}
async function gameEffectsOptions(entry, settings = loadSettings()) {
  const info = Modules.getModuleInfo(resolveModuleId(entry));
  const Binding = require("../modules/shared/reshade/launch-binding");
  const sessions = [...(runningGameSessions.get(entry.gamePath)?.values() || [])];
  const runningPids = sessions.map(session => session.pid).filter(pid => Number.isSafeInteger(pid) && pid > 0);
  const launch = Binding.read(entry, {userDataDir, runningPids});
  const launchBinding = launch || Binding.read(entry, {userDataDir});
  const session = launch ? sessions.find(session => session.pid === launch.pid) : undefined;
  const isCurrent = () => {
    const current = runningGameSessions.get(entry.gamePath);
    return (session ? current?.get(session.id) === session && session.pid === launch.pid && session.stopRequested !== true
      : sessions.length === 0 && !current?.size) && Binding.isCurrent(entry, launchBinding, {userDataDir});
  };
  const result = await launcherService.runAction(launch?.runtimeId ? {...entry, runtimeId: launch.runtimeId} : entry, "graphicsInputs", {}, { settings });
  const runtimeId = launch?.runtimeId || result?.runtimeId;
  const graphicsInputs = launch && Object.hasOwn(launch, "graphicsInputs") ? launch.graphicsInputs : result?.graphicsInputs || null;
  if (session && !session.graphicsRuntimeUse) session.graphicsRuntimeUse = require("./graphics-runtime-use").createGraphicsRuntimeUse({
    session, isCurrent,
    coordinator: settingsCoordinator, managers: listRuntimeManagers(), userDataDir, readSettings: loadSettings
  });
  const useRuntime = session ? identity => session.graphicsRuntimeUse.useRuntime(identity) : undefined;
  return { userDataDir, app, settings, graphicsHost: launch?.graphicsHost || info?.runtime?.entries?.[runtimeId]?.graphicsHost,
    graphicsArchitecture: launch?.graphicsArchitecture || graphicsInputs?.architecture || info?.runtime?.entries?.[runtimeId]?.graphicsArchitecture,
    running: sessions.length > 0, runningPids, launchBinding, isCurrent, useRuntime, graphicsRuntimeUse: session?.graphicsRuntimeUse,
    useModel: useRuntime ? version => useRuntime({managerId: "graphics-models", version}) : undefined,
    prepareEffectsEntry: result?.prepareEffectsEntry,
    withGraphicsUpdate: result?.withGraphicsUpdate,
    graphicsInputs };
}
ipcMain.handle("launcher:getGameEffects", async (_event, gamePath) => {
  const entry = findGameByPath(loadGamesHydrated({ persist: false }), gamePath);
  if (!entry) throw new Error("Game not found in library.");
  return EffectsRuntime.info(entry, await gameEffectsOptions(entry));
});
ipcMain.handle("launcher:getGameGraphicsStatus", (_event, gamePath) => {
  const entry = findGameByPath(loadGamesHydrated({persist: false}), gamePath);
  if (!entry) throw new Error("Game not found in library.");
  const runningPids = [...(runningGameSessions.get(entry.gamePath)?.values() || [])]
    .filter(session => session.stopRequested !== true).map(session => session.pid).filter(pid => Number.isSafeInteger(pid) && pid > 0);
  return require("../modules/shared/reshade/runtime-status").read(entry, {userDataDir, runningPids});
});
ipcMain.handle("launcher:getGameEffectParameters", async (_event, gamePath, nodeId, draftPlan) => {
  const entry = findGameByPath(loadGamesHydrated({ persist: false }), gamePath);
  if (!entry) throw new Error("Game not found in library.");
  return EffectsRuntime.describe(entry, nodeId, draftPlan, await gameEffectsOptions(entry));
});
ipcMain.handle("launcher:setGameEffects", (_event, gamePath, value) => editGraphics(gamePath, async signal => {
  const settings = loadSettings(), games = loadGamesHydrated({ persist: false });
  const entry = findGameByPath(games, gamePath);
  if (!entry) throw new Error("Game not found in library.");
  const effects = EffectsPlan.validate(value), updated = { ...entry, effects };
  const effectOptions = {...await gameEffectsOptions(entry, settings), signal};
  const prepared = await require("./graphics-update").apply(updated, effectOptions,
    options => EffectsRuntime.prepare(updated, {...options,
      live: options.running, deferRenderResolution: true}), ReShade.createPublication);
  entry.effects = prepared?.plan || effects; entry.updatedAt = Date.now(); saveGameRecord(entry);
  cachedState = buildState(settings, games); broadcastState(); return true;
}));
ipcMain.handle("launcher:resetGameEffects", (_event, gamePath) => editGraphics(gamePath, async signal => {
  const settings = loadSettings(), games = loadGamesHydrated({ persist: false });
  const entry = findGameByPath(games, gamePath);
  if (!entry) throw new Error("Game not found in library.");
  const updated = { ...entry, effects: null, reshade: ReShade.normalizeSettings(), graphics: GraphicsSettings.normalizeSettings() };
  const effectOptions = {...await gameEffectsOptions(entry, settings), signal};
  await require("./graphics-update").apply(updated, effectOptions, options => {
    if (options.running && !gameGraphicsLive(entry)) return {deferred: true};
    require("../modules/shared/reshade/live-controls").write(updated, userDataDir, options);
    EffectsRuntime.publishSimple(updated, userDataDir, options);
  }, ReShade.createPublication);
  entry.effects = null; entry.reshade = updated.reshade; entry.graphics = updated.graphics;
  entry.updatedAt = Date.now(); saveGameRecord(entry);
  cachedState = buildState(settings, games); broadcastState(); return true;
}, {reset: true}));
ipcMain.handle("launcher:pickGameEffectFile", async (_event, gamePath, kind) => {
  if (!findGameByPath(loadGamesHydrated({ persist: false }), gamePath)) throw new Error("Game not found in library.");
  return pickEffectFile(kind);
});
ipcMain.handle("launcher:ensureGameGraphicsModel", (_event, gamePath, kind, patch) => editGraphics(gamePath, async signal => {
  const entry = findGameByPath(loadGamesHydrated({ persist: false }), gamePath);
  if (!entry) throw new Error("Game not found in library.");
  if (EffectsPlan.normalize(entry.effects)) throw new Error("Edit the effects in Advanced, or return to Simple first.");
  const result = await require("../modules/shared/reshade/simple-setup").ensureGraphicsModel({
    entry, kind, patch, settings: loadSettings(), userDataDir, signal,
    runRuntimeAction: (managerId, action, payload) => backendService.request(`runtime:${managerId}`, "runtimeAction", managerId, action, payload),
    chooseLosslessSource: async ({ reason }) => {
      const options = { type: "question", title: "Lossless Scaling models",
        message: "Prepare compatible Lossless Scaling models",
        detail: [reason, "Models can be downloaded through Steam with an account that owns Lossless Scaling, or imported from a Lossless Scaling DLL. Original files remain unchanged."].filter(Boolean).join("\n\n"),
        buttons: ["Download from Steam…", "Choose DLL…", "Cancel"], defaultId: 0, cancelId: 2 };
      const owner = getLauncherDialogOwner();
      const answer = owner ? await dialog.showMessageBox(owner, options) : await dialog.showMessageBox(options);
      return ["download", "import", null][answer.response] ?? null;
    }
  });
  if (signal.aborted) return null;
  if (result) {
    void Promise.resolve().then(() => refreshRuntimeSnapshots([kind === "neural" ? "graphics-neural-models" : "graphics-models"]))
      .catch(error => require("../modules/shared/graphics-warning")(logger, "Graphics model status could not be refreshed.",
        String(error?.message || error).replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 512)));
    cachedState = buildState(loadSettings(), loadGamesHydrated({ persist: false }));
    broadcastState();
  }
  return result;
}, {modelKind: kind}));
async function pickEffectFile(kind) {
  if (kind !== undefined && kind !== "neural-model") throw new Error("Choose a supported effect file type.");
  const options = kind === "neural-model" ? { title: "Choose neural rendering model", properties: ["openFile", "openDirectory"], filters: [{name: "Neural rendering model source", extensions: ["dlssmodel", "app", "zip"]}] }
    : { title: "Choose shader or filter", properties: ["openFile"], filters: [{ name: "Shaders and filters", extensions: [...ReShadeFilters.SUPPORTED_EXTENSIONS] }] };
  const owner = getLauncherDialogOwner();
  const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
  if (result.canceled || !result.filePaths[0]) return null;
  const file = fs.realpathSync(result.filePaths[0]);
  if (kind === "neural-model") {
    const managed = require("../modules/shared/reshade/neural").modelIdentity(userDataDir, file);
    return managed ? file : (await importNeuralModelFile(file)).modelPath;
  }
  if (!ReShadeFilters.formatForPath(file) || !fs.statSync(file).isFile()) throw new Error("Choose a supported shader or filter file.");
  return file;
}
async function saveGameReShade(gamePath, patch, expectedSelection, signal, neuralDisabled = false) {
  const settings = loadSettings(), games = loadGamesHydrated({ persist: false });
  const entry = findGameByPath(games, gamePath);
  if (!entry) throw new Error("Game not found in library.");
  if (EffectsPlan.normalize(entry.effects)) throw new Error("Edit the effects in Advanced, or return to Simple first.");
  if (expectedSelection !== undefined) {
    const Live = require("../modules/shared/reshade/live-controls");
    if (!expectedSelection || typeof expectedSelection !== "object" || Array.isArray(expectedSelection) ||
        Live.effectKey(ReShade.normalizeSettings(expectedSelection)) !== Live.effectKey(ReShade.normalizeSettings(entry.reshade)))
      throw Object.assign(new Error("The shader selection changed. Open its current parameters before editing."), {code: "GRAPHICS_SHADER_STALE"});
  }
  const reshade = ReShade.updateSettings(entry.reshade, patch);
  const updated = {...entry, reshade, ...(neuralDisabled ? {graphics: {...entry.graphics, neuralMethod: "off"}} : {})},
    effectOptions = {...await gameEffectsOptions(entry, settings), signal};
  await require("./graphics-update").apply(updated, effectOptions, async options => {
    const runtimeEntry = await options.prepareEffectsEntry?.(updated) || updated;
    if (!options.isCurrent()) return {deferred: true};
    const result = await ReShade.updateLive(runtimeEntry, {...options, force: Object.hasOwn(patch, "effectPath")});
    return result === false ? {deferred: true} : result;
  }, ReShade.createPublication);
  entry.reshade = reshade;
  entry.updatedAt = Date.now();
  saveGameRecord(entry);
  cachedState = buildState(settings, games);
  broadcastState();
  return true;
}
ipcMain.handle("launcher:setGameReShade", (_event, gamePath, patch, expectedSelection) => editGraphics(gamePath, (signal, _patch, neuralDisabled) => saveGameReShade(gamePath, patch, expectedSelection, signal, neuralDisabled), {neuralCandidate: true}));
ipcMain.handle("launcher:getGameShaderParameters", async (_event, gamePath) => {
  const entry = findGameByPath(loadGamesHydrated({ persist: false }), gamePath);
  if (!entry) throw new Error("Game not found in library.");
  return ReShade.describeParameters(entry, await gameEffectsOptions(entry));
});
ipcMain.handle("launcher:setGameGraphics", (_event, gamePath, patch, expectedSpatialShader) => editGraphics(gamePath, async (signal, currentPatch) => {
  const settings = loadSettings(), games = loadGamesHydrated({ persist: false });
  const entry = findGameByPath(games, gamePath);
  if (!entry) throw new Error("Game not found in library.");
  if (EffectsPlan.normalize(entry.effects)) throw new Error("Edit the effects in Advanced, or return to Simple first.");
  if (expectedSpatialShader !== undefined) {
    const Live = require("../modules/shared/reshade/live-controls"), selected = entry.graphics?.spatialShader;
    if (!expectedSpatialShader || typeof expectedSpatialShader !== "object" || Array.isArray(expectedSpatialShader) || !selected ||
        Live.effectKey(ReShade.normalizeSettings(expectedSpatialShader)) !== Live.effectKey(ReShade.normalizeSettings(selected)))
      throw Object.assign(new Error("The upscaling shader changed. Open its current parameters before editing."), {code: "GRAPHICS_SHADER_STALE"});
  }
  const graphics = GraphicsSettings.updateSettings(entry.graphics, currentPatch), updated = { ...entry, graphics };
  const effectOptions = {...await gameEffectsOptions(entry, settings), signal};
  await require("./graphics-update").apply(updated, effectOptions, async options => {
    const runtimeEntry = await options.prepareEffectsEntry?.(updated) || updated;
    if (!options.isCurrent()) return {deferred: true};
    if (options.running) {
      if (await ReShade.validateLiveGraphics(runtimeEntry, options) === false) return {deferred: true};
      if (options.isCurrent()) await ReShade.updateAutomaticEffects(runtimeEntry, options);
    }
    if (require("../modules/shared/reshade/launch-binding").isCurrent(entry, options.launchBinding, options))
      require("../modules/shared/reshade/live-controls").write(runtimeEntry, userDataDir, options);
  }, ReShade.createPublication);
  entry.graphics = graphics;
  entry.updatedAt = Date.now();
  saveGameRecord(entry);
  cachedState = buildState(settings, games);
  broadcastState();
  return true;
}, {graphicsPatch: patch}));
function publishReShadeFilters() {
  cachedState = buildState(loadSettings(), loadGamesHydrated({ persist: false }));
  broadcastState();
}
ipcMain.handle("launcher:importReShadeFilters", async (_event, family) => {
  const extensions = ReShadeFilters.extensionsForFamily(family);
  const options = { title: "Import shaders and filters", properties: ["openFile", "multiSelections"], filters: [{ name: "Shaders and filters", extensions: [...extensions] }] };
  const owner = getLauncherDialogOwner();
  const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
  if (result.canceled || !result.filePaths.length) return null;
  if (family !== undefined && result.filePaths.some(file => !extensions.some(extension =>
    (extension === "glsl" || extension === "hook" ? "libplacebo" : extension) === ReShadeFilters.formatForPath(file))))
    throw new Error("Choose a shader file from the selected family.");
  const filters = GraphicsImports.importFilters(userDataDir, result.filePaths);
  publishReShadeFilters();
  return filters;
});
ipcMain.handle("launcher:updateReShadeFilter", async (_event, id, patch) => {
  const previous = ReShadeFilters.list(userDataDir).find(item => item.id === id);
  const filters = ReShadeFilters.update(userDataDir, id, patch);
  if (previous && previous.path !== filters.find(item => item.id === id)?.path) {
    const preset = `filter:${id}`;
    const usesFilter = entry => entry.reshade?.preset === preset || entry.graphics?.spatialShader?.preset === preset ||
      EffectsPlan.normalize(entry.effects)?.video.some(node => node.kind === "shader" && node.shader.preset === preset);
    const selected = loadGamesHydrated({ persist: false }).filter(usesFilter);
    await Promise.all(selected.map(game => editGraphics(game.gamePath, () => {
      const entry = findGameByPath(loadGamesHydrated({ persist: false }), game.gamePath);
      if (!entry || !usesFilter(entry)) return;
      let changed = false;
      if (entry.reshade?.preset === preset && entry.reshade.parameters) {
        entry.reshade = ReShade.updateSettings(entry.reshade, { parameters: null });changed = true;
      }
      if (entry.graphics?.spatialShader?.preset === preset && entry.graphics.spatialShader.parameters) {
        entry.graphics = GraphicsSettings.updateSettings(entry.graphics, {
          spatialShader: ReShade.updateSettings(entry.graphics.spatialShader, {parameters: null})});changed = true;
      }
      const plan = EffectsPlan.normalize(entry.effects);
      if (plan) {
        for (const node of plan.video) if (node.kind === "shader" && node.shader.preset === preset && node.shader.parameters) {
          delete node.shader.parameters;changed = true;
        }
        if (changed) entry.effects = plan;
      }
      if (!changed) return;
      entry.updatedAt = Date.now();
      saveGameRecord(entry);
    })));
  }
  publishReShadeFilters();
  return true;
});
ipcMain.handle("launcher:removeReShadeFilter", (_event, id) => {
  ReShadeFilters.remove(userDataDir, id);
  publishReShadeFilters();
  return true;
});
ipcMain.handle("launcher:pickReShadeFilterPath", async (_event, id) => {
  const filter = ReShadeFilters.list(userDataDir).find(item => item.id === id);
  if (!filter) throw new Error("Shader or filter not found. Import the file again or choose another entry.");
  const options = { title: "Choose shader or filter", defaultPath: filter.path, properties: ["openFile"], filters: [{ name: "Shaders and filters", extensions: [...ReShadeFilters.SUPPORTED_EXTENSIONS] }] };
  const owner = getLauncherDialogOwner();
  const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
  return result.canceled || !result.filePaths[0] ? null : result.filePaths[0];
});
ipcMain.handle("launcher:pickGameReShadeEffect", async (_event, gamePath) => {
  if (!findGameByPath(loadGamesHydrated({ persist: false }), gamePath)) throw new Error("Game not found in library.");
  const options = { title: "Choose shader or filter", properties: ["openFile"], filters: [{ name: "Shaders and filters", extensions: [...ReShadeFilters.SUPPORTED_EXTENSIONS] }] };
  const owner = getLauncherDialogOwner();
  const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
  if (result.canceled || !result.filePaths[0]) return null;
  const file = fs.realpathSync(result.filePaths[0]);
  if (!ReShadeFilters.formatForPath(file)) throw new Error("Choose a ReShade .fx, RetroArch .slangp or .slang, or MPV/libplacebo .glsl or .hook file.");
  await editGraphics(gamePath, (signal, _patch, neuralDisabled) => saveGameReShade(gamePath, { preset: "custom", effectPath: file }, undefined, signal, neuralDisabled), {neuralCandidate: true});
  return file;
});

ipcMain.handle("launcher:setLibrarySort", async (_event, sort) => {
  const settings = loadSettings();
  settings.launcher.library = LibraryState.setLibrarySort(settings.launcher.library, sort);
  saveSettings(settings);
  cachedState = buildState(settings, loadGamesHydrated({ persist: false }));
  broadcastState();
  return true;
});

ipcMain.handle("launcher:moveGame", async (_event, gamePath, delta) => {
  const settings = loadSettings();
  const games = loadGamesHydrated({ persist: false });
  const nextGames = moveGame(games, gamePath, Number(delta) || 0, settings);
  persistGames(nextGames);
  saveSettings(settings);
  cachedState = buildState(settings, nextGames);
  broadcastState();
  return true;
});

ipcMain.handle("launcher:reorderGame", async (_event, gamePath, toIndex) => {
  const settings = loadSettings();
  const idx = Number(toIndex);
  const games = loadGamesHydrated({ persist: false });
  const nextGames = reorderGame(games, gamePath, Number.isFinite(idx) ? idx : 0, settings);
  persistGames(nextGames);
  saveSettings(settings);
  cachedState = buildState(settings, nextGames);
  broadcastState();
  return true;
});

ipcMain.handle("launcher:deleteGame", async (event, gamePath) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!gamePath) throw new Error("Missing game path");
  const entry = findGameByPath(loadGamesHydrated({ persist: false }), gamePath);
  if (!entry) throw new Error("Game not found in library.");
  assertGameRemovalAvailable(entry);

  const confirm = await dialog.showMessageBox(win, {
    type: "warning",
    buttons: ["Cancel", "Move to Trash"],
    defaultId: 0,
    cancelId: 0,
    message: "Move this game to the Trash?",
    detail: gamePath
  });
  if (confirm.response !== 1) return false;

  await removeLibraryEntry(gamePath, { trash: true });
  return true;
});

ipcMain.handle("launcher:launchGame", async (_event, gamePath) => {
  return runGameByPath(gamePath);
});

ipcMain.handle("launcher:openSaveEditor", async (_event, gamePath) => {
  const entry = findGameByPath(loadGamesHydrated({ persist: false }), gamePath);
  if (!entry) throw new Error("Game not found in library.");
  if (!Modules.getModuleInfo(resolveModuleId(entry))?.supports?.saveLocation) throw new Error("Save tools are unavailable for this game.");
  await createSaveEditorWindow(entry);
  return true;
});

ipcMain.handle("launcher:launchGameWithRuntime", async (_event, gamePath, runtimeOverride) => {
  return runGameByPath(gamePath, { runtimeOverride });
});

ipcMain.handle("launcher:createGameCommand", async (event, gamePath) => {
  if (!gamePath) throw new Error("Missing game path");
  const games = loadGamesHydrated({ persist: false });
  const entry = findGameByPath(games, gamePath);
  const displayName = entry?.name || path.basename(gamePath);
  const defaultName = `${sanitizeFileName(displayName)}.command`;
  const defaultDir = app.getPath("desktop");
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showSaveDialog(win, {
    title: "Save Game Shortcut",
    defaultPath: path.join(defaultDir, defaultName),
    filters: [{ name: "Command Script", extensions: ["command"] }],
    properties: ["createDirectory", "showOverwriteConfirmation"]
  });
  if (result.canceled || !result.filePath) return null;

  const filePath = writeGameCommand(result.filePath, {
    gamePath: path.resolve(gamePath),
    userDataDir,
    executablePath: process.execPath,
    appBundlePath: resolveAppBundlePath(process.execPath),
    repoRoot: app.getAppPath(),
    packaged: app.isPackaged
  });
  try {
    shell.showItemInFolder(filePath);
  } catch {}
  return filePath;
});

ipcMain.handle("launcher:stopGame", async (_event, gamePath) => {
  if (!gamePath) throw new Error("Missing game path");
  return stopGameRuns(gamePath);
});

ipcMain.handle("launcher:setGameRuntime", async (_event, gamePath, runtimeId) => {
  const settings = loadSettings();
  const games = loadGamesHydrated({ persist: false });
  const entry = findGameByPath(games, gamePath);
  if (!entry) throw new Error("Game not found in library");

  const merged = entry;
  const moduleId = resolveModuleId(merged);
  const mod = Modules.getModule(moduleId);
  const moduleInfo = Modules.getModuleInfo(moduleId);
  const moduleSettings = resolveModuleSettings(settings, moduleId);
  const normalized = normalizeGameEntry(merged, settings);
  const resolvedRuntime = resolveRuntimeForEntry(
    runtimeId,
    mod,
    moduleInfo,
    normalized,
    moduleSettings,
    settings
  );

  entry.runtimeId = resolvedRuntime;

  entry.updatedAt = Date.now();
  saveGameRecord(entry);
  Object.assign(entry, await backendService.request(`game:${entry.gameId || gamePath}`, "refreshSaveLocations", entry, settings));
  cachedState = buildState(settings, games);
  broadcastState();
  return true;
});

ipcMain.handle("launcher:setGameRuntimeSettings", async (_event, gamePath, runtimeId, payload) => {
  if (!runtimeId) throw new Error("Missing runtime id");
  const settings = loadSettings();
  const games = loadGamesHydrated({ persist: false });
  const entry = findGameByPath(games, gamePath);
  if (!entry) throw new Error("Game not found in library");
  const moduleId = resolveModuleId(entry);
  const moduleInfo = Modules.getModuleInfo(moduleId);
  const schema = resolveRuntimeSettingsSchema(moduleInfo, runtimeId);
  if (!schema) throw new Error("Runtime settings not supported.");
  if (payload === null) {
    setEntryRuntimeSettings(entry, runtimeId, null);
  } else {
    const defaults =
      resolveModuleRuntimeSettings(settings, moduleId, moduleInfo, runtimeId) ||
      buildRuntimeSettingsDefaults(schema);
    const normalized = normalizeRuntimeSettings(schema, payload, defaults);
    if (shallowEqual(normalized, defaults)) {
      setEntryRuntimeSettings(entry, runtimeId, null);
    } else {
      setEntryRuntimeSettings(entry, runtimeId, normalized);
    }
  }
  entry.updatedAt = Date.now();
  saveGameRecord(entry);
  cachedState = buildState(settings, games);
  broadcastState();
  return true;
});

ipcMain.handle("launcher:openRuntimeSettings", async (_event, payload) => {
  const data = payload && typeof payload === "object" ? payload : {};
  const scope = data.scope === "game" ? "game" : "module";
  let runtimeId = typeof data.runtimeId === "string" ? data.runtimeId.trim() : "";
  let moduleId = typeof data.moduleId === "string" ? data.moduleId.trim() : "";
  const gamePath = typeof data.gamePath === "string" ? data.gamePath : "";
  if (scope === "game") {
    if (!gamePath) throw new Error("Missing game path");
    const entry = findGameByPath(loadGamesHydrated({ persist: false }), gamePath);
    if (!entry) throw new Error("Game not found in library");
    // Selection is saved before its refreshed renderer snapshot is broadcast.
    const current = normalizeGameEntry(entry, loadSettings());
    moduleId = current.moduleId;
    runtimeId = current.runtimeId;
  }
  if (!runtimeId) throw new Error("Missing runtime id");
  if (!moduleId) throw new Error("Missing module id");
  await createRuntimeSettingsWindow({
    scope,
    moduleId,
    runtimeId,
    ...(scope === "game" ? { gamePath } : {})
  });
  return true;
});

ipcMain.handle("launcher:setLauncherSettings", async (_event, patch) => {
  const settings = loadSettings();
  const current = settings.launcher && typeof settings.launcher === "object" ? settings.launcher : {};
  const next = { ...current };
  for (const [key, value] of Object.entries(patch || {})) {
    if (value === null || value === undefined) delete next[key];
    else next[key] = value;
  }
  settings.launcher = next;
  normalizeLauncherSettings(settings);
  saveSettings(settings);
  cachedState = buildState(settings, loadGamesHydrated({ persist: false }));
  broadcastState();
  return true;
});

ipcMain.handle("launcher:setModuleSettings", async (_event, moduleId, patch) => {
  if (!moduleId) throw new Error("Missing module id");
  const mod = Modules.getModule(moduleId);
  if (!mod) throw new Error("Unknown module");

  const settings = loadSettings();
  const current = resolveModuleSettings(settings, moduleId);
  const next = { ...current };
  for (const [key, value] of Object.entries(patch || {})) {
    if (value === null || value === undefined) delete next[key];
    else next[key] = value;
  }
  if (typeof next.defaultRuntime === "string" && next.defaultRuntime.trim() && typeof mod.normalizeRuntimeId === "function") {
    next.defaultRuntime = mod.normalizeRuntimeId(next.defaultRuntime);
  }
  if (!settings.modules || typeof settings.modules !== "object") settings.modules = {};
  settings.modules[moduleId] = next;
  saveSettings(settings);
  cachedState = buildState(settings, loadGamesHydrated({ persist: false }));
  broadcastState();
  return true;
});

ipcMain.handle("launcher:setModuleRuntimeSettings", async (_event, moduleId, runtimeId, payload) => {
  if (!moduleId) throw new Error("Missing module id");
  if (!runtimeId) throw new Error("Missing runtime id");
  const mod = Modules.getModule(moduleId);
  if (!mod) throw new Error("Unknown module");
  const moduleInfo = Modules.getModuleInfo(moduleId);
  const schema = resolveRuntimeSettingsSchema(moduleInfo, runtimeId);
  if (!schema) throw new Error("Runtime settings not supported.");

  const settings = loadSettings();
  const current = resolveModuleSettings(settings, moduleId);
  const runtimeSettings =
    current.runtimeSettings && typeof current.runtimeSettings === "object"
      ? { ...current.runtimeSettings }
      : {};
  if (payload === null) {
    delete runtimeSettings[runtimeId];
  } else {
    const defaults = readRuntimeDefaults(runtimeId, moduleInfo) || buildRuntimeSettingsDefaults(schema);
    const normalized = normalizeRuntimeSettings(schema, payload, defaults);
    if (shallowEqual(normalized, defaults)) {
      delete runtimeSettings[runtimeId];
    } else {
      runtimeSettings[runtimeId] = normalized;
    }
  }
  const next = { ...current, runtimeSettings };
  if (typeof next.defaultRuntime === "string" && next.defaultRuntime.trim() && typeof mod.normalizeRuntimeId === "function") {
    next.defaultRuntime = mod.normalizeRuntimeId(next.defaultRuntime);
  }
  if (!settings.modules || typeof settings.modules !== "object") settings.modules = {};
  settings.modules[moduleId] = next;
  saveSettings(settings);
  cachedState = buildState(settings, loadGamesHydrated({ persist: false }));
  broadcastState();
  return true;
});

ipcMain.handle("launcher:setGameModuleData", async (_event, gamePath, patch) => {
  const settings = loadSettings();
  const games = loadGamesHydrated({ persist: false });
  const entry = findGameByPath(games, gamePath);
  if (!entry) throw new Error("Game not found in library");

  updateEntryModuleData(entry, patch || {});

  const moduleId = resolveModuleId(entry);
  const needsRepatch =
    patch && Object.prototype.hasOwnProperty.call(patch, "toolsButtonVisibleOverride");
  const patcher = needsRepatch ? getCheatsPatcherIfSupported(moduleId) : null;
  if (patcher) {
    await backendService.request(`game:${entry.gameId || gamePath}`, "patcher", entry, "cheats", "updateVisibility",
      { toolsButtonVisible: resolveToolsButtonVisible(entry, settings) });
  }

  entry.updatedAt = Date.now();
  saveGameRecord(entry);
  cachedState = buildState(settings, games);
  broadcastState();
  return true;
});

ipcMain.handle("launcher:setGameRuntimeData", async (_event, gamePath, runtimeId, patch) => {
  if (!runtimeId) throw new Error("Missing runtime id");
  const settings = loadSettings();
  const games = loadGamesHydrated({ persist: false });
  const entry = findGameByPath(games, gamePath);
  if (!entry) throw new Error("Game not found in library");
  updateEntryRuntimeData(entry, runtimeId, patch);
  entry.updatedAt = Date.now();
  saveGameRecord(entry);
  cachedState = buildState(settings, games);
  broadcastState();
  return true;
});

ipcMain.handle("launcher:cancelDownload", async (_event, downloadId) => {
  if (!downloadId) return false;
  return String(downloadId).includes("|") ? backendService.cancelDownload(String(downloadId)) : downloadManager.cancel(String(downloadId));
});

ipcMain.handle("launcher:runtimeAction", async (event, managerId, action, payload) => {
  if (!getRuntimeManager(managerId)) throw new Error("Runtime manager not found");
  return backendService.request(`runtime:${managerId}`, "runtimeAction", managerId, action, payload);
});

ipcMain.handle("launcher:moduleSettingsAction", async (_event, moduleId, action, payload) => {
  if (!Modules.getModule(moduleId)) throw new Error("Module not found.");
  if (hostAccountActions.handles(moduleId, action)) return hostAccountActions.run(moduleId, action, payload);
  return backendService.request(`module:${moduleId}:settings`, "moduleSettingsAction", moduleId, action, payload);
});

const moduleActionRequests = createModuleActionRequests({ request: (...args) => backendService.request(...args) });
ipcMain.handle("launcher:cancelModuleAction", (event, requestId) => moduleActionRequests.cancel(event.sender, requestId));
ipcMain.handle("launcher:moduleAction", async (event, gamePath, action, payload, options) => {
  const settings = loadSettings();
  const games = loadGamesHydrated({ persist: false });
  const entry = findGameByPath(games, gamePath);
  if (!entry) throw new Error("Game not found in library");

  try {
    const result = options?.requestId !== undefined ? await moduleActionRequests.run(event.sender, options.requestId,
      `game:${entry.gameId || entry.gamePath}`, [entry, action, payload, settings]) :
      await backendService.request(`game:${entry.gameId || entry.gamePath}`, "moduleAction", entry, action, payload, settings);
    return action === "graphicsInputs" ? {...result, graphicsLive: gameGraphicsLive(entry)} : result;
  } catch (e) {
    if (isAbortError(e)) return false;
    throw e;
  }
});

ipcMain.handle("launcher:setCheats", async (_event, gamePath, cheats) => {
  const settings = loadSettings();
  const games = loadGamesHydrated({ persist: false });
  const entry = findGameByPath(games, gamePath);
  if (!entry) throw new Error("Game not found in library");

  const moduleId = resolveModuleId(entry);
  if (!getModuleCheats(moduleId)) return true;
  const normalized = normalizeCheatsForModule(moduleId, cheats);
  if (!normalized) return true;
  entry.cheats = normalized;
  entry.updatedAt = Date.now();
  writeCheatsFile(entry.gameId, moduleId, normalized);
  saveGameRecord(entry);
  cachedState = buildState(settings, games);
  broadcastState();
  return true;
});

ipcMain.handle("launcher:getCheatsPatchStatus", async (_event, gamePath) => {
  const games = loadGamesHydrated({ persist: false });
  const entry = findGameByPath(games, gamePath);
  if (!gamePath) return null;
  try {
    return await backendService.request(`game:${entry?.gameId || gamePath}`, "patcher", entry || { gamePath, importPath: gamePath }, "cheats", "status");
  } catch {
    return null;
  }
});

ipcMain.handle("launcher:patchCheatsIntoGame", async (_event, gamePath) => {
  const settings = loadSettings();
  const games = loadGamesHydrated({ persist: false });
  const entry = findGameByPath(games, gamePath);
  if (!entry) throw new Error("Game not found in library");

  return backendService.request(`game:${entry.gameId || gamePath}`, "patcher", entry, "cheats", "patch");
});

ipcMain.handle("launcher:unpatchCheatsFromGame", async (_event, gamePath) => {
  const settings = loadSettings();
  const games = loadGamesHydrated({ persist: false });
  const entry = findGameByPath(games, gamePath);
  if (!entry) throw new Error("Game not found in library");

  return backendService.request(`game:${entry.gameId || gamePath}`, "patcher", entry, "cheats", "unpatch");
});

ipcMain.handle("launcher:setGameLibVersion", async (_event, gamePath, depId, versionId) => {
  const settings = loadSettings();
  const games = loadGamesHydrated({ persist: false });
  const entry = findGameByPath(games, gamePath);
  if (!entry) throw new Error("Game not found in library");

  const moduleId = resolveModuleId(entry);
  const mod = Modules.getModule(moduleId);
  if (!mod?.libs?.catalog) throw new Error("Library patching is not supported for this module.");
  const dep = mod.libs.catalog.getDependency(depId);
  if (!dep) throw new Error("Unknown library dependency.");
  if (dep.engine && dep.engine !== moduleId) {
    throw new Error("Library dependency does not match this module.");
  }

  const nextVersion = typeof versionId === "string" ? versionId.trim() : "";
  if (nextVersion && !mod.libs.catalog.getVersion(depId, nextVersion)) {
    throw new Error("Unknown library version.");
  }

  const libVersions =
    entry.moduleData && typeof entry.moduleData === "object" && entry.moduleData.libVersions
      ? { ...entry.moduleData.libVersions }
      : {};
  if (nextVersion) libVersions[depId] = nextVersion;
  else delete libVersions[depId];

  updateEntryModuleData(entry, { libVersions });
  entry.updatedAt = Date.now();
  saveGameRecord(entry);
  cachedState = buildState(settings, games);
  broadcastState();
  return true;
});

ipcMain.handle("launcher:getLibsPatchStatus", async (_event, gamePath) => {
  const settings = loadSettings();
  const games = loadGamesHydrated({ persist: false });
  const entry = findGameByPath(games, gamePath) || { gamePath, importPath: gamePath };
  return backendService.request(`game:${entry.gameId || gamePath}`, "patcher", entry, "libs", "status");
});

ipcMain.handle("launcher:patchLibs", async (_event, gamePath) => {
  const settings = loadSettings();
  const games = loadGamesHydrated({ persist: false });
  const entry = findGameByPath(games, gamePath) || { gamePath, importPath: gamePath };
  return backendService.request(`game:${entry.gameId || gamePath}`, "patcher", entry, "libs", "patch");
});

ipcMain.handle("launcher:unpatchLibs", async (_event, gamePath) => {
  const entry = findGameByPath(loadGamesHydrated({ persist: false }), gamePath) || { gamePath, importPath: gamePath };
  return backendService.request(`game:${entry.gameId || gamePath}`, "patcher", entry, "libs", "unpatch");
});

ipcMain.handle("launcher:pickSaveDir", async (_event, gamePath) => {
  const settings = loadSettings();
  const games = loadGamesHydrated({ persist: false });
  const entry = findGameByPath(games, gamePath);
  if (!entry) throw new Error("Game not found in library");
  if (!canOverrideSaveLocation(entry, Modules)) throw new Error("This runtime uses a fixed private save folder.");

  const defaultDir = entry.defaultSaveDir;

  const result = await dialog.showOpenDialog({
    title: defaultDir
      ? `Select save directory. Default is ${defaultDir}`
      : "Select save directory.",
    properties: ["openDirectory", "createDirectory"]
  });
  if (result.canceled || result.filePaths.length === 0) return null;

  const nextDir = result.filePaths[0];
  entry.saveDirOverride = nextDir;

  entry.updatedAt = Date.now();
  saveGameRecord(entry);
  cachedState = buildState(settings, games);
  broadcastState();
  return nextDir;
});

ipcMain.handle("launcher:resetSaveDir", async (_event, gamePath) => {
  const settings = loadSettings();
  const games = loadGamesHydrated({ persist: false });
  const entry = findGameByPath(games, gamePath);
  if (!entry) throw new Error("Game not found in library");
  if (!canOverrideSaveLocation(entry, Modules)) throw new Error("This runtime uses a fixed private save folder.");

  entry.saveDirOverride = null;
  entry.updatedAt = Date.now();
  saveGameRecord(entry);
  cachedState = buildState(settings, games);
  broadcastState();
  return true;
});

ipcMain.handle("launcher:getSaveInfo", async (_event, gamePath) => {
  const entry = findGameByPath(loadGamesHydrated({ persist: false }), gamePath);
  if (!entry) throw new Error("Game not found in library.");
  return backendService.request(`game:${entry.gameId || gamePath}`, "saveInfo", entry, loadSettings());
});

ipcMain.handle("launcher:selectSaveLocation", async (_event, gamePath, directory) => {
  const settings = loadSettings();
  const games = loadGamesHydrated({ persist: false });
  const entry = findGameByPath(games, gamePath);
  if (!entry) throw new Error("Game not found in library");
  return backendService.request(`game:${entry.gameId || gamePath}`, "selectSaveLocation", entry, directory, settings);
});

ipcMain.handle("launcher:listSaveFiles", async (_event, gamePath) => {
  const { entry } = resolveSaveContext(gamePath);
  return backendService.request(`game:${entry.gameId || gamePath}`, "save", entry, "listFiles");
});

ipcMain.handle("launcher:importSaveDir", async (event, gamePath) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const { saveDir, detected, entry } = resolveSaveContext(gamePath);

  const result = await dialog.showOpenDialog(win, {
    title: `Import save folder for ${detected.name}`,
    properties: ["openDirectory"]
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const srcDir = result.filePaths[0];

  const confirm = await dialog.showMessageBox(win, {
    type: "warning",
    buttons: ["Cancel", "Import"],
    defaultId: 1,
    cancelId: 0,
    message: "Importing will overwrite any existing save files in the selected save directory.",
    detail: `From:\n${srcDir}\n\nTo:\n${saveDir}`
  });
  if (confirm.response !== 1) return null;

  await backendService.request(`game:${entry.gameId || gamePath}`, "save", entry, "runAction", "importSaveFolder", { directory: srcDir });
  return true;
});

ipcMain.handle("launcher:exportSaveDir", async (event, gamePath) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const { detected, entry } = resolveSaveContext(gamePath);

  const result = await dialog.showOpenDialog(win, {
    title: `Export save folder for ${detected.name}`,
    properties: ["openDirectory", "createDirectory"]
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const targetRoot = result.filePaths[0];

  const folderName = `${sanitizeFileSegment(detected.name)}_saves_${timestampForPath()}`;
  let outDir = path.join(targetRoot, folderName);
  let tries = 0;
  while (fs.existsSync(outDir) && tries < 50) {
    tries++;
    outDir = path.join(targetRoot, `${folderName}_${tries}`);
  }

  await backendService.request(`game:${entry.gameId || gamePath}`, "save", entry, "exportFolder", outDir);

  return outDir;
});

ipcMain.handle("launcher:importSaveFiles", async (event, gamePath) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const { detected, entry } = resolveSaveContext(gamePath);
  const saveExtensions = listKnownSaveExtensions();

  const result = await dialog.showOpenDialog(win, {
    title: `Import save files for ${detected.name}`,
    properties: ["openFile", "multiSelections"],
    filters: saveExtensions.length
      ? [
          { name: "Save Files", extensions: saveExtensions },
          { name: "All Files", extensions: ["*"] }
        ]
      : [{ name: "All Files", extensions: ["*"] }]
  });
  if (result.canceled || result.filePaths.length === 0) return null;

  await backendService.request(`game:${entry.gameId || gamePath}`, "save", entry, "runAction", "importSaveFiles", { filePaths: result.filePaths });
  return true;
});

ipcMain.handle("launcher:readSaveJson", async (_event, gamePath, fileName) => {
  const { entry } = resolveSaveContext(gamePath);
  const { json } = await backendService.request(`game:${entry.gameId || gamePath}`, "save", entry, "runAction", "readSaveDocument", { fileName });
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
});

ipcMain.handle("launcher:writeSaveJson", async (_event, gamePath, fileName, nextJson, expectedHash) => {
  const { entry } = resolveSaveContext(gamePath);
  await backendService.request(`game:${entry.gameId || gamePath}`, "save", entry, "runAction", "writeSaveDocument", { fileName, json: nextJson, expectedHash });
  return true;
});

ipcMain.handle(
  "launcher:openSaveJsonInExternalEditor",
  async (_event, gamePath, fileName, jsonText) => {
    const { entry } = resolveSaveContext(gamePath);
    const externalPath = await backendService.request(`game:${entry.gameId || gamePath}`, "save", entry, "prepareExternalDocument", { fileName, json: String(jsonText ?? "") });
    const err = await shell.openPath(externalPath);
    if (err) throw new Error(err);
    return externalPath;
  }
);

ipcMain.handle("launcher:readExternalSaveJson", async (_event, gamePath, fileName) => {
  const { entry } = resolveSaveContext(gamePath);
  return backendService.request(`game:${entry.gameId || gamePath}`, "save", entry, "readExternalDocument", { fileName });
});

ipcMain.handle("launcher:revealInFinder", async (_event, targetPath) => {
  if (!targetPath) return false;
  await shell.showItemInFolder(targetPath);
  return true;
});

ipcMain.handle("launcher:openExternal", async (_event, url) => {
  if (typeof url !== "string") return false;
  const trimmed = url.trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed);
    if (!["http:", "https:"].includes(parsed.protocol)) return false;
  } catch {
    return false;
  }
  try {
    await shell.openExternal(trimmed);
    return true;
  } catch (e) {
    logger.error("[shell] openExternal failed", String(e?.message || e));
    return false;
  }
});

ipcMain.on("maclauncher:debug:openDevTools", event => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  openDevToolsForWindow(win, "ipc");
});

ipcMain.on("maclauncher:debug:focusWindow", event => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  win.show();
  win.focus();
});

ipcMain.on("maclauncher:debug:closeWindow", event => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  win.close();
});

ipcMain.on("maclauncher:game:reload", event => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  win.webContents.reloadIgnoringCache();
});

ipcMain.on("maclauncher:window:show", event => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  win.show();
});

ipcMain.on("maclauncher:window:hide", event => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  win.hide();
});

ipcMain.on("maclauncher:window:maximize", event => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  win.maximize();
});

ipcMain.on("maclauncher:window:minimize", event => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  win.minimize();
});

ipcMain.on("maclauncher:window:restore", event => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  win.restore();
});

ipcMain.on("maclauncher:window:moveTo", (event, x, y) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  const nx = Number(x);
  const ny = Number(y);
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) return;
  win.setPosition(Math.round(nx), Math.round(ny));
});

ipcMain.on("maclauncher:window:resizeTo", (event, w, h, options) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return;
  const nw = Number(w);
  const nh = Number(h);
  if (!Number.isFinite(nw) || !Number.isFinite(nh)) return;
  const opts = options && typeof options === "object" ? options : null;
  const mode = opts?.mode === "outer" ? "outer" : "content";
  const nextW = Math.max(200, Math.round(nw));
  const nextH = Math.max(200, Math.round(nh));
  const wasResizable = win.isResizable();
  if (!wasResizable) win.setResizable(true);
  if (mode === "outer") {
    win.setSize(nextW, nextH);
  } else {
    win.setContentSize(nextW, nextH);
  }
  try {
    if (mode === "outer") {
      const [ow, oh] = win.getSize();
      if (ow !== nextW || oh !== nextH) {
        win.setContentSize(nextW, nextH);
      }
    } else {
      const [cw, ch] = win.getContentSize();
      if (cw !== nextW || ch !== nextH) {
        win.setSize(nextW, nextH);
      }
    }
  } catch {}
  if (!wasResizable) win.setResizable(false);
});

ipcMain.on("maclauncher:window:setAlwaysOnTop", (event, flag) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  win.setAlwaysOnTop(Boolean(flag));
});

ipcMain.on("maclauncher:window:setResizable", (event, flag) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  win.setResizable(Boolean(flag));
});

ipcMain.on("maclauncher:shell:openExternal", (_event, url) => {
  if (typeof url !== "string") return;

  try {
    const policy = gamePoliciesByWebContentsId.get(_event.sender.id);
    if (!policy?.allowExternal) {
      logger.warn(`[shell] blocked openExternal ${url}`);
      return;
    }
  } catch {
    logger.warn(`[shell] blocked openExternal ${url}`);
    return;
  }

  try {
    const u = new URL(url);
    if (!["http:", "https:", "mailto:", "file:"].includes(u.protocol)) {
      logger.warn(`[shell] blocked openExternal protocol ${u.protocol} ${url}`);
      return;
    }
  } catch {}

  shell.openExternal(url).catch(e => {
    logger.error("[shell] openExternal failed", String(e?.message || e));
  });
});

app.on("activate", () => {
  if (isChildGame || isSmoke || !cachedState) return;
  void ensureLauncherWindow().catch(error => logger.error("[launcher]", error.message));
});

app.on("window-all-closed", () => {
  app.quit();
});

app.whenReady().then(async () => {
  try {
    await init();
  } catch (e) {
    logger.error("Fatal error:", String(e?.stack || e));
    app.quit();
  }
});
