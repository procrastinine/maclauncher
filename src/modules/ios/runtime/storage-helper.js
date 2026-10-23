const fs = require("node:fs"), path = require("node:path");
const Bundled = require("../../shared/runtime/bundled-native");
const declarations = require("../distribution-supplementals.json");
function resolveStorageHelper() {
  const pin = declarations.find(item => item.id === "ios-playtools-paths");
  for (const root of [process.resourcesPath, path.resolve(__dirname, "../../../resources")].filter(Boolean)) {
    const directory = path.join(root, "native-runtimes", pin.directoryRelative);
    if (!fs.existsSync(directory)) continue;
    Bundled.verifyPayload(directory, pin);
    return fs.realpathSync(path.join(directory, "libplaytools-paths.dylib"));
  }
  throw new Error("The included PlayTools storage adapter is missing. Reinstall MacLauncher.");
}
module.exports = { resolveStorageHelper };
