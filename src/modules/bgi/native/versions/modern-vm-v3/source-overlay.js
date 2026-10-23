const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Base = require("../../source-overlay");
const Inputs = require("./base-inputs.json");

const VERSION = "0.0.1-build734-mac-vm-v3";
const SOURCE_REVISION = "e2500e0badd04aab472e4620477747973e5e5544";
const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const baseRoot = path.resolve(__dirname, "../..");
const parentFiles = new Map(Inputs.files.map(file => [file.path, file.sha256]));

function verifyBase() {
  if (Inputs.version !== Base.VERSION || Inputs.sourceRevision !== SOURCE_REVISION || Base.SOURCE_REVISION !== SOURCE_REVISION)
    throw new Error("The BGI v3 adapter requires its exact v2 source version.");
  for (const file of Inputs.files) {
    if (!/^[a-z0-9-]+\.(?:c|h|js|json)$/.test(file.path)) throw new Error("Invalid BGI parent source path.");
    const target = path.join(baseRoot, file.path), stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024 || sha256(fs.readFileSync(target)) !== file.sha256)
      throw new Error(`The pinned BGI parent source changed: ${file.path}`);
  }
}

function readStaged(root, file, priorHash) {
  const target = path.join(root, file), stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024 ||
      !fs.realpathSync(target).startsWith(fs.realpathSync(root) + path.sep))
    throw new Error(`The BGI v3 source context changed: ${file}`);
  const bytes = fs.readFileSync(target);
  if (sha256(bytes) !== priorHash) throw new Error(`The BGI v3 source context changed: ${file}`);
  return bytes;
}

function replaceStaged(root, file, priorHash, bytes) {
  readStaged(root, file, priorHash);
  const target = path.join(root, file);
  const descriptor = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW);
  try { fs.writeFileSync(descriptor, bytes); } finally { fs.closeSync(descriptor); }
  return { size: bytes.length, sha256: sha256(bytes) };
}

function applyCodec(stageRoot) {
  verifyBase();
  if (!path.isAbsolute(stageRoot || "") || !fs.lstatSync(stageRoot).isDirectory() || fs.lstatSync(stageRoot).isSymbolicLink())
    throw new Error("A regular absolute BGI staged source directory is required.");
  readStaged(stageRoot, "src/cbg-bitmap.c", parentFiles.get("cbg-bitmap.c"));
  const main = readStaged(stageRoot, "src/main.c", parentFiles.get("probe-main.c")).toString("utf8");
  if (main.split(Base.VERSION).length !== 2) throw new Error("The BGI v3 probe version context changed.");
  const replacements = {};
  replacements["src/cbg-bitmap.c"] = replaceStaged(stageRoot, "src/cbg-bitmap.c", parentFiles.get("cbg-bitmap.c"),
    fs.readFileSync(path.join(__dirname, "cbg-bitmap.c")));
  replacements["src/main.c"] = replaceStaged(stageRoot, "src/main.c", parentFiles.get("probe-main.c"),
    Buffer.from(main.replace(Base.VERSION, VERSION)));
  verifyBase();
  return replacements;
}

function stageSource(options) {
  verifyBase();
  const receipt = Base.stageSource(options), replacements = applyCodec(options.destination);
  const files = receipt.files.map(file => replacements[file.path] ? { ...file, ...replacements[file.path] } : file);
  return { ...receipt, version: VERSION, parentVersion: Base.VERSION, files, sourceTreeSha256: sha256(JSON.stringify(files)) };
}

module.exports = { VERSION, SOURCE_REVISION, INPUTS: Base.INPUTS, OWNED: Base.OWNED, verifyBase, applyCodec, stageSource, sha256 };
