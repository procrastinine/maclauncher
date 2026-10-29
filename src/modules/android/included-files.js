const fs = require("node:fs"), path = require("node:path");
const B = require("../shared/runtime/bundled-native");
const Included = require("../shared/runtime/included-helpers");
const declarations = require("./distribution-included.json");

function root() {
  const selected = Included.resolveIncluded(declarations, { id: "android-launcher", verification: "full" });
  if (!selected) throw new Error("The included Android integration helpers are unavailable. Reinstall MacLauncher.");
  return path.join(selected.directory, "files");
}
function file(relative) { return path.join(root(), B.relativeFile(relative)); }
function json(relative) { return JSON.parse(fs.readFileSync(file(relative), "utf8")); }
module.exports = { root, file, json };
