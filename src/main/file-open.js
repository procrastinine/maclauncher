const { createGameImportQueue } = require("../core/game-import-queue");
const fs = require("node:fs"), path = require("node:path"), { fileURLToPath } = require("node:url");

// Shared by the early Apple-event listener and the launcher IPC/menu adapters.
const gameImports = createGameImportQueue();

function documentLauncher(argv) {
  return !argv.some(value => ["--maclauncher-runtime-host", "--maclauncher-game-child", "--maclauncher-smoke"].includes(value) ||
    value.startsWith("--maclauncher-game="));
}
function configureLauncherData(app, argv) {
  try { app.setName("MacLauncher"); } catch {}
  const argument = argv.find(value => typeof value === "string" && value.startsWith("--user-data="));
  const selected = argument?.slice("--user-data=".length);
  if (argument !== undefined) {
    if (!selected || !path.isAbsolute(selected)) throw new Error("--user-data requires an absolute directory.");
    fs.mkdirSync(selected, { recursive: true, mode: 0o700 });
    app.setPath("userData", selected);
    app.setPath("sessionData", selected);
    app.setAppLogsPath(path.join(selected, "logs"));
    return;
  }
  try { app.setPath("userData", path.join(app.getPath("appData"), "maclauncher")); } catch {}
}
function pathsFromArguments(argv, { packaged = true, defaultApp = false, cwd = process.cwd(), appPath } = {}) {
  const files = new Set();
  // A renamed development Electron bundle is packaged, but still receives its
  // source entry point at argv[1]. Electron identifies that mode as defaultApp.
  for (const value of argv.slice(packaged && !defaultApp ? 1 : 2)) {
    if (typeof value !== "string" || !value || value.startsWith("-") || /[\x00-\x1f]/.test(value)) continue;
    try {
      const file = value.startsWith("file:") ? fileURLToPath(value) : path.resolve(cwd, value);
      if (appPath && path.resolve(file) === path.resolve(appPath)) continue;
      const stat = fs.statSync(file); if (stat.isFile() || stat.isDirectory()) files.add(file);
    } catch {}
  }
  return [...files];
}
function startFileOpen({ app, dialog, imports = gameImports, argv = process.argv, cwd = process.cwd(), defaultApp = Boolean(process.defaultApp) }) {
  if (!documentLauncher(argv)) return true;
  configureLauncherData(app, argv);
  const report = (error, file) => {
    if (error.code === "ABORT_ERR" || error.name === "AbortError") return;
    void dialog.showMessageBox({ type: "error", message: "Could not import file", detail: `${file}\n\n${error.message}` });
  };
  const open = files => { for (const file of files) void imports.import(file).catch(error => report(error, file)); };
  // Finder may send documents before ready; the shared FIFO waits for its importer.
  app.on("open-file", (event, file) => { event.preventDefault(); open([file]); });
  app.on("second-instance", (_event, arguments_, workingDirectory, additionalData) => {
    open(Array.isArray(additionalData?.inputPaths) ? additionalData.inputPaths :
      pathsFromArguments(arguments_, { packaged: app.isPackaged, defaultApp, cwd: workingDirectory, appPath: app.getAppPath() }));
    app.emit("activate");
  });
  const inputPaths = pathsFromArguments(argv, { packaged: app.isPackaged, defaultApp, cwd, appPath: app.getAppPath() });
  if (!app.requestSingleInstanceLock({ inputPaths })) { app.quit(); return false; }
  open(inputPaths);
  return true;
}
module.exports = { gameImports, configureLauncherData, documentLauncher, pathsFromArguments, startFileOpen };
