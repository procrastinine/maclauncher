const fs = require("node:fs");
const path = require("node:path");
const GameData = require("../shared/game-data");
const Writable = require("../shared/writable-input");
const { inside, inspectDosProgram } = require("./detect");

function gameDirectory(entry, context) {
  if (!/^[A-Za-z0-9_-]+$/.test(entry?.gameId || "") || !path.isAbsolute(context?.userDataDir || "")) throw new Error("DOSBox requires a game in the library.");
  return GameData.resolveGameModuleDir(context.userDataDir, entry.gameId, "dosbox");
}
function driveDirectory(entry) {
  if (entry.saveDirOverride) {
    if (!path.isAbsolute(entry.saveDirOverride) || /[\0\r\n]/.test(entry.saveDirOverride)) throw new Error("DOS game data requires an absolute local folder.");
    return entry.saveDirOverride;
  }
  const executable = entry.moduleData?.executablePath;
  if (!path.isAbsolute(executable || "") || /[\0\r\n]/.test(executable)) throw new Error("DOS game data requires an absolute local folder.");
  return path.dirname(executable);
}
async function prepareGame(entry, context) {
  context.signal?.throwIfAborted();
  const directory = gameDirectory(entry, context);
  const source = fs.realpathSync(entry.contentRootDir || entry.gamePath), selected = entry.moduleData?.executablePath;
  if (!path.isAbsolute(selected || "") || !inside(source, fs.realpathSync(selected)) || !inspectDosProgram(selected)) throw new Error("The DOS program is missing or invalid.");
  const executable = fs.realpathSync(selected), drive = driveDirectory(entry);
  // DOSBox mounts the selected program's own directory. Only its configuration
  // and runtime wrapper belong to launcher data; no game tree is prepared.
  Writable.assertOwnDirectory(context.userDataDir, directory);
  if (entry.saveDirOverride) {
    const launch = await require("./drive-override").prepareOverride({ source, executable, drive, directory, context });
    entry.defaultSaveDir = drive;
    return launch;
  }
  entry.defaultSaveDir = drive;
  return { directory, drive, executable };
}

module.exports = { gameDirectory, driveDirectory, prepareGame };
