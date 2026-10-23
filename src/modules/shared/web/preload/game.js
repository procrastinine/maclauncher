const fs = require("fs");
const path = require("path");
const Module = require("module");
const { contextBridge, ipcRenderer, webFrame } = require("electron");
const ChildProcessGuard = require("../runtime/child-process-guard");
const { hasPublisherWindowSize, initialCanvasFit } = require("./canvas-window");

function exposeInMainWorld(key, value) {
  try {
    if (process.contextIsolated) {
      contextBridge.exposeInMainWorld(key, value);
      return;
    }
  } catch {}
  try {
    window[key] = value;
  } catch {}
}

function parseArgValue(prefix) {
  const hit = process.argv.find(a => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

function decodeArg(value) {
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

const saveDir = decodeArg(parseArgValue("--maclauncher-save-dir="));
const moduleId = decodeArg(parseArgValue("--maclauncher-module=")) || "unknown";
const runtimeId = decodeArg(parseArgValue("--maclauncher-runtime=")) || "electron";
const gameDir = decodeArg(parseArgValue("--maclauncher-game-dir="));
const gameDataDir = decodeArg(parseArgValue("--maclauncher-game-data-dir="));
const contentRootDir = decodeArg(parseArgValue("--maclauncher-content-root="));
const indexHtml = decodeArg(parseArgValue("--maclauncher-index-html="));
const nwjsVersionArg = parseArgValue("--maclauncher-nwjs-version=");
const cheatsArg = parseArgValue("--maclauncher-cheats=");
const cheatsFileArg = parseArgValue("--maclauncher-cheats-file=");
const toolsButtonArg = parseArgValue("--maclauncher-tools-button=");
const unrestrictedArg = parseArgValue("--maclauncher-unrestricted=");
const networkAllowedArg = parseArgValue("--maclauncher-network-allowed=");
const gameArgumentsArg = parseArgValue("--maclauncher-game-arguments=");
let gameArguments = [];
try {
  const parsed = gameArgumentsArg ? JSON.parse(Buffer.from(gameArgumentsArg, "base64").toString("utf8")) : [];
  if (Array.isArray(parsed) && parsed.every(value => typeof value === "string")) gameArguments = parsed;
} catch {}

const cheatsFilePath = cheatsFileArg ? decodeArg(cheatsFileArg) : null;
const toolsButtonVisible = toolsButtonArg ? toolsButtonArg !== "0" : true;
const unrestricted = unrestrictedArg ? unrestrictedArg === "1" : false;
const networkAllowed = networkAllowedArg == null ? unrestricted : networkAllowedArg === "1";
const nwjsVersion = nwjsVersionArg ? decodeArg(nwjsVersionArg) : null;

function readPackageJsonManifest() {
  const root = contentRootDir || gameDir;
  if (!root) return null;
  const p = path.join(root, "package.json");
  if (!fs.existsSync(p)) return null;
  try {
    const raw = fs.readFileSync(p, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

let parsedCheats = null;
try {
  if (cheatsFilePath && fs.existsSync(cheatsFilePath)) {
    parsedCheats = JSON.parse(fs.readFileSync(cheatsFilePath, "utf8"));
  } else if (cheatsArg) {
    parsedCheats = JSON.parse(decodeURIComponent(cheatsArg));
  }
} catch {}

const manifest = readPackageJsonManifest();

const config = {
  saveDir,
  moduleId,
  runtimeId,
  gameDir,
  gameDataDir,
  contentRootDir,
  indexHtml,
  nwjsVersion,
  cheats: parsedCheats,
  cheatsFilePath,
  toolsButtonVisible,
  unrestricted,
  networkAllowed,
  gameArguments,
  manifest
};

// Application flags belong to the game renderer. Their encoded transport must
// never become Electron or Chromium startup switches.
if (gameArguments.length) process.argv = [process.execPath, indexHtml || gameDir, ...gameArguments];

try {
  if (typeof process === "object" && indexHtml) {
    if (!process.mainModule) process.mainModule = { filename: indexHtml };
    if (!process.mainModule?.filename) process.mainModule.filename = indexHtml;
  }
} catch {}

try {
  if (contentRootDir && typeof process?.chdir === "function") {
    process.chdir(contentRootDir);
  }
} catch {}

exposeInMainWorld("MacLauncher", {
  config,
  log: (...args) => console.log("[MacLauncher]", ...args),
  reloadPage: () => {
    try {
      globalThis.__maclauncher_reloading = true;
    } catch {}
    ipcRenderer.send("maclauncher:game:reload");
  }
});

function dispatchToolsEvent(action) {
  const eventName =
    action === "open"
      ? "maclauncher:openTools"
      : action === "close"
        ? "maclauncher:closeTools"
        : "maclauncher:toggleTools";
  try {
    if (action === "toggle") {
      globalThis.__maclauncher_toolsPendingOpen = !globalThis.__maclauncher_toolsPendingOpen;
    } else {
      globalThis.__maclauncher_toolsPendingOpen = action === "open";
    }
  } catch {}
  try {
    window.dispatchEvent(new Event(eventName));
  } catch {}
}

ipcRenderer.on("maclauncher:tools:toggle", () => dispatchToolsEvent("toggle"));
ipcRenderer.on("maclauncher:tools:open", () => dispatchToolsEvent("open"));
ipcRenderer.on("maclauncher:tools:close", () => dispatchToolsEvent("close"));

function installWindowResizeShim() {
  if (!ipcRenderer || typeof ipcRenderer.send !== "function") return;
  try {
    if (globalThis.__maclauncherResizeShimInstalled) return;
    globalThis.__maclauncherResizeShimInstalled = true;
  } catch {}

  const toNumber = value => {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  };

  const sendResize = (w, h, options) => {
    if (w == null || h == null) return;
    ipcRenderer.send("maclauncher:window:resizeTo", w, h, options);
  };

  const originalResizeTo = typeof window.resizeTo === "function" ? window.resizeTo.bind(window) : null;
  const originalResizeBy = typeof window.resizeBy === "function" ? window.resizeBy.bind(window) : null;

  window.resizeTo = (w, h) => {
    const nw = toNumber(w);
    const nh = toNumber(h);
    if (nw != null && nh != null) sendResize(nw, nh, { mode: "outer" });
    if (originalResizeTo) {
      try {
        originalResizeTo(w, h);
      } catch {}
    }
  };

  window.resizeBy = (dw, dh) => {
    const ndw = toNumber(dw);
    const ndh = toNumber(dh);
    const outerW = toNumber(window.outerWidth);
    const outerH = toNumber(window.outerHeight);
    const baseW = toNumber(window.innerWidth);
    const baseH = toNumber(window.innerHeight);
    const currentW = outerW ?? baseW;
    const currentH = outerH ?? baseH;
    if (currentW != null && currentH != null) {
      sendResize(currentW + (ndw || 0), currentH + (ndh || 0), { mode: "outer" });
    }
    if (originalResizeBy) {
      try {
        originalResizeBy(dw, dh);
      } catch {}
    }
  };
}

installWindowResizeShim();

function installInitialCanvasResize() {
  if (!ipcRenderer || typeof ipcRenderer.send !== "function") return;
  if (hasPublisherWindowSize(manifest)) return;
  try {
    if (globalThis.__maclauncherInitialCanvasResizeInstalled) return;
    globalThis.__maclauncherInitialCanvasResizeInstalled = true;
  } catch {}

  let done = false;
  let observer = null;
  let resizeObserver = null;
  let timeoutId = null;
  let pendingTimer = null;
  let pendingSize = null;
  let watchedCanvas = null;

  const cleanup = () => {
    if (observer) observer.disconnect();
    if (resizeObserver) resizeObserver.disconnect();
    observer = null;
    resizeObserver = null;
    if (timeoutId) clearTimeout(timeoutId);
    timeoutId = null;
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = null;
    pendingSize = null;
    watchedCanvas = null;
  };

  const pickCanvas = () => initialCanvasFit(document, manifest)?.canvas || null;

  const shouldResize = (width, height) => {
    const innerW = Math.round(Number(window.innerWidth));
    const innerH = Math.round(Number(window.innerHeight));
    if (Number.isFinite(innerW) && Number.isFinite(innerH)) {
      if (Math.abs(innerW - width) <= 2 && Math.abs(innerH - height) <= 2) {
        return false;
      }
    }
    return true;
  };

  const queueResize = size => {
    if (done) return;
    pendingSize = size;
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => {
      if (done || !pendingSize) return;
      // Startup may add another canvas or controls after the first layout.
      const fit = initialCanvasFit(document, manifest);
      if (!fit || fit.canvas !== watchedCanvas) {
        pendingTimer = null;
        pendingSize = null;
        return;
      }
      const { width, height } = fit;
      done = true;
      cleanup();
      if (!shouldResize(width, height)) return;
      ipcRenderer.send("maclauncher:window:resizeTo", width, height, {
        mode: "content"
      });
    }, 200);
  };

  const maybeResize = canvas => {
    if (done) return;
    const fit = initialCanvasFit(document, manifest);
    if (!fit || fit.canvas !== canvas) {
      if (pendingTimer) clearTimeout(pendingTimer);
      pendingTimer = null;
      pendingSize = null;
      return;
    }
    queueResize(fit);
  };

  const watchCanvas = canvas => {
    if (!canvas) return false;
    if (canvas === watchedCanvas) {
      maybeResize(canvas);
      return true;
    }
    watchedCanvas = canvas;
    if (resizeObserver) resizeObserver.disconnect();
    if (typeof ResizeObserver === "function") {
      resizeObserver = new ResizeObserver(() => maybeResize(canvas));
      resizeObserver.observe(canvas);
    }
    maybeResize(canvas);
    return true;
  };

  const start = () => {
    const canvas = pickCanvas();
    watchCanvas(canvas);
    if (typeof MutationObserver === "function") {
      observer = new MutationObserver(() => {
        const next = pickCanvas();
        watchCanvas(next);
      });
      const root = document.documentElement || document.body;
      if (root) observer.observe(root, {
        childList: true, subtree: true, characterData: true,
        attributes: true, attributeFilter: ["style", "class", "hidden"]
      });
    }
    if (typeof ResizeObserver !== "function") {
      let tries = 0;
      const timer = setInterval(() => {
        if (done) return clearInterval(timer);
        tries += 1;
        const next = pickCanvas();
        if (next) maybeResize(next);
        if (tries >= 120) clearInterval(timer);
      }, 250);
    }
    timeoutId = setTimeout(() => cleanup(), 20_000);
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
}

installInitialCanvasResize();

function normalizeModuleId(input) {
  const raw = String(input || "").trim();
  if (!raw) return null;
  if (!/^[a-z0-9_-]+$/i.test(raw)) return null;
  return raw;
}

function loadElectronRuntime(id) {
  const safeId = normalizeModuleId(id);
  if (!safeId) return null;
  const dir = path.resolve(__dirname, "..", "..", "..", safeId);
  const electronPath = path.join(dir, "electron.js");
  if (!fs.existsSync(electronPath)) return null;
  try {
    const mod = require(electronPath);
    if (typeof mod === "function") return { install: mod };
    return mod && typeof mod === "object" ? mod : null;
  } catch {
    return null;
  }
}

function makeNodeError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

const electronRuntime = loadElectronRuntime(moduleId);
let runtimeSetup = null;
try {
  if (electronRuntime && typeof electronRuntime.setup === "function") {
    runtimeSetup = electronRuntime.setup({
      moduleId,
      runtimeId,
      config,
      ipcRenderer,
      webFrame,
      exposeInMainWorld
    });
  }
} catch (e) {
  console.error("[MacLauncher] Failed to setup electron runtime:", e);
}

const requireOverrides =
  runtimeSetup && typeof runtimeSetup.requireOverrides === "object" ? runtimeSetup.requireOverrides : {};

const originalLoad = Module._load;
Module._load = function maclauncherModuleLoad(request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(requireOverrides, request)) {
    return requireOverrides[request];
  }
  if (!unrestricted && (request === "child_process" || request === "node:child_process")) {
    return ChildProcessGuard.wrapChildProcessModule(
      originalLoad.call(this, request, parent, isMain),
      { messageSuffix: " is disabled while child processes are blocked" }
    );
  }
  if (!networkAllowed) {
    if (request === "dns" || request === "node:dns") {
      return {
        lookup: (_hostname, cb) => {
          const callback = typeof cb === "function" ? cb : null;
          if (!callback) return;
          callback(makeNodeError("ENOTFOUND", "Offline mode: dns.lookup blocked"));
        }
      };
    }
    if (
      request === "http" ||
      request === "node:http" ||
      request === "https" ||
      request === "node:https" ||
      request === "net" ||
      request === "node:net" ||
      request === "tls" ||
      request === "node:tls" ||
      request === "dgram" ||
      request === "node:dgram"
    ) {
      return new Proxy(
        {},
        {
          get() {
            return () => {
              throw new Error("Blocked: network module disabled in MacLauncher offline mode");
            };
          }
        }
      );
    }
  }
  if (request === "electron") {
    throw new Error("Blocked: require('electron') is disabled for game code");
  }
  return originalLoad.call(this, request, parent, isMain);
};

try {
  if (electronRuntime && typeof electronRuntime.install === "function") {
    electronRuntime.install({
      moduleId,
      runtimeId,
      config,
      ipcRenderer,
      webFrame,
      exposeInMainWorld,
      setup: runtimeSetup
    });
  }
} catch (e) {
  console.error("[MacLauncher] Failed to install electron runtime:", e);
}
