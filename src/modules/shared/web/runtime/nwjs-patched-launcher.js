const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const GameData = require("../../game-data");
const NwjsManager = require("./nwjs-manager");
const Greenworks = require("./greenworks-runtime");

const WEB_CHEATS_ROOT = path.resolve(__dirname, "..", "cheats");
const MVMZ_CHEATS_ROOT = path.resolve(__dirname, "..", "..", "mvmz", "cheats");
const CHEATS_SCHEMA_PATH = path.join(MVMZ_CHEATS_ROOT, "schema.json");
const CHEATS_JS_PATH = path.join(MVMZ_CHEATS_ROOT, "cheats.js");
const CHEATS_RUNTIME_PATH = path.join(MVMZ_CHEATS_ROOT, "runtime.js");
const CHEATS_INJECT_PATH = path.join(WEB_CHEATS_ROOT, "nwjs-inject.js");
function isDevtoolsEnabled() {
  return process.env.MACLAUNCHER_DEVTOOLS === "1" || process.env.MACLAUNCHER_DEBUG === "1";
}

const PATCHED_ASSETS_ROOT = path.resolve(__dirname, "patched");
const PATCHED_KAWARIKI_ROOT = path.join(PATCHED_ASSETS_ROOT, "kawariki");
const PATCHED_CASE_INSENSITIVE = path.join(PATCHED_ASSETS_ROOT, "case-insensitive-nw.js");
const PATCHED_LOADER = path.join(PATCHED_ASSETS_ROOT, "loader.js");

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}


function appendChromiumArgs(existing, additions) {
  const base = typeof existing === "string" ? existing.trim() : "";
  let next = base;
  const extra = Array.isArray(additions) ? additions : [];
  for (const arg of extra) {
    if (typeof arg !== "string") continue;
    const value = arg.trim();
    if (!value) continue;
    if (next.includes(value)) continue;
    next = next ? `${next} ${value}` : value;
  }
  return next;
}

function stripDisableDevtoolsFlag(value) {
  if (typeof value !== "string") return value;
  const cleaned = value.replace(/(^|\s)--disable-devtools(=\S+)?(?=\s|$)/g, " ").trim();
  return cleaned.replace(/\s{2,}/g, " ");
}

function normalizeInjectList(input) {
  const list = Array.isArray(input) ? input : typeof input === "string" ? [input] : [];
  return list.map(item => String(item || "").trim()).filter(item => item);
}

