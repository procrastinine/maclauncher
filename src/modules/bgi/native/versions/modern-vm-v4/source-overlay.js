const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Parent = require("../modern-vm-v3/source-overlay");
const Inputs = require("./base-inputs.json");

const VERSION = "0.0.1-build734-mac-vm-v4";
const SOURCE_REVISION = "e2500e0badd04aab472e4620477747973e5e5544";
const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const parentRoot = path.resolve(__dirname, "../modern-vm-v3");
const OWNED = ["bitmap-format.c", "bitmap-format.h"];

function verifyBase() {
  Parent.verifyBase();
  if (Inputs.version !== Parent.VERSION || Inputs.sourceRevision !== SOURCE_REVISION || Parent.SOURCE_REVISION !== SOURCE_REVISION)
    throw new Error("The BGI v4 adapter requires its exact v3 source version.");
  for (const file of Inputs.files) {
    if (!/^[a-z0-9-]+\.(?:c|h|js|json)$/.test(file.path)) throw new Error("Invalid BGI parent source path.");
    const target = path.join(parentRoot, file.path), stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024 || sha256(fs.readFileSync(target)) !== file.sha256)
      throw new Error(`The pinned BGI parent source changed: ${file.path}`);
  }
}

function readStaged(root, file, hash) {
  const target = path.join(root, file), stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024 ||
      !fs.realpathSync(target).startsWith(fs.realpathSync(root) + path.sep))
    throw new Error(`The BGI v4 source context changed: ${file}`);
  const bytes = fs.readFileSync(target);
  if (sha256(bytes) !== hash) throw new Error(`The BGI v4 source context changed: ${file}`);
  return bytes;
}
function replaceOnce(text, before, after, file) {
  if (text.split(before).length !== 2) throw new Error(`The BGI v4 source context changed: ${file}`);
  return text.replace(before, after);
}
function applyGraphics(stageRoot) {
  verifyBase();
  if (!path.isAbsolute(stageRoot || "") || !fs.lstatSync(stageRoot).isDirectory() || fs.lstatSync(stageRoot).isSymbolicLink())
    throw new Error("A regular absolute BGI staged source directory is required.");
  const originals = new Map(Inputs.stagedFiles.map(file => [file.path, readStaged(stageRoot, file.path, file.sha256)]));
  const changed = new Map();
  let text = originals.get("src/vm-dialect.h").toString("utf8");
  text = replaceOnce(text, "    int (*bitmapInfo)(Engine_t *engine, uint32_t slot, uint32_t output[6]);",
    "    int (*bitmapInfo)(Engine_t *engine, uint32_t slot, uint32_t output[6]);\n    uint32_t (*setBitmapFormat)(Engine_t *engine, uint32_t slot, uint32_t format);", "src/vm-dialect.h");
  changed.set("src/vm-dialect.h", Buffer.from(text));
  text = originals.get("src/vm-dialect.c").toString("utf8");
  text = replaceOnce(text, "            case 0x18: {", `            case 0x17:
                if (!pop(thread, &b) || !pop(thread, &a)) break;
                if (!state->setBitmapFormat) { *result = fault(thread, "Bitmap format requires a native resource loader"); return 1; }
                c = state->setBitmapFormat(thread->engine, a, b);
                if (c > 2) { *result = fault(thread, "Bitmap format encountered invalid native storage"); return 1; }
                Thread_PushStack(thread, c); return 1;
            case 0x18: {`, "src/vm-dialect.c");
  changed.set("src/vm-dialect.c", Buffer.from(text));
  text = originals.get("src/bitmap-loader.c").toString("utf8");
  text = replaceOnce(text, '#include "bitmap-loader.h"', '#include "bitmap-loader.h"\n#include "bitmap-format.h"', "src/bitmap-loader.c");
  text = replaceOnce(text, "    state->createBitmap = create; state->clearBitmap = clear; state->blitBitmap = blit;",
    "    state->createBitmap = create; state->clearBitmap = clear; state->blitBitmap = blit;\n    state->setBitmapFormat = MLBGI_SetBitmapFormat;", "src/bitmap-loader.c");
  changed.set("src/bitmap-loader.c", Buffer.from(text));
  text = originals.get("src/main.c").toString("utf8");
  changed.set("src/main.c", Buffer.from(replaceOnce(text, Parent.VERSION, VERSION, "src/main.c")));
  for (const file of OWNED) {
    const target = path.join(__dirname, file), stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error(`Invalid BGI owned source: ${file}`);
    if (fs.existsSync(path.join(stageRoot, "src", file))) throw new Error(`The BGI v4 source context changed: src/${file}`);
    changed.set(`src/${file}`, fs.readFileSync(target));
  }
  verifyBase();
  for (const file of Inputs.stagedFiles) readStaged(stageRoot, file.path, file.sha256);
  const replacements = {};
  for (const [file, bytes] of changed) {
    const target = path.join(stageRoot, file);
    const descriptor = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW |
      (originals.has(file) ? fs.constants.O_TRUNC : fs.constants.O_CREAT | fs.constants.O_EXCL), 0o644);
    try { fs.writeFileSync(descriptor, bytes); } finally { fs.closeSync(descriptor); }
    replacements[file] = { size: bytes.length, sha256: sha256(bytes) };
  }
  return replacements;
}
function stageSource(options) {
  verifyBase();
  const receipt = Parent.stageSource(options), replacements = applyGraphics(options.destination);
  const files = receipt.files.map(file => replacements[file.path] ? { ...file, ...replacements[file.path] } : file);
  for (const file of OWNED) files.push({ path: `src/${file}`, ...replacements[`src/${file}`], owned: true });
  return { ...receipt, version: VERSION, parentVersion: Parent.VERSION, files, sourceTreeSha256: sha256(JSON.stringify(files)) };
}
module.exports = { VERSION, SOURCE_REVISION, INPUTS: Parent.INPUTS, OWNED: [...Parent.OWNED, ...OWNED], verifyBase, applyGraphics, stageSource, sha256 };
