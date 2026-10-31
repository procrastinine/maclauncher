const fs = require("node:fs"), path = require("node:path");
const Bundled = require("../../shared/runtime/bundled-native");
const Included = require("../../shared/runtime/included-helpers");
const declarations = require("../distribution-supplementals.json");
function resolveStorageHelper() {
  const pin = declarations.find(item => item.id === "ios-playtools-paths");
  const { directory } = Included.requireIncluded(declarations, { id: pin.id, version: pin.version, verification: "full" });
  return fs.realpathSync(path.join(directory, "libplaytools-paths.dylib"));
}
module.exports = { resolveStorageHelper };
