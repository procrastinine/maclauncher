const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow, dialog, ipcMain, Menu, shell, session, nativeImage } = require("electron");

const Modules = require("../modules/registry");
const IconUtils = require("./icon-utils");
const CleanupUtils = require("./cleanup-utils");
const { pickRuntimeId } = require("./runtime-utils");
const { mergeDetectedEntry } = require("./launch-utils");

const APP_NAME = "MacLauncher";
const USERDATA_DIRNAME = "maclauncher";

try {
  app.setName(APP_NAME);
} catch {}
try {
  app.setPath("userData", path.join(app.getPath("appData"), USERDATA_DIRNAME));
} catch {}

const isDebug = process.env.MACLAUNCHER_DEBUG === "1";
const devtoolsEnv = process.env.MACLAUNCHER_DEVTOOLS;
const devtoolsEnabled = devtoolsEnv === "1" || (devtoolsEnv == null && (isDebug || !app.isPackaged));
const devtoolsAuto = devtoolsEnabled && process.env.MACLAUNCHER_DEVTOOLS_AUTO === "1";
const isSmoke = process.argv.includes("--maclauncher-smoke");
// Child game instances avoid launcher state writes to prevent cross-process races.
const isChildGame = process.argv.includes("--maclauncher-game-child");

const DEFAULT_LAUNCHER_SETTINGS = {
  showIcons: true,
  showNonDefaultTags: true
};

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

function resolveModuleId(entry) {
  if (!entry || typeof entry !== "object") return "unknown";
  const moduleId = typeof entry.moduleId === "string" ? entry.moduleId.trim() : "";
  const engine = typeof entry.engine === "string" ? entry.engine.trim() : "";
  if (moduleId) {
    if ((moduleId === "web" || moduleId === "unknown") && engine && engine !== moduleId) {
      return engine;
    }
    return moduleId;
  }
  if (engine) return engine;
  return "unknown";
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
  settings.launcher = { ...DEFAULT_LAUNCHER_SETTINGS, ...current };
}

function applyModuleMigrations(settings) {
  for (const id of Modules.listModuleIds()) {
    const mod = Modules.getModule(id);
    if (typeof mod?.migrateSettings === "function") {
      mod.migrateSettings(settings);
    }
  }
}

