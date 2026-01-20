const fs = require("fs");
const path = require("path");
const Module = require("module");
const { contextBridge, ipcRenderer, webFrame } = require("electron");

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
const contentRootDir = decodeArg(parseArgValue("--maclauncher-content-root="));
const indexHtml = decodeArg(parseArgValue("--maclauncher-index-html="));
const nwjsVersionArg = parseArgValue("--maclauncher-nwjs-version=");
const cheatsArg = parseArgValue("--maclauncher-cheats=");
const cheatsFileArg = parseArgValue("--maclauncher-cheats-file=");
const toolsButtonArg = parseArgValue("--maclauncher-tools-button=");
const unrestrictedArg = parseArgValue("--maclauncher-unrestricted=");

const cheatsFilePath = cheatsFileArg ? decodeArg(cheatsFileArg) : null;
const toolsButtonVisible = toolsButtonArg ? toolsButtonArg !== "0" : true;
const unrestricted = unrestrictedArg ? unrestrictedArg === "1" : false;
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
  contentRootDir,
  indexHtml,
  nwjsVersion,
  cheats: parsedCheats,
  cheatsFilePath,
  toolsButtonVisible,
  unrestricted,
  manifest
};

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
  try {
    if (globalThis.__maclauncherInitialCanvasResizeInstalled) return;
    globalThis.__maclauncherInitialCanvasResizeInstalled = true;
  } catch {}

  const minSize = 200;
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

  const pickCanvas = () =>
    document.getElementById("GameCanvas") ||
    document.querySelector("canvas#gameCanvas") ||
    document.querySelector("canvas");

  const getCanvasSize = canvas => {
    if (!canvas || typeof canvas.getBoundingClientRect !== "function") return null;
    const rect = canvas.getBoundingClientRect();
    const width = Math.round(rect.width);
    const height = Math.round(rect.height);
    if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
    if (width < minSize || height < minSize) return null;
    return { width, height };
  };

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
      const { width, height } = pendingSize;
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
    const size = getCanvasSize(canvas);
    if (!size) return;
    queueResize(size);
  };

  const watchCanvas = canvas => {
    if (!canvas) return false;
    if (canvas === watchedCanvas) return true;
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
        if (watchCanvas(next)) {
          if (observer) observer.disconnect();
          observer = null;
        }
      });
      const root = document.documentElement || document.body;
      if (root) observer.observe(root, { childList: true, subtree: true });
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
  if (!unrestricted) {
    if (request === "dns" || request === "node:dns") {
      return {
        lookup: (_hostname, cb) => {
          const callback = typeof cb === "function" ? cb : null;
          if (!callback) return;
          callback(makeNodeError("ENOTFOUND", "Offline mode: dns.lookup blocked"));
        }
      };
    }
    if (request === "child_process" || request === "node:child_process") {
      return new Proxy(
        {},
        {
          get() {
            return () => {
              throw new Error("Blocked: child_process is disabled in MacLauncher offline mode");
            };
          }
        }
      );
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
