const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const Writable = require("../../shared/writable-input");
const Binary = require("./apksig/binary.json");
const pin = Binary.files[0];
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

function createResolver(resourceRoot = path.join(__dirname, "apksig")) {
  return function resolve(userDataDir) {
    const source = path.join(resourceRoot, pin.path);
    let bytes;
    try {
      const stat = fs.lstatSync(source);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== pin.size) throw Error();
      bytes = fs.readFileSync(source);
      if (digest(bytes) !== pin.sha256) throw Error();
    } catch { throw new Error("The included Android package signature verifier is unavailable. Reinstall MacLauncher."); }
    if (!path.resolve(source).split(path.sep).some(part => part.endsWith(".asar"))) return source;
    if (!path.isAbsolute(userDataDir || "")) throw new Error("Android package verification requires private launcher storage.");
    // Java cannot read Electron's virtual ASAR entries. Reuse one authenticated
    // physical helper, independently of any installed Android game runtime.
    const directory = path.join(userDataDir, "internal-tools/apksig", pin.sha256);
    Writable.assertOwnDirectory(userDataDir, directory);
    const file = path.join(directory, pin.path);
    if (fs.existsSync(file)) {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== pin.size || digest(fs.readFileSync(file)) !== pin.sha256)
        throw new Error("The Android package signature verifier changed on disk.");
    } else Writable.atomicWrite(file, bytes, { root: directory });
    return file;
  };
}

module.exports = { resolve: createResolver(), createResolver };