function migrateLegacyRuntimeSettings(settings) {
  const recents = Array.isArray(settings?.recents) ? settings.recents : [];
  let changed = false;
  for (const entry of recents) {
    if (!entry || typeof entry !== "object") continue;
    const moduleInfo = Modules.getModuleInfo(resolveModuleId(entry));
    const legacy = resolveLegacyRuntimeSettings(entry, moduleInfo);
    if (Object.keys(legacy).length > 0) {
      const runtimeSettings =
        entry.runtimeSettings && typeof entry.runtimeSettings === "object"
          ? { ...entry.runtimeSettings }
          : {};
      let updated = false;
      for (const [runtimeId, legacySettings] of Object.entries(legacy)) {
        const existing = runtimeSettings[runtimeId];
        if (existing && typeof existing === "object") {
          if (
            Object.prototype.hasOwnProperty.call(existing, "enableProtections") ||
            Object.prototype.hasOwnProperty.call(existing, "disableProtections")
          ) {
            continue;
          }
          runtimeSettings[runtimeId] = { ...existing, ...legacySettings };
        } else {
          runtimeSettings[runtimeId] = { ...legacySettings };
        }
        updated = true;
      }
      if (updated) {
        entry.runtimeSettings = runtimeSettings;
        changed = true;
      }
    }
    if (Object.prototype.hasOwnProperty.call(entry, "disableProtections")) {
      delete entry.disableProtections;
      changed = true;
    }
  }
  return changed;
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

  const recents = Array.isArray(settings?.recents) ? settings.recents : [];
  for (const entry of recents) {
    if (!entry || typeof entry !== "object") continue;
    const runtimeSettings =
      entry.runtimeSettings && typeof entry.runtimeSettings === "object"
        ? entry.runtimeSettings
        : null;
    if (!runtimeSettings) continue;
    const moduleId = resolveModuleId(entry);
    const moduleInfo = Modules.getModuleInfo(moduleId);
    for (const [runtimeId, runtimeOverride] of Object.entries(runtimeSettings)) {
      const schema = resolveRuntimeSettingsSchema(moduleInfo, runtimeId);
      if (!schema) {
        delete runtimeSettings[runtimeId];
        changed = true;
        continue;
      }
      const moduleDefaults = resolveModuleRuntimeSettings(settings, moduleId, moduleInfo, runtimeId);
      if (!moduleDefaults) continue;
      const normalized = normalizeRuntimeSettings(schema, runtimeOverride, moduleDefaults);
      if (shallowEqual(normalized, moduleDefaults)) {
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
      delete entry.runtimeSettings;
      changed = true;
    }
  }
  return changed;
}

function resolveHostedRuntimeInfo(moduleInfo) {
  const hosted = moduleInfo?.runtime?.hosted;
  if (!hosted) return null;
  if (typeof hosted === "string") {
    const id = hosted.trim();
    return id ? { id } : null;
  }
  if (hosted && typeof hosted === "object") {
    const id = typeof hosted.id === "string" ? hosted.id.trim() : "";
    if (!id) return null;
    const fallback =
      typeof hosted.fallback === "string" && hosted.fallback.trim() ? hosted.fallback.trim() : null;
    const suffix =
      typeof hosted.userAgent?.suffix === "string" && hosted.userAgent.suffix.trim()
        ? hosted.userAgent.suffix.trim()
        : null;
    const hint =
      typeof hosted.userAgent?.hint === "string" && hosted.userAgent.hint.trim()
        ? hosted.userAgent.hint.trim()
        : null;
    const userAgent = suffix || hint ? { suffix, hint } : null;
    return {
      id,
      ...(fallback ? { fallback } : {}),
      ...(userAgent ? { userAgent } : {})
    };
  }
  return null;
}

function resolveDefaultRuntimeForModule(moduleInfo, moduleSettings) {
  const hostedId = resolveHostedRuntimeInfo(moduleInfo)?.id;
  const fallback = moduleInfo?.runtime?.default || hostedId || "";
  const value = typeof moduleSettings?.defaultRuntime === "string" ? moduleSettings.defaultRuntime : "";
  const normalized = value.trim().toLowerCase();
  return normalized || fallback;
}

function resolveModuleSettings(settings, moduleId) {
  const modules = settings?.modules && typeof settings.modules === "object" ? settings.modules : {};
  return modules[moduleId] && typeof modules[moduleId] === "object" ? modules[moduleId] : {};
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
  if (typeof entry?.toolsButtonVisibleOverride === "boolean") {
    return entry.toolsButtonVisibleOverride;
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

function cleanupRuntimeGameData(entry, settings) {
  if (!entry || typeof entry !== "object") return;
  const gamePath = typeof entry.gamePath === "string" ? entry.gamePath.trim() : "";
  if (!gamePath) return;
  const moduleId = resolveModuleId(entry);
  const userDataDir = app.getPath("userData");
  const context = { entry, gamePath, moduleId, userDataDir, settings };
  for (const manager of listRuntimeManagers()) {
    if (typeof manager?.cleanupGameData !== "function") continue;
    try {
      manager.cleanupGameData(context);
    } catch (e) {
      logger.warn(`[cleanup] runtime manager ${manager.id} failed`, String(e?.message || e));
    }
  }
}

function cleanupModuleGameData(entry, settings) {
  if (!entry || typeof entry !== "object") return;
  const gamePath = typeof entry.gamePath === "string" ? entry.gamePath.trim() : "";
  if (!gamePath) return;
  const moduleId = resolveModuleId(entry);
  const mod = Modules.getModule(moduleId);
  if (typeof mod?.cleanupGameData !== "function") return;
  const userDataDir = app.getPath("userData");
  const context = { entry, gamePath, moduleId, userDataDir, settings, logger };
  try {
    mod.cleanupGameData(entry, context);
  } catch (e) {
    logger.warn(`[cleanup] module ${moduleId} failed`, String(e?.message || e));
  }
}

function cleanupLauncherGameData(entry) {
  if (!entry || typeof entry !== "object") return;
  const gamePath = typeof entry.gamePath === "string" ? entry.gamePath.trim() : "";
  if (!gamePath) return;
  const moduleId = resolveModuleId(entry);
  const userDataDir = app.getPath("userData");
  try {
    CleanupUtils.cleanupLauncherGameData({ userDataDir, moduleId, gamePath });
  } catch (e) {
    logger.warn("[cleanup] launcher data failed", String(e?.message || e));
  }
}

function cleanupGameUserData(entry, settings) {
  cleanupRuntimeGameData(entry, settings);
  cleanupModuleGameData(entry, settings);
  cleanupLauncherGameData(entry);
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

function resolveRuntimeSettingsSchema(moduleInfo, runtimeId) {
  const entry = resolveRuntimeEntry(moduleInfo, runtimeId);
  if (!entry?.settings || typeof entry.settings !== "object") return null;
  const fields = Array.isArray(entry.settings.fields)
    ? entry.settings.fields.filter(field => field && typeof field === "object")
    : [];
  if (!fields.length) return null;
  return { ...entry.settings, fields };
}

function resolveRuntimeSettingFallback(field) {
  if (!field || typeof field !== "object") return null;
  if (Object.prototype.hasOwnProperty.call(field, "default")) return field.default;
  const type = typeof field.type === "string" ? field.type : "string";
  if (type === "boolean") return false;
  if (type === "number") return 0;
  if (type === "list") return [];
  return "";
}

function normalizeListValue(value) {
  if (Array.isArray(value)) {
    return value
      .map(entry => String(entry ?? "").trim())
      .filter(entry => entry.length > 0);
  }
  if (typeof value === "string") {
    return value
      .split(/\r?\n|,/)
      .map(entry => entry.trim())
      .filter(entry => entry.length > 0);
  }
  return [];
}

function normalizeRuntimeSettingValue(field, value, fallback) {
  const type = typeof field?.type === "string" ? field.type : "string";
  if (type === "boolean") {
    if (value === true || value === false) return value;
    return fallback === true || fallback === false ? fallback : false;
  }
  if (type === "number") {
    const num = typeof value === "number" ? value : Number(value);
    if (Number.isFinite(num)) return num;
    const fb = typeof fallback === "number" ? fallback : Number(fallback);
    return Number.isFinite(fb) ? fb : 0;
  }
  if (type === "list") {
    if (value === null || value === undefined) return normalizeListValue(fallback);
    return normalizeListValue(value);
  }
  if (type === "select") {
    const options = Array.isArray(field.options) ? field.options : [];
    const values = options
      .map(opt => opt?.value ?? opt?.id)
      .filter(val => typeof val === "string" && val.length > 0);
    const incoming = typeof value === "string" ? value : "";
    if (incoming && values.includes(incoming)) return incoming;
    const fb = typeof fallback === "string" ? fallback : "";
    if (fb && values.includes(fb)) return fb;
    return values[0] || "";
  }
  if (typeof value === "string") return value;
  return typeof fallback === "string" ? fallback : "";
}

function buildRuntimeSettingsDefaults(schema) {
  if (!schema) return {};
  const base =
    schema.defaults && typeof schema.defaults === "object" ? schema.defaults : {};
  const out = {};
  for (const field of schema.fields || []) {
    const key = typeof field.key === "string" ? field.key : "";
    if (!key) continue;
    if (Object.prototype.hasOwnProperty.call(base, key)) {
      out[key] = normalizeRuntimeSettingValue(field, base[key], resolveRuntimeSettingFallback(field));
    } else {
      out[key] = normalizeRuntimeSettingValue(field, undefined, resolveRuntimeSettingFallback(field));
    }
  }
  return out;
}

function migrateRuntimeSettingsInput(schema, raw) {
  if (!schema) return raw;
  const fields = Array.isArray(schema.fields) ? schema.fields : [];
  const hasEnable = fields.some(field => field?.key === "enableProtections");
  const hasDisable = fields.some(field => field?.key === "disableProtections");
  if (
    hasEnable &&
    !Object.prototype.hasOwnProperty.call(raw, "enableProtections") &&
    Object.prototype.hasOwnProperty.call(raw, "disableProtections")
  ) {
    const next = { ...raw };
    next.enableProtections = !Boolean(next.disableProtections);
    delete next.disableProtections;
    return next;
  }
  if (
    hasDisable &&
    !Object.prototype.hasOwnProperty.call(raw, "disableProtections") &&
    Object.prototype.hasOwnProperty.call(raw, "enableProtections")
  ) {
    const next = { ...raw };
    next.disableProtections = !Boolean(next.enableProtections);
    delete next.enableProtections;
    return next;
  }
  return raw;
}

function normalizeRuntimeSettings(schema, incoming, defaults) {
  if (!schema) return {};
  const base = defaults && typeof defaults === "object" ? defaults : buildRuntimeSettingsDefaults(schema);
  const raw = incoming && typeof incoming === "object" ? incoming : {};
  const migrated = migrateRuntimeSettingsInput(schema, raw);
  const out = {};
  for (const field of schema.fields || []) {
    const key = typeof field.key === "string" ? field.key : "";
    if (!key) continue;
    const fallback = Object.prototype.hasOwnProperty.call(base, key)
      ? base[key]
      : resolveRuntimeSettingFallback(field);
    out[key] = normalizeRuntimeSettingValue(field, migrated[key], fallback);
  }
  return out;
}

function runtimeSettingsDir(runtimeId) {
  return path.join(app.getPath("userData"), "runtimes", runtimeId);
}

function runtimeSettingsPath(runtimeId) {
  return path.join(runtimeSettingsDir(runtimeId), "settings.json");
}

const runtimeDefaultsCache = new Map();

function readRuntimeDefaults(runtimeId, moduleInfo) {
  if (!runtimeId) return null;
  const schema = resolveRuntimeSettingsSchema(moduleInfo, runtimeId);
  if (!schema) return null;
  if (runtimeDefaultsCache.has(runtimeId)) {
    return { ...runtimeDefaultsCache.get(runtimeId) };
  }
  const defaults = buildRuntimeSettingsDefaults(schema);
  const p = runtimeSettingsPath(runtimeId);
  let parsed = null;
  let needsWrite = false;
  try {
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, "utf8");
      parsed = JSON.parse(raw);
    } else {
      needsWrite = true;
    }
  } catch {
    needsWrite = true;
  }
  const normalized = normalizeRuntimeSettings(schema, parsed, defaults);
  if (needsWrite || !shallowEqual(parsed, normalized)) {
    ensureDir(path.dirname(p));
    try {
      fs.writeFileSync(p, JSON.stringify(normalized, null, 2), "utf8");
    } catch {}
  }
  runtimeDefaultsCache.set(runtimeId, normalized);
  return { ...normalized };
}

function mergeRuntimeSettingsMap(base, incoming) {
  const out = {};
  const source = base && typeof base === "object" ? base : {};
  for (const [key, value] of Object.entries(source)) {
    if (!value || typeof value !== "object") continue;
    out[key] = { ...value };
  }
  const next = incoming && typeof incoming === "object" ? incoming : {};
  for (const [key, value] of Object.entries(next)) {
    if (!value || typeof value !== "object") continue;
    out[key] = { ...(out[key] || {}), ...value };
  }
  return out;
}

function resolveLegacyRuntimeSettings(entry, moduleInfo) {
  const out = {};
  if (!entry || typeof entry !== "object") return out;
  if (entry.disableProtections !== true && entry.disableProtections !== false) return out;
  const supported = Array.isArray(moduleInfo?.runtime?.supported)
    ? moduleInfo.runtime.supported
    : Object.keys(moduleInfo?.runtime?.entries || {});
  for (const runtimeId of supported) {
    const schema = resolveRuntimeSettingsSchema(moduleInfo, runtimeId);
    if (!schema) continue;
    const hasEnable = schema.fields?.some(field => field?.key === "enableProtections");
    const hasDisable = schema.fields?.some(field => field?.key === "disableProtections");
    if (!hasEnable && !hasDisable) continue;
    if (hasEnable) {
      out[runtimeId] = { enableProtections: entry.disableProtections !== true };
      continue;
    }
    out[runtimeId] = { disableProtections: entry.disableProtections === true };
  }
  return out;
}

function resolveModuleRuntimeSettings(settings, moduleId, moduleInfo, runtimeId) {
  const schema = resolveRuntimeSettingsSchema(moduleInfo, runtimeId);
  if (!schema) return null;
  const defaults = readRuntimeDefaults(runtimeId, moduleInfo) || buildRuntimeSettingsDefaults(schema);
  const moduleSettings = resolveModuleSettings(settings, moduleId);
  const runtimeSettings =
    moduleSettings.runtimeSettings &&
    typeof moduleSettings.runtimeSettings === "object"
      ? moduleSettings.runtimeSettings[runtimeId]
      : null;
  return normalizeRuntimeSettings(schema, runtimeSettings, defaults);
}

function resolveRuntimeSettingsForEntry(entry, settings, moduleInfo, runtimeId) {
  const schema = resolveRuntimeSettingsSchema(moduleInfo, runtimeId);
  if (!schema) return null;
  const moduleId = resolveModuleId(entry);
  const defaults = resolveModuleRuntimeSettings(settings, moduleId, moduleInfo, runtimeId);
  const legacy = resolveLegacyRuntimeSettings(entry, moduleInfo);
  const overrides = mergeRuntimeSettingsMap(
    legacy,
    entry?.runtimeSettings && typeof entry.runtimeSettings === "object"
      ? entry.runtimeSettings
      : {}
  );
  const override =
    overrides[runtimeId] && typeof overrides[runtimeId] === "object" ? overrides[runtimeId] : null;
  if (override) {
    const normalized = normalizeRuntimeSettings(schema, override, defaults);
    if (shallowEqual(normalized, defaults)) return defaults;
    return normalized;
  }
  return defaults;
}

function loadSettings() {
  let settings = {
    recents: [],
    modules: {},
    runtimes: {},
    launcher: {}
  };
  try {
    const raw = fs.readFileSync(settingsPath(), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") settings = parsed;
  } catch {}
  if (!Array.isArray(settings.recents)) settings.recents = [];
  if (!settings.modules || typeof settings.modules !== "object") settings.modules = {};
  if (!settings.runtimes || typeof settings.runtimes !== "object") settings.runtimes = {};
  if (!settings.launcher || typeof settings.launcher !== "object") settings.launcher = {};

  applyModuleMigrations(settings);
  normalizeModuleSettings(settings);
  normalizeLauncherSettings(settings);
  lastRuntimeSettingsMigration =
    migrateLegacyRuntimeSettings(settings) || pruneRuntimeSettingsDefaults(settings);

  const keep = new Set(["recents", "modules", "runtimes", "launcher"]);
  for (const key of Object.keys(settings)) {
    if (!keep.has(key)) delete settings[key];
  }
  return settings;
}

function loadSettingsHydrated({ persist = true } = {}) {
  const settings = loadSettings();
  const userDataDir = app.getPath("userData");
  let changed = lastRuntimeSettingsMigration;
  try {
    if (hydrateCheatsFromFiles(settings)) changed = true;
  } catch {}
  if (changed && persist) saveSettings(settings);
  return settings;
}

function saveSettings(next) {
  ensureDir(app.getPath("userData"));
  fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2), "utf8");
  try {
    syncCheatsFiles(next);
  } catch {}
}

function cheatsDirPath(moduleId) {
  const dir = path.join(app.getPath("userData"), "modules", moduleId, "cheats");
  ensureDir(dir);
  return dir;
}

function cheatsFilePathForGame(gamePath, moduleId) {
  const id = stableIdForPath(gamePath);
  const moduleDir = cheatsDirPath(moduleId);
  const next = path.join(moduleDir, `${id}.json`);
  return next;
}

const cheatsFileLastWritten = new Map();
const cheatsFileWatchers = new Map();
const cheatsFileDebounceTimers = new Map();
const cheatsFileToGamePath = new Map();
const cheatsFileToModuleId = new Map();

function writeCheatsFile(gamePath, moduleId, cheats) {
  const normalized = normalizeCheatsForModule(moduleId, cheats);
  if (!normalized) return null;
  const p = cheatsFilePathForGame(gamePath, moduleId);
  const json = JSON.stringify(normalized, null, 2);
  if (cheatsFileLastWritten.get(p) === json) return p;
  try {
    fs.writeFileSync(p, json, "utf8");
    cheatsFileLastWritten.set(p, json);
  } catch {}
  return p;
}

function readCheatsFile(gamePath, moduleId) {
  const p = cheatsFilePathForGame(gamePath, moduleId);
  if (!fs.existsSync(p)) return null;
  try {
    const raw = fs.readFileSync(p, "utf8");
    const parsed = JSON.parse(raw);
    return normalizeCheatsForModule(moduleId, parsed);
  } catch {
    return null;
  }
}

function hydrateCheatsFromFiles(settings) {
  const recents = Array.isArray(settings?.recents) ? settings.recents : [];
  let changed = false;
  for (const entry of recents) {
    if (!entry || typeof entry.gamePath !== "string" || !entry.gamePath) continue;
    const moduleId = resolveModuleId(entry);
    if (!getModuleCheats(moduleId)) continue;
    const fromFile = readCheatsFile(entry.gamePath, moduleId);
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
  const gamePath = cheatsFileToGamePath.get(filePath);
  const moduleId = cheatsFileToModuleId.get(filePath);
  if (!gamePath) return;
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

  const settings = loadSettings();
  const entry = (settings.recents || []).find(r => r.gamePath === gamePath);
  if (!entry) return;

  if (cheatsEqualForModule(moduleId, entry.cheats, nextCheats)) return;
  entry.cheats = nextCheats;
  saveSettings(settings);
  cachedState = buildState(settings);
  broadcastState();
}

function syncCheatsFiles(settings) {
  const recents = Array.isArray(settings?.recents) ? settings.recents : [];
  const wanted = new Map();

  for (const entry of recents) {
    if (!entry || typeof entry.gamePath !== "string" || !entry.gamePath) continue;
    const moduleId = resolveModuleId(entry);
    if (!getModuleCheats(moduleId)) continue;
    const gamePath = entry.gamePath;
    const p = cheatsFilePathForGame(gamePath, moduleId);
    wanted.set(p, gamePath);
    cheatsFileToGamePath.set(p, gamePath);
    cheatsFileToModuleId.set(p, moduleId);
    writeCheatsFile(gamePath, moduleId, entry.cheats);

    if (!cheatsFileWatchers.has(p)) {
      try {
        const watcher = fs.watch(p, () => scheduleCheatsFileRead(p));
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
    cheatsFileDebounceTimers.delete(p);
    cheatsFileToGamePath.delete(p);
    cheatsFileToModuleId.delete(p);
    cheatsFileLastWritten.delete(p);
  }
}

function resolveNativeLaunchPath(entry) {
  const nativePath =
    typeof entry?.nativeAppPath === "string" && entry.nativeAppPath.trim()
      ? entry.nativeAppPath.trim()
      : null;
  if (nativePath && nativePath.toLowerCase().endsWith(".app")) {
    try {
      if (fs.existsSync(nativePath) && fs.statSync(nativePath).isDirectory()) return nativePath;
    } catch {}
  }

  const gamePath = typeof entry?.gamePath === "string" ? entry.gamePath : "";
  if (gamePath && gamePath.toLowerCase().endsWith(".app")) {
    try {
      if (fs.existsSync(gamePath) && fs.statSync(gamePath).isDirectory()) return gamePath;
    } catch {}
  }
  return null;
}

function readAppBundleExecutableName(appPath) {
  const infoPath = path.join(appPath, "Contents", "Info.plist");
  try {
    const raw = fs.readFileSync(infoPath);
    if (!raw || raw.length < 16) return null;
    const header = raw.subarray(0, 6).toString("utf8");
    if (header === "bplist") return null;
    const text = raw.toString("utf8");
    const match = text.match(/<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

function resolveAppBundleExecutablePath(appPath) {
  if (!appPath) return null;
  const macosDir = path.join(appPath, "Contents", "MacOS");
  try {
    if (!fs.existsSync(macosDir) || !fs.statSync(macosDir).isDirectory()) return null;
  } catch {
    return null;
  }

  const fromPlist = readAppBundleExecutableName(appPath);
  if (fromPlist) {
    const direct = path.join(macosDir, fromPlist);
    if (fs.existsSync(direct)) return direct;
  }

  const bundleName = path.basename(appPath, ".app");
  if (bundleName) {
    const direct = path.join(macosDir, bundleName);
    if (fs.existsSync(direct)) return direct;
  }

  try {
    const entries = fs.readdirSync(macosDir, { withFileTypes: true });
    const file = entries.find(entry => entry.isFile());
    return file ? path.join(macosDir, file.name) : null;
  } catch {
    return null;
  }
}

function resolveModuleNativeLaunchPath(entry, mod) {
  if (typeof mod?.resolveNativeLaunchPath === "function") {
    return mod.resolveNativeLaunchPath(entry, {
      resolveNativeLaunchPath,
      app,
      fs,
      path,
      userDataDir: app.getPath("userData")
    });
  }
  return resolveNativeLaunchPath(entry);
}

function resolveRuntimeSupportForEntry(mod, moduleInfo, entry, moduleSettings) {
  const supported = Array.isArray(moduleInfo?.runtime?.supported)
    ? moduleInfo.runtime.supported.slice()
    : [];
  if (typeof mod?.filterRuntimeSupport === "function") {
    return mod.filterRuntimeSupport(entry, supported, moduleSettings);
  }
  return supported;
}

function resolveRuntimeForEntry(requestedRuntime, mod, moduleInfo, entry, moduleSettings, settings) {
  const supported = resolveRuntimeSupportForEntry(mod, moduleInfo, entry, moduleSettings);
  const defaultRuntime = resolveDefaultRuntimeForModule(moduleInfo, moduleSettings);
  const nativePath = resolveModuleNativeLaunchPath(entry, mod);
  const runtimeContext = {
    app,
    userDataDir: app.getPath("userData"),
    settings
  };
  return pickRuntimeId({
    requestedRuntime,
    supported,
    defaultRuntime,
    nativePath,
    canLaunchRuntime: typeof mod?.canLaunchRuntime === "function" ? mod.canLaunchRuntime : null,
    entry,
    moduleSettings,
    context: runtimeContext
  });
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
  const importPath = resolveImportPath(entry);
  if (importPath) {
    const ext = path.extname(importPath).toLowerCase();
    if (ext === ".app") return { path: importPath, source: ICON_SOURCES.APP };
    if (ext === ".exe") return { path: importPath, source: ICON_SOURCES.EXE };
  }

  const gamePath = typeof entry?.gamePath === "string" ? entry.gamePath.trim() : "";
  if (gamePath && gamePath.toLowerCase().endsWith(".app")) {
    return { path: gamePath, source: ICON_SOURCES.APP };
  }

  const nativeAppPath = typeof entry?.nativeAppPath === "string" ? entry.nativeAppPath.trim() : "";
  if (nativeAppPath && nativeAppPath.toLowerCase().endsWith(".app")) {
    return { path: nativeAppPath, source: ICON_SOURCES.APP };
  }

  if (gamePath) {
    try {
      if (fs.existsSync(gamePath) && fs.statSync(gamePath).isDirectory()) {
        const exePath = IconUtils.findBestExePath(gamePath, entry?.name);
        if (exePath) return { path: exePath, source: ICON_SOURCES.EXE };
      }
    } catch {}
  }

  return null;
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
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.url;
    }
    const img = nativeImage.createFromPath(iconPath);
    if (!img || img.isEmpty()) return null;
    const url = img.toDataURL();
    if (!url || typeof url !== "string") return null;
    iconDataUrlCache.set(iconPath, { mtimeMs: stat.mtimeMs, size: stat.size, url });
    return url;
  } catch {
    return null;
  }
}

function normalizeRecentEntry(entry, settings) {
  const moduleId = resolveModuleId(entry);
  const mod = Modules.getModule(moduleId);
  const moduleInfo = Modules.getModuleInfo(moduleId);
  const moduleSettings = settings?.modules?.[moduleId] || {};
  const migrated = mod?.migrateEntry ? mod.migrateEntry(entry) : {};

  const moduleData = {
    ...(entry.moduleData && typeof entry.moduleData === "object" ? entry.moduleData : {}),
    ...(migrated.moduleData && typeof migrated.moduleData === "object" ? migrated.moduleData : {})
  };
  const runtimeData = {
    ...(entry.runtimeData && typeof entry.runtimeData === "object" ? entry.runtimeData : {}),
    ...(migrated.runtimeData && typeof migrated.runtimeData === "object" ? migrated.runtimeData : {})
  };
  const runtimeSettings = mergeRuntimeSettingsMap(
    mergeRuntimeSettingsMap(
      resolveLegacyRuntimeSettings(entry, moduleInfo),
      entry.runtimeSettings && typeof entry.runtimeSettings === "object" ? entry.runtimeSettings : {}
    ),
    migrated.runtimeSettings && typeof migrated.runtimeSettings === "object"
      ? migrated.runtimeSettings
      : {}
  );

  const rawRuntimeRequested =
    (typeof entry.runtimeId === "string" && entry.runtimeId.trim() ? entry.runtimeId : null) ||
    migrated.runtimeId ||
    entry.runtime;
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
      : resolveModuleNativeLaunchPath(entryContext, mod);

  const defaultSaveDir =
    typeof entry.defaultSaveDir === "string" && entry.defaultSaveDir
      ? entry.defaultSaveDir
      : null;

  const cheats = getModuleCheats(moduleId)
    ? normalizeCheatsForModule(moduleId, entry.cheats)
    : null;

  const importPath = resolveImportPath(entry);
  const moduleIconPath = resolveModuleIconPath(mod, entryContext);
  const moduleDefaultIconPath = resolveModuleDefaultIconPath(moduleId);
  const rawIconPath = normalizeIconPath(entry.iconPath);
  let iconPath = rawIconPath;
  let iconSource =
    typeof entry.iconSource === "string" && entry.iconSource.trim()
      ? entry.iconSource.trim()
      : null;
  if (moduleDefaultIconPath && iconPath === moduleDefaultIconPath) {
    iconSource = ICON_SOURCES.MODULE_DEFAULT;
  }
  if (moduleIconPath) {
    iconPath = moduleIconPath;
    iconSource = ICON_SOURCES.MODULE;
  } else if (!iconPath && moduleDefaultIconPath) {
    iconPath = moduleDefaultIconPath;
    iconSource = ICON_SOURCES.MODULE_DEFAULT;
  }
  if (!iconPath) iconSource = null;

  return {
    gamePath: entry.gamePath,
    importPath,
    name: resolveEntryDisplayName(entry),
    moduleId,
    gameType: entry.gameType ?? moduleInfo.gameType ?? null,
    indexDir: entry.indexDir,
    indexHtml: entry.indexHtml,
    contentRootDir: entry.contentRootDir ?? entry.gamePath,
    defaultSaveDir,
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
      cheats: moduleInfo.supports?.cheats === true,
      cheatsPatcher: moduleInfo.supports?.cheatsPatcher === true,
      saveEditing: moduleInfo.supports?.saveEditing === true,
      saveLocation: moduleInfo.supports?.saveLocation === true
    }
  };
}

function buildModuleLaunchContext(entry, settings, options = {}) {
  const moduleId = resolveModuleId(entry);
  const moduleInfo = Modules.getModuleInfo(moduleId);
  const moduleSettings = resolveModuleSettings(settings, moduleId);
  const runtimeId = options.runtimeId || entry?.runtimeId || null;
  const runtimeSettings =
    options.runtimeSettings ||
    (runtimeId ? resolveRuntimeSettingsForEntry(entry, settings, moduleInfo, runtimeId) : null);
  return {
    settings,
    moduleSettings,
    userDataDir: app.getPath("userData"),
    logger,
    toolsButtonVisible: options.toolsButtonVisible,
    cheatsFilePath: options.cheatsFilePath,
    spawnDetachedChecked,
    runtimeId,
    runtimeSettings,
    onRuntimeStateChange: () => {
      cachedState = buildState(loadSettings());
      broadcastState();
    }
  };
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

function decorateRecentEntry(entry, settings) {
  const normalized = normalizeRecentEntry(entry, settings);
  return { ...normalized, iconUrl: iconUrlForPath(normalized.iconPath) };
}

function resolveSaveContext(gamePath) {
  const settings = loadSettings();
  const entry = (settings.recents || []).find(r => r.gamePath === gamePath);
  if (!entry) throw new Error("Game not found in recents");

  const detected = Modules.detectGame(resolveDetectPath(entry));
  const saveDir = entry.saveDirOverride || entry.defaultSaveDir || detected.defaultSaveDir || null;
  if (!saveDir) {
    const info = Modules.getModuleInfo(resolveModuleId(detected));
    throw new Error(`Save directory is not available for ${info.label}.`);
  }
  return { detected, saveDir, settings };
}

function assertSaveEditingSupported(moduleId) {
  const info = Modules.getModuleInfo(moduleId);
  if (!info.supports?.saveEditing) {
    throw new Error(`Save editing is not supported for ${info.label}.`);
  }
  return info;
}

function getCheatsPatcherForModule(moduleId) {
  const patcher = getCheatsPatcherIfSupported(moduleId);
  if (patcher) return patcher;
  const info = Modules.getModuleInfo(moduleId);
  throw new Error(`Cheats patching is not supported for ${info.label}.`);
}

function assertInsideDir(rootDir, filePath) {
  const rel = path.relative(rootDir, filePath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("Path escapes root");
}

function safeJoinSavePath(saveDir, fileName) {
  const safe = path.basename(String(fileName || ""));
  if (!safe) throw new Error("Missing file name");
  const full = path.join(saveDir, safe);
  assertInsideDir(saveDir, full);
  return full;
}

function listSaveFiles(saveDir) {
  try {
    if (!fs.existsSync(saveDir) || !fs.statSync(saveDir).isDirectory()) return [];
  } catch {
    return [];
  }

  const out = [];
  const entries = fs.readdirSync(saveDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (String(entry.name).toLowerCase().endsWith(".maclauncher.json")) continue;
    const full = path.join(saveDir, entry.name);
    try {
      const stat = fs.statSync(full);
      out.push({ name: entry.name, path: full, size: stat.size, mtimeMs: stat.mtimeMs });
    } catch {}
  }

  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
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

function copyDirContents(srcDir, destDir) {
  ensureDir(destDir);
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      fs.cpSync(srcPath, destPath, { recursive: true, force: true });
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

const MIME = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".svg", "image/svg+xml"],
  [".ico", "image/x-icon"],
  [".mp3", "audio/mpeg"],
  [".ogg", "audio/ogg"],
  [".m4a", "audio/mp4"],
  [".wav", "audio/wav"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".ttf", "font/ttf"],
  [".otf", "font/otf"],
  [".eot", "application/vnd.ms-fontobject"],
  [".wasm", "application/wasm"],
  [".bin", "application/octet-stream"],
  [".dat", "application/octet-stream"],
  [".txt", "text/plain; charset=utf-8"]
]);

function guessMime(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME.get(ext) ?? "application/octet-stream";
}

function safeDecodePathname(pathname) {
  try {
    return decodeURIComponent(pathname);
  } catch {
    try {
      const withUnicode = pathname.replace(/%u([0-9a-fA-F]{4})/g, (_m, hex) =>
        String.fromCharCode(parseInt(hex, 16))
      );
      return decodeURIComponent(withUnicode);
    } catch {
      // eslint-disable-next-line no-undef
      return unescape(pathname);
    }
  }
}

function createStaticServer(rootDir) {
  const server = http.createServer((req, res) => {
    try {
      const host = req.headers.host || "";
      logger.debug(`[server] ${req.method} ${host}${req.url || ""}`);

      const rawUrl = req.url || "/";
      const url = new URL(rawUrl, "http://127.0.0.1");
      let pathname = safeDecodePathname(url.pathname);
      if (pathname === "/") pathname = "/index.html";

      const absolute = path.resolve(rootDir, "." + pathname);
      const rel = path.relative(rootDir, absolute);
      if (rel.startsWith("..") || path.isAbsolute(rel)) {
        res.statusCode = 403;
        res.end("Forbidden");
        return;
      }

      if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }

      const stat = fs.statSync(absolute);
      const mime = guessMime(absolute);
      res.setHeader("Content-Type", mime);
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Accept-Ranges", "bytes");

      const range = req.headers.range;
      if (range) {
        const m = /^bytes=(\\d+)-(\\d+)?$/.exec(range);
        if (m) {
          const start = Number(m[1]);
          const end = m[2] ? Number(m[2]) : stat.size - 1;
          if (Number.isFinite(start) && Number.isFinite(end) && start <= end) {
            res.statusCode = 206;
            res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
            res.setHeader("Content-Length", String(end - start + 1));
            fs.createReadStream(absolute, { start, end }).pipe(res);
            return;
          }
        }
      }

      res.statusCode = 200;
      res.setHeader("Content-Length", String(stat.size));
      fs.createReadStream(absolute).pipe(res);
    } catch (e) {
      logger.error("[server] error", String(e?.stack || e));
      res.statusCode = 500;
      res.end("Internal error");
    }
  });

  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to bind game server"));
        return;
      }
      resolve({
        port: address.port,
        close: () => new Promise(r => server.close(() => r()))
      });
    });
  });
}

