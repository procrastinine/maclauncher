const fs = require("node:fs");
const path = require("node:path");
const Writable = require("../writable-input");

const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative === "" || relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
};

function relativeWindowsPath(root, file) {
  if (!inside(root, file)) throw new Error("The Windows launch path escapes its game folder.");
  const relative = path.relative(root, file);
  if (relative.split(path.sep).some(part => /[\\:\0\r\n]/.test(part))) throw new Error("The Windows launch path contains unsupported filename characters.");
  return relative.split(path.sep).join("\\");
}

function mapRoot(prefixPath, root) {
  const dosdevices = path.join(prefixPath, "dosdevices");
  Writable.assertOwnDirectory(prefixPath, dosdevices);
  // Prefer the established game drive, then other non-system drive letters.
  const letters = Array.from({ length: 22 }, (_, index) => String.fromCharCode(100 + index));
  letters.push(...letters.splice(0, 3)); // G–Y, then D–F; A–C and Z retain their system roles.
  const free = [];
  for (const letter of letters) {
    const mapping = path.join(dosdevices, letter + ":");
    let stat; try { stat = fs.lstatSync(mapping); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (!stat) { free.push(mapping); continue; }
    if (stat.isSymbolicLink()) try { if (fs.realpathSync(mapping) === root) return letter.toUpperCase() + ":\\"; } catch {}
  }
  for (const mapping of free) {
    try { fs.symlinkSync(path.relative(fs.realpathSync(dosdevices), root), mapping, "dir"); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      // Another launch can allocate a drive in a shared external bottle.
      try { if (!fs.lstatSync(mapping).isSymbolicLink() || fs.realpathSync(mapping) !== root) continue; } catch { continue; }
    }
    return path.basename(mapping)[0].toUpperCase() + ":\\";
  }
  throw new Error("No free Windows game drive is available in this environment. Existing drive mappings were preserved.");
}

function prepareGamePaths(prefixPath, { gameRoot, executablePath, workingRoot = gameRoot, workingDirectory = path.dirname(executablePath) }) {
  const root = fs.realpathSync(gameRoot), executable = fs.realpathSync(executablePath);
  const cwdRoot = fs.realpathSync(workingRoot), cwd = fs.realpathSync(workingDirectory);
  const executableRelative = relativeWindowsPath(root, executable), cwdRelative = relativeWindowsPath(cwdRoot, cwd);
  if (!executableRelative) throw new Error("The Windows executable must be inside its game folder.");
  const workingDrive = mapRoot(prefixPath, cwdRoot), executableDrive = root === cwdRoot ? workingDrive : mapRoot(prefixPath, root);
  return { windowsExecutablePath: executableDrive + executableRelative, windowsWorkingDirectory: workingDrive + cwdRelative };
}

module.exports = { prepareGamePaths };
