// Compatibility for the pre-change, unreleased private Xash3D layout.
// Xash3D is absent from the v0.5.1 tag. Only the shared one-time migration
// invokes this hook; remove it when these prior development layouts are no
// longer supported. Runtime links remain pending until safely retired.
const path = require("node:path");
const GameData = require("../../shared/game-data");

function legacyGameMirrors(entry, context) {
  if (entry.saveDirOverride || !path.isAbsolute(entry.contentRootDir || "") || !entry.moduleData?.gameFolder) return [];
  const directory = GameData.resolveGameModuleDir(context.userDataDir, entry.gameId, "xash3d");
  return [{ mirrorRoot: path.join(directory, "saves"), sourceRoot: path.join(entry.contentRootDir, entry.moduleData.gameFolder, "save") },
    { mirrorRoot: path.join(directory, "data"), sourceRoot: entry.contentRootDir }];
}

module.exports = { legacyGameMirrors };
