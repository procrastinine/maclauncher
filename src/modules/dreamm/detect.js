const fs = require("node:fs");
const path = require("node:path");

// The main data file of each LucasArts title DREAMM runs that no other game
// type covers. Dark Forces' GOB archive is also checked by its `GOB` and
// line-feed magic. DREAMM itself identifies the exact edition, demo or
// release from the files beside it.
const TITLES = {
  "dark.gob": { title: "Star Wars: Dark Forces", magic: "GOB\n" },
  "outlaws.lab": { title: "Outlaws" },
  "yodesk.dta": { title: "Star Wars: Yoda Stories" },
  "desktop.daw": { title: "Indiana Jones and His Desktop Adventures" }
};

function readHead(file, helpers, length) {
  if (helpers?.readBytes) return helpers.readBytes(file, 0, length);
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const data = Buffer.alloc(length);
    return data.subarray(0, fs.readSync(fd, data, 0, length, 0));
  } catch { return null; } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function known(file, helpers) {
  const known = TITLES[path.basename(file).toLowerCase()];
  if (!known) return null;
  if (known.magic && readHead(file, helpers, known.magic.length)?.toString("latin1") !== known.magic) return null;
  return known;
}
function candidates(directory, helpers) {
  let entries;
  try { entries = helpers?.readdir ? helpers.readdir(directory) : fs.readdirSync(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === "DETECTION_LIMIT") throw error; return []; }
  return entries.filter(entry => entry.isFile() && TITLES[entry.name.toLowerCase()]).map(entry => path.join(directory, entry.name))
    .filter(file => known(file, helpers)).sort((a, b) => a.localeCompare(b));
}

// A selected main data file, or a folder holding one at its top level,
// selects the game in that folder.
function detectGame(context, helpers = context?.detection) {
  if (context?.isAppBundle || !context?.stat) return null;
  let file;
  if (context.stat.isFile()) file = known(context.inputPath, helpers) ? context.inputPath : null;
  else if (context.stat.isDirectory()) {
    const found = candidates(context.rootDir, helpers);
    if (found.length > 1) throw Object.assign(new Error("Several LucasArts games were found. Select the game's main data file."),
      { code: "DETECTION_CONFLICT", choices: found });
    file = found[0];
  }
  if (!file) return null;
  const root = path.dirname(file);
  return { moduleId: "dreamm", engine: "dreamm", gamePath: root, contentRootDir: root,
    name: TITLES[path.basename(file).toLowerCase()].title, runtimeId: "dreamm", moduleData: { gameFile: path.basename(file) } };
}

module.exports = { detectGame, candidates, TITLES };
