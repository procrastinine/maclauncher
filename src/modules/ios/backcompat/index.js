// Backcompat: MacLauncher v0.5.1 interrupted IPA .previous generations.
// Runs only in the once-per-game profile migration, never preparation or Play.
// Delete when those released generations are no longer supported.
const path = require("node:path");
const GameData = require("../../shared/game-data");

function legacyGameMirrors(entry, {userDataDir} = {}) {
  if (!/^[A-Za-z0-9_-]+$/.test(entry?.gameId || "") || !path.isAbsolute(userDataDir || ""))
    throw new Error("IPA recovery requires a saved game and an absolute data directory.");
  const root = GameData.resolveGameModuleDir(userDataDir, entry.gameId, "ios");
  return [
    {mirrorRoot: path.join(root, ".previous"), sourceRoot: path.join(root, "prepared"), createSourceWithin: root, generated: []},
    {mirrorRoot: path.join(root, "extracted/.previous"), sourceRoot: path.join(root, "extracted/contents"), createSourceWithin: path.join(root, "extracted"), generated: []}
  ];
}

module.exports = {legacyGameMirrors};
