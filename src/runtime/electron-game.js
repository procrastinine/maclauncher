const path = require("node:path");
const { createHostedStartupReporter, guardHostedOutput } = require("../core/hosted-startup-reporter");

function parseArguments(argv) {
  const value = name => argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const game = value("game");
  if (!game?.trim()) throw new Error("A game is required: --game=/path/to/game");
  const runtimeId = value("runtime") || "electron";
  const userData = value("user-data");
  return { gamePath: path.resolve(game), runtimeId, userDataDir: userData ? path.resolve(userData) : null };
}

/** Standalone hosted runtime: uses core services without loading the launcher UI. */
async function startElectronGame({ argv = process.argv, electron, createLauncher, createElectronGameHost, logger, startupReporter } = {}) {
  const args = parseArguments(argv);
  electron ||= require("electron");
  createLauncher ||= require("../core/launcher").createLauncher;
  createElectronGameHost ||= require("../modules/shared/web/runtime/electron-host").createElectronGameHost;
  const { app, nativeImage } = electron;
  app.setName("MacLauncher");
  const userDataDir = args.userDataDir || path.join(app.getPath("appData"), "maclauncher");
  logger ||= require("../core/hosted-logger").createHostedLogger(userDataDir);
  app.setPath("userData", userDataDir);
  if (process.env.MACLAUNCHER_DEBUG === "1" || argv.includes("--maclauncher-smoke")) {
    app.commandLine.appendSwitch("enable-logging");
    app.commandLine.appendSwitch("enable-crash-reporter");
  }
  let host;
  let startupFailure;
  const startupWindows = new Map();
  const clearStartupListeners = () => {
    for (const [win, listeners] of startupWindows) {
      win.removeListener("closed", listeners.closed);
      listeners.webContents.removeListener("did-fail-load", listeners.failed);
      listeners.webContents.removeListener("render-process-gone", listeners.gone);
      listeners.webContents.removeListener("did-stop-loading", listeners.stopped);
    }
    startupWindows.clear();
  };
  const launcher = createLauncher({
    userDataDir, logger, app, ui: { shell: electron.shell, dialog: electron.dialog, nativeImage },
    launchHosted: (entry, runtimeId, context) => host.createGameWindow(entry, { runtimeId, context })
  });
  host = createElectronGameHost({
    electron, userDataDir, logger, isSmoke: argv.includes("--maclauncher-smoke"),
    onWindowCreated: win => {
      if (!startupReporter.enabled) return;
      const webContents = win.webContents;
      const failed = error => {
        startupFailure ||= error;
        startupReporter.error(error);
        listeners.finish?.(error);
      };
      const listeners = {
        webContents,
        closed: () => failed(new Error("The game window closed before it loaded.")),
        failed: (_event, code, description, url, isMainFrame) => {
          if (isMainFrame) failed(new Error(`The game window failed to load (${code}: ${description}) ${url || ""}`));
        },
        gone: (_event, detail) => failed(new Error(`The game renderer exited during startup (${detail?.reason || "unknown"}).`)),
        stopped: () => {
          if (!webContents.isLoadingMainFrame?.()) listeners.finish?.();
        },
        waitUntilLoaded: () => new Promise((resolve, reject) => {
          listeners.finish = error => error ? reject(error) : resolve();
          if (startupFailure) reject(startupFailure);
          else listeners.stopped();
        })
      };
      startupWindows.set(win, listeners);
      win.once("closed", listeners.closed);
      webContents.on("did-fail-load", listeners.failed);
      webContents.once("render-process-gone", listeners.gone);
      webContents.on("did-stop-loading", listeners.stopped);
    },
    getLaunchContext: (entry, settings, options) => launcher.getLaunchContext(entry, settings, options),
    applyDockIdentity: entry => {
      if (process.platform !== "darwin") return;
      try { if (entry.name) app.setName(entry.name); } catch {}
      try {
        if (entry.iconPath) {
          const icon = nativeImage.createFromPath(entry.iconPath);
          if (!icon.isEmpty()) app.dock.setIcon(icon);
        }
      } catch {}
    }
  });
  const onAllClosed = () => app.quit();
  const onBeforeQuit = () => { void host.dispose(); };
  app.on("window-all-closed", onAllClosed);
  app.on("before-quit", onBeforeQuit);
  try {
    await app.whenReady();
    host.installIpc();
    host.installMenu();
    const settings = launcher.loadSettings();
    const entry = await launcher.resolveEntry(args.gamePath, { runtimeId: args.runtimeId, persist: false });
    const result = await launcher.launchEntry(entry, { runtimeId: args.runtimeId, settings });
    if (startupReporter.enabled) {
      if (startupFailure) throw startupFailure;
      const win = result?.win;
      const startup = startupWindows.get(win);
      const webContents = startup?.webContents;
      if (!win || win.isDestroyed?.() || !webContents || webContents.isDestroyed?.()) {
        throw new Error("Hosted runtime did not create and load its game BrowserWindow.");
      }
      // Chromium can still report main-frame loading immediately after loadURL
      // resolves. Wait for did-stop-loading before acknowledging this window.
      await startup.waitUntilLoaded();
      if (startupFailure) throw startupFailure;
      if (win.isDestroyed?.() || webContents.isDestroyed?.() || !webContents.getURL?.()) {
        throw new Error("Hosted runtime did not create and load its game BrowserWindow.");
      }
      startupReporter.ready({ windowId: win.id, url: webContents.getURL() });
    }
    clearStartupListeners();
    return { launcher, host, entry, result };
  } catch (error) {
    clearStartupListeners();
    app.removeListener("window-all-closed", onAllClosed);
    app.removeListener("before-quit", onBeforeQuit);
    await host.dispose();
    throw error;
  }
}

async function runElectronGame(options = {}) {
  const startupReporter = options.startupReporter || createHostedStartupReporter();
  if (startupReporter.enabled) guardHostedOutput();
  try { return await startElectronGame({ ...options, startupReporter }); }
  catch (error) { startupReporter.error(error); throw error; }
}

if (require.main === module || process.argv.includes("--maclauncher-runtime-host")) {
  runElectronGame().catch(error => {
    console.error("[electron-game]", String(error?.stack || error));
    require("electron").app.exit(1);
  });
}

module.exports = { parseArguments, runElectronGame };
