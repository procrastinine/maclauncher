// Legacy NW.js exports retain their browser script context in the Electron
// game process. Node modules loaded with require keep their own CommonJS scope.
function prepareBrowserGlobals(target = globalThis) {
  try { target.module = undefined; } catch {}
  try { target.exports = undefined; } catch {}
}

function setupNwjsCompatibility(context, target = globalThis) {
  const ipc = context.ipcRenderer;
  const send = (channel, ...args) => ipc.send(channel, ...args);
  const gameWindow = {
    showDevTools: () => send("maclauncher:debug:openDevTools"),
    isDevToolsOpen: () => false,
    focus: () => send("maclauncher:debug:focusWindow"),
    show: () => send("maclauncher:window:show"),
    hide: () => send("maclauncher:window:hide"),
    maximize: () => send("maclauncher:window:maximize"),
    minimize: () => send("maclauncher:window:minimize"),
    restore: () => send("maclauncher:window:restore"),
    enterFullscreen: () => send("maclauncher:window:setFullScreen", true),
    leaveFullscreen: () => send("maclauncher:window:setFullScreen", false),
    toggleFullscreen: () => send("maclauncher:window:toggleFullScreen"),
    close: () => send("maclauncher:debug:closeWindow"),
    moveTo: (x, y) => send("maclauncher:window:moveTo", Number(x), Number(y)),
    resizeTo: (width, height) => send("maclauncher:window:resizeTo", Number(width), Number(height), { mode: "outer" }),
    setAlwaysOnTop: value => send("maclauncher:window:setAlwaysOnTop", Boolean(value)),
    setResizable: value => send("maclauncher:window:setResizable", Boolean(value)),
    on: (event, callback) => {
      if (event !== "close" || typeof callback !== "function") return;
      target.addEventListener?.("beforeunload", () => {
        if (target.__maclauncher_reloading) return;
        try { callback(); } catch {}
      });
    }
  };
  const shim = {
    App: {
      argv: [], manifest: context.config?.manifest || null,
      quit: () => { if (!target.__maclauncher_reloading) send("maclauncher:debug:closeWindow"); }
    },
    Menu: class Menu {
      constructor(options) { this.type = options?.type; }
      createMacBuiltin() {}
    },
    MenuItem: class MenuItem { constructor(options) { this.label = options?.label; } },
    Window: { get: () => gameWindow },
    Shell: { openExternal: url => send("maclauncher:shell:openExternal", url) }
  };
  if (typeof context.exposeInMainWorld === "function") context.exposeInMainWorld("nw", shim);
  else target.nw = shim;
  const configured = context.config?.nwjsVersion;
  const version = typeof configured === "string" && configured.trim() ? configured.trim() : "0.107.0";
  try {
    const versions = (context.process || target.process)?.versions;
    if (versions) { versions.nw ??= version; versions["node-webkit"] ??= version; }
  } catch {}
  return { requireOverrides: { "nw.gui": shim, nw: shim } };
}

module.exports = { prepareBrowserGlobals, setupNwjsCompatibility };
