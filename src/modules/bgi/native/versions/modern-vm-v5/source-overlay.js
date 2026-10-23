const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Parent = require("../modern-vm-v4/source-overlay");
const Inputs = require("./base-inputs.json");

const VERSION = "0.0.1-build734-mac-vm-v5";
const SOURCE_REVISION = "e2500e0badd04aab472e4620477747973e5e5544";
const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const parentRoot = path.resolve(__dirname, "../modern-vm-v4");
const OWNED = ["immediate-bitmap.c", "immediate-bitmap.h"];
function verifyBase() {
  Parent.verifyBase();
  if (Inputs.version !== Parent.VERSION || Inputs.sourceRevision !== SOURCE_REVISION || Parent.SOURCE_REVISION !== SOURCE_REVISION)
    throw new Error("The BGI v5 adapter requires its exact v4 source version.");
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
    throw new Error(`The BGI v5 source context changed: ${file}`);
  const bytes = fs.readFileSync(target);
  if (sha256(bytes) !== hash) throw new Error(`The BGI v5 source context changed: ${file}`);
  return bytes;
}
function replaceCount(text, before, after, count, file) {
  if (text.split(before).length !== count + 1) throw new Error(`The BGI v5 source context changed: ${file}`);
  return text.replaceAll(before, after);
}
function applyCompositor(stageRoot) {
  verifyBase();
  if (!path.isAbsolute(stageRoot || "") || !fs.lstatSync(stageRoot).isDirectory() || fs.lstatSync(stageRoot).isSymbolicLink())
    throw new Error("A regular absolute BGI staged source directory is required.");
  const originals = new Map(Inputs.stagedFiles.map(file => [file.path, readStaged(stageRoot, file.path, file.sha256)]));
  const changed = new Map();
  let text = originals.get("src/vm-dialect.h").toString("utf8");
  text = replaceCount(text, '#include "platform-text.h"', '#include "platform-text.h"\n#include "immediate-bitmap.h"', 1, "src/vm-dialect.h");
  text = replaceCount(text, "    MLBGI_Sprite sprites[512];", "    MLBGI_Sprite sprites[512];\n    MLBGI_ImmediateBitmap immediateBitmap;", 1, "src/vm-dialect.h");
  changed.set("src/vm-dialect.h", Buffer.from(text));
  text = originals.get("src/vm-dialect.c").toString("utf8");
  text = replaceCount(text, "        state->rootOffsetX = x; state->rootOffsetY = y;", `        state->rootOffsetX = x; state->rootOffsetY = y;
        if (state->immediateBitmap.allocated) {
            state->immediateBitmap.offsetX = x; state->immediateBitmap.offsetY = y;
        }`, 1, "src/vm-dialect.c");
  text = replaceCount(text, "    SceneEntry entries[536]; unsigned count = 0;", `    SceneEntry entries[537]; unsigned count = 0;
    if (state->immediateBitmap.allocated) {
        const MLBGI_ImmediateBitmap *object = &state->immediateBitmap;
        uint32_t key = sceneKey(state, 0, 1, object->offsetY);
        if (key <= maximumKey) entries[count++] = (SceneEntry){ key, 0x70000000, object->drawSequence };
    }`, 1, "src/vm-dialect.c");
  text = replaceCount(text, "        okay = (entries[i].handle & 0xff000000) == 0x80000000 ? drawSprite(",
    "        okay = entries[i].handle == 0x70000000 ? MLBGI_DrawImmediateBitmap(engine, canvas, bytes, width, height, (size_t)width * 4) :\n            (entries[i].handle & 0xff000000) == 0x80000000 ? drawSprite(", 1, "src/vm-dialect.c");
  text = replaceCount(text, "    if (group == 0x90 && service == 0x50) {", `    if (group == 0x90 && service == 0x43) {
        uint32_t values[9];
        for (int i = 8; i >= 0; i--) if (!pop(thread, &values[i])) { *result = UINT32_MAX - 3; return 1; }
        if (!MLBGI_SetImmediateBitmap(thread->engine, values)) {
            *result = fault(thread, "Immediate bitmap draw requires a valid bitmap, plain source selector, no mask and zero transparency"); return 1;
        }
        return 1;
    }
    if (group == 0x90 && service == 0x50) {`, 1, "src/vm-dialect.c");
  changed.set("src/vm-dialect.c", Buffer.from(text));
  text = originals.get("src/bitmap-loader.c").toString("utf8");
  text = replaceCount(text, '#include "bitmap-format.h"', '#include "bitmap-format.h"\n#include "immediate-bitmap.h"', 1, "src/bitmap-loader.c");
  text = replaceCount(text, "    renderer->bitmaps[slot] = bitmap;", "    MLBGI_InvalidateImmediateBitmap(renderer->engine, slot);\n    renderer->bitmaps[slot] = bitmap;", 2, "src/bitmap-loader.c");
  text = replaceCount(text, "    renderer->bitmaps[destination] = bitmap;", "    MLBGI_InvalidateImmediateBitmap(renderer->engine, destination);\n    renderer->bitmaps[destination] = bitmap;", 1, "src/bitmap-loader.c");
  text = replaceCount(text, "    renderer->bitmaps[slot] = NULL;", "    MLBGI_InvalidateImmediateBitmap(renderer->engine, slot);\n    renderer->bitmaps[slot] = NULL;", 1, "src/bitmap-loader.c");
  text = replaceCount(text, "    engine->renderer->bitmaps[slot] = bitmap;", "    MLBGI_InvalidateImmediateBitmap(engine, slot);\n    engine->renderer->bitmaps[slot] = bitmap;", 1, "src/bitmap-loader.c");
  changed.set("src/bitmap-loader.c", Buffer.from(text));
  text = originals.get("src/main.c").toString("utf8");
  changed.set("src/main.c", Buffer.from(replaceCount(text, Parent.VERSION, VERSION, 1, "src/main.c")));
  for (const file of OWNED) {
    const target = path.join(__dirname, file), stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error(`Invalid BGI owned source: ${file}`);
    if (fs.existsSync(path.join(stageRoot, "src", file))) throw new Error(`The BGI v5 source context changed: src/${file}`);
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
  const receipt = Parent.stageSource(options), replacements = applyCompositor(options.destination);
  const files = receipt.files.map(file => replacements[file.path] ? { ...file, ...replacements[file.path] } : file);
  for (const file of OWNED) files.push({ path: `src/${file}`, ...replacements[`src/${file}`], owned: true });
  return { ...receipt, version: VERSION, parentVersion: Parent.VERSION, files, sourceTreeSha256: sha256(JSON.stringify(files)) };
}
module.exports = { VERSION, SOURCE_REVISION, INPUTS: Parent.INPUTS, OWNED: [...Parent.OWNED, ...OWNED], verifyBase, applyCompositor, stageSource, sha256 };
