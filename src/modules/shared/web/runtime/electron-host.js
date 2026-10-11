const fs = require("node:fs");
const path = require("node:path");
const CleanupUtils = require("../../../../main/cleanup-utils");
const GameData = require("../../game-data");
const { createRuntimeSettingsStore } = require("../../../../core/runtime-settings");
const { writeJsonAtomic } = require("../../../../core/json-files");

function moduleIdFor(entry) {
  const id = String(entry?.moduleId || "").trim();
  const engine = String(entry?.engine || "").trim();
  return ((id === "web" || id === "unknown") && engine ? engine : id || engine) || "unknown";
}

function hostedInfoFor(info) {
  const hosted = info?.runtime?.hosted;
  return typeof hosted === "string" ? { id: hosted.trim() } : hosted || {};
}

function assertInside(root, file) {
  const relative = path.relative(root, file);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Game index.html must be inside the content root.");
  }
  return relative;
}

function contentPaths(entry) {
  const indexHtml = path.resolve(entry.indexHtml);
  const rootDir = path.resolve(entry.contentRootDir ||
    (fs.statSync(entry.gamePath).isDirectory() ? entry.gamePath : path.dirname(indexHtml)));
  const relativeIndex = assertInside(rootDir, indexHtml);
  if (!fs.statSync(rootDir).isDirectory() || !fs.statSync(indexHtml).isFile()) {
    throw new Error("Missing game content directory or index.html.");
  }
  assertInside(fs.realpathSync(rootDir), fs.realpathSync(indexHtml));
  return { rootDir, indexHtml, relativeIndex };
}

function windowConfig(rootDir) {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
  } catch {}
  const dimension = value => {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(200, Math.min(8000, number)) : null;
  };
  return {
    width: dimension(pkg?.window?.width) || 1100,
    height: dimension(pkg?.window?.height) || 700,
    title: typeof pkg?.window?.title === "string" ? pkg.window.title.trim() : ""
  };
}

/**
 * Electron is supplied by the caller; requiring this module never loads Electron.
 * Prefer a core launch context in createGameWindow(entry, { runtimeId, context }).
 * Legacy callers may instead supply the individual settings/launch hooks below.
 * Pass an existing policies Map when the launcher owns its IPC handlers; only
 * standalone callers need installIpc() and installMenu(). Registry fallback is
 * deliberately deferred because the registry also discovers this helper.
 * Persistent partitions and saves survive disposal; window/server resources do not.
 */
