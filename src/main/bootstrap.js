// The packaged application has independent entry points: the launcher UI, the
// web-game runtime and an Electron game's own app. Native engines use src/core
// directly and need none of them.
if (process.argv.includes("--maclauncher-runtime-host")) {
  require("../runtime/electron-game");
} else if (process.argv.some(value => value.startsWith("--maclauncher-electron-app="))) {
  require("../runtime/electron-app");
} else {
  const { app, dialog } = require("electron");
  const { startFileOpen } = require("./file-open");
  if (startFileOpen({ app, dialog })) require("./main");
}
