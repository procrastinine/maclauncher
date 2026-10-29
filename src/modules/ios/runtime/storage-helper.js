const fs = require("node:fs"), path = require("node:path");
const Bundled = require("../../shared/runtime/bundled-native");
const Included = require("../../shared/runtime/included-helpers");
const declarations = require("../distribution-supplementals.json");
function resolveStorageHelper() {
  const pin = declarations.find(item => item.id === "ios-playtools-paths");
  const included = Included.resolveIncluded(declarations, { id: pin.id, version: pin.version, verification: "full" });
  if (included) {
    const { directory } = included;
    return fs.realpathSync(path.join(directory, "libplaytools-paths.dylib"));
  }
  throw new Error("The included PlayTools storage adapter is missing. Reinstall MacLauncher.");
}
module.exports = { resolveStorageHelper };
