// The packaged application has two independent entry points: the launcher UI and
// the web-game runtime. Native engines use src/core directly and need neither.
if (process.argv.includes("--maclauncher-runtime-host")) {
  require("../runtime/electron-game");
} else {
  const { app, dialog } = require("electron");
  const { gameImports } = require("./file-open");
  // Register before loading engine modules: Finder can deliver this before ready.
  app.on("open-file", (event, filePath) => {
    event.preventDefault();
    void gameImports.import(filePath).catch(error => {
      if (error.code === "ABORT_ERR" || error.name === "AbortError") return;
      void dialog.showMessageBox({ type: "error", message: "Could not add game", detail: error.message });
    });
  });
  require("./main");
}