function dedupeList(list) {
  const out = [];
  const seen = new Set();
  for (const item of list) {
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function normalizeExtraFiles(extraFiles) {
  if (!Array.isArray(extraFiles)) return [];
  const out = [];
  for (const item of extraFiles) {
    if (!item || typeof item !== "object") continue;
    const rawPath = typeof item.path === "string" ? item.path.trim() : "";
    if (!rawPath) continue;
    const normalized = path.normalize(rawPath).replace(/^([\\/])+/, "");
    if (!normalized || normalized.startsWith("..")) continue;
    const contents = typeof item.contents === "string" ? item.contents : null;
    if (contents == null) continue;
    out.push({ path: normalized, contents });
  }
  return out;
}

const DEVTOOLS_HELPER = `// maclauncher:devtools-keybinding
(() => {
  try {
    if (window.__maclauncherDevToolsInstalled) return;
    window.__maclauncherDevToolsInstalled = true;
  } catch {}

  const getWindow = () => {
    try {
      if (typeof nw !== "undefined" && nw.Window && typeof nw.Window.get === "function") {
        return nw.Window.get();
      }
    } catch {}
    return null;
  };

  const toggleDevTools = () => {
    try {
      const win = getWindow();
      if (!win) return;
      if (typeof win.isDevToolsOpen === "function" && win.isDevToolsOpen()) {
        if (typeof win.closeDevTools === "function") {
          win.closeDevTools();
          return;
        }
      }
      if (typeof win.showDevTools === "function") {
        win.showDevTools();
      }
    } catch {}
  };

  try {
    window.__maclauncherOpenDevTools = toggleDevTools;
    window.__maclauncherToggleDevTools = toggleDevTools;
  } catch {}

  const ensureMenuItem = () => {
    try {
      const win = getWindow();
      if (!win || !win.menu || !Array.isArray(win.menu.items)) return false;
      const viewMenu = win.menu.items.find(item => {
        const label = String((item && item.label) || "").toLowerCase();
        return label === "view";
      });
      if (!viewMenu || !viewMenu.submenu || !Array.isArray(viewMenu.submenu.items)) return false;
      const hasItem = viewMenu.submenu.items.some(item => {
        const label = String((item && item.label) || "").toLowerCase();
        return label.includes("developer tools");
      });
      if (hasItem) return true;
      if (typeof nw !== "undefined" && typeof nw.MenuItem === "function") {
        viewMenu.submenu.append(
          new nw.MenuItem({
            label: "Toggle Developer Tools",
            click: () => toggleDevTools()
          })
        );
        return true;
      }
    } catch {}
    return false;
  };

  const scheduleMenuCheck = () => {
    let tries = 0;
    const tick = () => {
      if (ensureMenuItem()) return;
      tries += 1;
      if (tries < 6) setTimeout(tick, 500);
    };
    tick();
  };

  let isMac = false;
  try {
    isMac = /mac/i.test(String(navigator.platform || ""));
  } catch {}
  scheduleMenuCheck();

  window.addEventListener(
    "keydown",
    event => {
      const key = String(event.key || "").toLowerCase();
      const code = String(event.code || "").toLowerCase();
      const isKeyI = key === "i" || code === "keyi";
      const wantsDevTools =
        key === "f12" ||
        code === "f12" ||
        (isMac && event.metaKey && (event.altKey || event.shiftKey) && isKeyI) ||
        (!isMac && event.ctrlKey && event.shiftKey && isKeyI);
      if (!wantsDevTools) return;
      try {
        event.preventDefault();
        if (typeof event.stopImmediatePropagation === "function") {
          event.stopImmediatePropagation();
        }
        event.stopPropagation();
      } catch {}
      toggleDevTools();
    },
    true
  );
})();
`;

function resolveWrapperRoot(userDataDir, gameId) {
  if (!userDataDir || !gameId) return null;
  return path.join(GameData.resolveGameRuntimeDir(userDataDir, gameId, "nwjs-patched"), "wrappers");
}

function resolveProfileRoot(userDataDir, gameId) {
  if (!userDataDir || !gameId) return null;
  return path.join(GameData.resolveGameRuntimeDir(userDataDir, gameId, "nwjs-patched"), "profiles");
}

function readPackageJson(contentRootDir) {
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

function findIndexHtml(contentRootDir) {
  const pkg = readPackageJson(contentRootDir);
  if (pkg && typeof pkg.main === "string") {
    const candidate = path.resolve(contentRootDir, pkg.main);
    if (candidate.toLowerCase().endsWith(".html") && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  const rootIndex = path.join(contentRootDir, "index.html");
  const wwwIndex = path.join(contentRootDir, "www", "index.html");
  if (fs.existsSync(rootIndex)) return rootIndex;
  if (fs.existsSync(wwwIndex)) return wwwIndex;
  return null;
}

function spawnDetachedProcess(cmd, args, options = {}, needsRosetta = false) {
  if (needsRosetta) {
    const child = spawn("arch", ["-x86_64", cmd, ...args], {
      ...options,
      stdio: "ignore",
      detached: true
    });
    child.unref();
    return child;
  }
  const child = spawn(cmd, args, { ...options, stdio: "ignore", detached: true });
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

function resolveRuntimeConfig({ managerSettings, runtimeData, greenworksVersion } = {}) {
  const cfg = NwjsManager.normalizeSettings(managerSettings);
  const data = runtimeData && typeof runtimeData === "object" ? runtimeData : {};
  let version =
    typeof data.version === "string" && data.version.trim()
      ? data.version.trim().replace(/^v/i, "")
      : cfg.defaultVersion;

  if (greenworksVersion) {
    version = greenworksVersion;
  }

  return {
    version: version || cfg.defaultVersion,
    variant: "sdk",
    greenworksVersion: greenworksVersion || null
  };
}

async function ensureRuntimeInstalled({
  userDataDir,
  version,
  variant,
  logger,
  onState,
  allowInstall = false
}) {
  const resolved = NwjsManager.core.resolveBestInstalled({
    userDataDir,
    version,
    variant,
    platform: process.platform,
    arch: process.arch
  });
  if (resolved) return resolved;
  if (!allowInstall) {
    const suffix = version ? ` v${version}` : "";
    throw new Error(`NW.js runtime${suffix} is not installed. Install it from Runtimes.`);
  }

  onState?.();

  const installed = await NwjsManager.installRuntime({
    userDataDir,
    version,
    variant,
    logger,
    onProgress: () => onState?.()
  });

  onState?.();
  return installed;
}

function ensureGreenworksInstalled({ userDataDir, version }) {
  if (!version) throw new Error("Greenworks requires a NW.js version.");
  const installed = Greenworks.listInstalled(userDataDir);
  const match = installed.find(item => item.version === version);
  if (match) return match;
  throw new Error(`Greenworks for NW.js v${version} is not installed. Install it from Runtimes.`);
}

function copyFile(src, dest) {
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

function copyDir(src, dest) {
  ensureDir(dest);
  fs.cpSync(src, dest, { recursive: true, force: true });
}

function ensureMaterializedPath(wrapperDir, sourceRoot, relDir) {
  const parts = relDir.split(path.sep).filter(Boolean);
  let currentWrapper = wrapperDir;
  let currentSource = sourceRoot;

  for (const part of parts) {
    const wrapperPath = path.join(currentWrapper, part);
    const sourcePath = path.join(currentSource, part);
    let isSymlink = false;

    try {
      isSymlink = fs.lstatSync(wrapperPath).isSymbolicLink();
    } catch {
      isSymlink = false;
    }

    if (isSymlink) {
      try {
        fs.unlinkSync(wrapperPath);
      } catch {}
    }

    if (!fs.existsSync(wrapperPath)) {
      fs.mkdirSync(wrapperPath, { recursive: true });
      if (fs.existsSync(sourcePath)) {
        let entries = [];
        try {
          entries = fs.readdirSync(sourcePath, { withFileTypes: true });
        } catch {
          entries = [];
        }
        for (const entry of entries) {
          const src = path.join(sourcePath, entry.name);
          const dest = path.join(wrapperPath, entry.name);
          if (fs.existsSync(dest)) continue;
          try {
            fs.symlinkSync(src, dest);
          } catch {}
        }
      }
    }

    currentWrapper = wrapperPath;
    currentSource = sourcePath;
  }

  return currentWrapper;
}

function findGreenworksTargets(rootDir) {
  if (!rootDir || typeof rootDir !== "string") return [];
  const targets = [];
  const queue = [rootDir];
  const seen = new Set();

  while (queue.length) {
    const current = queue.shift();
    if (!current || seen.has(current)) continue;
    seen.add(current);

    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.name || entry.name.startsWith(".")) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(full);
        continue;
      }
      if (entry.isFile()) {
        const name = entry.name.toLowerCase();
        if (name === "greenworks.js" || name === "greenworks.node") {
          targets.push(path.dirname(full));
        }
      }
    }
  }

  return targets;
}

function resolveGreenworksVersion({ userDataDir, managerSettings }) {
  const cfg = NwjsManager.normalizeSettings(managerSettings);
  if (cfg.greenworksDefaultVersion) return cfg.greenworksDefaultVersion;
  const installed = Greenworks.listInstalled(userDataDir);
  return installed[0]?.version || null;
}

function resolveGreenworksRequirement({ userDataDir, managerSettings, sourceRoot }) {
  const targets = findGreenworksTargets(sourceRoot);
  if (targets.length === 0) {
    return { needsGreenworks: false, greenworksVersion: null, targets: [] };
  }
  const greenworksVersion = resolveGreenworksVersion({ userDataDir, managerSettings });
  return { needsGreenworks: true, greenworksVersion, targets };
}

function overlayGreenworks({ wrapperDir, sourceRoot, greenworksDir, targets }) {
  if (!greenworksDir) return;
  const resolvedTargets =
    Array.isArray(targets) && targets.length > 0 ? targets : findGreenworksTargets(sourceRoot);
  if (resolvedTargets.length === 0) return;

  for (const target of resolvedTargets) {
    const rel = path.relative(sourceRoot, target);
    const overlayRoot = rel && rel !== "." ? ensureMaterializedPath(wrapperDir, sourceRoot, rel) : wrapperDir;
    copyDir(greenworksDir, overlayRoot);
  }
}

function buildWrapper({
  entry,
  moduleId,
  userDataDir,
  supportsCheats,
  toolsButtonVisible,
  runtimeSettings,
  patchConfig,
  contentRootOverride,
  indexHtmlOverride,
  chromiumArgs,
  injectStart,
  extraFiles
}) {
  const gamePath = entry?.gamePath;
  const contentRootDir = contentRootOverride || entry?.contentRootDir || gamePath;
  const indexHtml = indexHtmlOverride || entry?.indexHtml || findIndexHtml(contentRootDir);

  if (!gamePath || !contentRootDir || !indexHtml) {
    throw new Error("Missing game data required for the patched NW.js wrapper.");
  }
  if (entry?.gameType && entry.gameType !== "web") {
    throw new Error("Patched NW.js runtime only supports web games.");
  }

  const gameId = entry?.gameId;
  if (!gameId) {
    throw new Error("Missing gameId required for the patched NW.js wrapper.");
  }
  const wrappersRoot = resolveWrapperRoot(userDataDir, gameId);
  if (!wrappersRoot) {
    throw new Error("Missing wrapper root.");
  }
  ensureDir(wrappersRoot);

  const id = String(gameId);
  let wrapperDir = path.join(wrappersRoot, id);

  const metaPath = path.join(wrapperDir, ".maclauncher-wrapper.json");
  const expectedSource = contentRootDir;
  try {
    if (fs.existsSync(metaPath)) {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      if (meta?.source && meta.source !== expectedSource) {
        wrapperDir = path.join(wrappersRoot, `${id}-${Date.now()}`);
      }
    }
  } catch {}

  ensureDir(wrapperDir);

  const original = readPackageJson(contentRootDir) || {};
  const relativeMain = path.relative(contentRootDir, indexHtml).replaceAll(path.sep, "/");

  const wrapperManifest = { ...original };
  wrapperManifest.main = relativeMain;
  if (typeof wrapperManifest.name !== "string" || !wrapperManifest.name.trim()) {
    wrapperManifest.name = `maclauncher-${id}`;
  }

  const protectionsEnabled =
    runtimeSettings && typeof runtimeSettings === "object"
      ? runtimeSettings.enableProtections !== false
      : true;
  const caseInsensitive = runtimeSettings?.caseInsensitive === true;
  const needsBgScript = protectionsEnabled || caseInsensitive;

  wrapperManifest.maclauncher = {
    ...(wrapperManifest.maclauncher && typeof wrapperManifest.maclauncher === "object"
      ? wrapperManifest.maclauncher
      : {}),
    gamePath,
    moduleId,
    patchedConfigPath: "__maclauncher/nwjs-patched/patch.json",
    caseInsensitive: caseInsensitive === true,
    offlineEnabled: protectionsEnabled,
    ...(supportsCheats && entry?.gamePath
      ? {
          cheatsFilePath: entry?.cheatsFilePath || null,
          toolsButtonVisible: toolsButtonVisible !== false
        }
      : {})
  };

  const existingInject = normalizeInjectList(wrapperManifest.inject_js_start);
  const requestedInject = normalizeInjectList(injectStart);
  const mergedInject = dedupeList([...requestedInject, ...existingInject]);
  wrapperManifest.maclauncher.injectStart = mergedInject;
  wrapperManifest.inject_js_start = "maclauncher-start.js";

  const existingInjectEnd = normalizeInjectList(wrapperManifest.inject_js_end);
  if (existingInjectEnd.length > 0) {
    wrapperManifest.maclauncher.injectEnd = existingInjectEnd;
    wrapperManifest.inject_js_end = "maclauncher-end.js";
  } else {
    delete wrapperManifest.inject_js_end;
  }

  if (needsBgScript) {
    wrapperManifest["bg-script"] = "bg.js";
  } else {
    delete wrapperManifest["bg-script"];
  }

  const devtoolsEnabled = isDevtoolsEnabled();
  let chromiumArgsValue = wrapperManifest["chromium-args"];
  if (protectionsEnabled) {
    chromiumArgsValue = appendChromiumArgs(chromiumArgsValue, [
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-client-side-phishing-detection",
      "--disable-default-apps",
      "--disable-domain-reliability",
      "--disable-sync",
      "--disable-translate",
      "--dns-prefetch-disable",
      "--no-pings",
      "--proxy-server=127.0.0.1:9",
      "--proxy-bypass-list=<-loopback>",
      "--safebrowsing-disable-auto-update",
      "--safebrowsing-disable-download-protection"
    ]);
  }
  if (Array.isArray(chromiumArgs) && chromiumArgs.length > 0) {
    chromiumArgsValue = appendChromiumArgs(chromiumArgsValue, chromiumArgs);
  }
  chromiumArgsValue = stripDisableDevtoolsFlag(chromiumArgsValue);
  if (chromiumArgsValue) {
    wrapperManifest["chromium-args"] = chromiumArgsValue;
  } else {
    delete wrapperManifest["chromium-args"];
  }

  const extraFileList = normalizeExtraFiles(extraFiles);
  const symlinkBlocklist = new Set([
    "package.json",
    "bg.js",
    "disable-child.js",
    "disable-net.js",
    "__maclauncher",
    "maclauncher-inject.js",
    "maclauncher-start.js",
    "maclauncher-end.js",
    "maclauncher-offline.js",
    ".maclauncher-wrapper.json"
  ]);
  for (const extra of extraFileList) {
    const top = extra.path.split(/[\\/]/)[0];
    if (top) symlinkBlocklist.add(top);
  }

  const entries = fs.readdirSync(contentRootDir, { withFileTypes: true });
  for (const item of entries) {
    if (!item.name) continue;
    if (symlinkBlocklist.has(item.name)) continue;
    const src = path.join(contentRootDir, item.name);
    const dest = path.join(wrapperDir, item.name);
    if (fs.existsSync(dest)) continue;
    try {
      fs.symlinkSync(src, dest);
    } catch {}
  }

  fs.writeFileSync(metaPath, JSON.stringify({ source: expectedSource }, null, 2), "utf8");
  fs.writeFileSync(path.join(wrapperDir, "package.json"), JSON.stringify(wrapperManifest, null, 2), "utf8");

  const maclauncherRoot = path.join(wrapperDir, "__maclauncher");
  ensureDir(maclauncherRoot);

  if (extraFileList.length > 0) {
    for (const extra of extraFileList) {
      const dest = path.join(wrapperDir, extra.path);
      ensureDir(path.dirname(dest));
      fs.writeFileSync(dest, extra.contents, "utf8");
    }
  }

  if (supportsCheats && entry?.cheatsFilePath) {
    fs.writeFileSync(path.join(maclauncherRoot, "schema.json"), fs.readFileSync(CHEATS_SCHEMA_PATH, "utf8"), "utf8");
    fs.writeFileSync(path.join(maclauncherRoot, "cheats.js"), fs.readFileSync(CHEATS_JS_PATH, "utf8"), "utf8");
    fs.writeFileSync(path.join(maclauncherRoot, "runtime.js"), fs.readFileSync(CHEATS_RUNTIME_PATH, "utf8"), "utf8");

    const injectSrc = fs.readFileSync(CHEATS_INJECT_PATH, "utf8");
    fs.writeFileSync(path.join(wrapperDir, "maclauncher-inject.js"), injectSrc, "utf8");
    fs.writeFileSync(path.join(maclauncherRoot, "inject.js"), injectSrc, "utf8");
  }

  const patchedRoot = path.join(maclauncherRoot, "nwjs-patched");
  ensureDir(patchedRoot);
  copyFile(PATCHED_CASE_INSENSITIVE, path.join(patchedRoot, "case-insensitive-nw.js"));
  copyFile(PATCHED_LOADER, path.join(patchedRoot, "loader.js"));
  if (moduleId === "mv" || moduleId === "mz") {
    copyDir(PATCHED_KAWARIKI_ROOT, path.join(patchedRoot, "kawariki"));
  }

  const patchPayload = {
    runtimeRoot: "__maclauncher/nwjs-patched",
    modules: Array.isArray(patchConfig?.modules) ? patchConfig.modules : [],
    scripts: Array.isArray(patchConfig?.scripts) ? patchConfig.scripts : [],
    enableUserScripts: runtimeSettings?.enableUserScripts === true,
    userScriptRoot: patchConfig?.userScriptRoot || null
  };
  fs.writeFileSync(path.join(patchedRoot, "patch.json"), JSON.stringify(patchPayload, null, 2), "utf8");

  fs.writeFileSync(
    path.join(wrapperDir, "disable-child.js"),
    `// maclauncher:disable-child.js\nconst Module=require("module");\nconst orig=Module.prototype.require;\nfunction block(msg){try{if(typeof window!==\"undefined\")alert(msg);}catch{};console.error(msg);throw new Error(msg)}\nModule.prototype.require=function(id){if(id===\"child_process\"||id===\"node:child_process\")block(\"Blocked: child_process\");return orig.apply(this,arguments)};\ntry{const cp=orig.call({},\"node:child_process\");for(const k of [\"exec\",\"execFile\",\"spawn\",\"fork\",\"spawnSync\",\"execSync\",\"execFileSync\"]){if(k in cp)cp[k]=function(){block(\"Blocked: child_process.\"+k)}}}catch{}\n`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(wrapperDir, "disable-net.js"),
    `// maclauncher:disable-net.js\nconst Module=require("module");const orig=Module.prototype.require;\nconst ALLOW=new Set([\"127.0.0.1\",\"::1\",\"localhost\"]);\nfunction ok(h){try{return h&&ALLOW.has(String(h).toLowerCase())}catch{return false}}\nfunction block(reason){try{if(typeof window!==\"undefined\")alert(\"Network blocked: \"+reason);}catch{};console.error(\"Network blocked: \"+reason);const e=new Error(\"Outbound network disabled: \"+reason);e.code=\"ERR_NET_BLOCKED\";throw e}\nModule.prototype.require=function(id){const m=orig.apply(this,arguments);\nif(id===\"http\"||id===\"https\"){const wrap=fn=>function(options){const o=typeof options===\"string\"?new URL(options):options instanceof URL?options:options||{};const host=o.hostname||o.host||(o.headers&&o.headers.Host);if(!ok(host))block(id.toUpperCase()+\" to \"+host);return fn.apply(this,arguments)};m.request=wrap(m.request);if(m.get)m.get=function(){const r=m.request.apply(this,arguments);r.end();return r}}\nif(id===\"net\"||id===\"tls\"){const wrap=fn=>function(){const args=[...arguments];const o=typeof args[0]===\"object\"?args[0]:{};const host=o.host||o.hostname||args[0];if(!ok(host))block(id.toUpperCase()+\" connect to \"+host);return fn.apply(this,arguments)};m.connect=wrap(m.connect);if(m.createConnection)m.createConnection=wrap(m.createConnection)}\nif(id===\"dns\"){const wrap=fn=>function(hostname){if(!ok(hostname))block(\"DNS lookup for \"+hostname);return fn.apply(this,arguments)};for(const k of [\"lookup\",\"resolve\",\"resolve4\",\"resolve6\",\"resolveAny\",\"resolveCname\",\"resolveTxt\",\"resolveSrv\",\"resolveNs\",\"resolveMx\",\"reverse\"])if(typeof m[k]===\"function\")m[k]=wrap(m[k])}\nreturn m};\n`,
    "utf8"
  );

  if (needsBgScript) {
    fs.writeFileSync(
      path.join(wrapperDir, "bg.js"),
      `// maclauncher:bg.js\n(() => {\n  const safeRequire = request => { try { return require(request); } catch { return null; } };\n  const manifest = (() => { try { return typeof nw !== \"undefined\" && nw?.App?.manifest ? nw.App.manifest : null; } catch { return null; } })();\n  const maclauncher = manifest && typeof manifest.maclauncher === \"object\" ? manifest.maclauncher : {};\n  if (maclauncher.caseInsensitive) {\n    if (maclauncher.caseInsensitive) process.env.KAWARIKI_NWJS_CIFS = \"1\";\n    safeRequire(\"./__maclauncher/nwjs-patched/case-insensitive-nw.js\");\n  }\n  if (maclauncher.offlineEnabled !== false) {\n    safeRequire(\"./disable-child\");\n    safeRequire(\"./disable-net\");\n  }\n})();\n`,
      "utf8"
    );
  }

  fs.writeFileSync(
    path.join(wrapperDir, "maclauncher-offline.js"),
    `// maclauncher:offline.js\n(() => {\n  try {\n    if (window.__maclauncher_offlineInstalled) return;\n    window.__maclauncher_offlineInstalled = true;\n  } catch {}\n\n  const allowHosts = new Set([\"127.0.0.1\", \"::1\", \"localhost\"]);\n\n  const resolveUrl = input => {\n    try {\n      if (input instanceof URL) return input;\n      if (input && typeof input === \"object\" && \"url\" in input) return new URL(String(input.url), window.location.href);\n      return new URL(String(input), window.location.href);\n    } catch {\n      return null;\n    }\n  };\n\n  const isBlocked = input => {\n    const url = resolveUrl(input);\n    if (!url) return false;\n    const proto = String(url.protocol || \"\").toLowerCase();\n    if (proto !== \"http:\" && proto !== \"https:\" && proto !== \"ws:\" && proto !== \"wss:\") return false;\n    const host = String(url.hostname || \"\").toLowerCase();\n    return host && !allowHosts.has(host);\n  };\n\n  const block = reason => {\n    try { console.error(\"[MacLauncher] Network blocked:\", reason); } catch {}\n    const err = new Error(\"Outbound network disabled: \" + reason);\n    err.code = \"ERR_NET_BLOCKED\";\n    throw err;\n  };\n\n  try {\n    const origFetch = window.fetch;\n    if (typeof origFetch === \"function\") {\n      window.fetch = function(resource, init) {\n        if (isBlocked(resource)) block(\"fetch \" + String(resource));\n        return origFetch.call(this, resource, init);\n      };\n    }\n  } catch {}\n\n  try {\n    const XHR = window.XMLHttpRequest;\n    if (XHR && XHR.prototype && typeof XHR.prototype.open === \"function\") {\n      const origOpen = XHR.prototype.open;\n      XHR.prototype.open = function(method, url) {\n        if (isBlocked(url)) block(\"xhr \" + String(url));\n        return origOpen.apply(this, arguments);\n      };\n    }\n  } catch {}\n\n  try {\n    const OrigWS = window.WebSocket;\n    if (typeof OrigWS === \"function\") {\n      const WrappedWS = function(url, protocols) {\n        if (isBlocked(url)) block(\"websocket \" + String(url));\n        return new OrigWS(url, protocols);\n      };\n      WrappedWS.prototype = OrigWS.prototype;\n      window.WebSocket = WrappedWS;\n    }\n  } catch {}\n\n  try {\n    const OrigES = window.EventSource;\n    if (typeof OrigES === \"function\") {\n      const WrappedES = function(url, config) {\n        if (isBlocked(url)) block(\"eventsource \" + String(url));\n        return new OrigES(url, config);\n      };\n      WrappedES.prototype = OrigES.prototype;\n      window.EventSource = WrappedES;\n    }\n  } catch {}\n\n  try {\n    if (navigator && typeof navigator.sendBeacon === \"function\") {\n      const origBeacon = navigator.sendBeacon.bind(navigator);\n      navigator.sendBeacon = function(url, data) {\n        if (isBlocked(url)) block(\"beacon \" + String(url));\n        return origBeacon(url, data);\n      };\n    }\n  } catch {}\n\n  const wrapUrlSetter = (proto, prop, label) => {\n    try {\n      const desc = Object.getOwnPropertyDescriptor(proto, prop);\n      if (!desc || typeof desc.set !== \"function\") return;\n      Object.defineProperty(proto, prop, {\n        configurable: true,\n        enumerable: desc.enumerable,\n        get: desc.get,\n        set(value) {\n          if (isBlocked(value)) block(label + \" \" + String(value));\n          return desc.set.call(this, value);\n        }\n      });\n    } catch {}\n  };\n\n  try {\n    if (window.HTMLImageElement) wrapUrlSetter(HTMLImageElement.prototype, \"src\", \"img\");\n    if (window.HTMLScriptElement) wrapUrlSetter(HTMLScriptElement.prototype, \"src\", \"script\");\n    if (window.HTMLLinkElement) wrapUrlSetter(HTMLLinkElement.prototype, \"href\", \"link\");\n    if (window.HTMLIFrameElement) wrapUrlSetter(HTMLIFrameElement.prototype, \"src\", \"iframe\");\n    if (window.HTMLMediaElement) wrapUrlSetter(HTMLMediaElement.prototype, \"src\", \"media\");\n    if (window.HTMLSourceElement) wrapUrlSetter(HTMLSourceElement.prototype, \"src\", \"source\");\n  } catch {}\n\n  try {\n    const origOpen = window.open;\n    if (typeof origOpen === \"function\") {\n      window.open = function(url, target, features) {\n        if (isBlocked(url)) block(\"open \" + String(url));\n        return origOpen.call(this, url, target, features);\n      };\n    }\n  } catch {}\n})();\n`,
    "utf8"
  );

  const devtoolsHelperSource = devtoolsEnabled ? DEVTOOLS_HELPER : "";
  fs.writeFileSync(
    path.join(wrapperDir, "maclauncher-start.js"),
    `// maclauncher:start.js\n${devtoolsHelperSource}\n(() => {\n  const safeRequire = request => {\n    try { return require(request); } catch { return null; }\n  };\n\n  const manifest = (() => {\n    try { return typeof nw !== \"undefined\" && nw?.App?.manifest ? nw.App.manifest : null; } catch { return null; }\n  })();\n\n  const maclauncher = manifest && typeof manifest.maclauncher === \"object\" ? manifest.maclauncher : {};\n  const injectStart = Array.isArray(maclauncher.injectStart) ? maclauncher.injectStart : [];\n  const offlineEnabled = maclauncher.offlineEnabled !== false;\n\n  if (offlineEnabled) {\n    safeRequire(\"./maclauncher-offline.js\");\n  }\n\n  if (maclauncher.caseInsensitive) {\n    process.env.KAWARIKI_NWJS_CIFS = \"1\";\n    safeRequire(\"./__maclauncher/nwjs-patched/case-insensitive-nw.js\");\n  }\n\n  safeRequire(\"./__maclauncher/nwjs-patched/loader.js\");\n\n  for (const entry of injectStart) {\n    if (!entry || typeof entry !== \"string\") continue;\n    const trimmed = entry.trim();\n    if (!trimmed) continue;\n    try {\n      if (trimmed.startsWith(\".\") || trimmed.startsWith(\"/\")) {\n        safeRequire(trimmed);\n      } else if (typeof nw !== \"undefined\" && nw?.App?.startPath) {\n        const p = safeRequire(\"path\");\n        if (p) safeRequire(p.join(nw.App.startPath, trimmed));\n      } else {\n        safeRequire(trimmed);\n      }\n    } catch {}\n  }\n\n  if (maclauncher.cheatsFilePath) {\n    safeRequire(\"./maclauncher-inject.js\");\n  }\n})();\n`,
    "utf8"
  );

  if (existingInjectEnd.length > 0) {
    fs.writeFileSync(
      path.join(wrapperDir, "maclauncher-end.js"),
      `// maclauncher:end.js\n(() => {\n  const safeRequire = request => {\n    try { return require(request); } catch { return null; }\n  };\n\n  const manifest = (() => {\n    try { return typeof nw !== \"undefined\" && nw?.App?.manifest ? nw.App.manifest : null; } catch { return null; }\n  })();\n\n  const maclauncher = manifest && typeof manifest.maclauncher === \"object\" ? manifest.maclauncher : {};\n  const injectEnd = Array.isArray(maclauncher.injectEnd) ? maclauncher.injectEnd : [];\n\n  for (const entry of injectEnd) {\n    if (!entry || typeof entry !== \"string\") continue;\n    const trimmed = entry.trim();\n    if (!trimmed) continue;\n    try {\n      if (trimmed.startsWith(\".\") || trimmed.startsWith(\"/\")) {\n        safeRequire(trimmed);\n      } else if (typeof nw !== \"undefined\" && nw?.App?.startPath) {\n        const p = safeRequire(\"path\");\n        if (p) safeRequire(p.join(nw.App.startPath, trimmed));\n      } else {\n        safeRequire(trimmed);\n      }\n    } catch {}\n  }\n})();\n`,
      "utf8"
    );
  }

  return wrapperDir;
}

async function launchRuntime({
  entry,
  moduleId,
  userDataDir,
  settings,
  toolsButtonVisible,
  runtimeSettings,
  cheatsFilePath,
  supportsCheats,
  patchConfig,
  contentRootOverride,
  indexHtmlOverride,
  chromiumArgs,
  injectStart,
  extraFiles,
  logger,
  onRuntimeStateChange
}) {
  const runtimeData =
    entry?.runtimeData?.["nwjs-patched"] ||
    {};
  const managerSettings = settings?.runtimes?.nwjs || {};
  const sourceRoot =
    typeof contentRootOverride === "string" && contentRootOverride
      ? contentRootOverride
      : entry?.contentRootDir || entry?.gamePath || "";
  const greenworks = resolveGreenworksRequirement({
    userDataDir,
    managerSettings,
    sourceRoot
  });
  if (greenworks.needsGreenworks && !greenworks.greenworksVersion) {
    throw new Error(
      "Greenworks is required but no Greenworks runtime is installed. Install it from Runtimes."
    );
  }
  const { version, variant, greenworksVersion } = resolveRuntimeConfig({
    managerSettings,
    runtimeData,
    greenworksVersion: greenworks.greenworksVersion
  });

  const installed = await ensureRuntimeInstalled({
    userDataDir,
    version,
    variant,
    logger,
    onState: onRuntimeStateChange,
    allowInstall: false
  });

  const greenworksInstall = greenworks.needsGreenworks
    ? ensureGreenworksInstalled({ userDataDir, version: greenworksVersion || version })
    : null;

  const wrapperDir = buildWrapper({
    entry: {
      ...entry,
      cheatsFilePath
    },
    moduleId,
    userDataDir,
    supportsCheats,
    toolsButtonVisible,
    runtimeSettings,
    patchConfig,
    contentRootOverride,
    indexHtmlOverride,
    chromiumArgs,
    injectStart,
    extraFiles
  });

  if (greenworksInstall?.installDir) {
    overlayGreenworks({
      wrapperDir,
      sourceRoot,
      greenworksDir: greenworksInstall.installDir,
      targets: greenworks.targets
    });
  }

  const profileRoot = resolveProfileRoot(userDataDir, entry?.gameId);
  if (!profileRoot) {
    throw new Error("Missing profile root.");
  }
  const profileDir = path.join(
    profileRoot,
    `${installed.version}-${installed.platformKey}-${installed.variant}`
  );
  ensureDir(profileDir);

  const args = [`--user-data-dir=${profileDir}`, wrapperDir];
  const cmd = installed.executablePath;

  logger?.info?.(`[nwjs-patched] launch ${cmd} ${args.join(" ")}`);

  const needsRosetta = process.arch === "arm64" && installed.platformKey === "osx-x64";
  return spawnDetachedChecked(cmd, args, { cwd: wrapperDir }, needsRosetta);
}

module.exports = {
  buildWrapper,
  launchRuntime,
  resolveRuntimeConfig,
  resolveWrapperRoot,
  resolveProfileRoot,
  overlayGreenworks,
  ensureGreenworksInstalled,
  resolveGreenworksRequirement,
  resolveGreenworksVersion,
  findGreenworksTargets
};
