const fs = require("node:fs");
const path = require("node:path");

// Build-engine game data: a GRP archive (`KenSilverman` magic) or Blood's RFF
// archive (`RFF` and 0x1A). PowerSlave keeps its GRP archive in `STUFF.DAT`.
const GRP = "KenSilverman", RFF = "RFF\u001a";
const TITLES = {
  "duke3d.grp": "Duke Nukem 3D", "dukedc.grp": "Duke It Out in D.C.", "vacation.grp": "Duke Caribbean: Life's a Beach",
  "nwinter.grp": "Duke: Nuclear Winter", "nam.grp": "NAM", "napalm.grp": "Napalm", "ww2gi.grp": "World War II GI",
  "redneck.grp": "Redneck Rampage", "sw.grp": "Shadow Warrior", "wt.grp": "Shadow Warrior: Wanton Destruction",
  "td.grp": "Shadow Warrior: Twin Dragon", "blood.rff": "Blood", "stuff.dat": "PowerSlave"
};

function readHead(file, helpers, length = 12) {
  if (helpers?.readBytes) return helpers.readBytes(file, 0, length);
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const data = Buffer.alloc(length);
    return data.subarray(0, fs.readSync(fd, data, 0, length, 0));
  } catch { return null; } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function isGameData(file, helpers) {
  const name = path.basename(file).toLowerCase(), head = readHead(file, helpers)?.toString("latin1") || "";
  if (name.endsWith(".grp") || name === "stuff.dat") return head === GRP;
  return name === "blood.rff" && head.startsWith(RFF);
}
const named = name => /\.grp$/i.test(name) || /^(?:stuff\.dat|blood\.rff)$/i.test(name);
function candidates(directory, helpers) {
  let entries;
  try { entries = helpers?.readdir ? helpers.readdir(directory) : fs.readdirSync(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === "DETECTION_LIMIT") throw error; return []; }
  return entries.filter(entry => entry.isFile() && named(entry.name)).map(entry => path.join(directory, entry.name))
    .filter(file => isGameData(file, helpers)).sort((a, b) => a.localeCompare(b));
}
function title(file) {
  const name = path.basename(file);
  return TITLES[name.toLowerCase()] || path.basename(name, path.extname(name));
}

// A selected data file selects that game. A folder selects the data file at
// its top level; a folder holding several, such as a game and its add-ons,
// asks for one of them.
function detectGame(context, helpers = context?.detection) {
  if (context?.isAppBundle || !context?.stat) return null;
  let file;
  if (context.stat.isFile()) {
    if (!named(path.basename(context.inputPath)) || !isGameData(context.inputPath, helpers)) return null;
    file = context.inputPath;
  } else if (context.stat.isDirectory()) {
    const found = candidates(context.rootDir, helpers);
    if (found.length > 1) throw Object.assign(new Error("Several Build-engine game files were found. Select the game's GRP or RFF file."),
      { code: "DETECTION_CONFLICT", choices: found });
    file = found[0];
  }
  if (!file) return null;
  return { moduleId: "raze", engine: "raze", gamePath: context.stat.isFile() ? file : context.rootDir, contentRootDir: path.dirname(file),
    name: title(file), runtimeId: "raze", moduleData: { gameFile: path.basename(file) } };
}

module.exports = { detectGame, isGameData, candidates, title };