function createElectronGameHost({ electron, userDataDir, logger = console, registry, policies = new Map(), ...hooks } = {}) {
  if (!electron?.BrowserWindow || !electron?.session) throw new TypeError("Missing Electron window/session APIs.");
  if (typeof userDataDir !== "string" || !userDataDir) throw new TypeError("Missing userDataDir.");
  const { app, BrowserWindow, dialog, ipcMain, Menu, shell, session } = electron;
  const modules = registry || require("../../../registry");
  const runtimeSettingsStore = createRuntimeSettingsStore({ userDataDir });
  const windows = new Map();
  const resources = new Set();
  const restrictions = new WeakMap();
  const ipcListeners = new Map();
  const platform = hooks.platform || process.platform;
  const isDebug = hooks.isDebug ?? hooks.debug ?? (process.env.MACLAUNCHER_DEBUG === "1");
  const isSmoke = hooks.isSmoke ?? process.argv.includes("--maclauncher-smoke");
  const devtoolsEnabled = hooks.devtoolsEnabled ??
    (process.env.MACLAUNCHER_DEVTOOLS === "1" ||
      (process.env.MACLAUNCHER_DEVTOOLS == null && (isDebug || !app?.isPackaged)));
  const devtoolsAuto = hooks.devtoolsAuto ?? (devtoolsEnabled && process.env.MACLAUNCHER_DEVTOOLS_AUTO === "1");
  let disposed = false;
  let disposePromise;
  let uninstallMenu;

  function resolveRuntimeSettings(entry, settings, info, runtimeId) {
    return hooks.resolveRuntimeSettingsForEntry
      ? hooks.resolveRuntimeSettingsForEntry(entry, settings, info, runtimeId)
      : runtimeSettingsStore.resolveForEntry(entry, settings, info, runtimeId);
  }

  function runtimeLabel(id, info) {
    return hooks.resolveRuntimeLabel?.(id, info) || info?.runtime?.entries?.[id]?.label ||
      info?.runtime?.labels?.[id] || id || "Runtime";
  }

  function preferredNwjsVersion(settings) {
    if (hooks.resolvePreferredNwjsVersion) return hooks.resolvePreferredNwjsVersion(settings, userDataDir);
    const manager = modules.listSharedRuntimeManagers?.().find(item => item.id === "nwjs");
    const config = manager?.normalizeSettings?.(settings?.runtimes?.nwjs);
    const preferred = String(config?.defaultVersion || "").trim().replace(/^v/i, "") || null;
    const installed = (manager?.core?.listInstalled?.(userDataDir) || []).map(item => item?.version).filter(Boolean);
    if (preferred && installed.includes(preferred)) return preferred;
    installed.sort((a, b) => String(b).localeCompare(String(a), undefined, { numeric: true }));
    return installed[0] || preferred;
  }

  function applyRestrictions(netSession, origin) {
    const allowed = new URL(origin);
    let restriction = restrictions.get(netSession);
    if (!restriction) {
      restriction = { ports: new Set() };
      restrictions.set(netSession, restriction);
      netSession.webRequest.onBeforeRequest((details, callback) => {
        try {
          const url = new URL(details.url);
          if (["data:", "blob:", "devtools:", "chrome-devtools:", "chrome:", "chrome-extension:"].includes(url.protocol)) {
            return callback({});
          }
          if (["http:", "https:", "ws:", "wss:"].includes(url.protocol)) {
            const port = url.port || (["https:", "wss:"].includes(url.protocol) ? "443" : "80");
            const local = ["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname);
            if (local && restriction.ports.has(port)) return callback({});
          }
          logger.warn?.(`[offline] blocked ${details.url}`);
        } catch {}
        callback({ cancel: true });
      });
    }
    restriction.ports.add(allowed.port);
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      restriction.ports.delete(allowed.port);
      if (!restriction.ports.size) {
        netSession.webRequest.onBeforeRequest(null);
        restrictions.delete(netSession);
      }
    };
  }

  function openDevTools(win, source) {
    if (hooks.openDevToolsForWindow) return hooks.openDevToolsForWindow(win, source);
    if (win.isDestroyed()) return;
    const wc = win.webContents;
    try {
      if (wc.isDevToolsOpened()) return wc.focusDevTools?.();
      wc.openDevTools({ mode: "detach" });
      const timer = setTimeout(() => {
        if (!win.isDestroyed() && !wc.isDestroyed?.() && !wc.isDevToolsOpened()) {
          try { wc.openDevTools({ mode: "right" }); } catch {}
        }
      }, 150);
      timer.unref?.();
      win.once("closed", () => clearTimeout(timer));
    } catch (error) {
      logger.warn?.(`[devtools] open failed (${source}) ${String(error?.message || error)}`);
    }
  }

  function attachWindowBehavior(win, entry) {
    const wc = win.webContents;
    if (hooks.attachWebContentsLogging) hooks.attachWebContentsLogging(wc, `game:${entry.name}`);
    else {
      wc.on("console-message", event => {
        const message = String(event?.message ?? event?.text ?? "");
        if (/Electron Security Warning \(Insecure Content-Security-Policy\)|Canvas2D: .*willReadFrequently|CanvasTextAlign.*not a valid enum value|not a valid enum value.*CanvasTextAlign/i.test(message)) return;
        logger.info?.(`[game:${entry.name}] ${message} (${event?.sourceId ?? event?.sourceURL}:${event?.line ?? event?.lineNumber})`);
      });
      wc.on("render-process-gone", (_event, details) => logger.error?.(`[game:${entry.name}] render-process-gone`, details));
      wc.on("unresponsive", () => logger.warn?.(`[game:${entry.name}] unresponsive`));
    }
    if (hooks.attachDevToolsShortcut) hooks.attachDevToolsShortcut(win);
    else if (devtoolsEnabled) wc.on("before-input-event", (event, input) => {
      if (input.type && input.type !== "keyDown") return;
      if (String(input.key || "").toLowerCase() !== "i") return;
      if (!(platform === "darwin" ? input.meta && input.alt : input.control && input.shift)) return;
      event.preventDefault();
      openDevTools(win, "before-input-event");
    });
    if (hooks.attachDevToolsAutoOpen) hooks.attachDevToolsAutoOpen(win, "game");
    else if (devtoolsAuto) {
      let opened = false;
      const openOnce = () => {
        if (opened) return;
        opened = true;
        openDevTools(win, "game:auto");
      };
      wc.once("did-finish-load", openOnce);
      wc.once("did-fail-load", openOnce);
    }
  }

  async function createGameWindow(entry, options = {}) {
    if (disposed) throw new Error("Electron game host is disposed.");
    const moduleId = moduleIdFor(entry);
    const mod = modules.getModule(moduleId);
    const info = modules.getModuleInfo(moduleId);
    const hosted = hostedInfoFor(info);
    const runtimeId = hosted.id || options.runtimeId || entry.runtimeId || info?.runtime?.default ||
      info?.runtime?.supported?.[0] || "electron";
    const label = runtimeLabel(runtimeId, info);
    if (entry.gameType && entry.gameType !== "web") throw new Error(`${label} is not supported for ${info?.label || moduleId}.`);
    if (!entry.indexHtml) throw new Error(`Missing index.html; ${label} requires a web game.`);
    const { rootDir, indexHtml, relativeIndex } = contentPaths(entry);
    let context = options.context;
    const settings = context?.settings ?? options.settings ?? await hooks.loadSettings?.() ?? {};
    if (!context && hooks.getLaunchContext) context = await hooks.getLaunchContext(entry, settings, { ...options, runtimeId });
    context ||= {};
    const moduleSettings = context.moduleSettings ?? hooks.resolveModuleSettings?.(settings, moduleId) ?? settings.modules?.[moduleId] ?? {};
    const runtimeSettings = options.runtimeSettings ?? context.runtimeSettings ?? resolveRuntimeSettings(entry, settings, info, runtimeId);
    const enableProtections = runtimeSettings?.enableProtections !== false;
    const runtimeSupport = hooks.resolveRuntimeSupportForEntry
      ? hooks.resolveRuntimeSupportForEntry(mod, info, entry, moduleSettings)
      : mod?.filterRuntimeSupport?.(entry, [...(info?.runtime?.supported || [])], moduleSettings) ?? info?.runtime?.supported ?? [];
    const fallbackRuntimeId = runtimeSupport.includes(hosted.fallback) ? hosted.fallback : null;
    const rawSaveDir = entry.saveDirOverride || entry.defaultSaveDir;
    const saveDir = hosted.saveDirectory === true && typeof rawSaveDir === "string" && rawSaveDir ? rawSaveDir : null;
    const cheats = hooks.normalizeCheatsForModule
      ? hooks.normalizeCheatsForModule(moduleId, entry.cheats)
      : info?.supports?.cheats ? mod?.cheats?.normalize?.(entry.cheats) : null;
    let cheatsFilePath = context.cheatsFilePath ?? null;
    if (cheats && !cheatsFilePath) {
      if (hooks.writeCheatsFile) cheatsFilePath = await hooks.writeCheatsFile(entry.gameId, moduleId, cheats);
      else if (entry.gameId) {
        cheatsFilePath = GameData.resolveGameCheatsPath(userDataDir, entry.gameId);
        fs.mkdirSync(path.dirname(cheatsFilePath), { recursive: true });
        writeJsonAtomic(cheatsFilePath, cheats);
      }
    }
    const toolsButtonVisible = options.toolsButtonVisible ?? context.toolsButtonVisible ??
      hooks.resolveToolsButtonVisible?.(entry, settings) ??
      (Boolean(cheats) && (entry.moduleData?.toolsButtonVisibleOverride ?? moduleSettings.toolsButtonVisible ?? true));
    const nwjsVersion = context.nwjsVersion ?? preferredNwjsVersion(settings);
    const additionalArguments = [
      ...(saveDir ? [`--maclauncher-save-dir=${encodeURIComponent(saveDir)}`] : []),
      `--maclauncher-module=${encodeURIComponent(moduleId)}`,
      `--maclauncher-runtime=${encodeURIComponent(runtimeId)}`,
      `--maclauncher-game-dir=${encodeURIComponent(entry.gamePath)}`,
      ...(entry.gameId ? [`--maclauncher-game-data-dir=${encodeURIComponent(GameData.resolveGameDir(userDataDir, entry.gameId))}`] : []),
      `--maclauncher-content-root=${encodeURIComponent(rootDir)}`,
      `--maclauncher-index-html=${encodeURIComponent(indexHtml)}`,
      `--maclauncher-tools-button=${toolsButtonVisible ? "1" : "0"}`,
      `--maclauncher-unrestricted=${enableProtections ? "0" : "1"}`,
      ...(nwjsVersion ? [`--maclauncher-nwjs-version=${encodeURIComponent(nwjsVersion)}`] : []),
      ...(cheats && cheatsFilePath ? [
        `--maclauncher-cheats=${encodeURIComponent(JSON.stringify(cheats))}`,
        `--maclauncher-cheats-file=${encodeURIComponent(cheatsFilePath)}`
      ] : [])
    ];
    let server;
    let win;
    let webContentsId;
    let cleanupRestriction;
    let cleanupPromise;
    const resource = { cleanup, closeWindow };
    function closeWindow() {
      if (win && !win.isDestroyed()) win.destroy();
    }
    function cleanup() {
      if (cleanupPromise) return cleanupPromise;
      if (webContentsId != null) {
        policies.delete(webContentsId);
        windows.delete(webContentsId);
      }
      try { cleanupRestriction?.(); } catch (error) { logger.warn?.("[offline] cleanup failed", error); }
      cleanupPromise = Promise.resolve().then(() => server?.close())
        .catch(error => logger.warn?.("[server] close failed", error))
        .finally(() => resources.delete(resource));
      return cleanupPromise;
    }
    let offerFallback;
    try {
      const createServer = hooks.createStaticServer || require("../../../../core/static-server").createStaticServer;
      const readRoots = typeof mod?.getContentReadRoots === "function" ? mod.getContentReadRoots(entry, context) : [];
      server = await createServer(rootDir, { logger, readRoots });
      resources.add(resource);
      if (disposed) throw new Error("Electron game host is disposed.");
      const origin = `http://127.0.0.1:${server.port}`;
      const url = `${origin}/${relativeIndex.split(path.sep).map(encodeURIComponent).join("/")}`;
      const partitionId = CleanupUtils.stablePartitionId(entry.gameId, enableProtections ? "protected" : "unrestricted");
      const partition = CleanupUtils.ensurePartitionSymlink({ userDataDir, gameId: entry.gameId, partitionId, logger });
      if (!partition.ok) throw new Error("Failed to prepare per-game storage partition.");
      const netSession = session.fromPartition(partitionId, { cache: true });
      if (enableProtections) cleanupRestriction = applyRestrictions(netSession, origin);
      const config = windowConfig(rootDir);
      if (hooks.applyDockIdentity) hooks.applyDockIdentity(entry);
      win = new BrowserWindow({
        width: config.width, height: config.height, useContentSize: true,
        title: config.title || entry.name, backgroundColor: "#000000",
        webPreferences: {
          session: netSession, preload: path.resolve(__dirname, "../preload/game.js"),
          nodeIntegration: true, contextIsolation: false, sandbox: false, devTools: true,
          additionalArguments
        }
      });
      win.__maclauncherWindowType = "game";
      webContentsId = win.webContents.id;
      windows.set(webContentsId, win);
      policies.set(webContentsId, { allowExternal: !enableProtections, enableProtections });
      win.once("closed", cleanup);
      win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      attachWindowBehavior(win, entry);

      let fallbackPromise;
      offerFallback = (title, detail) => {
        if (fallbackPromise) return fallbackPromise;
        fallbackPromise = Promise.resolve().then(async () => {
          try {
            if (isSmoke || disposed || win.isDestroyed()) return;
            const message = {
              type: "error", buttons: fallbackRuntimeId ? ["Close", `Launch with ${runtimeLabel(fallbackRuntimeId, info)}`] : ["Close"],
              defaultId: fallbackRuntimeId ? 1 : 0, cancelId: 0, message: title, detail: String(detail || "")
            };
            const result = await dialog?.showMessageBox(win, message);
            if (result?.response === 1 && fallbackRuntimeId && mod?.launchRuntime && !disposed) {
              const fallbackOptions = { toolsButtonVisible, cheatsFilePath, runtimeId: fallbackRuntimeId };
              const buildContext = hooks.getLaunchContext || hooks.buildModuleLaunchContext;
              const launchContext = buildContext ? await buildContext(entry, settings, fallbackOptions) : {
                ...context, settings, moduleSettings, userDataDir, logger, ...fallbackOptions,
                runtimeSettings: resolveRuntimeSettings(entry, settings, info, fallbackRuntimeId)
              };
              const child = await mod.launchRuntime(fallbackRuntimeId, entry, launchContext);
              if (child) hooks.onProcessRun?.(entry, child, fallbackRuntimeId);
            }
          } catch (error) {
            logger.error?.("[fallback] failed", String(error?.message || error));
          } finally {
            try { if (!win.isDestroyed()) win.close(); } catch {}
            try { closeWindow(); } catch {}
            await cleanup();
          }
        });
        return fallbackPromise;
      };
      win.webContents.on("render-process-gone", (_event, details) => {
        const reason = String(details?.reason || "");
        if (reason && reason !== "clean-exit") void offerFallback("Game process exited unexpectedly.",
          `Reason: ${reason}${details?.exitCode != null ? ` · exit ${details.exitCode}` : ""}`);
      });
      win.webContents.on("did-fail-load", (_event, code, description, validatedUrl, isMainFrame) => {
        if (isMainFrame) void offerFallback("Failed to load the game.", `${code} · ${description}\n${validatedUrl || ""}`.trim());
      });
      try {
        const ua = win.webContents.getUserAgent?.() || "";
        const raw = String(hosted.userAgent?.suffix || "").trim();
        const suffix = context.userAgentSuffix ?? (hooks.resolveUserAgentSuffix
          ? hooks.resolveUserAgentSuffix(raw, { settings, userDataDir, nwjsVersion })
          : raw.includes("{nwjsVersion}") && !nwjsVersion ? "" : raw.split("{nwjsVersion}").join(nwjsVersion || ""));
        const hint = String(hosted.userAgent?.hint || "").trim();
        if (suffix && !ua.includes(hint || suffix)) win.webContents.setUserAgent(`${ua} ${suffix}`.trim());
      } catch {}
      if (isDebug) openDevTools(win, "debug");
      hooks.onWindowCreated?.(win, entry);
      await win.loadURL(url);
      return { win, server, saveDir, origin };
    } catch (error) {
      try {
        if (offerFallback && win && !win.isDestroyed()) await offerFallback("Failed to load the game.", String(error?.message || error));
      } finally {
        try { closeWindow(); } catch {}
        await cleanup();
      }
      throw error;
    }
  }

  function senderWindow(event) {
    const win = windows.get(event?.sender?.id);
    return win && !win.isDestroyed() && win.webContents === event.sender ? win : null;
  }

  function resizeWindow(win, width, height, options) {
    const w = Number(width), h = Number(height);
    if (!Number.isFinite(w) || !Number.isFinite(h)) return;
    const nextW = Math.max(200, Math.round(w)), nextH = Math.max(200, Math.round(h));
    const outer = options?.mode === "outer";
    const wasResizable = win.isResizable();
    if (!wasResizable) win.setResizable(true);
    try {
      if (outer) win.setSize(nextW, nextH);
      else win.setContentSize(nextW, nextH);
      try {
        const [actualW, actualH] = outer ? win.getSize() : win.getContentSize();
        if (actualW !== nextW || actualH !== nextH) {
          if (outer) win.setContentSize(nextW, nextH);
          else win.setSize(nextW, nextH);
        }
      } catch {}
    } finally {
      if (!wasResizable) win.setResizable(false);
    }
  }

  function uninstallIpc() {
    for (const [channel, listener] of ipcListeners) ipcMain.removeListener(channel, listener);
    ipcListeners.clear();
  }

  function installIpc() {
    if (disposed) throw new Error("Electron game host is disposed.");
    if (ipcListeners.size) return uninstallIpc;
    const actions = {
      "maclauncher:debug:openDevTools": win => openDevTools(win, "ipc"),
      "maclauncher:debug:focusWindow": win => { win.show(); win.focus(); },
      "maclauncher:debug:closeWindow": win => win.close(),
      "maclauncher:game:reload": win => win.webContents.reloadIgnoringCache(),
      ...Object.fromEntries(["show", "hide", "maximize", "minimize", "restore"].map(action => [`maclauncher:window:${action}`, win => win[action]()])),
      "maclauncher:window:moveTo": (win, x, y) => {
        if (Number.isFinite(Number(x)) && Number.isFinite(Number(y))) win.setPosition(Math.round(Number(x)), Math.round(Number(y)));
      },
      "maclauncher:window:resizeTo": resizeWindow,
      "maclauncher:window:setAlwaysOnTop": (win, flag) => win.setAlwaysOnTop(Boolean(flag)),
      "maclauncher:window:setResizable": (win, flag) => win.setResizable(Boolean(flag)),
      "maclauncher:window:setFullScreen": (win, flag) => win.setFullScreen(Boolean(flag)),
      "maclauncher:window:toggleFullScreen": win => win.setFullScreen(!win.isFullScreen()),
      "maclauncher:shell:openExternal": (win, url) => {
        if (typeof url !== "string" || !policies.get(win.webContents.id)?.allowExternal) return;
        try {
          if (!["http:", "https:", "mailto:", "file:"].includes(new URL(url).protocol)) return;
          Promise.resolve(shell.openExternal(url)).catch(error => logger.error?.("[shell] openExternal failed", error));
        } catch {}
      }
    };
    for (const [channel, action] of Object.entries(actions)) {
      const listener = (event, ...args) => {
        const win = senderWindow(event);
        if (win) action(win, ...args);
      };
      ipcMain.on(channel, listener);
      ipcListeners.set(channel, listener);
    }
    return uninstallIpc;
  }

  function installMenu() {
    if (disposed) throw new Error("Electron game host is disposed.");
    if (uninstallMenu) return uninstallMenu;
    const previous = Menu.getApplicationMenu();
    const template = [
      ...(platform === "darwin" ? [{ role: "appMenu" }] : []),
      { label: "File", submenu: [{ role: platform === "darwin" ? "close" : "quit" }] },
      { role: "editMenu" },
      { label: "View", submenu: [
        { role: "reload" }, { role: "forceReload" }, ...(devtoolsEnabled ? [{ role: "toggleDevTools" }] : []),
        { type: "separator" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" },
        { type: "separator" }, { role: "togglefullscreen" }
      ] },
      { label: "Tools", submenu: ["toggle", "open", "close"].map(action => ({
        label: `${action.charAt(0).toUpperCase() + action.slice(1)} Tools Panel`,
        ...(action === "toggle" ? { accelerator: "CmdOrCtrl+Shift+T" } : {}),
        click: () => {
          const win = BrowserWindow.getFocusedWindow();
          if (win && senderWindow({ sender: win.webContents })) win.webContents.send(`maclauncher:tools:${action}`);
        }
      })) },
      { role: "windowMenu" }
    ];
    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
    uninstallMenu = () => {
      if (Menu.getApplicationMenu() === menu) Menu.setApplicationMenu(previous);
      uninstallMenu = undefined;
    };
    return uninstallMenu;
  }

  function dispose() {
    if (disposePromise) return disposePromise;
    disposed = true;
    uninstallIpc();
    uninstallMenu?.();
    disposePromise = Promise.allSettled(Array.from(resources, resource => {
      try { resource.closeWindow(); } catch {}
      return resource.cleanup();
    }));
    return disposePromise;
  }

  return { createGameWindow, policies, installIpc, installMenu, dispose };
}

module.exports = { createElectronGameHost };