function stablePartitionId(gamePath, mode = "protected") {
  const h = crypto.createHash("sha256").update(gamePath).digest("hex").slice(0, 16);
  const suffix = mode === "unrestricted" ? "unrestricted-" : "";
  return `persist:maclauncher-game-${suffix}${h}`;
}

const sessionRestrictions = new WeakMap();

function safeRm(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {}
}

function stableIdForPath(input) {
  return crypto.createHash("sha256").update(String(input || "")).digest("hex").slice(0, 12);
}

function iconCacheDir() {
  const dir = path.join(app.getPath("userData"), "icons");
  ensureDir(dir);
  return dir;
}

function iconCachePath(gamePath, source) {
  const safeSource = String(source || "icon").replace(/[^a-z0-9-]+/gi, "");
  return path.join(iconCacheDir(), `${stableIdForPath(gamePath)}-${safeSource}.png`);
}

function writePngToCache(cachePath, pngBuffer) {
  if (!cachePath || !pngBuffer || pngBuffer.length === 0) return null;
  try {
    fs.writeFileSync(cachePath, pngBuffer);
    return cachePath;
  } catch {
    return null;
  }
}

function extractAppIconToCache(appPath, cachePath) {
  const icnsPath = IconUtils.findAppBundleIconPath(appPath);
  if (!icnsPath) return null;
  try {
    const img = nativeImage.createFromPath(icnsPath);
    if (!img || img.isEmpty()) return null;
    return writePngToCache(cachePath, img.toPNG());
  } catch {
    return null;
  }
}

