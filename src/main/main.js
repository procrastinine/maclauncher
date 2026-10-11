const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow, dialog, ipcMain, Menu, shell, session, nativeImage, screen } = require("electron");

const Modules = require("../modules/registry");
const GameData = require("../modules/shared/game-data");
const IconUtils = require("./icon-utils");
const GameStore = require("./game-store");
const CleanupUtils = require("./cleanup-utils");
const LibraryState = require("./library-state");
const { gameImports } = require("./file-open");
const LibraryMaintenance = require("../core/library-maintenance");
const { createLauncher, resolveModuleId, resolveHostedRuntimeInfo,
  resolveNativeLaunchPath, resolveModuleSettings, resolveRuntimeSupportForEntry, mergeSettingsChanges } = require("../core/launcher");
const { createElectronHostLaunch } = require("../core/electron-binary");
const { launchHostedProcess } = require("../core/hosted-process");
const { stopProcessTree } = require("../core/process-stop");
const { observeGameProcess } = require("../core/game-process-events");
const { canLaunchEntry } = require("../core/launch-capability");
const { readJsonObject, writeJsonAtomic } = require("../core/json-files");
const { coordinatorFor } = require("../core/runtime-coordinator");
const { createSettingsSnapshots } = require("../core/settings-snapshots");
const { createUtilityWindowController } = require("./utility-windows");
const { runRuntimeManagerAction } = require("../core/runtime-manager-service");
const { createBackendService } = require("../core/backend-worker-client");
const { loadLocalView } = require("../core/view-loading");
const { hydrateGameSaveLocations, selectKnownSaveLocation } = require("../core/save-locations");
const { watchFileChanges } = require("../core/watch-files");
const { resolveRuntimeSettingsSchema, buildRuntimeSettingsDefaults, normalizeRuntimeSettings,
  mergeRuntimeSettingsMap } = require("../core/runtime-settings");
const { createElectronGameHost } = require("../modules/shared/web/runtime/electron-host");
const { mergeDetectedEntry } = require("./launch-utils");
const { DownloadManager } = require("../modules/shared/runtime/download-manager");
const { isAbortError } = require("../modules/shared/runtime/download-utils");

const APP_NAME = "MacLauncher";
const USERDATA_DIRNAME = "maclauncher";

try {
  app.setName(APP_NAME);
} catch {}
const requestedUserData = getArgValue("--user-data=");
if (requestedUserData && !path.isAbsolute(requestedUserData)) throw new Error("--user-data requires an absolute directory.");
try {
  app.setPath("userData", requestedUserData || path.join(app.getPath("appData"), USERDATA_DIRNAME));
} catch {}
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

function sanitizeFileName(value) {
  const cleaned = String(value || "")
    .trim()
    .replace(/[:/\\]/g, "-")
    .replace(/[^0-9A-Za-z ._-]+/g, "_")
    .replace(/\s+/g, " ");
  return cleaned || "MacLauncher";
}

