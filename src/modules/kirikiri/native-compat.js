const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Native = require("../shared/runtime/local-native");
const { throwIfAborted } = require("../shared/runtime/download-utils");

const REVISION = "124bdf841f09e7ce02aa99b7b55791a0f7a900ff";
const OVERLAY_REVISION = "macos-storage-font-monitor-v1";

function prepareSource({ sourceRoot, revision, signal }) {
  throwIfAborted(signal);
  if (revision !== REVISION) throw new Error("KiriKiri native bridge requires its exact reviewed upstream revision.");
  const patches = [
    { relative: "external/krkrz/base/StorageIntf.cpp", include: "#include <dirent.h>\n#include <sys/stat.h>\n#include <cstring>\n",
      anchor: "TJS_BEGIN_NATIVE_METHOD_DECL(/*func. name*/getFileProperty)", resource: "storage-dirlist.inc" },
    { relative: "external/krkrz/base/SystemIntf.cpp", include: '#include "FontSystem.h"\n#include "tjsDictionary.h"\n#include "SDL.h"\n#include <algorithm>\n#include <climits>\nextern FontSystem* TVPFontSystem;\n',
      anchor: "TJS_BEGIN_NATIVE_METHOD_DECL(/*func. name*/terminate)", resource: "system-addfont.inc" }
  ];
  const files = [], digest = crypto.createHash("sha256");
  for (const patch of patches) {
    throwIfAborted(signal);
    const file = path.join(sourceRoot, patch.relative), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("KiriKiri bridge accepts regular staged source files only.");
    const beforeSha256 = Native.hashFile(file), source = fs.readFileSync(file, "utf8");
    if (source.indexOf(patch.anchor) < 0 || source.indexOf(patch.anchor) !== source.lastIndexOf(patch.anchor)) throw new Error("KiriKiri bridge source anchor differs from the reviewed layout.");
    const implementation = fs.readFileSync(path.join(__dirname, "overlays", patch.resource), "utf8");
    fs.writeFileSync(file, patch.include + source.replace(patch.anchor, implementation + "\n" + patch.anchor));
    const afterSha256 = Native.hashFile(file);
    files.push({ file: patch.relative, beforeSha256, afterSha256, resource: patch.resource,
      implementationSha256: crypto.createHash("sha256").update(implementation).digest("hex") });
    digest.update(patch.relative + "\0" + patch.include + implementation + "\0");
  }
  return { revision: OVERLAY_REVISION, upstreamRevision: REVISION, sha256: digest.digest("hex"), files,
    operations: ["actual local/archive directory listing", "process-local native FreeType font loading", "dialog rectangle positioning against actual SDL monitor work areas"] };
}

module.exports = { REVISION, OVERLAY_REVISION, prepareSource };
