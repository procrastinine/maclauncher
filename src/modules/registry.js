const fs = require("node:fs");
const path = require("node:path");

const { applyGameName } = require("../core/game-name");
const { UNKNOWN_MODULE } = require("./shared/unknown-module");
const Detection = require("./detection");
const RuntimeProviders = require("./shared/runtime/providers");
const { withReleaseRoot } = require("./shared/web/release-root");
const { withNetworkSettings } = require("./shared/runtime/network-isolation");
const { withHostSettings } = require("./shared/runtime/host-settings");

const MODULES_DIR = path.resolve(__dirname);
// "shared" is a special namespace for cross-module code (not a module itself).
const SHARED_DIR_NAME = "shared";
const SHARED_DIR = path.join(MODULES_DIR, SHARED_DIR_NAME);

function loadSharedSubmodules() {
  const out = [];
  const seen = new Set();

  function walk(dir, prefix) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!entry.name || entry.name.startsWith(".")) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (seen.has(rel)) continue;
      const full = path.join(dir, entry.name);
      out.push({ id: rel, dir: full });
      seen.add(rel);
      walk(full, rel);
    }
  }

  walk(SHARED_DIR, "");
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

function loadModules() {
  const modules = [];
  let entries = [];
  try {
    entries = fs.readdirSync(MODULES_DIR, { withFileTypes: true });
  } catch {
    entries = [];
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === SHARED_DIR_NAME) continue;
    const dir = path.join(MODULES_DIR, entry.name);
    const manifestPath = path.join(dir, "manifest.json");
    const mainPath = path.join(dir, "main.js");
    if (!fs.existsSync(manifestPath) || !fs.existsSync(mainPath)) continue;
    try {
      const current = require(mainPath);
      if (current && current.id) {
        const mod = { ...current };
        const backcompatPath = path.join(dir, "backcompat", "index.js");
        let backcompat;
        const migrationPart = () => {
          if (backcompat !== undefined) return backcompat;
          try {
            return backcompat = require(backcompatPath);
          } catch (error) {
            if (error.code === "MODULE_NOT_FOUND" && error.message.split("\n")[0] === `Cannot find module '${backcompatPath}'`) return backcompat = null;
            throw error;
          }
        };
        // Parts load only for the once-only runner, never normal import or Play.
        mod.legacyGameMirrors = (entry, context) => migrationPart()?.legacyGameMirrors?.(entry, context) || [];
        mod.migrateLegacyGameData = (entry, context) => migrationPart()?.migrateLegacyGameData?.(entry, context) || null;
        mod.__moduleDir = dir;
        modules.push(mod);
      }
    } catch {
      // Ignore modules that fail to load to keep registry resilient.
    }
  }

  modules.sort((a, b) => {
    const la = String(a?.manifest?.label || a?.id || "");
    const lb = String(b?.manifest?.label || b?.id || "");
    return la.localeCompare(lb);
  });

  return modules;
}

function loadSharedRuntimeManagers(submodules) {
  const managers = [];
  for (const sub of submodules) {
    const runtimeDir = path.join(sub.dir, "runtime");
    let entries = [];
    try {
      entries = fs.readdirSync(runtimeDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name || !entry.name.endsWith(".js")) continue;
      const runtimePath = path.join(runtimeDir, entry.name);
      try {
        const mod = require(runtimePath);
        if (mod && typeof mod === "object" && mod.id) managers.push(mod);
        if (Array.isArray(mod)) {
          for (const item of mod) {
            if (item && typeof item === "object" && item.id) managers.push(item);
          }
        }
      } catch {
        // Keep registry resilient when shared runtime helpers fail to load.
      }
    }
  }
  return managers;
}

const MODULES = loadModules();
const RUNTIME_PROVIDERS = RuntimeProviders.listRuntimeProviders(MODULES);
const SHARED_SUBMODULES = loadSharedSubmodules();
const SHARED_RUNTIME_MANAGERS = loadSharedRuntimeManagers(SHARED_SUBMODULES);

const moduleIndex = new Map();
const moduleList = [];

for (const original of MODULES) {
  const composed = RuntimeProviders.composeRuntimeProviders(original, RUNTIME_PROVIDERS);
  const mod = composed && { ...composed, manifest: withHostSettings(withNetworkSettings(composed.manifest)) };
  if (!mod || !mod.id) continue;
  moduleIndex.set(mod.id, mod);
  moduleList.push(mod);
}

function findIndexHtml(rootDir) {
  try {
    return Detection.createDetectionSession(rootDir).findIndexHtml(rootDir);
  } catch (error) {
    if (error.code === "DETECTION_LIMIT") throw error;
    return null;
  }
}

const providerContext = inputPath => ({ inputPath: typeof inputPath === "string" && inputPath ? path.resolve(inputPath) : null });
// Every detected game gets its release folder, when the layout proves one,
// before providers record their evidence.
const finishDetected = (detected, inputPath) => RuntimeProviders.decorateRuntimeEntry(withReleaseRoot(applyGameName(detected)),
  RUNTIME_PROVIDERS, providerContext(inputPath));

function explainDetection(inputPath, options = {}) {
  const report = Detection.explainDetection(inputPath, MODULES, options);
  if (report.detected) report.detected = finishDetected(report.detected, inputPath);
  return report;
}