function shellEscape(value) {
  return `'${String(value ?? "").replace(/'/g, `'\\''`)}'`;
}

function buildGameCommandScript({ gamePath, appName, appBundlePath, repoRoot, packaged }) {
  const lines = ["#!/bin/zsh", "set -e"];
  const escapedGamePath = shellEscape(gamePath);

  if (packaged) {
    const escapedAppPath = shellEscape(appBundlePath || "");
    const escapedAppName = shellEscape(appName || "");
    lines.push(`GAME_PATH=${escapedGamePath}`);
    lines.push(`APP_PATH=${escapedAppPath}`);
    lines.push(`APP_NAME=${escapedAppName}`);
    lines.push('if [ -d "$APP_PATH" ]; then');
    lines.push('  open -a "$APP_PATH" --args --maclauncher-game="$GAME_PATH"');
    lines.push("else");
    lines.push('  open -a "$APP_NAME" --args --maclauncher-game="$GAME_PATH"');
    lines.push("fi");
  } else {
    const escapedRepoRoot = shellEscape(repoRoot || "");
    lines.push(`GAME_PATH=${escapedGamePath}`);
    lines.push(`REPO_ROOT=${escapedRepoRoot}`);
    lines.push('if [ ! -d "$REPO_ROOT" ]; then');
    lines.push('  echo "MacLauncher repo not found: $REPO_ROOT"');
    lines.push("  exit 1");
    lines.push("fi");
    lines.push('if ! command -v node >/dev/null 2>&1; then');
    lines.push('  echo "node not found in PATH."');
    lines.push("  exit 1");
    lines.push("fi");
    lines.push('cd "$REPO_ROOT"');
    lines.push('node scripts/run-game.mjs --game "$GAME_PATH"');
  }

  return `${lines.join("\n")}\n`;
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

  function write(level, ...args) {
    const ts = new Date().toISOString();
    const line =
      `[${ts}] [${level}] ` +
      args.map(a => (typeof a === "string" ? a : JSON.stringify(a))).join(" ") +
      "\n";
    try {
      fs.appendFileSync(logPath, line);
    } catch {}
    if (isDebug || level !== "debug") {
      // eslint-disable-next-line no-console
      console[level === "debug" ? "log" : level]?.(...args);
    }
  }

  return {
    path: logPath,
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
const runtimeStateSnapshots = {};
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
    if (event === "toolLaunch") { registerProcessRun(payload.gamePath, payload.child, payload.runtimeId); return; }
    if (event === "log") { logger[payload.level]?.(...payload.args); return; }
    if (event === "runtimeState" || event === "moduleState") {
      const snapshots = event === "runtimeState" ? runtimeStateSnapshots : moduleStateSnapshots;
      if (JSON.stringify(snapshots[payload.id]) === JSON.stringify(payload.state)) return;
      snapshots[payload.id] = payload.state;
      if (cachedState) {
        const settings = loadSettings();
        cachedState = { ...cachedState, ...(event === "runtimeState"
          ? { runtimeManagers: buildRuntimeManagerState(settings),
            moduleSettings: launcherService.getResolvedModuleSettings(settings) }
          : { moduleStates: buildModuleState(settings) }) };
      }
      saveStateSnapshotsSoon(); broadcastState(); return;
    }
    if (event === "preparation") {
      if (payload.phase === "done") gamePreparations.delete(payload.gamePath);
      else gamePreparations.set(payload.gamePath, payload);
      broadcastState(); return;
    }
    if (event === "importProgress") {
      if (payload.phase === "done") importProgress.delete(payload.inputPath);
      else importProgress.set(payload.inputPath, payload);
      broadcastState(); return;
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
    if (event === "downloads") broadcastState();
  }
});
async function confirmRuntimeInstallation(plan, entry) {
  const versionLabel = [plan.label, plan.version].filter(Boolean).join(" ");
  const options = { type: "question", buttons: [plan.confirmLabel || "Download and Play", "Cancel"], defaultId: 0, cancelId: 1,
    message: plan.message || `${plan.kind === "prerequisite" ? "Install" : "Download"} ${versionLabel}?`,
    detail: plan.detail || (entry ? `Required to run ${entry.name || path.basename(entry.gamePath)}.` : "Required by this runtime.") };
  const owner = getLauncherDialogOwner();
  const choice = owner ? await dialog.showMessageBox(owner, options) : await dialog.showMessageBox(options);
  return choice.response === 0 ? plan.licenseRequired ? { approved: true, licenseAccepted: true } : true : false;
}
const launcherService = createLauncher({
  userDataDir, logger, app, ui: { shell, dialog, nativeImage }, writeCheatsFile,
  getRuntimeManagerState: id => runtimeStateSnapshots[id] || { installed: [] },
  downloads: () => downloadManager,
  confirmRuntimeInstall: confirmRuntimeInstallation,
  onPreparationChange: preparation => {
    if (preparation.phase === "done") gamePreparations.delete(preparation.gamePath);
    else gamePreparations.set(preparation.gamePath, preparation);
    broadcastState();
  },
  isGameRunning: entry => Boolean(runningGameSessions.get(entry.gamePath)?.size),
  launchHosted: (entry, runtimeId) => launchHostedRuntimeChild(entry, runtimeId),
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
  settings.launcher = { ...DEFAULT_LAUNCHER_SETTINGS, ...current, library };
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

function parseSemver(input) {
  const match = String(input || "").trim().replace(/^v/i, "").match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareSemverDesc(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return String(b || "").localeCompare(String(a || ""));
  for (let i = 0; i < 3; i += 1) {
    const diff = pb[i] - pa[i];
    if (diff !== 0) return diff;
  }
  return 0;
}

function resolvePreferredNwjsVersion(settings, userDataDir) {
  const manager = getRuntimeManager("nwjs");
  if (!manager || typeof manager.normalizeSettings !== "function") return null;
  const cfg = manager.normalizeSettings(settings?.runtimes?.nwjs);
  const defaultVersion =
    typeof cfg?.defaultVersion === "string" && cfg.defaultVersion.trim()
      ? cfg.defaultVersion.trim().replace(/^v/i, "")
      : null;
  const installed = userDataDir && typeof manager.core?.listInstalled === "function"
    ? manager.core.listInstalled(userDataDir)
    : [];
  const installedVersions = Array.isArray(installed)
    ? installed.map(entry => entry?.version).filter(Boolean)
    : [];
  if (installedVersions.length > 0) {
    if (defaultVersion && installedVersions.includes(defaultVersion)) return defaultVersion;
    installedVersions.sort(compareSemverDesc);
    return installedVersions[0] || defaultVersion;
  }
  return defaultVersion;
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

  for (const [p, watcher] of cheatsFileWatchers.entries()) {
    if (wanted.has(p)) continue;
    try {
      watcher.close();
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

function resolveModuleIconPath(mod, entry) {
  if (typeof mod?.resolveGameIcon !== "function") return null;
  try {
    return normalizeIconPath(
      mod.resolveGameIcon(entry, {
        app,
        ui: { shell, dialog, nativeImage },
        fs,
        path,
        userDataDir: app.getPath("userData")
      })
    );
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
      return cached.url;
    }
    const img = nativeImage.createFromPath(iconPath);
    if (!img || img.isEmpty()) return null;
    const url = img.toDataURL();
    if (!url || typeof url !== "string") return null;
    iconDataUrlCache.set(iconPath, { mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, ino: stat.ino, size: stat.size, url });
    return url;
  } catch {
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
    moduleId,
    gameType: entry.gameType ?? moduleInfo.gameType ?? null,
    indexDir: entry.indexDir,
    indexHtml: entry.indexHtml,
    contentRootDir: entry.contentRootDir ?? entry.gamePath,
    defaultSaveDir,
    saveLocations: entry.saveLocations || [],
    saveDirOverride: entry.saveDirOverride ?? null,
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
    moduleRuntimeSupport: resolveRuntimeSupportForEntry(mod, moduleInfo, entryContext, moduleSettings),
    moduleSupports: {
      launch: canLaunchEntry({ mod, info: moduleInfo, entry: entryContext, runtimeId, moduleSettings,
        context: { app, userDataDir, settings } }),
      cheats: moduleInfo.supports?.cheats === true,
      cheatsPatcher: moduleInfo.supports?.cheatsPatcher === true,
      saveEditing: moduleInfo.supports?.saveEditing === true,
      saveLocation: moduleInfo.supports?.saveLocation === true
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
  const key = JSON.stringify([entry, settings?.modules?.[resolveModuleId(entry)]]);
  const previous = recentDecorationCache.get(entry.gameId || entry.gamePath);
  if (previous?.key === key) return previous.value;
  const normalized = normalizeGameEntry(entry, settings);
  const value = { ...normalized, iconUrl: iconUrlForPath(normalized.iconPath) };
  recentDecorationCache.set(entry.gameId || entry.gamePath, { key, value });
  return value;
}

function resolveSaveContext(gamePath) {
  const settings = loadSettings();
  const games = loadGamesHydrated({ persist: false });
  const entry = findGameByPath(games, gamePath);
  if (!entry) throw new Error("Game not found in library");

  const detected = entry;
  const saveDir = entry.saveDirOverride || entry.defaultSaveDir || null;
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

function extractAppIconToCache(appPath, cachePath) {
  const icnsPath = IconUtils.findAppBundleIconPath(appPath);
  if (!icnsPath) return null;
  if (process.platform === "darwin") {
    try {
      const sips = fs.existsSync("/usr/bin/sips") ? "/usr/bin/sips" : "sips";
      ensureDir(path.dirname(cachePath));
      const res = spawnSync(sips, ["-s", "format", "png", icnsPath, "--out", cachePath], {
        stdio: "ignore"
      });
      if (res.status === 0) {
        const stat = fs.statSync(cachePath);
        if (stat.isFile() && stat.size > 0) return cachePath;
      }
    } catch {}
  }

  try {
    const img = nativeImage.createFromPath(icnsPath);
    if (img && !img.isEmpty()) {
      return writePngToCache(cachePath, img.toPNG());
    }
  } catch {}

  return null;
}

function extractExeIconToCache(exePath, cachePath) {
  return writePngToCache(cachePath, IconUtils.extractExeIconPngBuffer(exePath));
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
    result = extractAppIconToCache(appPath, cachePath);
  } else if (source === ICON_SOURCES.EXE) result = extractExeIconToCache(sourcePath, cachePath);
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
    moduleIconPath: resolveModuleIconPath(mod, entry), moduleDefaultIconPath: resolveModuleDefaultIconPath(moduleId),
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

function applyGameDockIdentity(entry) {
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
      const img = nativeImage.createFromPath(iconPath);
      if (img && !img.isEmpty()) app.dock.setIcon(img);
    } catch {}
  }
}

const gamePoliciesByWebContentsId = new Map();
const runningGameSessions = new Map();
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
  const id = nextRunSessionId++;
  const runs = runningGameSessions.get(gamePath) || new Map();
  runs.set(id, { id, ...session });
  runningGameSessions.set(gamePath, runs);
  broadcastState();
  return id;
}

function unregisterGameRun(gamePath, runId) {
  const runs = runningGameSessions.get(gamePath);
  if (!runs) return;
  runs.delete(runId);
  if (runs.size === 0) runningGameSessions.delete(gamePath);
  broadcastState();
}

function registerGameWindowRun(gamePath, win, runtimeId) {
  if (!win) return null;
  const runId = registerGameRun(gamePath, { kind: "window", runtimeId, win });
  win.once("closed", () => unregisterGameRun(gamePath, runId));
  return runId;
}

function registerProcessRun(gamePath, child, runtimeId) {
  if (!child || !child.pid) return null;
  const runId = child.exitCode != null || child.signalCode != null ? null
    : registerGameRun(gamePath, { kind: "process", pid: child.pid, runtimeId });
  const session = runningGameSessions.get(gamePath)?.get(runId);
  observeGameProcess(child, {
    isStopping: () => session?.stopRequested === true,
    onExit: () => { if (runId != null) unregisterGameRun(gamePath, runId); },
    onFailure: ({ code, signal, error }) => {
      const entry = findGameByPath(gameRecordsCache || [], gamePath);
      const name = entry?.name || path.basename(gamePath);
      const reason = error ? String(error.message || error) : signal || `exit ${code}`;
      const message = `${name} stopped unexpectedly (${reason}).`;
      logger.error(`[game] ${gamePath}: ${reason}`);
      for (const win of launcherWindows) {
        try { win.webContents.send("launcher:gameFailed", { gamePath, message }); } catch {}
      }
      if (signal) void maybeOfferRuntimeRecoveryAfterCrash(gamePath, runtimeId, signal);
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
    return stopProcessTree(session.pid);
  }
  return false;
}

async function stopGameRuns(gamePath) {
  const runs = runningGameSessions.get(gamePath);
  if (!runs || runs.size === 0) return false;
  const sessions = Array.from(runs.values());
  await Promise.allSettled(sessions.map(session => stopRunSession(session)));
  return true;
}

function buildRuntimeManagerState(settings) {
  const out = {};
  for (const manager of listRuntimeManagers()) {
    if (!manager || typeof manager.getState !== "function") continue;
    const state = runtimeStateSnapshots[manager.id] || { installed: [], catalog: { versions: [], loading: true } };
    out[manager.id] = {
      id: manager.id,
      label: manager.label || manager.id,
      ...state,
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
    broadcastState();
  }
});

function getLauncherState() {
  if (!cachedState) return cachedState;
  return {
    ...cachedState,
    running: buildRunningState(),
    preparing: { ...Object.fromEntries(gamePreparations), ...Object.fromEntries(gameRemovals) },
    importing: gameImports.list().map(job => ({ ...job, ...importProgress.get(job.inputPath) })),
    downloads: [...downloadManager.list(), ...backendService.listDownloads()]
  };
}

function broadcastState() {
  if (launcherWindows.size === 0) return;
  const running = buildRunningState();
  backendService.updateRunning({ games: running, saveRoots: (gameRecordsCache || []).filter(entry => running[entry.gamePath])
    .map(entry => entry.saveDirOverride || entry.defaultSaveDir).filter(directory => typeof directory === "string" && path.isAbsolute(directory)) });
  const state = getLauncherState();
  for (const win of launcherWindows) {
    try {
      win.webContents.send("launcher:state", utilityWindows.stateForWindow(win, state));
    } catch {}
  }
}

function registerLauncherWindow(win) {
  if (!win) return;
  launcherWindows.add(win);
  win.on("closed", () => launcherWindows.delete(win));
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
      resolveRuntimeSupportForEntry, resolveToolsButtonVisible,
      normalizeCheatsForModule, writeCheatsFile, resolvePreferredNwjsVersion,
      resolveUserAgentSuffix, buildModuleLaunchContext,
      onProcessRun: (entry, child, runtimeId) => registerProcessRun(entry.gamePath, child, runtimeId),
      applyDockIdentity: entry => { if (!mainWindow) applyGameDockIdentity(entry); },
      attachWebContentsLogging, attachDevToolsShortcut, attachDevToolsAutoOpen, openDevToolsForWindow,
      isDebug, isSmoke
    });
  }
  return electronGameHost.createGameWindow(gameEntry, {
    ...options,
    context: buildModuleLaunchContext(gameEntry, loadSettings(), options)
  });
}

async function launchHostedRuntimeChild(gameEntry, runtimeId) {
  const launch = createElectronHostLaunch({ executable: process.execPath,
    appPath: path.resolve(__dirname, "bootstrap.js"),
    gamePath: gameEntry.importPath || gameEntry.gamePath, runtimeId, userDataDir });
  logger.info(`[hosted] launch ${runtimeId} ${gameEntry.gamePath}`);
  return launchHostedProcess({ ...launch, logger });
}

async function runGameEntry(gameEntry, runtimeId, options = {}) {
  assertGameNotRemoving(gameEntry);
  const result = await backendService.launchEntry(gameEntry, {
    ...options, runtimeId, settings: loadSettings()
  });
  if (result.kind === "cancelled") return false;
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
  return {
    recents: ordered.map(entry => decorateRecentEntry(entry, settings)),
    modules: Modules.listModules(),
    moduleSettings: launcherService.getResolvedModuleSettings(settings),
    moduleStates: buildModuleState(settings),
    runtimeManagers: buildRuntimeManagerState(settings),
    runtimeDefaults: buildRuntimeDefaultsState(),
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
  gameImports.setImporter(importGameIntoLibrary, { onChange: () => broadcastState(),
    cancelImporter: inputPath => backendService.request("library", "cancelImport", inputPath) });
}

ipcMain.handle("launcher:getState", event =>
  utilityWindows.stateForWindow(BrowserWindow.fromWebContents(event.sender), getLauncherState()));
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

async function importGameIntoLibrary(resolved) {
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
  await ensureLauncherWindow();
  for (const win of BrowserWindow.getAllWindows()) {
    if (!isLauncherWindow(win) || win.isDestroyed()) continue;
    win.webContents.send("launcher:gameImported", upserted.entry.gamePath);
  }
  return upserted.entry;
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

let quittingImports = false;
app.on("before-quit", event => {
  const imports = gameImports.list();
  if (quittingImports || !imports.length) return;
  event.preventDefault(); quittingImports = true;
  // Cancellation waits for the owned helper to exit and its staging cleanup.
  void Promise.allSettled(imports.map(job => gameImports.cancel(job.inputPath))).finally(() => app.quit());
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
  const settings = loadSettings();
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

  const filePath = result.filePath.toLowerCase().endsWith(".command")
    ? result.filePath
    : `${result.filePath}.command`;
  const script = buildGameCommandScript({
    gamePath: path.resolve(gamePath),
    appName: app.getName(),
    appBundlePath: resolveAppBundlePath(process.execPath),
    repoRoot: app.getAppPath(),
    packaged: app.isPackaged
  });
  fs.writeFileSync(filePath, script, "utf8");
  try {
    fs.chmodSync(filePath, 0o755);
  } catch {}
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
  const runtimeId = typeof data.runtimeId === "string" ? data.runtimeId.trim() : "";
  let moduleId = typeof data.moduleId === "string" ? data.moduleId.trim() : "";
  const gamePath = typeof data.gamePath === "string" ? data.gamePath : "";
  if (!runtimeId) throw new Error("Missing runtime id");
  if (scope === "game") {
    if (!gamePath) throw new Error("Missing game path");
    if (!moduleId) {
      const settings = loadSettings();
      const games = loadGamesHydrated({ persist: false });
      const entry = findGameByPath(games, gamePath);
      if (entry) moduleId = resolveModuleId(entry);
    }
  }
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

ipcMain.handle("launcher:moduleAction", async (_event, gamePath, action, payload) => {
  const settings = loadSettings();
  const games = loadGamesHydrated({ persist: false });
  const entry = findGameByPath(games, gamePath);
  if (!entry) throw new Error("Game not found in library");

  try {
    return await backendService.request(`game:${entry.gameId || entry.gamePath}`, "moduleAction", entry, action, payload, settings);
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

app.on("ready", async () => {
  try {
    await init();
  } catch (e) {
    logger.error("Fatal error:", String(e?.stack || e));
    app.quit();
  }
});
