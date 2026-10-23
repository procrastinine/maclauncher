// The packaged application has two independent entry points: the launcher UI and
// the web-game runtime. Native engines use src/core directly and need neither.
if (process.argv.includes("--maclauncher-runtime-host")) {
  require("../runtime/electron-game");
} else {
  const { app, dialog } = require("electron");
  const { startFileOpen } = require("./file-open");
  if (startFileOpen({ app, dialog })) require("./main");
}
