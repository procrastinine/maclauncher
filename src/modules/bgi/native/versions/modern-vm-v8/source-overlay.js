const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Parent = require("../modern-vm-v7/source-overlay");
const Inputs = require("./base-inputs.json");

const VERSION = "0.0.1-build734-mac-vm-v8";
const SOURCE_REVISION = "e2500e0badd04aab472e4620477747973e5e5544";
const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const parentRoot = path.resolve(__dirname, "../modern-vm-v7");
const OWNED = ["bitmap-crossfade.c", "bitmap-crossfade.h"];
function verifyBase() {
  Parent.verifyBase();
  if (Inputs.version !== Parent.VERSION || Inputs.sourceRevision !== SOURCE_REVISION || Parent.SOURCE_REVISION !== SOURCE_REVISION)
    throw new Error("The BGI v8 adapter requires its exact v7 source version.");
  for (const file of Inputs.files) {
    if (!/^(?:[a-z0-9-]+\.(?:c|h|js|json)|README\.md)$/.test(file.path)) throw new Error("Invalid BGI parent source path.");
    const target = path.join(parentRoot, file.path), stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024 || sha256(fs.readFileSync(target)) !== file.sha256)
      throw new Error(`The pinned BGI parent source changed: ${file.path}`);
  }
}
function readStaged(root, file, hash) {
  const target = path.join(root, file), stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024 ||
      !fs.realpathSync(target).startsWith(fs.realpathSync(root) + path.sep))
    throw new Error(`The BGI v8 source context changed: ${file}`);
  const bytes = fs.readFileSync(target);
  if (sha256(bytes) !== hash) throw new Error(`The BGI v8 source context changed: ${file}`);
  return bytes;
}
function replaceCount(text, before, after, count, file) {
  if (text.split(before).length !== count + 1) throw new Error(`The BGI v8 source context changed: ${file}`);
  return text.replaceAll(before, after);
}
function applyCrossfade(stageRoot) {
  verifyBase();
  if (!path.isAbsolute(stageRoot || "") || !fs.lstatSync(stageRoot).isDirectory() || fs.lstatSync(stageRoot).isSymbolicLink())
    throw new Error("A regular absolute BGI staged source directory is required.");
  const originals = new Map(Inputs.stagedFiles.map(file => [file.path, readStaged(stageRoot, file.path, file.sha256)]));
  const changed = new Map();
  let text = originals.get("src/immediate-bitmap.h").toString("utf8");
  text = replaceCount(text, "    const void *sourceIdentity;", "    const void *sourceIdentity;\n    int hasSecond;\n    uint32_t transparency;\n    const void *secondSourceIdentity;", 1, "src/immediate-bitmap.h");
  changed.set("src/immediate-bitmap.h", Buffer.from(text));
  text = originals.get("src/immediate-bitmap.c").toString("utf8");
  text = replaceCount(text, '#include "current-draw.h"', '#include "current-draw.h"\n#include "bitmap-crossfade.h"', 1, "src/immediate-bitmap.c");
  text = replaceCount(text, "int MLBGI_SetImmediateBitmap(Engine_t *engine, const uint32_t values[9]) {", `int MLBGI_SetImmediateBitmap(Engine_t *engine, const uint32_t values[9]) {
    if (values && values[5] != 0x7fff && values[5] != UINT32_MAX)
        return MLBGI_SetImmediateCrossfade(engine, values);`, 1, "src/immediate-bitmap.c");
  text = replaceCount(text, "    object->sourceValid = 1; object->bitmapSlot = values[2]; object->sourceIdentity = bitmap;", `    object->sourceValid = 1; object->bitmapSlot = values[2]; object->sourceIdentity = bitmap;
    object->hasSecond = 0; object->transparency = 0; object->secondSourceIdentity = NULL;`, 1, "src/immediate-bitmap.c");
  text = replaceCount(text, "state->immediateBitmap.allocated && state->immediateBitmap.bitmapSlot == slot", "state->immediateBitmap.allocated && (state->immediateBitmap.bitmapSlot == slot ||\n        (state->immediateBitmap.hasSecond && state->immediateBitmap.selector == slot))", 1, "src/immediate-bitmap.c");
  text = replaceCount(text, "        state->immediateBitmap.sourceIdentity = NULL;", "        state->immediateBitmap.sourceIdentity = NULL;\n        state->immediateBitmap.secondSourceIdentity = NULL;", 1, "src/immediate-bitmap.c");
  text = replaceCount(text, "    if (!object->sourceValid) { clearCanvas(rgba, width, height, stride); return 1; }", `    if (!object->sourceValid) { clearCanvas(rgba, width, height, stride); return 1; }
    if (object->hasSecond) {
        int drawn = MLBGI_DrawImmediateCrossfade(engine, rgba, capacity, width, height, stride);
        if (drawn < 0) clearCanvas(rgba, width, height, stride);
        return drawn != 0;
    }`, 1, "src/immediate-bitmap.c");
  changed.set("src/immediate-bitmap.c", Buffer.from(text));
  text = originals.get("src/current-draw.c").toString("utf8");
  text = replaceCount(text, "object->bitmapSlot == UINT32_MAX && !object->sourceIdentity;", "object->bitmapSlot == UINT32_MAX && !object->sourceIdentity &&\n        !object->hasSecond && !object->transparency && !object->secondSourceIdentity;", 1, "src/current-draw.c");
  changed.set("src/current-draw.c", Buffer.from(text));
  text = originals.get("src/vm-dialect.c").toString("utf8");
  text = replaceCount(text, "Immediate bitmap draw requires a valid bitmap, plain source selector, no mask and zero transparency", "Immediate bitmap draw requires valid bitmap sources and a supported no-mask transparency branch", 1, "src/vm-dialect.c");
  changed.set("src/vm-dialect.c", Buffer.from(text));
  text = originals.get("src/main.c").toString("utf8");
  changed.set("src/main.c", Buffer.from(replaceCount(text, Parent.VERSION, VERSION, 1, "src/main.c")));
  for (const file of OWNED) {
    const target = path.join(__dirname, file), stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error(`Invalid BGI owned source: ${file}`);
    if (fs.existsSync(path.join(stageRoot, "src", file))) throw new Error(`The BGI v8 source context changed: src/${file}`);
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
  const receipt = Parent.stageSource(options), replacements = applyCrossfade(options.destination);
  const files = receipt.files.map(file => replacements[file.path] ? { ...file, ...replacements[file.path] } : file);
  for (const file of OWNED) files.push({ path: `src/${file}`, ...replacements[`src/${file}`], owned: true });
  return { ...receipt, version: VERSION, parentVersion: Parent.VERSION, files, sourceTreeSha256: sha256(JSON.stringify(files)) };
}
module.exports = { VERSION, SOURCE_REVISION, INPUTS: Parent.INPUTS, OWNED: [...Parent.OWNED, ...OWNED], verifyBase, applyCrossfade, stageSource, sha256 };
