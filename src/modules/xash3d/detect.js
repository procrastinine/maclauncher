const fs = require("node:fs");
const path = require("node:path");
const Architecture = require("../shared/runtime/architecture");
const Native = require("../shared/runtime/local-native");

// Half-Life's own game folder. Mods are sibling folders that build on it.
const BASE_FOLDER = "valve";
const LIMIT = 64 * 1024 * 1024;

function findName(directory, name) {
  try {
    const found = fs.readdirSync(directory).find(value => value.toLowerCase() === name.toLowerCase());
    return found ? path.join(directory, found) : null;
  } catch { return null; }
}
function findPath(directory, relative) {
  let current = directory;
  for (const part of relative.split("/").filter(Boolean)) if (!(current = findName(current, part))) return null;
  return current;
}
function isFile(file) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

// A game folder's description, read the way the engine reads it: gameinfo.txt
// first, then liblist.gam. Both hold `key "value"` lines.
function readGameInfo(directory) {
  for (const name of ["gameinfo.txt", "liblist.gam"]) {
    const file = findName(directory, name);
    let text;
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > 64 * 1024) continue;
      text = fs.readFileSync(file, "latin1");
    } catch { continue; }
    const fields = {};
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*([A-Za-z_]\w*)\s+(?:"([^"\r\n]*)"|([^\s"]+))/.exec(line);
      if (match && !Object.hasOwn(fields, match[1].toLowerCase())) fields[match[1].toLowerCase()] = match[2] ?? match[3];
    }
    return { file, fields };
  }
  return null;
}

// The engine loads `<folder>/<name>_<cpu>.dylib`, named after the game's macOS
// library entry, else its Linux or Windows one, without an Intel suffix.
function serverLibrary(fields) {
  const named = String(fields.gamedll_osx || fields.gamedll_linux || fields.gamedll || "dlls/hl.dll").replace(/\\/g, "/");
  return { folder: path.posix.dirname(named), name: path.posix.basename(named).replace(/\.[^.]*$/, "").replace(/_i[3-6]86$/i, "") };
}
function sameFile(left, right) {
  try {
    const a = fs.statSync(left), b = fs.statSync(right);
    return a.isFile() && b.isFile() && a.size === b.size && a.size <= LIMIT && fs.readFileSync(left).equals(fs.readFileSync(right));
  } catch { return false; }
}
// Half-Life's game code comes with the runtime. A mod runs when it uses that
// code, with no game library of its own or an unchanged copy of Half-Life's,
// or when it includes a library built for this engine and this Mac's CPU.
function gameLibrary(game, base, fields, arch = Architecture.selectedArchitecture()) {
  const library = serverLibrary(fields);
  if (path.resolve(game) === path.resolve(base)) return "Half-Life";
  const included = `${library.folder}/${library.name}_${arch === "x64" ? "amd64" : "arm64"}.dylib`;
  const native = findPath(game, included);
  if (native) {
    try {
      if (Native.readMachOArchitectures(native, { allowLibrary: true })
        .some(cpu => Architecture.normalizeArchitecture(cpu) === arch)) return included;
    } catch {}
    return null;
  }
  if (library.name.toLowerCase() !== "hl" || library.folder.toLowerCase() !== "dlls") return null;
  const windows = String(fields.gamedll || "dlls/hl.dll").replace(/\\/g, "/"), own = findPath(game, windows);
  return !own || sameFile(own, findPath(base, windows)) ? "Half-Life" : null;
}
function halfLifeFolder(root) {
  const base = findName(root, BASE_FOLDER);
  if (!base || !readGameInfo(base)) return null;
  return ["halflife.wad", "pak0.pak"].some(name => isFile(findName(base, name))) ? base : null;
}

// A Half-Life folder selects Half-Life. Its `valve` folder or a mod folder
// inside it selects that game.
function detectGame(context) {
  if (context.isAppBundle || !context.stat?.isDirectory()) return null;
  const selected = context.rootDir;
  let root = selected, base = halfLifeFolder(selected), game = base;
  if (!base) {
    root = path.dirname(selected);
    base = halfLifeFolder(root);
    game = !base || !readGameInfo(selected) ? null : path.basename(selected).toLowerCase() === BASE_FOLDER ? base : selected;
  }
  if (!game) return null;
  const info = readGameInfo(game), library = gameLibrary(game, base, info.fields);
  if (!library) return null;
  const folder = path.basename(game), title = String(info.fields.title || info.fields.game || "").trim();
  return { moduleId: "xash3d", engine: "xash3d", gamePath: game === base ? root : game, contentRootDir: root,
    name: title || folder, runtimeId: "xash3d-fwgs",
    moduleData: { gameFolder: folder, gameInfo: path.relative(root, info.file), gameLibrary: library } };
}

module.exports = { detectGame, readGameInfo, serverLibrary, gameLibrary, halfLifeFolder };
