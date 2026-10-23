const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const Models = require("./models");

const STORE_URL = "https://store.steampowered.com/app/993090/Lossless_Scaling/";
function directories(root) {
  try { return fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).slice(0, 256).map(entry => path.join(root, entry.name)); }
  catch { return []; }
}
function readSmall(file) {
  try { const stat = fs.statSync(file); return stat.isFile() && stat.size <= 1024 * 1024 ? fs.readFileSync(file, "utf8") : ""; }
  catch { return ""; }
}
function steamLibraries(root, drive) {
  const libraries = [root];
  const text = readSmall(path.join(root, "steamapps/libraryfolders.vdf"));
  for (const match of text.matchAll(/"(?:path|\d+)"\s*"((?:\\.|[^"\\])*)"/g)) {
    const location = match[1].replace(/\\\\/g, "\\").replace(/\\"/g, '"');
    if (path.isAbsolute(location)) libraries.push(location);
    else if (drive && /^C:\\/i.test(location)) libraries.push(path.join(drive, ...location.slice(3).split("\\")));
  }
  return libraries.slice(0, 256);
}
// Inspect only conventional installation locations on an explicit Find action.
// No recursive home scan and no Steam/CrossOver process is started.
function findModels({ home = os.homedir(), clientRoots = require("./steam-client-models").clientRoots(home) } = {}) {
  const steam = path.join(home, "Library/Application Support/Steam");
  const libraries = [...steamLibraries(steam), ...clientRoots];
  for (const bottles of [path.join(home, "Library/Application Support/CrossOver/Bottles"), path.join(home, "Applications/CrossOver/Bottles")]) {
    for (const bottle of directories(bottles)) {
      const drive = path.join(bottle, "drive_c");
      for (const programFiles of ["Program Files (x86)", "Program Files"]) {
        libraries.push(...steamLibraries(path.join(drive, programFiles, "Steam"), drive));
      }
    }
  }
  const found = new Set();
  for (const library of libraries) {
    const locations = [path.join(library, "steamapps/common/Lossless Scaling"),
      ...directories(path.join(library, "steamapps/content/app_993090")).filter(dir => /^depot_\d+$/.test(path.basename(dir)))];
    for (const directory of locations) {
      // Both current and older publishers use this name; preserve filename case.
      let names; try { names = fs.readdirSync(directory).filter(name => /^lossless\.dll$/i.test(name)); } catch { continue; }
      for (const name of names) {
        try {
          const file = path.join(directory, name), stat = fs.lstatSync(file);
          if (stat.isFile() && !stat.isSymbolicLink() && stat.size >= 64 && stat.size <= Models.MAX_BYTES) found.add(fs.realpathSync(file));
        } catch { /* An installation can be moved or removed during discovery. */ }
      }
    }
  }
  return [...found];
}
async function importFound(context = {}) {
  const candidates = findModels(context);
  if (!candidates.length) throw new Error("No Lossless Scaling DLL was found in Steam or CrossOver. Choose a DLL with Import, or use Download from Steam.");
  const installed = [], errors = [];
  for (const runtimePath of candidates) {
    context.signal?.throwIfAborted();
    try { installed.push(await Models.importModel({ ...context, runtimePath })); }
    catch (error) { if (context.signal?.aborted || error.name === "AbortError") throw error; errors.push(error); }
  }
  if (!installed.length) throw errors[0];
  const count = new Set(installed.map(item => item.version)).size;
  return { ...installed[0], message: `${count} compatible model ${count === 1 ? "version" : "versions"} imported.${errors.length ? ` ${errors.length} ${errors.length === 1 ? "DLL" : "DLLs"} could not be imported.` : ""}` };
}
module.exports = { STORE_URL, findModels, importFound };
