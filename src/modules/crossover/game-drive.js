// The folder that a Wine launch maps as the game's Windows drive. Windows
// programs can resolve files above their own folder, and a drive root clamps
// those parent paths. The drive therefore follows the folder the game was
// imported from, not only the folder that holds the selected executable.
const fs = require("node:fs");
const path = require("node:path");
const { inside } = require("./detect");

const realDirectory = folder => {
  try { const real = fs.realpathSync(folder); return fs.statSync(real).isDirectory() ? real : null; } catch { return null; }
};

// A packaged Unreal program is <install>/<project>/Binaries/<platform>/<name>.exe
// and resolves its install folder as ../../.. from the executable. Engine/ in
// the install folder and Content/ in the project folder identify that layout.
function unrealInstallRoot(executable) {
  const binaries = path.dirname(path.dirname(executable));
  if (path.basename(binaries).toLowerCase() !== "binaries") return null;
  const project = path.dirname(binaries), install = path.dirname(project);
  const engine = realDirectory(path.join(install, "Engine")), content = realDirectory(path.join(project, "Content"));
  return engine && content && inside(install, engine) && inside(project, content) ? install : null;
}

/**
 * The drive root for `executablePath` found in the game folder `sourceRoot`.
 * An imported folder that contains the game folder is used as recorded. When
 * no recorded folder reaches the install folder of a packaged Unreal layout,
 * as for an executable imported alone, the drive is widened to that folder.
 */
function gameDriveRoot(entry, sourceRoot, executablePath) {
  const root = fs.realpathSync(sourceRoot), executable = fs.realpathSync(executablePath);
  const imported = typeof entry?.importPath === "string" && path.isAbsolute(entry.importPath) ? realDirectory(entry.importPath) : null;
  const recorded = imported && inside(imported, root) ? imported : root;
  const install = unrealInstallRoot(executable);
  return install && inside(install, recorded) ? install : recorded;
}

module.exports = { gameDriveRoot, unrealInstallRoot };