function extractExeIconToCache(exePath, cachePath) {
  const image = IconUtils.extractExeIconImage(exePath);
  if (!image) return null;
  if (image.type === "png") return writePngToCache(cachePath, image.buffer);
  if (image.type === "bitmap") {
    try {
      const img = nativeImage.createFromBitmap(image.buffer, {
        width: image.width,
        height: image.height
      });
      if (!img || img.isEmpty()) return null;
      return writePngToCache(cachePath, img.toPNG());
    } catch {
      return null;
    }
  }
  return null;
}

async function ensureCachedIcon(gamePath, sourcePath, source) {
  if (!ICON_EXTRACTION_ENABLED) return null;
  if (!gamePath || !sourcePath || !source) return null;
  try {
    if (!fs.existsSync(sourcePath)) return null;
  } catch {
    return null;
  }

  const cachePath = iconCachePath(gamePath, source);
  try {
    if (fs.existsSync(cachePath) && fs.statSync(cachePath).isFile()) return cachePath;
  } catch {}

  if (source === ICON_SOURCES.APP) return extractAppIconToCache(sourcePath, cachePath);
  if (source === ICON_SOURCES.EXE) return extractExeIconToCache(sourcePath, cachePath);
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

  const moduleIconPath = resolveModuleIconPath(mod, entry);
  if (moduleIconPath) {
    return applyIconFields(entry, moduleIconPath, ICON_SOURCES.MODULE);
  }

  const moduleDefaultIconPath = resolveModuleDefaultIconPath(moduleId);
  let existingPath = normalizeIconPath(entry.iconPath);
  let existingSource =
    typeof entry.iconSource === "string" && entry.iconSource.trim()
      ? entry.iconSource.trim()
      : null;
  if (moduleDefaultIconPath && existingPath === moduleDefaultIconPath) {
    existingSource = ICON_SOURCES.MODULE_DEFAULT;
  }

  if (existingPath && existingSource !== ICON_SOURCES.MODULE_DEFAULT) {
    return applyIconFields(entry, existingPath, existingSource);
  }

  const candidate = resolveDefaultIconCandidate(entry);
  if (candidate) {
    const cached = await ensureCachedIcon(entry.gamePath, candidate.path, candidate.source);
    if (cached) return applyIconFields(entry, cached, candidate.source);
  }

  if (moduleDefaultIconPath) {
    return applyIconFields(entry, moduleDefaultIconPath, ICON_SOURCES.MODULE_DEFAULT);
  }

  return applyIconFields(entry, null, null);
}

let iconRefreshPromise = null;

async function ensureIconsForRecents(settings) {
  if (iconRefreshPromise) return iconRefreshPromise;
  iconRefreshPromise = (async () => {
    const recents = Array.isArray(settings?.recents) ? settings.recents : [];
    let changed = false;
    for (const entry of recents) {
      // eslint-disable-next-line no-await-in-loop
      if (await ensureIconForEntry(entry)) changed = true;
    }
    if (changed) {
      saveSettings(settings);
      cachedState = buildState(settings);
      broadcastState();
    }
  })();
  try {
    await iconRefreshPromise;
  } finally {
    iconRefreshPromise = null;
  }
}

