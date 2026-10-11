const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Parent = require("../modern-vm-v6/source-overlay");
const Inputs = require("./base-inputs.json");

const VERSION = "0.0.1-build734-mac-vm-v7";
const SOURCE_REVISION = "e2500e0badd04aab472e4620477747973e5e5544";
const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const parentRoot = path.resolve(__dirname, "../modern-vm-v6");
const OWNED = ["current-draw.c", "current-draw.h"];
function verifyBase() {
  Parent.verifyBase();
  if (Inputs.version !== Parent.VERSION || Inputs.sourceRevision !== SOURCE_REVISION || Parent.SOURCE_REVISION !== SOURCE_REVISION)
    throw new Error("The BGI v7 adapter requires its exact v6 source version.");
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
    throw new Error(`The BGI v7 source context changed: ${file}`);
  const bytes = fs.readFileSync(target);
  if (sha256(bytes) !== hash) throw new Error(`The BGI v7 source context changed: ${file}`);
  return bytes;
}
function replaceCount(text, before, after, count, file) {
  if (text.split(before).length !== count + 1) throw new Error(`The BGI v7 source context changed: ${file}`);
  return text.replaceAll(before, after);
}
function applyCurrentDraw(stageRoot) {
  verifyBase();
  if (!path.isAbsolute(stageRoot || "") || !fs.lstatSync(stageRoot).isDirectory() || fs.lstatSync(stageRoot).isSymbolicLink())
    throw new Error("A regular absolute BGI staged source directory is required.");
  const originals = new Map(Inputs.stagedFiles.map(file => [file.path, readStaged(stageRoot, file.path, file.sha256)]));
  const changed = new Map();
  let text = originals.get("src/immediate-bitmap.h").toString("utf8");
  text = replaceCount(text, "    uint32_t bitmapSlot, selector, maskParameter;", "    uint32_t type, bitmapSlot, selector, maskParameter;", 1, "src/immediate-bitmap.h");
  changed.set("src/immediate-bitmap.h", Buffer.from(text));
  text = originals.get("src/immediate-bitmap.c").toString("utf8");
  text = replaceCount(text, '#include "immediate-bitmap.h"', '#include "immediate-bitmap.h"\n#include "current-draw.h"', 1, "src/immediate-bitmap.c");
  text = replaceCount(text, `    if (!object->allocated) {
        if (state->drawSequence == UINT64_MAX) return 0;
        *object = (MLBGI_ImmediateBitmap){ .allocated = 1, .drawSequence = ++state->drawSequence };
    }`, `    if (!MLBGI_SelectCurrentBitmap(engine)) return 0;`, 1, "src/immediate-bitmap.c");
  text = replaceCount(text, "    if (!object->allocated) return 1;", "    if (!object->allocated) return 1;\n    if (!MLBGI_CurrentDrawSupported(object)) return 0;", 1, "src/immediate-bitmap.c");
  changed.set("src/immediate-bitmap.c", Buffer.from(text));
  text = originals.get("src/graphic-offset.c").toString("utf8");
  text = replaceCount(text, '#include "graphic-offset.h"', '#include "graphic-offset.h"\n#include "current-draw.h"', 1, "src/graphic-offset.c");
  text = replaceCount(text, "    if (!handle) return state->immediateBitmap.allocated;", "    if (!handle) return MLBGI_CurrentDrawSupported(&state->immediateBitmap);", 1, "src/graphic-offset.c");
  changed.set("src/graphic-offset.c", Buffer.from(text));
  text = originals.get("src/vm-dialect.c").toString("utf8");
  text = replaceCount(text, '#include "graphic-offset.h"', '#include "graphic-offset.h"\n#include "current-draw.h"', 1, "src/vm-dialect.c");
  text = replaceCount(text, "    engine->mlRuntime = state; return 1;", `    engine->mlRuntime = state;
    if (dialect == MLBGI_ETHORNELL_172 && !MLBGI_InitializeCurrentDraw(engine)) {
        MLBGI_FreeDialect(engine); return 0;
    }
    return 1;`, 1, "src/vm-dialect.c");
  text = replaceCount(text, "            if (!state->immediateBitmap.allocated) {", "            if (!MLBGI_CurrentDrawSupported(&state->immediateBitmap)) {", 1, "src/vm-dialect.c");
  changed.set("src/vm-dialect.c", Buffer.from(text));
  text = originals.get("src/main.c").toString("utf8");
  changed.set("src/main.c", Buffer.from(replaceCount(text, Parent.VERSION, VERSION, 1, "src/main.c")));
  for (const file of OWNED) {
    const target = path.join(__dirname, file), stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error(`Invalid BGI owned source: ${file}`);
    if (fs.existsSync(path.join(stageRoot, "src", file))) throw new Error(`The BGI v7 source context changed: src/${file}`);
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
  const receipt = Parent.stageSource(options), replacements = applyCurrentDraw(options.destination);
  const files = receipt.files.map(file => replacements[file.path] ? { ...file, ...replacements[file.path] } : file);
  for (const file of OWNED) files.push({ path: `src/${file}`, ...replacements[`src/${file}`], owned: true });
  return { ...receipt, version: VERSION, parentVersion: Parent.VERSION, files, sourceTreeSha256: sha256(JSON.stringify(files)) };
}
module.exports = { VERSION, SOURCE_REVISION, INPUTS: Parent.INPUTS, OWNED: [...Parent.OWNED, ...OWNED], verifyBase, applyCurrentDraw, stageSource, sha256 };
