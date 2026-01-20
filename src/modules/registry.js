const fs = require("node:fs");
const path = require("node:path");

const IconUtils = require("../main/icon-utils");
const { UNKNOWN_MODULE } = require("./shared/unknown-module");

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
      const mod = require(mainPath);
      if (mod && mod.id) {
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
const SHARED_SUBMODULES = loadSharedSubmodules();
const SHARED_RUNTIME_MANAGERS = loadSharedRuntimeManagers(SHARED_SUBMODULES);

const moduleIndex = new Map();
const moduleList = [];
const sharedIndex = new Map();

for (const mod of MODULES) {
  if (!mod || !mod.id) continue;
  moduleIndex.set(mod.id, mod);
  moduleList.push(mod);
}

for (const sub of SHARED_SUBMODULES) {
  if (!sub?.id) continue;
  sharedIndex.set(sub.id, sub);
}

function safeStat(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

function findIndexHtml(rootDir) {
  let indexHtml = null;
  const pkgPath = path.join(rootDir, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      if (typeof pkg?.main === "string") {
        const candidate = path.resolve(rootDir, pkg.main);
        if (candidate.toLowerCase().endsWith(".html") && fs.existsSync(candidate)) {
          indexHtml = candidate;
        }
      }
    } catch {}
  }

  const rootIndex = path.join(rootDir, "index.html");
  const wwwIndex = path.join(rootDir, "www", "index.html");
  if (!indexHtml && fs.existsSync(rootIndex)) indexHtml = rootIndex;
  if (!indexHtml && fs.existsSync(wwwIndex)) indexHtml = wwwIndex;
  return indexHtml;
}

function resolveInputPath(inputPath) {
  const stat = safeStat(inputPath);
  if (!stat) throw new Error("Path not found");
  const rootDir = stat.isFile() ? path.dirname(inputPath) : inputPath;
  const isAppBundle = rootDir.toLowerCase().endsWith(".app");
  return { inputPath, rootDir, isAppBundle, stat };
}

function resolveExeFallbackName(gamePath, hintName) {
  if (!gamePath) return null;
  try {
    if (!fs.statSync(gamePath).isDirectory()) return null;
  } catch {
    return null;
  }
  const exePath = IconUtils.findBestExePath(gamePath, hintName);
  if (!exePath) return null;
  return path.basename(exePath, path.extname(exePath));
}

function applyExeNameFallback(detected) {
  if (!detected || typeof detected !== "object") return detected;
  const rawName = typeof detected.name === "string" ? detected.name.trim() : "";
  const gamePath = typeof detected.gamePath === "string" ? detected.gamePath : "";
  const folderName = gamePath ? path.basename(gamePath) : "";
  const shouldFallback = !rawName || (folderName && rawName === folderName);
  if (!shouldFallback) return detected;
  const exeName = resolveExeFallbackName(gamePath, rawName || folderName);
  if (!exeName) return detected;
  return { ...detected, name: exeName };
}

function detectGenericWeb(context) {
  if (context.isAppBundle) return null;
  const rootDir = context.rootDir;
  const indexHtml = findIndexHtml(rootDir);
  if (!indexHtml) return null;
  const indexDir = path.dirname(indexHtml);
  return {
    gameType: "web",
    gamePath: rootDir,
    contentRootDir: rootDir,
    name: path.basename(rootDir),
    engine: "unknown",
    indexDir,
    indexHtml
  };
}

function detectGame(inputPath) {
  const context = resolveInputPath(inputPath);
  for (const mod of MODULES) {
    if (typeof mod.detectGame !== "function") continue;
    const detected = mod.detectGame(context, { findIndexHtml });
    if (detected) return applyExeNameFallback(detected);
  }

  const fallback = detectGenericWeb(context);
  if (fallback) return applyExeNameFallback(fallback);

  if (!context.isAppBundle) {
    throw new Error("Could not find index.html in root or www/");
  }

  const supported = listSupportedModules();
  const supportedText = supported.length ? ` Supported modules: ${supported.join(", ")}.` : "";
  throw new Error(`Unsupported .app bundle.${supportedText}`);
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

function getSharedSubmodule(id) {
  return sharedIndex.get(id) || null;
}

function listSharedRuntimeManagers() {
  return SHARED_RUNTIME_MANAGERS.slice();
}

function listSupportedModules() {
  return moduleList.map(mod => mod.manifest?.label || mod.id);
}

function getModule(id) {
  return moduleIndex.get(id) || null;
}

function getModuleInfo(id) {
  const mod = getModule(id);
  if (mod?.manifest) return mod.manifest;
  if (typeof id === "string" && id && id !== "unknown") {
    return { ...UNKNOWN_MODULE.manifest, id };
  }
  return UNKNOWN_MODULE.manifest;
}

function getModuleDir(id) {
  const mod = getModule(id);
  const dir = mod && mod.__moduleDir;
  return typeof dir === "string" && dir ? dir : null;
}

function listModuleIds() {
  return moduleList.map(mod => mod.id);
}

module.exports = {
  detectGame,
  findIndexHtml,
  getModule,
  getModuleDir,
  getModuleInfo,
  getSharedSubmodule,
  listModuleIds,
  listModules,
  listSharedSubmodules,
  listSharedRuntimeManagers,
  listSupportedModules,
  UNKNOWN_MODULE
};
