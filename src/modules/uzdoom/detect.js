const fs = require("node:fs");
const path = require("node:path");

// Doom-engine main game files (IWADs). A `.wad` starts with the `IWAD` magic;
// an `.ipk3`, or a `.pk3` holding an `iwadinfo` lump, is a ZIP archive that
// carries its own game definition. Add-on `PWAD` files need a main game and
// are not games by themselves.
const EXTENSIONS = [".wad", ".ipk3", ".pk3"];
const TITLES = {
  "doom.wad": "Doom", "doom1.wad": "Doom (Shareware)", "doomu.wad": "The Ultimate Doom", "doom2.wad": "Doom II",
  "doom2f.wad": "Doom II (French)", "plutonia.wad": "Final Doom: The Plutonia Experiment", "tnt.wad": "Final Doom: TNT: Evilution",
  "heretic.wad": "Heretic", "heretic1.wad": "Heretic (Shareware)", "hexen.wad": "Hexen", "strife1.wad": "Strife",
  "strife0.wad": "Strife (Demo)", "chex.wad": "Chex Quest", "chex3.wad": "Chex Quest 3", "freedoom1.wad": "Freedoom: Phase 1",
  "freedoom2.wad": "Freedoom: Phase 2", "freedm.wad": "FreeDM"
};

function readHead(file, helpers, length = 4) {
  if (helpers?.readBytes) return helpers.readBytes(file, 0, length);
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const data = Buffer.alloc(length);
    return data.subarray(0, fs.readSync(fd, data, 0, length, 0));
  } catch { return null; } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function zipEntries(file, helpers) {
  try {
    const result = helpers?.readZipEntries ? helpers.readZipEntries(file) : require("../shared/runtime/zip").readZipEntries(file);
    return Array.isArray(result?.entries) ? result.entries : [];
  } catch (error) { if (error.code === "DETECTION_LIMIT") throw error; return []; }
}
function isMainGame(file, helpers) {
  const extension = path.extname(file).toLowerCase(), head = readHead(file, helpers);
  if (!head || head.length < 4) return false;
  if (extension === ".wad") return head.toString("latin1") === "IWAD";
  if (head.toString("latin1") !== "PK\u0003\u0004") return false;
  return extension === ".ipk3" || zipEntries(file, helpers).some(entry => /^iwadinfo(?:\.[^/]*)?$/i.test(String(entry.name || entry.fileName || "")));
}
function title(file) {
  const name = path.basename(file);
  return TITLES[name.toLowerCase()] || path.basename(name, path.extname(name));
}
function candidates(directory, helpers) {
  let entries;
  try { entries = helpers?.readdir ? helpers.readdir(directory) : fs.readdirSync(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === "DETECTION_LIMIT") throw error; return []; }
  return entries.filter(entry => entry.isFile() && EXTENSIONS.includes(path.extname(entry.name).toLowerCase()))
    .map(entry => path.join(directory, entry.name)).filter(file => isMainGame(file, helpers)).sort((a, b) => a.localeCompare(b));
}

// A selected main game file selects that game. A folder selects the main game
// file at its top level; a folder holding several asks for one of them.
function detectGame(context, helpers = context?.detection) {
  if (context?.isAppBundle || !context?.stat) return null;
  let file;
  if (context.stat.isFile()) {
    if (!EXTENSIONS.includes(path.extname(context.inputPath).toLowerCase()) || !isMainGame(context.inputPath, helpers)) return null;
    file = context.inputPath;
  } else if (context.stat.isDirectory()) {
    const found = candidates(context.rootDir, helpers);
    if (found.length > 1) throw Object.assign(new Error("Several Doom-engine games were found. Select the game's WAD or IPK3 file."),
      { code: "DETECTION_CONFLICT", choices: found });
    file = found[0];
  }
  if (!file) return null;
  const root = path.dirname(file);
  return { moduleId: "uzdoom", engine: "uzdoom", gamePath: context.stat.isFile() ? file : context.rootDir, contentRootDir: root,
    name: title(file), runtimeId: "uzdoom", moduleData: { gameFile: path.basename(file) } };
}

module.exports = { detectGame, isMainGame, candidates, title };