async function explainDetectionAsync(inputPath, options = {}) {
  const report = await Detection.explainDetectionAsync(inputPath, MODULES, options);
  if (report.detected) report.detected = finishDetected(report.detected, inputPath);
  return report;
}

function detectGame(inputPath, options = {}) {
  return Detection.resultOrThrow(explainDetection(inputPath, options));
}

async function detectGameAsync(inputPath, options = {}) {
  return Detection.resultOrThrow(await explainDetectionAsync(inputPath, options));
}

function listModules() {
  return moduleList.map(mod => {
    const manifest = mod.manifest && typeof mod.manifest === "object" ? mod.manifest : {};
    const ui = mod.ui || manifest.ui || null;
    return { ...manifest, ui };
  });
}

function listSharedSubmodules() {
  return SHARED_SUBMODULES.map(sub => ({ id: sub.id, dir: sub.dir }));
}

function listSharedRuntimeManagers() {
  return SHARED_RUNTIME_MANAGERS.slice();
}
function listGraphicsComputeHosts(){
  return moduleList.flatMap(module=>(module.graphicsComputeHosts||[]).map(host=>({...host,moduleId:module.id})));
}

// A module directory or shared namespace declares the derived data it owns in
// an optional derived-stores.js, an array of store declarations applied by
// core/storage-maintenance.js. Loaded only when storage upkeep asks.
let derivedStores = null;
function listDerivedStores() {
  if (!derivedStores) {
    derivedStores = [];
    const owners = [...MODULES.map(mod => ({ id: mod.id, dir: mod.__moduleDir })),
      ...SHARED_SUBMODULES.map(sub => ({ id: `${SHARED_DIR_NAME}/${sub.id}`, dir: sub.dir }))];
    for (const owner of owners) {
      const file = path.join(owner.dir, "derived-stores.js");
      if (!fs.existsSync(file)) continue;
      try {
        const declared = require(file);
        for (const store of Array.isArray(declared) ? declared : []) {
          if (store && typeof store.id === "string") derivedStores.push({ ...store, owner: owner.id });
        }
      } catch {
        // A failing declaration only leaves its owner's stores unmaintained.
      }
    }
  }
  return derivedStores.slice();
}

function listSupportedModules() {
  return moduleList.map(mod => mod.manifest?.label || mod.id);
}

function getRuntimeManagerUi(managerId) {
  const copy = ui => ui && typeof ui === "object" ? { ...ui,
    ...(ui.sectionManagement && typeof ui.sectionManagement === "object" ? { sectionManagement: { ...ui.sectionManagement } } : {}) } : null;
  for (const mod of moduleList) {
    const ui = mod.manifest?.runtime?.managerUi?.[managerId];
    if (ui && typeof ui === "object") return copy(ui);
  }
  return copy(SHARED_RUNTIME_MANAGERS.find(manager => manager.id === managerId)?.ui);
}

function listSupportedInputExtensions() {
  const extensions = new Set();
  for (const mod of moduleList) {
    const detection = mod.manifest?.detection || {};
    if (detection.inputKinds?.includes("app")) extensions.add("app");
    if (detection.binaryFormats?.includes("elf")) {
      extensions.add("x86");
      extensions.add("x86_64");
    }
    const declared = [
      ...(detection.fileExtensions || []),
      ...(detection.extensions || []).map(item => item?.extension)
    ];
    for (const extension of declared) {
      if (typeof extension !== "string") continue;
      const normalized = extension.replace(/^\./, "").toLowerCase();
      if (/^[a-z0-9_]+$/.test(normalized)) extensions.add(normalized);
    }
  }
  return [...extensions].sort();
}

function getModule(id) {
  return moduleIndex.get(id) || null;
}

function listRuntimeProviderModules() {
  return moduleList.filter(mod => mod.runtimeProvider || mod.runtimeProviders?.length);
}

function getModuleInfo(id) {
  const mod = getModule(id);
  if (mod?.manifest) return mod.manifest;
  if (typeof id === "string" && id && id !== "unknown") {
    return withNetworkSettings({ ...UNKNOWN_MODULE.manifest, id });
  }
  return withNetworkSettings(UNKNOWN_MODULE.manifest);
}

function getModuleDir(id) {
  const mod = getModule(id);
  const dir = mod && mod.__moduleDir;
  return typeof dir === "string" && dir ? dir : null;
}

function listModuleIds() {
  return moduleList.map(mod => mod.id);
}

require("./shared/runtime/custom-runtime").instrumentManagers([
  ...moduleList.flatMap(mod => mod.runtimeManagers || []), ...SHARED_RUNTIME_MANAGERS
]);

module.exports = {
  detectGame,
  detectGameAsync,
  explainDetection,
  explainDetectionAsync,
  findIndexHtml,
  getModule,
  getModuleDir,
  getModuleInfo,
  getRuntimeManagerUi,
  listDerivedStores,
  listModuleIds,
  listModules,
  listSharedSubmodules,
  listSharedRuntimeManagers,
  listRuntimeProviderModules,
  listGraphicsComputeHosts,
  listSupportedInputExtensions,
  listSupportedModules,
  UNKNOWN_MODULE
};
