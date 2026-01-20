const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const NwjsManager = require("./nwjs-manager");

const WEB_CHEATS_ROOT = path.resolve(__dirname, "..", "cheats");
const MVMZ_CHEATS_ROOT = path.resolve(__dirname, "..", "..", "mvmz", "cheats");
const CHEATS_SCHEMA_PATH = path.join(MVMZ_CHEATS_ROOT, "schema.json");
const CHEATS_JS_PATH = path.join(MVMZ_CHEATS_ROOT, "cheats.js");
const CHEATS_RUNTIME_PATH = path.join(MVMZ_CHEATS_ROOT, "runtime.js");
const CHEATS_INJECT_PATH = path.join(WEB_CHEATS_ROOT, "nwjs-inject.js");
function isDevtoolsEnabled() {
  return process.env.MACLAUNCHER_DEVTOOLS === "1" || process.env.MACLAUNCHER_DEBUG === "1";
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function stableIdForPath(input) {
  return crypto.createHash("sha256").update(String(input || "")).digest("hex").slice(0, 12);
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

function resolveWrapperRoot(userDataDir, moduleId) {
  return path.join(userDataDir, "modules", moduleId, "nwjs", "wrappers");
}

function resolveProfileRoot(userDataDir, moduleId) {
  return path.join(userDataDir, "modules", moduleId, "nwjs", "profiles");
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

function resolveRuntimeConfig(runtimeSettings, runtimeData) {
  const cfg = NwjsManager.normalizeSettings(runtimeSettings);
  const data = runtimeData && typeof runtimeData === "object" ? runtimeData : {};
  const version =
    typeof data.version === "string" && data.version.trim()
      ? data.version.trim().replace(/^v/i, "")
      : cfg.defaultVersion;
  return {
    version: version || cfg.defaultVersion,
    variant: "sdk"
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

function buildWrapper({
  entry,
  moduleId,
  userDataDir,
  cheatsFilePath,
  supportsCheats,
  toolsButtonVisible,
  enableProtections,
  chromiumArgs,
  injectStart,
  extraFiles
}) {
  const gamePath = entry?.gamePath;
  const contentRootDir = entry?.contentRootDir || gamePath;
  const indexHtml = entry?.indexHtml;
  if (!gamePath || !contentRootDir || !indexHtml) {
    throw new Error("Missing game data required for the NW.js wrapper.");
  }
  if (entry.gameType && entry.gameType !== "web") {
    throw new Error("NW.js runtime only supports web games.");
  }

  const wrappersRoot = resolveWrapperRoot(userDataDir, moduleId);
  ensureDir(wrappersRoot);

  const id = stableIdForPath(gamePath);
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

  wrapperManifest.maclauncher = {
    ...(wrapperManifest.maclauncher && typeof wrapperManifest.maclauncher === "object"
      ? wrapperManifest.maclauncher
      : {}),
    gamePath,
    moduleId,
    ...(supportsCheats && cheatsFilePath
      ? { cheatsFilePath, toolsButtonVisible: toolsButtonVisible !== false }
      : {})
  };

  const protectionsEnabled = enableProtections !== false;
  const devtoolsEnabled = isDevtoolsEnabled();
  const devtoolsHelperSource = devtoolsEnabled ? DEVTOOLS_HELPER : "";
  const existingInject = normalizeInjectList(wrapperManifest.inject_js_start);
  const requestedInject = normalizeInjectList(injectStart);
  const mergedInject = dedupeList([...requestedInject, ...existingInject]);
  const needsMaclauncherStart =
    protectionsEnabled || (supportsCheats && cheatsFilePath) || mergedInject.length > 0;
  if (needsMaclauncherStart) {
    wrapperManifest.maclauncher = {
      ...wrapperManifest.maclauncher,
      offlineEnabled: protectionsEnabled,
      injectStart: mergedInject
    };
    wrapperManifest.inject_js_start = "maclauncher-start.js";
  } else {
    const injectList = mergedInject.slice();
    if (devtoolsEnabled && !injectList.includes("maclauncher-devtools.js")) {
      injectList.push("maclauncher-devtools.js");
    }
    if (injectList.length > 0) {
      wrapperManifest.inject_js_start =
        injectList.length === 1 ? injectList[0] : injectList;
    } else {
      delete wrapperManifest.inject_js_start;
    }
  }

  let chromiumArgsValue = wrapperManifest["chromium-args"];
  if (!protectionsEnabled) {
    try {
      delete wrapperManifest["bg-script"];
    } catch {}
  } else {
    wrapperManifest["bg-script"] = "bg.js";
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
    "maclauncher-devtools.js",
    "maclauncher-cheats-schema.json",
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

  if (extraFileList.length > 0) {
    for (const extra of extraFileList) {
      const dest = path.join(wrapperDir, extra.path);
      ensureDir(path.dirname(dest));
      fs.writeFileSync(dest, extra.contents, "utf8");
    }
  }

  if (supportsCheats && cheatsFilePath) {
    const maclauncherDir = path.join(wrapperDir, "__maclauncher");
    ensureDir(maclauncherDir);

    fs.writeFileSync(path.join(maclauncherDir, "schema.json"), fs.readFileSync(CHEATS_SCHEMA_PATH, "utf8"), "utf8");
    fs.writeFileSync(path.join(maclauncherDir, "cheats.js"), fs.readFileSync(CHEATS_JS_PATH, "utf8"), "utf8");
    fs.writeFileSync(path.join(maclauncherDir, "runtime.js"), fs.readFileSync(CHEATS_RUNTIME_PATH, "utf8"), "utf8");

    const injectSrc = fs.readFileSync(CHEATS_INJECT_PATH, "utf8");
    fs.writeFileSync(path.join(wrapperDir, "maclauncher-inject.js"), injectSrc, "utf8");
    fs.writeFileSync(path.join(maclauncherDir, "inject.js"), injectSrc, "utf8");
  }

  if (protectionsEnabled) {
    fs.writeFileSync(
      path.join(wrapperDir, "disable-child.js"),
      `// maclauncher:disable-child.js\nconst Module=require("module");\nconst orig=Module.prototype.require;\nfunction block(msg){try{if(typeof window!=="undefined")alert(msg);}catch{};console.error(msg);throw new Error(msg)}\nModule.prototype.require=function(id){if(id==="child_process"||id==="node:child_process")block("Blocked: child_process");return orig.apply(this,arguments)};\ntry{const cp=orig.call({},"node:child_process");for(const k of ["exec","execFile","spawn","fork","spawnSync","execSync","execFileSync"]){if(k in cp)cp[k]=function(){block("Blocked: child_process."+k)}}}catch{}\n`,
      "utf8"
    );
    fs.writeFileSync(
      path.join(wrapperDir, "disable-net.js"),
      `// maclauncher:disable-net.js\nconst Module=require("module");const orig=Module.prototype.require;\nconst ALLOW=new Set(["127.0.0.1","::1","localhost"]);\nfunction ok(h){try{return h&&ALLOW.has(String(h).toLowerCase())}catch{return false}}\nfunction block(reason){try{if(typeof window!=="undefined")alert("Network blocked: "+reason);}catch{};console.error("Network blocked: "+reason);const e=new Error("Outbound network disabled: "+reason);e.code="ERR_NET_BLOCKED";throw e}\nModule.prototype.require=function(id){const m=orig.apply(this,arguments);\nif(id==="http"||id==="https"){const wrap=fn=>function(options){const o=typeof options==="string"?new URL(options):options instanceof URL?options:options||{};const host=o.hostname||o.host||(o.headers&&o.headers.Host);if(!ok(host))block(id.toUpperCase()+" to "+host);return fn.apply(this,arguments)};m.request=wrap(m.request);if(m.get)m.get=function(){const r=m.request.apply(this,arguments);r.end();return r}}\nif(id==="net"||id==="tls"){const wrap=fn=>function(){const args=[...arguments];const o=typeof args[0]==="object"?args[0]:{};const host=o.host||o.hostname||args[0];if(!ok(host))block(id.toUpperCase()+" connect to "+host);return fn.apply(this,arguments)};m.connect=wrap(m.connect);if(m.createConnection)m.createConnection=wrap(m.createConnection)}\nif(id==="dns"){const wrap=fn=>function(hostname){if(!ok(hostname))block("DNS lookup for "+hostname);return fn.apply(this,arguments)};for(const k of ["lookup","resolve","resolve4","resolve6","resolveAny","resolveCname","resolveTxt","resolveSrv","resolveNs","resolveMx","reverse"])if(typeof m[k]==="function")m[k]=wrap(m[k])}\nreturn m};\n`,
      "utf8"
    );
    fs.writeFileSync(
      path.join(wrapperDir, "bg.js"),
      `// maclauncher:bg.js\nrequire("./disable-child");\nrequire("./disable-net");\n`,
      "utf8"
    );
  }

  if (needsMaclauncherStart) {
    fs.writeFileSync(
      path.join(wrapperDir, "maclauncher-offline.js"),
      `// maclauncher:offline.js\n(() => {\n  try {\n    if (window.__maclauncher_offlineInstalled) return;\n    window.__maclauncher_offlineInstalled = true;\n  } catch {}\n\n  const allowHosts = new Set([\"127.0.0.1\", \"::1\", \"localhost\"]);\n\n  const resolveUrl = input => {\n    try {\n      if (input instanceof URL) return input;\n      if (input && typeof input === \"object\" && \"url\" in input) return new URL(String(input.url), window.location.href);\n      return new URL(String(input), window.location.href);\n    } catch {\n      return null;\n    }\n  };\n\n  const isBlocked = input => {\n    const url = resolveUrl(input);\n    if (!url) return false;\n    const proto = String(url.protocol || \"\").toLowerCase();\n    if (proto !== \"http:\" && proto !== \"https:\" && proto !== \"ws:\" && proto !== \"wss:\") return false;\n    const host = String(url.hostname || \"\").toLowerCase();\n    return host && !allowHosts.has(host);\n  };\n\n  const block = reason => {\n    try { console.error(\"[MacLauncher] Network blocked:\", reason); } catch {}\n    const err = new Error(\"Outbound network disabled: \" + reason);\n    err.code = \"ERR_NET_BLOCKED\";\n    throw err;\n  };\n\n  try {\n    const origFetch = window.fetch;\n    if (typeof origFetch === \"function\") {\n      window.fetch = function(resource, init) {\n        if (isBlocked(resource)) block(\"fetch \" + String(resource));\n        return origFetch.call(this, resource, init);\n      };\n    }\n  } catch {}\n\n  try {\n    const XHR = window.XMLHttpRequest;\n    if (XHR && XHR.prototype && typeof XHR.prototype.open === \"function\") {\n      const origOpen = XHR.prototype.open;\n      XHR.prototype.open = function(method, url) {\n        if (isBlocked(url)) block(\"xhr \" + String(url));\n        return origOpen.apply(this, arguments);\n      };\n    }\n  } catch {}\n\n  try {\n    const OrigWS = window.WebSocket;\n    if (typeof OrigWS === \"function\") {\n      const WrappedWS = function(url, protocols) {\n        if (isBlocked(url)) block(\"websocket \" + String(url));\n        return new OrigWS(url, protocols);\n      };\n      WrappedWS.prototype = OrigWS.prototype;\n      window.WebSocket = WrappedWS;\n    }\n  } catch {}\n\n  try {\n    const OrigES = window.EventSource;\n    if (typeof OrigES === \"function\") {\n      const WrappedES = function(url, config) {\n        if (isBlocked(url)) block(\"eventsource \" + String(url));\n        return new OrigES(url, config);\n      };\n      WrappedES.prototype = OrigES.prototype;\n      window.EventSource = WrappedES;\n    }\n  } catch {}\n\n  try {\n    if (navigator && typeof navigator.sendBeacon === \"function\") {\n      const origBeacon = navigator.sendBeacon.bind(navigator);\n      navigator.sendBeacon = function(url, data) {\n        if (isBlocked(url)) block(\"beacon \" + String(url));\n        return origBeacon(url, data);\n      };\n    }\n  } catch {}\n\n  const wrapUrlSetter = (proto, prop, label) => {\n    try {\n      const desc = Object.getOwnPropertyDescriptor(proto, prop);\n      if (!desc || typeof desc.set !== \"function\") return;\n      Object.defineProperty(proto, prop, {\n        configurable: true,\n        enumerable: desc.enumerable,\n        get: desc.get,\n        set(value) {\n          if (isBlocked(value)) block(label + \" \" + String(value));\n          return desc.set.call(this, value);\n        }\n      });\n    } catch {}\n  };\n\n  try {\n    if (window.HTMLImageElement) wrapUrlSetter(HTMLImageElement.prototype, \"src\", \"img\");\n    if (window.HTMLScriptElement) wrapUrlSetter(HTMLScriptElement.prototype, \"src\", \"script\");\n    if (window.HTMLLinkElement) wrapUrlSetter(HTMLLinkElement.prototype, \"href\", \"link\");\n    if (window.HTMLIFrameElement) wrapUrlSetter(HTMLIFrameElement.prototype, \"src\", \"iframe\");\n    if (window.HTMLMediaElement) wrapUrlSetter(HTMLMediaElement.prototype, \"src\", \"media\");\n    if (window.HTMLSourceElement) wrapUrlSetter(HTMLSourceElement.prototype, \"src\", \"source\");\n  } catch {}\n\n  try {\n    const origOpen = window.open;\n    if (typeof origOpen === \"function\") {\n      window.open = function(url, target, features) {\n        if (isBlocked(url)) block(\"open \" + String(url));\n        return origOpen.call(this, url, target, features);\n      };\n    }\n  } catch {}\n})();\n`,
      "utf8"
    );
    fs.writeFileSync(
      path.join(wrapperDir, "maclauncher-start.js"),
      `// maclauncher:start.js\n${devtoolsHelperSource}\n(() => {\n  const safeRequire = request => {\n    try { return require(request); } catch { return null; }\n  };\n\n  const manifest = (() => {\n    try { return typeof nw !== \"undefined\" && nw?.App?.manifest ? nw.App.manifest : null; } catch { return null; }\n  })();\n\n  const maclauncher = manifest && typeof manifest.maclauncher === \"object\" ? manifest.maclauncher : {};\n  const injectStart = Array.isArray(maclauncher.injectStart) ? maclauncher.injectStart : [];\n  const offlineEnabled = maclauncher.offlineEnabled !== false;\n\n  if (offlineEnabled) {\n    safeRequire(\"./maclauncher-offline.js\");\n  }\n\n  for (const entry of injectStart) {\n    if (!entry || typeof entry !== \"string\") continue;\n    const trimmed = entry.trim();\n    if (!trimmed) continue;\n    try {\n      if (trimmed.startsWith(\".\") || trimmed.startsWith(\"/\")) {\n        safeRequire(trimmed);\n      } else if (typeof nw !== \"undefined\" && nw?.App?.startPath) {\n        const path = safeRequire(\"path\");\n        if (path) safeRequire(path.join(nw.App.startPath, trimmed));\n      } else {\n        safeRequire(trimmed);\n      }\n    } catch {}\n  }\n\n  if (maclauncher.cheatsFilePath) {\n    safeRequire(\"./maclauncher-inject.js\");\n  }\n})();\n`,
      "utf8"
    );
  } else if (devtoolsEnabled) {
    fs.writeFileSync(path.join(wrapperDir, "maclauncher-devtools.js"), DEVTOOLS_HELPER, "utf8");
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
  chromiumArgs,
  injectStart,
  extraFiles,
  logger,
  onRuntimeStateChange
}) {
  const runtimeData =
    entry?.runtimeData?.nwjs ||
    entry?.runtimeData?.external ||
    {};
  const managerSettings =
    settings?.runtimes?.nwjs ||
    settings?.runtimes?.external ||
    {};
  const { version, variant } = resolveRuntimeConfig(managerSettings, runtimeData);
  const enableProtections =
    runtimeSettings && typeof runtimeSettings === "object"
      ? runtimeSettings.enableProtections === false
        ? false
        : runtimeSettings.disableProtections === true
          ? false
          : true
      : true;

  const installed = await ensureRuntimeInstalled({
    userDataDir,
    version,
    variant,
    logger,
    onState: onRuntimeStateChange,
    allowInstall: false
  });

  const wrapperDir = buildWrapper({
    entry,
    moduleId,
    userDataDir,
    cheatsFilePath,
    supportsCheats,
    toolsButtonVisible,
    enableProtections,
    chromiumArgs,
    injectStart,
    extraFiles
  });

  const profileRoot = resolveProfileRoot(userDataDir, moduleId);
  const profileDir = path.join(
    profileRoot,
    stableIdForPath(entry.gamePath),
    `${installed.version}-${installed.platformKey}-${installed.variant}`
  );
  ensureDir(profileDir);

  const args = [`--user-data-dir=${profileDir}`, wrapperDir];
  const cmd = installed.executablePath;

  logger?.info?.(`[nwjs] launch ${cmd} ${args.join(" ")}`);

  const needsRosetta = process.arch === "arm64" && installed.platformKey === "osx-x64";
  return spawnDetachedChecked(cmd, args, { cwd: wrapperDir }, needsRosetta);
}

module.exports = {
  buildWrapper,
  launchRuntime,
  resolveRuntimeConfig,
  resolveWrapperRoot,
  resolveProfileRoot,
  stableIdForPath
};
