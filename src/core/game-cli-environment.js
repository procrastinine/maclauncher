const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/** Describe the loaded distribution without importing Electron's application. */
function initializeCommandEnvironment({ appPath = path.resolve(__dirname, "../..") } = {}) {
  const parent = path.dirname(appPath);
  const isPackaged = ["app.asar", "app"].includes(path.basename(appPath)) &&
    path.basename(parent) === "Resources" && path.basename(path.dirname(parent)) === "Contents";
  // Derive this from the loaded app, including when the executable is a symlink.
  // Resource managers may cache their search roots while modules are imported.
  if (isPackaged) Object.defineProperty(process, "resourcesPath", {
    value: parent, writable: true, configurable: true, enumerable: true
  });
  return {
    appPath,
    createApp(userDataDir = path.join(os.homedir(), "Library/Application Support/maclauncher")) {
      const home = os.homedir();
      const paths = { home, userData: path.resolve(userDataDir), appData: path.join(home, "Library/Application Support"),
        temp: os.tmpdir(), exe: process.execPath, desktop: path.join(home, "Desktop"),
        documents: path.join(home, "Documents"), downloads: path.join(home, "Downloads"),
        logs: path.join(userDataDir, "logs") };
      let version;
      try { version = JSON.parse(fs.readFileSync(path.join(appPath, "package.json"), "utf8")).version; } catch {}
      return { isPackaged, getAppPath: () => appPath, getPath: name => paths[name],
        getVersion: () => version, getName: () => "MacLauncher" };
    }
  };
}

module.exports = { initializeCommandEnvironment };