function readGamePackageJson(contentRootDir) {
  const pkgPath = path.join(contentRootDir, "package.json");
  if (!fs.existsSync(pkgPath)) return null;
  try {
    const raw = fs.readFileSync(pkgPath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function windowConfigFromPackageJson(pkg) {
  const w = pkg && typeof pkg === "object" ? pkg.window : null;
  const width = Number(w?.width);
  const height = Number(w?.height);
  const title = typeof w?.title === "string" && w.title.trim() ? w.title.trim() : null;
  return {
    width: Number.isFinite(width) ? Math.max(200, Math.min(8000, width)) : null,
    height: Number.isFinite(height) ? Math.max(200, Math.min(8000, height)) : null,
    title
  };
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
  const runId = registerGameRun(gamePath, { kind: "process", pid: child.pid, runtimeId });
  const onExit = () => unregisterGameRun(gamePath, runId);
  child.once("exit", onExit);
  child.once("error", onExit);
  return runId;
}

function isProcessAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function stopProcessTree(pid) {
  if (!pid) return false;
  let signaled = false;
  try {
    process.kill(-pid, "SIGTERM");
    signaled = true;
  } catch (err) {
    if (err?.code === "ESRCH") return false;
    try {
      process.kill(pid, "SIGTERM");
      signaled = true;
    } catch {
      return false;
    }
  }
  if (signaled) {
    setTimeout(() => {
      if (!isProcessAlive(pid)) return;
      try {
        process.kill(-pid, "SIGKILL");
      } catch {}
    }, 2000);
  }
  return signaled;
}

async function stopRunSession(session) {
  if (!session) return false;
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
  const userDataDir = app.getPath("userData");
  for (const manager of listRuntimeManagers()) {
    if (!manager || typeof manager.getState !== "function") continue;
    const state = manager.getState({
      settings: settings?.runtimes?.[manager.id],
      userDataDir,
      logger
    });
    out[manager.id] = {
      id: manager.id,
      label: manager.label || manager.id,
      ...state
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
  const context = {
    settings,
    userDataDir: app.getPath("userData"),
    logger,
    app,
    fs,
    path
  };
  for (const id of Modules.listModuleIds()) {
    const mod = Modules.getModule(id);
    if (!mod) continue;
    const state = typeof mod.getState === "function" ? mod.getState(context) : null;
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

function applyGameSessionRestrictions(netSession, allowedOrigin) {
  const allowed = new URL(allowedOrigin);
  const allowPort = String(allowed.port);
  let restriction = sessionRestrictions.get(netSession);
  if (!restriction) {
    restriction = {
      allowHost: allowed.hostname,
      allowPorts: new Set()
    };
    sessionRestrictions.set(netSession, restriction);

    netSession.webRequest.onBeforeRequest((details, callback) => {
      try {
        const u = new URL(details.url);
        const proto = u.protocol;

        if (proto === "data:" || proto === "blob:") return callback({});
        if (
          proto === "devtools:" ||
          proto === "chrome-devtools:" ||
          proto === "chrome:" ||
          proto === "chrome-extension:"
        ) {
          return callback({});
        }

        if (proto === "ws:" || proto === "wss:") {
          const host = u.hostname;
          const isAllowed =
            host === restriction.allowHost ||
            host === "localhost" ||
            host === "127.0.0.1" ||
            host === "::1";
          if (isAllowed) return callback({});
          logger.warn(`[offline] blocked ${details.url}`);
          return callback({ cancel: true });
        }

        if (proto === "http:" || proto === "https:") {
          const port = String(u.port || (proto === "https:" ? "443" : "80"));
          const isAllowed =
            (u.hostname === restriction.allowHost || u.hostname === "localhost") &&
            restriction.allowPorts.has(port);
          if (isAllowed) return callback({});
          logger.warn(`[offline] blocked ${details.url}`);
          return callback({ cancel: true });
        }

        logger.warn(`[offline] blocked protocol ${details.url}`);
        return callback({ cancel: true });
      } catch {
        return callback({ cancel: true });
      }
    });
  }

  restriction.allowHost = allowed.hostname;
  restriction.allowPorts.add(allowPort);
  return () => restriction.allowPorts.delete(allowPort);
}

let mainWindow = null;
let cachedState = null;
let lastRuntimeSettingsMigration = false;
const launcherWindows = new Set();

function getLauncherState() {
  if (!cachedState) return cachedState;
  return { ...cachedState, running: buildRunningState() };
}

function broadcastState() {
  if (launcherWindows.size === 0) return;
  const state = getLauncherState();
  for (const win of launcherWindows) {
    try {
      win.webContents.send("launcher:state", state);
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
    await win.loadURL(url.toString());
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
  const win = new BrowserWindow({
    width: 900,
    height: 650,
    backgroundColor: "#0b0f17",
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

  await loadLauncherView(win);

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

async function createGameWindow(gameEntry, options = {}) {
  const moduleId = resolveModuleId(gameEntry);
  const mod = Modules.getModule(moduleId);
  const moduleInfo = Modules.getModuleInfo(moduleId);
  const hostedInfo = resolveHostedRuntimeInfo(moduleInfo);
  let runtimeId =
    options.runtimeId ||
    hostedInfo?.id ||
    gameEntry.runtimeId ||
    moduleInfo?.runtime?.default ||
    moduleInfo?.runtime?.supported?.[0] ||
    null;
  if (hostedInfo?.id && runtimeId !== hostedInfo.id) runtimeId = hostedInfo.id;
  const runtimeName = runtimeId ? resolveRuntimeName(runtimeId, moduleInfo) : "Runtime";
  if (gameEntry.gameType && gameEntry.gameType !== "web") {
    throw new Error(`${runtimeName} is not supported for ${moduleInfo.label}.`);
  }
  if (!gameEntry.indexHtml) {
    throw new Error(`Missing index.html; ${runtimeName} requires a web game.`);
  }

  const settings = loadSettings();
  const runtimeSettings =
    options.runtimeSettings ||
    resolveRuntimeSettingsForEntry(gameEntry, settings, moduleInfo, runtimeId);
  const enableProtections =
    runtimeSettings && typeof runtimeSettings === "object"
      ? runtimeSettings.enableProtections === false
        ? false
        : runtimeSettings.disableProtections === true
          ? false
          : true
      : true;
  const rootDir = gameEntry.gamePath;
  const server = await createStaticServer(rootDir);
  const relativeIndex = path.relative(rootDir, gameEntry.indexHtml).replaceAll(path.sep, "/");
  const origin = `http://127.0.0.1:${server.port}`;
  const url = `${origin}/${relativeIndex}`;

  const netSession = session.fromPartition(
    stablePartitionId(gameEntry.gamePath, enableProtections ? "protected" : "unrestricted"),
    {
      cache: true
    }
  );

  const cleanupRestriction = enableProtections
    ? applyGameSessionRestrictions(netSession, origin)
    : null;

  const pkg = readGamePackageJson(gameEntry.contentRootDir || gameEntry.gamePath);
  const winCfg = windowConfigFromPackageJson(pkg);

  if (process.platform === "darwin" && !mainWindow) {
    applyGameDockIdentity(gameEntry);
  }

  const moduleSettings = resolveModuleSettings(settings, moduleId);
  const runtimeSupport = resolveRuntimeSupportForEntry(mod, moduleInfo, gameEntry, moduleSettings);
  const fallbackRuntimeId =
    hostedInfo?.fallback && runtimeSupport.includes(hostedInfo.fallback)
      ? hostedInfo.fallback
      : null;
  const shouldInjectSaveDir =
    runtimeId === "electron" && (moduleId === "mv" || moduleId === "mz");
  const rawSaveDir = gameEntry.saveDirOverride || gameEntry.defaultSaveDir || null;
  const saveDir =
    shouldInjectSaveDir && typeof rawSaveDir === "string" && rawSaveDir ? rawSaveDir : null;
  const cheats = normalizeCheatsForModule(moduleId, gameEntry.cheats);
  const cheatsFilePath = cheats ? writeCheatsFile(gameEntry.gamePath, moduleId, cheats) : null;
  const toolsButtonVisible =
    typeof options?.toolsButtonVisible === "boolean"
      ? options.toolsButtonVisible
      : resolveToolsButtonVisible(gameEntry, settings);

  const nwjsVersion = resolvePreferredNwjsVersion(settings, userDataDir);
  const additionalArguments = [
    ...(saveDir ? [`--maclauncher-save-dir=${encodeURIComponent(saveDir)}`] : []),
    `--maclauncher-module=${encodeURIComponent(moduleId)}`,
    `--maclauncher-runtime=${encodeURIComponent(runtimeId || "")}`,
    `--maclauncher-game-dir=${encodeURIComponent(gameEntry.gamePath)}`,
    `--maclauncher-content-root=${encodeURIComponent(gameEntry.contentRootDir || gameEntry.gamePath)}`,
    `--maclauncher-index-html=${encodeURIComponent(gameEntry.indexHtml)}`,
    `--maclauncher-tools-button=${toolsButtonVisible ? "1" : "0"}`,
    enableProtections ? "--maclauncher-unrestricted=0" : "--maclauncher-unrestricted=1"
  ];
  if (nwjsVersion) {
    additionalArguments.push(`--maclauncher-nwjs-version=${encodeURIComponent(nwjsVersion)}`);
  }
  if (cheats && cheatsFilePath) {
    additionalArguments.push(
      `--maclauncher-cheats=${encodeURIComponent(JSON.stringify(cheats))}`,
      `--maclauncher-cheats-file=${encodeURIComponent(cheatsFilePath)}`
    );
  }

  const win = new BrowserWindow({
    width: winCfg.width || 1100,
    height: winCfg.height || 700,
    useContentSize: true,
    title: winCfg.title || gameEntry.name,
    backgroundColor: "#000000",
    webPreferences: {
      session: netSession,
      preload: path.resolve(__dirname, "../modules/shared/web/preload/game.js"),
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
      devTools: true,
      additionalArguments
    }
  });
  win.__maclauncherWindowType = "game";

  attachWebContentsLogging(win.webContents, `game:${gameEntry.name}`);
  attachDevToolsShortcut(win);
  attachDevToolsAutoOpen(win, "game");

  if (!isSmoke) {
    let fallbackOffered = false;
    const offerFallback = async (title, detail) => {
      if (fallbackOffered) return;
      fallbackOffered = true;
      try {
        const buttons = fallbackRuntimeId
          ? ["Close", `Launch with ${resolveRuntimeLabel(fallbackRuntimeId, moduleInfo)}`]
          : ["Close"];
        const res = await dialog.showMessageBox(win, {
          type: "error",
          buttons,
          defaultId: fallbackRuntimeId ? 1 : 0,
          cancelId: 0,
          message: title,
          detail: String(detail || "")
        });
        if (fallbackRuntimeId && res.response === 1 && mod?.launchRuntime) {
          const launchContext = buildModuleLaunchContext(gameEntry, settings, {
            toolsButtonVisible,
            cheatsFilePath,
            runtimeId: fallbackRuntimeId
          });
          const child = await mod.launchRuntime(fallbackRuntimeId, gameEntry, launchContext);
          if (child) registerProcessRun(gameEntry.gamePath, child, fallbackRuntimeId);
        }
      } catch (e) {
        logger.error("[fallback] failed", String(e?.message || e));
      } finally {
        try {
          win.close();
        } catch {}
      }
    };

    win.webContents.on("render-process-gone", (_event, details) => {
      const reason = String(details?.reason || "");
      if (!reason || reason === "clean-exit") return;
      offerFallback(
        "Game process exited unexpectedly.",
        `Reason: ${reason}${details?.exitCode != null ? ` · exit ${details.exitCode}` : ""}`
      );
    });

    win.webContents.on("did-fail-load", (_event, code, desc, validatedUrl, isMainFrame) => {
      if (!isMainFrame) return;
      offerFallback(
        "Failed to load the game.",
        `${code} · ${desc}\n${validatedUrl || ""}`.trim()
      );
    });
  }

  try {
    const ua = win.webContents.getUserAgent?.() || "";
    const rawSuffix =
      typeof hostedInfo?.userAgent?.suffix === "string" ? hostedInfo.userAgent.suffix.trim() : "";
    const suffix = resolveUserAgentSuffix(rawSuffix, { settings, userDataDir, nwjsVersion });
    const hint =
      typeof hostedInfo?.userAgent?.hint === "string" ? hostedInfo.userAgent.hint.trim() : "";
    if (suffix) {
      const shouldAppend = hint ? !ua.includes(hint) : !ua.includes(suffix);
      if (shouldAppend) win.webContents.setUserAgent(`${ua} ${suffix}`.trim());
    }
  } catch {}

  const webContentsId = win.webContents.id;
  gamePoliciesByWebContentsId.set(webContentsId, {
    allowExternal: !enableProtections,
    enableProtections
  });

  win.on("closed", () => {
    gamePoliciesByWebContentsId.delete(webContentsId);
    try {
      cleanupRestriction?.();
    } catch {}
    server.close().catch(() => {});
  });

  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  if (isDebug) openDevToolsForWindow(win, "debug");

  await win.loadURL(url);

  return { win, server, saveDir, origin };
}

async function launchHostedRuntimeChild(gameEntry, runtimeId) {
  const cmd = process.execPath;
  const args = [];
  if (!app.isPackaged) args.push(app.getAppPath());
  args.push(`--maclauncher-game=${gameEntry.gamePath}`);
  args.push("--maclauncher-game-child");

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  const runtimeTag = runtimeId ? ` ${runtimeId}` : "";
  logger.info(`[hosted] launch${runtimeTag} ${cmd} ${args.join(" ")}`);
  return spawnDetachedChecked(cmd, args, { env });
}

function spawnDetachedProcess(cmd, args, options = {}, needsRosetta = false) {
  const { stdio, ...rest } = options || {};
  const resolvedStdio = stdio || "ignore";
  if (needsRosetta) {
    const child = spawn("arch", ["-x86_64", cmd, ...args], {
      ...rest,
      stdio: resolvedStdio,
      detached: true
    });
    child.unref();
    return child;
  }
  const child = spawn(cmd, args, { ...rest, stdio: resolvedStdio, detached: true });
  child.unref();
  return child;
}

async function spawnDetachedChecked(cmd, args, options = {}, needsRosetta = false) {
  const child = spawnDetachedProcess(cmd, args, options, needsRosetta);
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  return child;
}

function canLaunchNatively(gameEntry) {
  if (process.platform !== "darwin") return false;
  const mod = Modules.getModule(resolveModuleId(gameEntry));
  return Boolean(resolveModuleNativeLaunchPath(gameEntry, mod));
}

async function launchGameNatively(gameEntry) {
  if (!canLaunchNatively(gameEntry)) {
    throw new Error("Native runtime is only available for .app bundles on macOS");
  }
  const mod = Modules.getModule(resolveModuleId(gameEntry));
  const appPath = resolveModuleNativeLaunchPath(gameEntry, mod);
  if (!appPath) throw new Error("Native app bundle not found.");
  const executablePath = resolveAppBundleExecutablePath(appPath);
  if (!executablePath) throw new Error("Native app executable not found.");
  logger.info(`[native] launch ${executablePath}`);
  return spawnDetachedChecked(executablePath, [], { cwd: path.dirname(executablePath) });
}

async function runGameEntry(gameEntry, runtimeId, options = {}) {
  const settings = loadSettings();
  const moduleId = resolveModuleId(gameEntry);
  const mod = Modules.getModule(moduleId);
  const moduleInfo = Modules.getModuleInfo(moduleId);
  const hostedInfo = resolveHostedRuntimeInfo(moduleInfo);
  const hostedRuntimeId = hostedInfo?.id || null;
  const toolsButtonVisible =
    typeof options?.toolsButtonVisible === "boolean"
      ? options.toolsButtonVisible
      : resolveToolsButtonVisible(gameEntry, settings);
  const cheatsFilePath = getModuleCheats(moduleId)
    ? writeCheatsFile(gameEntry.gamePath, moduleId, gameEntry.cheats)
    : null;

  if (hostedRuntimeId && runtimeId === hostedRuntimeId) {
    const runtimeName = resolveRuntimeName(runtimeId, moduleInfo);
    if (gameEntry.gameType && gameEntry.gameType !== "web") {
      throw new Error(`${runtimeName} is not supported for ${moduleInfo.label}.`);
    }
    if (!gameEntry.indexHtml) {
      throw new Error(`Missing index.html; ${runtimeName} requires a web game.`);
    }
    const child = await launchHostedRuntimeChild(gameEntry, runtimeId);
    registerProcessRun(gameEntry.gamePath, child, runtimeId);
    return true;
  }

  if (runtimeId === "native") {
    const child = await launchGameNatively(gameEntry);
    registerProcessRun(gameEntry.gamePath, child, runtimeId);
    return true;
  }

  if (mod?.launchRuntime) {
    const launchContext = buildModuleLaunchContext(gameEntry, settings, {
      toolsButtonVisible,
      cheatsFilePath,
      runtimeId
    });
    const child = await mod.launchRuntime(runtimeId, gameEntry, launchContext);
    if (child) {
      registerProcessRun(gameEntry.gamePath, child, runtimeId);
      return true;
    }
  }

  if (!hostedRuntimeId) {
    throw new Error(`Runtime ${resolveRuntimeLabel(runtimeId, moduleInfo)} is not supported.`);
  }

  const { win } = await createGameWindow(gameEntry, {
    toolsButtonVisible,
    runtimeId: hostedRuntimeId
  });
  registerGameWindowRun(gameEntry.gamePath, win, hostedRuntimeId);
  return true;
}

async function runGameByPath(gamePath, options = {}) {
  const settings = loadSettings();
  const entry = (settings.recents || []).find(r => r.gamePath === gamePath);
  if (!entry) throw new Error("Game not found in recents");

  const detected = Modules.detectGame(resolveDetectPath(entry));
  const merged = mergeDetectedEntry(entry, detected);

  const normalized = normalizeRecentEntry(merged, settings);
  const nextSettings = upsertRecent(settings, normalized);
  saveSettings(nextSettings);
  cachedState = buildState(nextSettings);
  broadcastState();

  const moduleId = resolveModuleId(normalized);
  const mod = Modules.getModule(moduleId);
  const moduleInfo = Modules.getModuleInfo(moduleId);
  const moduleSettings = resolveModuleSettings(settings, moduleId);
  const runtimeId = resolveRuntimeForEntry(
    options.runtimeOverride ?? normalized.runtimeId,
    mod,
    moduleInfo,
    normalized,
    moduleSettings,
    settings
  );
  const toolsButtonVisible = resolveToolsButtonVisible(normalized, settings);
  return runGameEntry(normalized, runtimeId, { toolsButtonVisible });
}

function buildState(settings) {
  return {
    recents: (settings.recents || []).map(entry => decorateRecentEntry(entry, settings)),
    modules: Modules.listModules(),
    moduleSettings: settings.modules || {},
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

function sendLauncherMenuEvent(action) {
  const win = BrowserWindow.getFocusedWindow();
  if (!isLauncherWindow(win)) return;
  try {
    win.webContents.send(`launcher:${action}`);
  } catch {}
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
    { role: "reload" },
    { role: "forceReload" },
    ...(devtoolsEnabled ? [{ role: "toggleDevTools" }] : []),
    { type: "separator" },
    { role: "resetZoom" },
    { role: "zoomIn" },
    { role: "zoomOut" },
    { type: "separator" },
    { role: "togglefullscreen" }
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
        { type: "separator" },
        {
          label: "Settings...",
          accelerator: "CmdOrCtrl+,",
          click: () => sendLauncherMenuEvent("openSettings")
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
      submenu: process.platform === "darwin" ? [{ role: "close" }] : [{ role: "quit" }]
    },
    { label: "Edit", submenu: editSubmenu },
    { label: "View", submenu: viewSubmenu },
    { label: "Tools", submenu: toolsSubmenu },
    { label: "Window", submenu: windowSubmenu }
  );

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function upsertRecent(settings, nextEntry) {
  const recents = Array.isArray(settings.recents) ? settings.recents.slice() : [];
  const existingIndex = recents.findIndex(r => r.gamePath === nextEntry.gamePath);
  const existing = existingIndex >= 0 ? recents[existingIndex] : null;
  const merged = existing ? { ...existing, ...nextEntry } : nextEntry;
  const moduleId = resolveModuleId(merged);
  const mod = Modules.getModule(moduleId);
  const mergedEntry = typeof mod?.mergeEntry === "function" ? mod.mergeEntry(existing, merged, settings) : merged;
  if (!existing && typeof mod?.onImport === "function") {
    try {
      const result = mod.onImport(mergedEntry, {
        userDataDir: app.getPath("userData"),
        settings,
        logger
      });
      if (result && typeof result.then === "function") {
        result.catch(err => {
          logger.warn("[import] onImport failed", String(err?.message || err));
        });
      }
    } catch (e) {
      logger.warn("[import] onImport failed", String(e?.message || e));
    }
  }
  const normalized = normalizeRecentEntry(mergedEntry, settings);
  if (existingIndex >= 0) recents.splice(existingIndex, 1);
  recents.unshift(normalized);
  return { ...settings, recents: recents.slice(0, 25) };
}

function removeRecent(settings, gamePath) {
  const recents = Array.isArray(settings.recents) ? settings.recents.slice() : [];
  const next = recents.filter(r => r.gamePath !== gamePath);
  return { ...settings, recents: next };
}

function moveRecent(settings, gamePath, delta) {
  const recents = Array.isArray(settings.recents) ? settings.recents.slice() : [];
  const idx = recents.findIndex(r => r.gamePath === gamePath);
  if (idx < 0) throw new Error("Game not found in recents");

  const nextIdx = idx + delta;
  if (nextIdx < 0 || nextIdx >= recents.length) return settings;

  const [item] = recents.splice(idx, 1);
  recents.splice(nextIdx, 0, item);
  return { ...settings, recents };
}

function reorderRecent(settings, gamePath, toIndex) {
  const recents = Array.isArray(settings.recents) ? settings.recents.slice() : [];
  const fromIndex = recents.findIndex(r => r.gamePath === gamePath);
  if (fromIndex < 0) throw new Error("Game not found in recents");

  const [item] = recents.splice(fromIndex, 1);
  const maxIndex = recents.length;
  const idx = Number.isFinite(toIndex) ? Math.max(0, Math.min(maxIndex, toIndex)) : 0;
  recents.splice(idx, 0, item);
  return { ...settings, recents };
}

async function init() {
  logger.info("MacLauncher starting");
  setupAppMenu();

  const settings = loadSettingsHydrated({ persist: !isChildGame });
  if (!isChildGame) {
    cachedState = buildState(settings);
    syncCheatsFiles(settings);
    ensureIconsForRecents(settings).catch(e => {
      logger.warn("[icons] refresh failed", String(e?.message || e));
    });
  }

  const directGame = getArgValue("--maclauncher-game=");
  if (directGame) {
    const resolvedDirect = path.resolve(app.getAppPath(), directGame);
    const detected = Modules.detectGame(resolvedDirect);
    detected.importPath = resolvedDirect;
    if (!isChildGame) {
      await ensureIconForEntry(detected);
    }
    const moduleId = resolveModuleId(detected);
    const mod = Modules.getModule(moduleId);

    if (isSmoke) {
      const smokeSaveDir = path.join(
        os.tmpdir(),
        "maclauncher-smoke",
        stablePartitionId(detected.gamePath).replace("persist:", ""),
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

    const existing = (settings.recents || []).find(r => r.gamePath === detected.gamePath);
    const merged = mergeDetectedEntry(existing, detected);
    const normalized = normalizeRecentEntry(merged, settings);

    if (!isChildGame) {
      const nextSettings = upsertRecent(settings, normalized);
      saveSettings(nextSettings);
      cachedState = buildState(nextSettings);
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

  mainWindow = await createLauncherWindow();

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

ipcMain.handle("launcher:getState", () => getLauncherState());

ipcMain.handle("launcher:openGameDialog", async () => {
  const supportedModules = Modules.listSupportedModules();
  const supportedSuffix = supportedModules.length
    ? ` (Supported modules: ${supportedModules.join(", ")})`
    : "";
  const result = await dialog.showOpenDialog({
    title: `Select a game folder or app bundle${supportedSuffix}`,
    properties: ["openFile", "openDirectory", "multiSelections"],
    filters: [
      { name: "Games", extensions: ["app", "exe", "sh", "py"] },
      { name: "All Files", extensions: ["*"] }
    ]
  });
  return result.canceled ? [] : result.filePaths;
});

ipcMain.handle("launcher:addRecent", async (_event, inputPath) => {
  const resolved = path.resolve(inputPath);
  const detected = Modules.detectGame(resolved);
  detected.importPath = resolved;

  const settings = loadSettings();
  await ensureIconForEntry(detected);
  const nextSettings = upsertRecent(settings, detected);
  saveSettings(nextSettings);
  cachedState = buildState(nextSettings);
  broadcastState();
  return detected;
});

ipcMain.handle("launcher:forgetGame", async (_event, gamePath) => {
  const settings = loadSettings();
  const entry = (settings.recents || []).find(r => r.gamePath === gamePath);
  if (entry) {
    cleanupGameUserData(entry, settings);
  }
  const nextSettings = removeRecent(settings, gamePath);
  saveSettings(nextSettings);
  cachedState = buildState(nextSettings);
  broadcastState();
  return true;
});

ipcMain.handle("launcher:moveGame", async (_event, gamePath, delta) => {
  const settings = loadSettings();
  const nextSettings = moveRecent(settings, gamePath, Number(delta) || 0);
  saveSettings(nextSettings);
  cachedState = buildState(nextSettings);
  broadcastState();
  return true;
});

ipcMain.handle("launcher:reorderGame", async (_event, gamePath, toIndex) => {
  const settings = loadSettings();
  const idx = Number(toIndex);
  const nextSettings = reorderRecent(settings, gamePath, Number.isFinite(idx) ? idx : 0);
  saveSettings(nextSettings);
  cachedState = buildState(nextSettings);
  broadcastState();
  return true;
});

ipcMain.handle("launcher:deleteGame", async (event, gamePath) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!gamePath) throw new Error("Missing game path");

  const confirm = await dialog.showMessageBox(win, {
    type: "warning",
    buttons: ["Cancel", "Move to Trash"],
    defaultId: 0,
    cancelId: 0,
    message: "Move this game to the Trash?",
    detail: gamePath
  });
  if (confirm.response !== 1) return false;

  try {
    await shell.trashItem(gamePath);
  } catch (e) {
    throw new Error(`Failed to move to Trash: ${String(e?.message || e)}`);
  }

  const settings = loadSettings();
  const entry = (settings.recents || []).find(r => r.gamePath === gamePath);
  if (entry) {
    cleanupGameUserData(entry, settings);
  }
  const nextSettings = removeRecent(settings, gamePath);
  saveSettings(nextSettings);
  cachedState = buildState(nextSettings);
  broadcastState();
  return true;
});

ipcMain.handle("launcher:launchGame", async (_event, gamePath) => {
  return runGameByPath(gamePath);
});

ipcMain.handle("launcher:launchGameWithRuntime", async (_event, gamePath, runtimeOverride) => {
  return runGameByPath(gamePath, { runtimeOverride });
});

ipcMain.handle("launcher:createGameCommand", async (event, gamePath) => {
  if (!gamePath) throw new Error("Missing game path");
  const settings = loadSettings();
  const entry = (settings.recents || []).find(r => r.gamePath === gamePath);
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
  const entry = (settings.recents || []).find(r => r.gamePath === gamePath);
  if (!entry) throw new Error("Game not found in recents");

  const detected = Modules.detectGame(resolveDetectPath(entry));
  const merged = { ...entry, ...detected };
  const moduleId = resolveModuleId(merged);
  const mod = Modules.getModule(moduleId);
  const moduleInfo = Modules.getModuleInfo(moduleId);
  const moduleSettings = resolveModuleSettings(settings, moduleId);
  const normalized = normalizeRecentEntry(merged, settings);
  const resolvedRuntime = resolveRuntimeForEntry(
    runtimeId,
    mod,
    moduleInfo,
    normalized,
    moduleSettings,
    settings
  );

  entry.runtimeId = resolvedRuntime;
  if ("runtime" in entry) delete entry.runtime;

  saveSettings(settings);
  cachedState = buildState(settings);
  broadcastState();
  return true;
});

ipcMain.handle("launcher:setGameRuntimeSettings", async (_event, gamePath, runtimeId, payload) => {
  if (!runtimeId) throw new Error("Missing runtime id");
  const settings = loadSettings();
  const entry = (settings.recents || []).find(r => r.gamePath === gamePath);
  if (!entry) throw new Error("Game not found in recents");
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
  saveSettings(settings);
  cachedState = buildState(settings);
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
      const entry = (settings.recents || []).find(r => r.gamePath === gamePath);
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
  cachedState = buildState(settings);
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
  if (typeof next.defaultRuntime === "string" && typeof mod.normalizeRuntimeId === "function") {
    next.defaultRuntime = mod.normalizeRuntimeId(next.defaultRuntime);
  }
  if (!settings.modules || typeof settings.modules !== "object") settings.modules = {};
  settings.modules[moduleId] = next;
  saveSettings(settings);
  cachedState = buildState(settings);
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
  if (typeof next.defaultRuntime === "string" && typeof mod.normalizeRuntimeId === "function") {
    next.defaultRuntime = mod.normalizeRuntimeId(next.defaultRuntime);
  }
  if (!settings.modules || typeof settings.modules !== "object") settings.modules = {};
  settings.modules[moduleId] = next;
  saveSettings(settings);
  cachedState = buildState(settings);
  broadcastState();
  return true;
});

ipcMain.handle("launcher:setGameModuleData", async (_event, gamePath, patch) => {
  const settings = loadSettings();
  const entry = (settings.recents || []).find(r => r.gamePath === gamePath);
  if (!entry) throw new Error("Game not found in recents");

  updateEntryModuleData(entry, patch || {});

  const moduleId = resolveModuleId(entry);
  const needsRepatch =
    patch && Object.prototype.hasOwnProperty.call(patch, "toolsButtonVisibleOverride");
  const patcher = needsRepatch ? getCheatsPatcherIfSupported(moduleId) : null;
  if (patcher) {
    const detected = Modules.detectGame(resolveDetectPath(entry));
    const status = patcher.getPatchStatus(detected);
    if (status?.patched) {
      const toolsButtonVisible = resolveToolsButtonVisible(entry, settings);
      try {
        patcher.unpatchGame(detected);
        patcher.patchGame(detected, {
          appVersion: app.getVersion?.() || null,
          toolsButtonVisible
        });
      } catch (e) {
        throw new Error(`Failed to repatch tools visibility: ${String(e?.message || e)}`);
      }
    }
  }

  saveSettings(settings);
  cachedState = buildState(settings);
  broadcastState();
  return true;
});

ipcMain.handle("launcher:setGameRuntimeData", async (_event, gamePath, runtimeId, patch) => {
  if (!runtimeId) throw new Error("Missing runtime id");
  const settings = loadSettings();
  const entry = (settings.recents || []).find(r => r.gamePath === gamePath);
  if (!entry) throw new Error("Game not found in recents");
  updateEntryRuntimeData(entry, runtimeId, patch);
  saveSettings(settings);
  cachedState = buildState(settings);
  broadcastState();
  return true;
});

ipcMain.handle("launcher:runtimeAction", async (_event, managerId, action, payload) => {
  const manager = getRuntimeManager(managerId);
  if (!manager) throw new Error("Runtime manager not found");

  const settings = loadSettings();
  if (!settings.runtimes || typeof settings.runtimes !== "object") settings.runtimes = {};
  const userDataDir = app.getPath("userData");
  const data = payload && typeof payload === "object" ? payload : {};
  let result = null;

  if (action === "refreshCatalog") {
    if (typeof manager.refreshCatalog !== "function") throw new Error("Runtime manager cannot refresh");
    result = await manager.refreshCatalog({ logger, force: true, ...data });
  } else if (action === "install") {
    if (typeof manager.installRuntime !== "function") throw new Error("Runtime manager cannot install");
    result = await manager.installRuntime({
      userDataDir,
      logger,
      ...data,
      onProgress: () => {
        cachedState = buildState(loadSettings());
        broadcastState();
      }
    });
    if (typeof manager.updateSettingsAfterInstall === "function") {
      const next = manager.updateSettingsAfterInstall(settings.runtimes[managerId], result, data);
      if (next) settings.runtimes[managerId] = next;
      saveSettings(settings);
    }
  } else if (action === "uninstall") {
    if (typeof manager.uninstallRuntime !== "function") throw new Error("Runtime manager cannot uninstall");
    result = await manager.uninstallRuntime({ userDataDir, ...data });
    if (typeof manager.updateSettingsAfterUninstall === "function") {
      const next = manager.updateSettingsAfterUninstall(settings.runtimes[managerId], data, { userDataDir });
      if (next) settings.runtimes[managerId] = next;
      saveSettings(settings);
    }
  } else if (action === "setDefault") {
    if (typeof manager.applySettingsUpdate !== "function") throw new Error("Runtime manager cannot update settings");
    const next = manager.applySettingsUpdate("setDefault", data, settings.runtimes[managerId]);
    settings.runtimes[managerId] = next;
    saveSettings(settings);
  } else {
    throw new Error("Unsupported runtime action");
  }

  cachedState = buildState(loadSettings());
  broadcastState();
  return result ?? true;
});

ipcMain.handle("launcher:moduleAction", async (_event, gamePath, action, payload) => {
  const settings = loadSettings();
  const entry = (settings.recents || []).find(r => r.gamePath === gamePath);
  if (!entry) throw new Error("Game not found in recents");

  const moduleId = resolveModuleId(entry);
  const mod = Modules.getModule(moduleId);
  const handler = mod?.actions?.[action];
  if (typeof handler !== "function") throw new Error("Module action not supported");

  const context = {
    settings,
    userDataDir: app.getPath("userData"),
    logger,
    app,
    fs,
    path,
    onRuntimeStateChange: () => {
      cachedState = buildState(loadSettings());
      broadcastState();
    },
    spawnDetachedChecked
  };

  const result = await handler(entry, payload, context);
  saveSettings(settings);
  cachedState = buildState(settings);
  broadcastState();
  return result ?? true;
});

ipcMain.handle("launcher:setCheats", async (_event, gamePath, cheats) => {
  const settings = loadSettings();
  const entry = (settings.recents || []).find(r => r.gamePath === gamePath);
  if (!entry) throw new Error("Game not found in recents");

  const moduleId = resolveModuleId(entry);
  if (!getModuleCheats(moduleId)) return true;
  const normalized = normalizeCheatsForModule(moduleId, cheats);
  if (!normalized) return true;
  entry.cheats = normalized;
  saveSettings(settings);
  cachedState = buildState(settings);
  broadcastState();
  return true;
});

ipcMain.handle("launcher:getCheatsPatchStatus", async (_event, gamePath) => {
  const settings = loadSettings();
  const entry = (settings.recents || []).find(r => r.gamePath === gamePath) || null;
  if (entry) {
    const moduleId = resolveModuleId(entry);
    const patcher = getCheatsPatcherIfSupported(moduleId);
    if (!patcher) return null;
    const detected = Modules.detectGame(resolveDetectPath(entry));
    return patcher.getPatchStatus(detected);
  }
  if (!gamePath) return null;
  let detected = null;
  try {
    detected = Modules.detectGame(gamePath);
  } catch {
    return null;
  }
  const moduleId = resolveModuleId(detected);
  const patcher = getCheatsPatcherIfSupported(moduleId);
  if (!patcher) return null;
  return patcher.getPatchStatus(detected);
});

ipcMain.handle("launcher:patchCheatsIntoGame", async (_event, gamePath) => {
  const settings = loadSettings();
  const entry = (settings.recents || []).find(r => r.gamePath === gamePath);
  if (!entry) throw new Error("Game not found in recents");

  const detected = Modules.detectGame(resolveDetectPath(entry));
  const moduleId = resolveModuleId(detected);
  const patcher = getCheatsPatcherIfSupported(moduleId);
  if (!patcher) return null;
  const toolsButtonVisible = resolveToolsButtonVisible(entry, settings);
  return patcher.patchGame(detected, {
    appVersion: app.getVersion?.() || null,
    toolsButtonVisible
  });
});

ipcMain.handle("launcher:unpatchCheatsFromGame", async (_event, gamePath) => {
  const settings = loadSettings();
  const entry = (settings.recents || []).find(r => r.gamePath === gamePath);
  if (!entry) throw new Error("Game not found in recents");

  const detected = Modules.detectGame(resolveDetectPath(entry));
  const moduleId = resolveModuleId(detected);
  const patcher = getCheatsPatcherIfSupported(moduleId);
  if (!patcher) return null;
  return patcher.unpatchGame(detected);
});

ipcMain.handle("launcher:setGameLibVersion", async (_event, gamePath, depId, versionId) => {
  const settings = loadSettings();
  const entry = (settings.recents || []).find(r => r.gamePath === gamePath);
  if (!entry) throw new Error("Game not found in recents");

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
  saveSettings(settings);
  cachedState = buildState(settings);
  broadcastState();
  return true;
});

ipcMain.handle("launcher:getLibsPatchStatus", async (_event, gamePath) => {
  const settings = loadSettings();
  const entry = (settings.recents || []).find(r => r.gamePath === gamePath) || {};
  const detected = Modules.detectGame(gamePath);
  const moduleId = resolveModuleId(detected);
  const mod = Modules.getModule(moduleId);
  if (!mod?.libs?.patcher) throw new Error("Library patching is not supported for this module.");
  const selections = resolveModuleLibSelections(entry, mod);
  return mod.libs.patcher.getPatchStatus(detected, selections);
});

ipcMain.handle("launcher:patchLibs", async (_event, gamePath) => {
  const settings = loadSettings();
  const entry = (settings.recents || []).find(r => r.gamePath === gamePath) || {};
  const detected = Modules.detectGame(gamePath);
  const moduleId = resolveModuleId(detected);
  const mod = Modules.getModule(moduleId);
  if (!mod?.libs?.patcher) throw new Error("Library patching is not supported for this module.");
  const selections = resolveModuleLibSelections(entry, mod);
  return mod.libs.patcher.patchGame(detected, {
    selections,
    appVersion: app.getVersion?.() || null
  });
});

ipcMain.handle("launcher:unpatchLibs", async (_event, gamePath) => {
  const detected = Modules.detectGame(gamePath);
  const moduleId = resolveModuleId(detected);
  const mod = Modules.getModule(moduleId);
  if (!mod?.libs?.patcher) throw new Error("Library patching is not supported for this module.");
  return mod.libs.patcher.unpatchGame(detected);
});

ipcMain.handle("launcher:pickSaveDir", async (_event, gamePath) => {
  const settings = loadSettings();
  const entry = (settings.recents || []).find(r => r.gamePath === gamePath);
  if (!entry) throw new Error("Game not found in recents");

  const detected = Modules.detectGame(resolveDetectPath(entry));
  const defaultDir = detected.defaultSaveDir;

  const result = await dialog.showOpenDialog({
    title: defaultDir
      ? `Select save directory. Default is ${defaultDir}`
      : "Select save directory.",
    properties: ["openDirectory", "createDirectory"]
  });
  if (result.canceled || result.filePaths.length === 0) return null;

  const nextDir = result.filePaths[0];
  entry.saveDirOverride = nextDir;

  saveSettings(settings);
  cachedState = buildState(settings);
  broadcastState();
  return nextDir;
});

ipcMain.handle("launcher:resetSaveDir", async (_event, gamePath) => {
  const settings = loadSettings();
  const entry = (settings.recents || []).find(r => r.gamePath === gamePath);
  if (!entry) throw new Error("Game not found in recents");

  entry.saveDirOverride = null;
  saveSettings(settings);
  cachedState = buildState(settings);
  broadcastState();
  return true;
});

ipcMain.handle("launcher:getSaveInfo", async (_event, gamePath) => {
  const { detected, saveDir } = resolveSaveContext(gamePath);
  ensureDir(saveDir);
  const moduleId = resolveModuleId(detected);
  const moduleInfo = Modules.getModuleInfo(moduleId);
  return {
    saveDir,
    moduleId,
    moduleLabel: moduleInfo.label,
    moduleShortLabel: moduleInfo.shortLabel,
    name: detected.name
  };
});

ipcMain.handle("launcher:listSaveFiles", async (_event, gamePath) => {
  const { saveDir } = resolveSaveContext(gamePath);
  return listSaveFiles(saveDir);
});

ipcMain.handle("launcher:importSaveDir", async (event, gamePath) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const { saveDir, detected } = resolveSaveContext(gamePath);

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

  ensureDir(saveDir);
  copyDirContents(srcDir, saveDir);
  return true;
});

ipcMain.handle("launcher:exportSaveDir", async (event, gamePath) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const { saveDir, detected } = resolveSaveContext(gamePath);

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

  ensureDir(outDir);
  if (fs.existsSync(saveDir)) {
    fs.cpSync(saveDir, outDir, { recursive: true, force: true });
  }

  return outDir;
});

ipcMain.handle("launcher:importSaveFiles", async (event, gamePath) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const { saveDir, detected } = resolveSaveContext(gamePath);
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

  ensureDir(saveDir);
  for (const src of result.filePaths) {
    const dest = safeJoinSavePath(saveDir, path.basename(src));
    fs.copyFileSync(src, dest);
  }
  return true;
});

ipcMain.handle("launcher:readSaveJson", async (_event, gamePath, fileName) => {
  const { saveDir, detected } = resolveSaveContext(gamePath);
  const moduleId = resolveModuleId(detected);
  assertSaveEditingSupported(moduleId);
  const mod = Modules.getModule(moduleId);
  if (!mod?.save?.decode) throw new Error("Save decoding is not available for this module.");
  const filePath = safeJoinSavePath(saveDir, fileName);
  const raw = fs.readFileSync(filePath, "utf8");
  const json = mod.save.decode(raw);
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
});

ipcMain.handle("launcher:writeSaveJson", async (_event, gamePath, fileName, nextJson) => {
  const { saveDir, detected } = resolveSaveContext(gamePath);
  const moduleId = resolveModuleId(detected);
  assertSaveEditingSupported(moduleId);
  const mod = Modules.getModule(moduleId);
  if (!mod?.save?.encode) throw new Error("Save encoding is not available for this module.");
  const filePath = safeJoinSavePath(saveDir, fileName);

  let minified = String(nextJson || "");
  try {
    minified = JSON.stringify(JSON.parse(minified));
  } catch (e) {
    throw new Error(`Invalid JSON: ${String(e?.message || e)}`);
  }

  const encoded = mod.save.encode(minified);
  ensureDir(saveDir);

  try {
    if (fs.existsSync(filePath)) {
      fs.copyFileSync(filePath, `${filePath}.maclauncher.bak`);
    }
  } catch {}

  fs.writeFileSync(filePath, encoded, "utf8");
  return true;
});

ipcMain.handle(
  "launcher:openSaveJsonInExternalEditor",
  async (_event, gamePath, fileName, jsonText) => {
    const { saveDir, detected } = resolveSaveContext(gamePath);
    const moduleId = resolveModuleId(detected);
    assertSaveEditingSupported(moduleId);
    const savePath = safeJoinSavePath(saveDir, fileName);
    const externalPath = `${savePath}.maclauncher.json`;
    assertInsideDir(saveDir, externalPath);

    if (!fs.existsSync(externalPath)) {
      fs.writeFileSync(externalPath, String(jsonText ?? ""), "utf8");
    }
    const err = await shell.openPath(externalPath);
    if (err) throw new Error(err);
    return externalPath;
  }
);

ipcMain.handle("launcher:readExternalSaveJson", async (_event, gamePath, fileName) => {
  const { saveDir, detected } = resolveSaveContext(gamePath);
  const moduleId = resolveModuleId(detected);
  assertSaveEditingSupported(moduleId);
  const savePath = safeJoinSavePath(saveDir, fileName);
  const externalPath = `${savePath}.maclauncher.json`;
  assertInsideDir(saveDir, externalPath);

  if (!fs.existsSync(externalPath)) {
    throw new Error('External JSON not found. Click "Open in editor" first.');
  }
  return fs.readFileSync(externalPath, "utf8");
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
