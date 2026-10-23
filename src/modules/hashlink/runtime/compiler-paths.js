const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PROFILE = "maclauncher-logical-roots-v2";

// Cover both spelling and physical identity: macOS exposes /var through
// /private/var, and a shared workspace can also have a home-directory alias.
function aliases(directory) {
  const values = new Set([path.resolve(directory)]);
  try { values.add(fs.realpathSync(directory)); } catch {}
  for (const value of [...values]) {
    if (/^\/private\/(?:var|tmp)(?:\/|$)/.test(value)) values.add(value.slice("/private".length));
    else if (/^\/(?:var|tmp)(?:\/|$)/.test(value)) values.add("/private" + value);
  }
  return [...values];
}

function compilerPathMappings({ source, sdlSource, openalSource, build, runtime,
  workspace = path.resolve(__dirname, "../../../.."), temporary = os.tmpdir(),
  cache = path.join(os.homedir(), "Library", "Caches"), home = os.homedir() } = {}) {
  const roots = [
    [source, "maclauncher-source/hashlink"], [sdlSource, "maclauncher-source/sdl2"],
    [openalSource, "maclauncher-source/openal-soft"], [build, "maclauncher-build/hashlink"],
    [runtime, "maclauncher-runtime/hashlink"], [workspace, "maclauncher-workspace"],
    [temporary, "maclauncher-tmp"], [cache, "maclauncher-cache"], [home, "maclauncher-home"]
  ];
  const mappings = new Map();
  for (const [directory, to] of roots) {
    if (directory === undefined) continue;
    if (typeof directory !== "string" || !path.isAbsolute(directory) || directory === "/" || directory.includes("\0"))
      throw new Error("HashLink compiler maps require absolute, non-root build directories.");
    for (const from of aliases(directory)) if (!mappings.has(from)) mappings.set(from, { from, to });
  }
  return [...mappings.values()].sort((a, b) => b.from.length - a.from.length || a.from.localeCompare(b.from));
}

function compilerFlags(mappings) {
  return mappings.flatMap(({ from, to }) => ["file", "debug", "macro"].map(kind => `-f${kind}-prefix-map=${from}=${to}`))
    .concat("-fdebug-compilation-dir=maclauncher-build/hashlink");
}

// Make and CMake receive a flags string; quote each argument, including paths
// containing spaces or shell punctuation. The build itself uses spawn(argv).
const quoteFlag = value => "'" + value.replaceAll("'", "'\\''") + "'";
const flagsString = flags => flags.map(quoteFlag).join(" ");

function cmakeOverlay(flags) {
  function literal(value) {
    let equals = "=";
    while (value.includes("]" + equals + "]")) equals += "=";
    return "[" + equals + "[" + value + "]" + equals + "]";
  }
  // A project include applies separate argv entries to C/C++/Objective-C alike.
  // Quoted CMAKE_C_FLAGS strings can otherwise collapse into one prefix-map.
  return "add_compile_options(\n" + flags.map(flag => "  " + literal(flag)).join("\n") + "\n)\n";
}

module.exports = { PROFILE, compilerPathMappings, compilerFlags, flagsString, cmakeOverlay };
