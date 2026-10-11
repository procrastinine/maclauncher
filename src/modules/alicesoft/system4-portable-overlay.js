const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const VERSION = "xsystem4-macos-resources-v2";
const SOURCE_HASHES = Object.freeze({
  "meson.build": "448d24e39a50ff00a89ed27b5f61c925a20514aee39561b3b66b42ba7308296a",
  "meson_options.txt": "d005c5f719163dfc3251f5c9515af25cf443ed0b797a4d8aecc7c117b7f3ecb4",
  "src/meson.build": "39502be629322402d96accd667663b2ed08ded17fee7d5f40cb95c926230854a",
  "src/video.c": "751edffd67576aec4d09b2d762b74c93282eb5155f63b6ae7beadcaa647a087f",
  "src/text.c": "60785853fcb397fdbbfbfa7b61eed03d45c3ef7b66676186750c5379c665b767",
  "src/util.c": "d91ce2ea661cf35c46974661b47102b0cddc11d3c722b35ad147a264f222e368",
  "include/xsystem4.h": "d2299cbe7de4b69b8910ee1f53597d4cd71c1ec06963945781d1c80ae11debcd",
  "subprojects/libsys4/meson.build": "1cee7e2def4117253790cf0b3e5d9e81d360532d96d10472f4518d7f69dbf94d"
});
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function replace(source, before, after) {
  if (!source.includes(before) || source.indexOf(before) !== source.lastIndexOf(before)) throw new Error("xsystem4 source differs from the selected Mac adapter.");
  return source.replace(before, after);
}

const RESOURCE_FUNCTION = `// Runtime-owned assets follow the real executable; game files stay separate.
bool xsys4_resource_path(char *output, size_t capacity, const char *relative)
{
\tif (!output || !capacity || !relative || !*relative || *relative == '/' || strchr(relative, '\\\\'))
\t\treturn false;
\tfor (const char *part = relative; *part;) {
\t\tconst char *end = strchr(part, '/');
\t\tsize_t size = end ? (size_t)(end - part) : strlen(part);
\t\tif (!size || (size == 1 && part[0] == '.') || (size == 2 && part[0] == '.' && part[1] == '.'))
\t\t\treturn false;
\t\tif (!end) break;
\t\tpart = end + 1;
\t\tif (!*part) return false;
\t}
\tchar executable[PATH_MAX], resolved[PATH_MAX];
\tuint32_t length = sizeof(executable);
\tif (_NSGetExecutablePath(executable, &length) != 0 || !realpath(executable, resolved))
\t\treturn false;
\tchar *separator = strrchr(resolved, '/');
\tif (!separator) return false;
\t*separator = '\\0';
\tint length_written = snprintf(output, capacity, "%s/../share/xsystem4/%s", resolved, relative);
\treturn length_written >= 0 && (size_t)length_written < capacity;
}
`;

