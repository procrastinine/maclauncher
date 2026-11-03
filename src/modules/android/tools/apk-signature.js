const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const Binary = require("./apksig/binary.json");
const pin = Binary.files[0];
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

function createResolver(resourceRoot = path.join(__dirname, "apksig")) {
  return function resolve() {
    const parts = path.resolve(resourceRoot).split(path.sep);
    const archive = parts.indexOf("app.asar");
    if (archive !== -1) parts[archive] = "app.asar.unpacked";
    const source = path.join(parts.join(path.sep), pin.path);
    let bytes;
    try {
      const physical = require("../../shared/runtime/bundled-native").appAlias(source) || source;
      const stat = fs.lstatSync(physical);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== pin.size) throw Error();
      bytes = fs.readFileSync(physical);
      if (digest(bytes) !== pin.sha256) throw Error();
    } catch { throw new Error("The included Android package signature verifier is unavailable. Reinstall MacLauncher."); }
    return source;
  };
}

module.exports = { resolve: createResolver(), createResolver };
