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
  const selected = argv.find(value => value.startsWith("--user-data="))?.slice("--user-data=".length);
  if (selected && !path.isAbsolute(selected)) throw new Error("--user-data requires an absolute directory.");
  try { app.setPath("userData", selected || path.join(app.getPath("appData"), "maclauncher")); } catch {}
}
function pathsFromArguments(argv, { packaged = true, cwd = process.cwd(), appPath } = {}) {
  const files = new Set();
  for (const value of argv.slice(packaged ? 1 : 2)) {
    if (typeof value !== "string" || !value || value.startsWith("-") || /[\x00-\x1f]/.test(value)) continue;
    try {
      const file = value.startsWith("file:") ? fileURLToPath(value) : path.resolve(cwd, value);
      if (appPath && path.resolve(file) === path.resolve(appPath)) continue;
      const stat = fs.statSync(file); if (stat.isFile() || stat.isDirectory()) files.add(file);
    } catch {}
  }
  return [...files];
}
function startFileOpen({ app, dialog, imports = gameImports, argv = process.argv, cwd = process.cwd() }) {
  if (!documentLauncher(argv)) return true;
  configureLauncherData(app, argv);
  const report = error => {
    if (error.code === "ABORT_ERR" || error.name === "AbortError") return;
    void dialog.showMessageBox({ type: "error", message: "Could not import file", detail: error.message });
  };
  const open = files => { for (const file of files) void imports.import(file).catch(report); };
  // Finder may send documents before ready; the shared FIFO waits for its importer.
  app.on("open-file", (event, file) => { event.preventDefault(); open([file]); });
  app.on("second-instance", (_event, arguments_, workingDirectory, additionalData) => {
    open(Array.isArray(additionalData?.inputPaths) ? additionalData.inputPaths :
      pathsFromArguments(arguments_, { packaged: app.isPackaged, cwd: workingDirectory, appPath: app.getAppPath() }));
    app.emit("activate");
  });
  const inputPaths = pathsFromArguments(argv, { packaged: app.isPackaged, cwd, appPath: app.getAppPath() });
  if (!app.requestSingleInstanceLock({ inputPaths })) { app.quit(); return false; }
  open(inputPaths);
  return true;
}
module.exports = { gameImports, configureLauncherData, documentLauncher, pathsFromArguments, startFileOpen };
