const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Parent = require("../modern-vm-v5/source-overlay");
const Inputs = require("./base-inputs.json");

const VERSION = "0.0.1-build734-mac-vm-v6";
const SOURCE_REVISION = "e2500e0badd04aab472e4620477747973e5e5544";
const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const parentRoot = path.resolve(__dirname, "../modern-vm-v5");
const OWNED = ["graphic-offset.c", "graphic-offset.h"];
function verifyBase() {
  Parent.verifyBase();
  if (Inputs.version !== Parent.VERSION || Inputs.sourceRevision !== SOURCE_REVISION || Parent.SOURCE_REVISION !== SOURCE_REVISION)
    throw new Error("The BGI v6 adapter requires its exact v5 source version.");
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
    throw new Error(`The BGI v6 source context changed: ${file}`);
  const bytes = fs.readFileSync(target);
  if (sha256(bytes) !== hash) throw new Error(`The BGI v6 source context changed: ${file}`);
  return bytes;
}
function replaceCount(text, before, after, count, file) {
  if (text.split(before).length !== count + 1) throw new Error(`The BGI v6 source context changed: ${file}`);
  return text.replaceAll(before, after);
}
function applyOffsets(stageRoot) {
  verifyBase();
  if (!path.isAbsolute(stageRoot || "") || !fs.lstatSync(stageRoot).isDirectory() || fs.lstatSync(stageRoot).isSymbolicLink())
    throw new Error("A regular absolute BGI staged source directory is required.");
  const originals = new Map(Inputs.stagedFiles.map(file => [file.path, readStaged(stageRoot, file.path, file.sha256)]));
  const changed = new Map();
  let text = originals.get("src/vm-dialect.h").toString("utf8");
  text = replaceCount(text, "    int32_t offsetX, offsetY;", "    int32_t offsetX, offsetY;\n    int32_t secondOffsetX, secondOffsetY;", 3, "src/vm-dialect.h");
  changed.set("src/vm-dialect.h", Buffer.from(text));
  text = originals.get("src/immediate-bitmap.h").toString("utf8");
  text = replaceCount(text, "    int32_t x, y, secondX, secondY, offsetX, offsetY;", "    int32_t x, y, secondX, secondY, offsetX, offsetY;\n    int32_t secondOffsetX, secondOffsetY;", 1, "src/immediate-bitmap.h");
  changed.set("src/immediate-bitmap.h", Buffer.from(text));
  text = originals.get("src/immediate-bitmap.c").toString("utf8");
  for (const axis of ["X", "Y"]) text = replaceCount(text,
    '(uint32_t)object->' + axis.toLowerCase() + ' + (uint32_t)object->offset' + axis,
    '(uint32_t)object->' + axis.toLowerCase() + ' + (uint32_t)object->offset' + axis + ' + (uint32_t)object->secondOffset' + axis, 1, "src/immediate-bitmap.c");
  changed.set("src/immediate-bitmap.c", Buffer.from(text));
  text = originals.get("src/vm-dialect.c").toString("utf8");
  text = replaceCount(text, '#include "archive-reader.h"', '#include "archive-reader.h"\n#include "graphic-offset.h"', 1, "src/vm-dialect.c");
  for (const [name, axis, count] of [["window", "X", 2], ["window", "Y", 3], ["object", "X", 1], ["object", "Y", 2], ["filter", "Y", 1]])
    text = replaceCount(text, '(uint32_t)' + name + '->' + axis.toLowerCase() + ' + (uint32_t)' + name + '->offset' + axis,
      '(uint32_t)' + name + '->' + axis.toLowerCase() + ' + (uint32_t)' + name + '->offset' + axis + ' + (uint32_t)' + name + '->secondOffset' + axis,
      count, "src/vm-dialect.c");
  text = replaceCount(text, "sceneKey(state, 0, 1, object->offsetY)", "sceneKey(state, 0, 1, (int32_t)((uint32_t)object->offsetY + (uint32_t)object->secondOffsetY))", 1, "src/vm-dialect.c");
  text = replaceCount(text, "    if (group == 0x90 && service == 0x37) {", `    if (group == 0x90 && service == 0x36) {
        if (!pop(thread, &c) || !pop(thread, &b) || !pop(thread, &a)) { *result = UINT32_MAX - 3; return 1; }
        if (!MLBGI_SetGraphicSecondOffset(thread->engine, a, (int32_t)b, (int32_t)c))
            *result = fault(thread, "Secondary graphic offset requires an existing object or a current immediate draw");
        return 1;
    }
    if (group == 0x90 && service == 0x37) {`, 1, "src/vm-dialect.c");
  text = replaceCount(text, "        if (!setObjectOffset(state, a, (int32_t)b, (int32_t)c))", `        if (!a) {
            if (!state->immediateBitmap.allocated) {
                *result = fault(thread, "Graphic offset requires a current immediate draw"); return 1;
            }
            state->immediateBitmap.offsetX = (int32_t)b; state->immediateBitmap.offsetY = (int32_t)c;
            state->drawOrderDirty = 1;
        } else if (!setObjectOffset(state, a, (int32_t)b, (int32_t)c))`, 1, "src/vm-dialect.c");
  changed.set("src/vm-dialect.c", Buffer.from(text));
  text = originals.get("src/main.c").toString("utf8");
  changed.set("src/main.c", Buffer.from(replaceCount(text, Parent.VERSION, VERSION, 1, "src/main.c")));
  for (const file of OWNED) {
    const target = path.join(__dirname, file), stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error(`Invalid BGI owned source: ${file}`);
    if (fs.existsSync(path.join(stageRoot, "src", file))) throw new Error(`The BGI v6 source context changed: src/${file}`);
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
  const receipt = Parent.stageSource(options), replacements = applyOffsets(options.destination);
  const files = receipt.files.map(file => replacements[file.path] ? { ...file, ...replacements[file.path] } : file);
  for (const file of OWNED) files.push({ path: `src/${file}`, ...replacements[`src/${file}`], owned: true });
  return { ...receipt, version: VERSION, parentVersion: Parent.VERSION, files, sourceTreeSha256: sha256(JSON.stringify(files)) };
}
module.exports = { VERSION, SOURCE_REVISION, INPUTS: Parent.INPUTS, OWNED: [...Parent.OWNED, ...OWNED], verifyBase, applyOffsets, stageSource, sha256 };
