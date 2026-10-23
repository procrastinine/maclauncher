const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const VERSION = "xsystem35-macos-resources-v3";
const SOURCE_HASHES = Object.freeze({
  "CMakeLists.txt": "d64c56b052357f26238b0f52353a244878aefecb8a25814e079e8dc1c1ce5683",
  "src/font.c": "404842057c45a5028b83a7b27b8ccf614c3c7d64b1e59d8b192c214fb6b5aab2"
});
const MIXER_CMAKE_SHA256 = "c14000d099bb2135ef7994dce44adad1f6dfa9b35a21f28d75476d5b001a0e08";
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

function replace(source, before, after) {
  if (!source.includes(before) || source.indexOf(before) !== source.lastIndexOf(before)) throw new Error("xsystem35 source does not match the selected Mac adapter.");
  return source.replace(before, after);
}

function adapt(file, bytes) {
  if (!Object.hasOwn(SOURCE_HASHES, file) || digest(bytes) !== SOURCE_HASHES[file]) throw new Error("xsystem35 source checksum does not match the selected version.");
  let source = bytes.toString("utf8");
  if (file === "CMakeLists.txt") {
    source = replace(source, "    set(DEFAULT_FONT_PATH ${CMAKE_INSTALL_PREFIX}/share/xsystem35/fonts/)",
      "    if (APPLE)\n      set(DEFAULT_FONT_PATH \"\")\n    else()\n      set(DEFAULT_FONT_PATH ${CMAKE_INSTALL_PREFIX}/share/xsystem35/fonts/)\n    endif()");
    source = replace(source, "  if (WIN32)\n    optional_pkg_check_modules(PORTMIDI IMPORTED_TARGET portmidi)",
      "  option(ENABLE_PORTMIDI \"Enable PortMidi output\" ON)\n  if (WIN32)\n    optional_pkg_check_modules(PORTMIDI IMPORTED_TARGET portmidi)");
    source = replace(source, "  else ()\n    find_library(PORTMIDI portmidi)", "  elseif (ENABLE_PORTMIDI)\n    find_library(PORTMIDI portmidi)");
    source = replace(source, "if (NOT EMSCRIPTEN AND NOT ANDROID AND NOT WIN32)\n  include(FindIntl)",
      "option(ENABLE_GETTEXT \"Use external gettext catalogs\" ON)\nif (ENABLE_GETTEXT AND NOT EMSCRIPTEN AND NOT ANDROID AND NOT WIN32)\n  include(FindIntl)");
  } else {
    source = replace(source, "#include <stdlib.h>\n", "#include <stdlib.h>\n#ifdef __APPLE__\n#include <limits.h>\n#include <stdio.h>\n#include <mach-o/dyld.h>\n#endif\n");
    source = replace(source, "static FT_Face open_face(const char *name, int index) {", `#ifdef __APPLE__
// Shipped defaults follow the executable, including nested app resource roots.
// Explicit custom font paths retain FreeType's normal lookup behavior.
static FT_Face open_default_font(const char *name, int index) {
\tif (strcmp(name, DEFAULT_GOTHIC_TTF) && strcmp(name, DEFAULT_MINCHO_TTF))
\t\treturn NULL;
\tchar executable[PATH_MAX];
\tuint32_t length = sizeof(executable);
\tif (_NSGetExecutablePath(executable, &length) != 0)
\t\treturn NULL;
\tchar resolved[PATH_MAX];
\tif (!realpath(executable, resolved))
\t\treturn NULL;
\tchar *separator = strrchr(resolved, '/');
\tif (!separator)
\t\treturn NULL;
\t*separator = '\\0';
\tchar resource[PATH_MAX];
\tint size = snprintf(resource, sizeof(resource), "%s/../share/xsystem35/fonts/%s", resolved, name);
\tif (size < 0 || (size_t)size >= sizeof(resource))
\t\treturn NULL;
\tFT_Face face = NULL;
\tif (FT_New_Face(ft_library, resource, index, &face))
\t\treturn NULL;
\treturn face;
}
#endif

static FT_Face open_face(const char *name, int index) {`);
    source = replace(source, "\tFT_Face face = NULL;\n\n#ifdef _WIN32", "\tFT_Face face = NULL;\n#ifdef __APPLE__\n\tface = open_default_font(name, index);\n#endif\n\n#ifdef _WIN32");
  }
  return Buffer.from(source);
}

function apply(sourceRoot, { sourceDir = path.resolve(__dirname, "../../external/xsystem35-sdl2") } = {}) {
  if (!path.isAbsolute(sourceRoot || "") || !path.isAbsolute(sourceDir || "")) throw new Error("xsystem35 source directories must be absolute.");
  const output = fs.realpathSync(sourceRoot), original = fs.realpathSync(sourceDir);
  if (output === original || output.startsWith(original + path.sep) || original.startsWith(output + path.sep)) throw new Error("xsystem35 adapters require a separate writable source copy.");
  const changes = [];
  for (const relative of Object.keys(SOURCE_HASHES)) {
    const file = path.join(output, relative);
    if (!fs.lstatSync(file).isFile() || !fs.realpathSync(file).startsWith(output + path.sep)) throw new Error("xsystem35 adapter inputs must be contained regular files.");
    const bytes = adapt(relative, fs.readFileSync(file));
    changes.push({ file, bytes, relative, sourceSha256: SOURCE_HASHES[relative], adaptedSourceSha256: digest(bytes) });
  }
  // Validate all pinned inputs before changing either disposable source file.
  for (const change of changes) fs.writeFileSync(change.file, change.bytes);
  return { version: VERSION, overlaySha256: digest(fs.readFileSync(__filename)), files: changes.map(({ relative, sourceSha256, adaptedSourceSha256 }) => ({ path: relative, sourceSha256, adaptedSourceSha256 })) };
}

function applyMixer(sourceRoot) {
  if (!path.isAbsolute(sourceRoot || "") || !fs.lstatSync(sourceRoot).isDirectory()) throw new Error("SDL2_mixer source must be a separate absolute directory.");
  const root = fs.realpathSync(sourceRoot), external = fs.realpathSync(path.resolve(__dirname, "../../external"));
  if (root === external || root.startsWith(external + path.sep)) throw new Error("SDL2_mixer adapters cannot change source checkouts.");
  const file = path.join(root, "CMakeLists.txt");
  if (!fs.lstatSync(file).isFile() || !fs.realpathSync(file).startsWith(root + path.sep)) throw new Error("SDL2_mixer adapter input must be a contained regular file.");
  const bytes = fs.readFileSync(file);
  if (digest(bytes) !== MIXER_CMAKE_SHA256) throw new Error("SDL2_mixer source checksum does not match the selected version.");
  const adapted = Buffer.from(replace(bytes.toString("utf8"), "        find_package(FLAC REQUIRED)", "        find_package(Threads REQUIRED)\n        find_package(FLAC REQUIRED)"));
  fs.writeFileSync(file, adapted);
  return { path: "CMakeLists.txt", sourceSha256: MIXER_CMAKE_SHA256, adaptedSourceSha256: digest(adapted) };
}

module.exports = { VERSION, SOURCE_HASHES, MIXER_CMAKE_SHA256, adapt, apply, applyMixer };