function adapt(file, bytes, { version = "snapshot-04333ad-macos-v2" } = {}) {
  if (!Object.hasOwn(SOURCE_HASHES, file) || digest(bytes) !== SOURCE_HASHES[file]) throw new Error("xsystem4 source checksum differs from the selected version.");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(version)) throw new Error("Invalid xsystem4 runtime version.");
  let source = bytes.toString("utf8");
  if (file === "meson.build") {
    source = replace(source, "add_project_arguments('-DXSYS4_DATA_DIR=\"' + get_option('prefix') / get_option('datadir') / 'xsystem4\"', language : 'c')", "add_project_arguments('-DXSYS4_DATA_DIR=\"\"', language : 'c')");
    source = replace(source, "gl = dependency('GL')", "gl = dependency('appleframeworks', modules : ['OpenGL'])");
    for (const name of ["libavcodec", "libavformat", "libavutil", "libswscale"]) {
      const expression = new RegExp(`(dependency\\('${name}'[^\\n]*required:) false`);
      if (!expression.test(source)) throw new Error("xsystem4 movie dependency adapter differs.");
      source = source.replace(expression, "$1 get_option('ffmpeg')");
    }
    for (const [name, option] of [["chibi-scheme", "scheme"], ["readline", "readline"]]) source = replace(source,
      `dependency('${name}', required : false, static : static_libs)`,
      `dependency('${name}', required : get_option('${option}'), static : static_libs, method : 'pkg-config')`);
    for (const name of ["zlib", "sdl2", "freetype2", "libffi", "libturbojpeg", "libwebp", "libpng", "sndfile"]) source = replace(source,
      `dependency('${name}', static : static_libs)`, `dependency('${name}', static : static_libs, method : 'pkg-config')`);
    source = replace(source, "dependency('cglm', version : '>=0.9.2', fallback : ['cglm', 'cglm_dep'])", "dependency('cglm', version : '>=0.9.2', method : 'pkg-config')");
    source = replace(source, "dependency('glew')", "dependency('glew', method : 'pkg-config')");
  } else if (file === "meson_options.txt") {
    source += "\noption('ffmpeg', type : 'feature', value : 'enabled', description : 'Pinned movie decoder profile')\noption('scheme', type : 'feature', value : 'disabled', description : 'Optional Scheme debugger')\noption('readline', type : 'feature', value : 'disabled', description : 'Optional readline debugger')\n";
  } else if (file === "src/meson.build") {
    source = replace(source, "fallback : 'unknown version'", `fallback : '${version}'`);
  } else if (file === "subprojects/libsys4/meson.build") {
    source = replace(source, "dependency('libdeflate', required: false, static : static_libs)", "dependency('libdeflate', required: false, static : static_libs, method : 'pkg-config')");
    for (const name of ["zlib", "libturbojpeg", "libwebp", "libpng"]) source = replace(source,
      `dependency('${name}', static : static_libs)`, `dependency('${name}', static : static_libs, method : 'pkg-config')`);
  } else if (file === "src/video.c") {
    source = replace(source, '"#version 140\\n"', '"#version 150\\n"');
    source = replace(source, "SDL_GL_SetAttribute(SDL_GL_CONTEXT_MINOR_VERSION, 1);", "SDL_GL_SetAttribute(SDL_GL_CONTEXT_MINOR_VERSION, 2);");
    const start = source.indexOf("\tGLchar *source = SDL_LoadFile(path, NULL);"), end = source.indexOf("\treturn source;", start);
    if (start < 0 || end < start) throw new Error("xsystem4 shader adapter differs.");
    source = source.slice(0,start) + "\tchar full_path[PATH_MAX];\n\tGLchar *source = NULL;\n\tif (xsys4_resource_path(full_path, sizeof(full_path), path))\n\t\tsource = SDL_LoadFile(full_path, NULL);\n\tif (!source) source = SDL_LoadFile(path, NULL);\n\tif (!source) ERROR(\"Failed to load shader file %s\", path);\n" + source.slice(end);
  } else if (file === "src/text.c") {
    source = replace(source, "\tstruct font *font;\n\t// user specified font", "\tstruct font *font;\n\tchar runtime_font[4096];\n\t// user specified font");
    source = replace(source, "\tif ((font = ft_font_load(default_font_paths[type])))", "\tif (xsys4_resource_path(runtime_font, sizeof(runtime_font), local_font_paths[type]) && (font = ft_font_load(runtime_font)))\n\t\treturn font;\n\tif ((font = ft_font_load(default_font_paths[type])))");
  } else if (file === "src/util.c") {
    source = replace(source, "#include <ctype.h>\n", "#include <ctype.h>\n#include <limits.h>\n#include <mach-o/dyld.h>\n");
    source = replace(source, "char *unix_path(const char *path)\n", RESOURCE_FUNCTION + "\nchar *unix_path(const char *path)\n");
  } else if (file === "include/xsystem4.h") {
    source = replace(source, "char *savedir_path(const char *path);", "char *savedir_path(const char *path);\nbool xsys4_resource_path(char *output, size_t capacity, const char *relative);");
  }
  return Buffer.from(source);
}

function apply(sourceRoot, { sourceDir = path.resolve(__dirname, "../../external/xsystem4"), version } = {}) {
  if (!path.isAbsolute(sourceRoot || "") || !path.isAbsolute(sourceDir || "")) throw new Error("xsystem4 source directories must be absolute.");
  const output = fs.realpathSync(sourceRoot), original = fs.realpathSync(sourceDir);
  if (output === original || output.startsWith(original + path.sep) || original.startsWith(output + path.sep)) throw new Error("xsystem4 adapters require a separate writable source copy.");
  const changes = [];
  for (const relative of Object.keys(SOURCE_HASHES)) {
    const file = path.join(output, relative);
    if (!fs.lstatSync(file).isFile() || !fs.realpathSync(file).startsWith(output + path.sep)) throw new Error("xsystem4 adapter inputs must be contained regular files.");
    const bytes = adapt(relative, fs.readFileSync(file), { version });
    changes.push({ file, bytes, relative, sourceSha256: SOURCE_HASHES[relative], adaptedSourceSha256: digest(bytes) });
  }
  for (const change of changes) fs.writeFileSync(change.file, change.bytes);
  return { version: VERSION, overlaySha256: digest(fs.readFileSync(__filename)), files: changes.map(({relative,sourceSha256,adaptedSourceSha256})=>({path:relative,sourceSha256,adaptedSourceSha256})) };
}
module.exports = { VERSION, SOURCE_HASHES, RESOURCE_FUNCTION, adapt, apply };
