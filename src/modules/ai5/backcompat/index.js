// Backcompat: MacLauncher v0.5.1 stored AI5 saves and screenshots beneath
// games/<gameId>/modules/ai5/{saves,screenshots}. Runs only through the shared
// one-time profile migration, never import, preparation or Play. Remove when
// upgrades from that layout and retained migration diagnostics are unsupported.
const path = require("node:path");
const GameData = require("../../shared/game-data");
const LaunchArguments = require("../../shared/runtime/launch-arguments");

function legacyGameMirrors(entry, { userDataDir, environment = process.env } = {}) {
  const sourceRoot = entry.contentRootDir || entry.gamePath;
  if (!/^[A-Za-z0-9_-]+$/.test(entry.gameId || "") || !path.isAbsolute(userDataDir || "") || !path.isAbsolute(sourceRoot || "")) return [];
  const directory = GameData.resolveGameModuleDir(userDataDir, entry.gameId, "ai5");
  const override = typeof entry.saveDirOverride === "string" && entry.saveDirOverride && path.resolve(entry.saveDirOverride);
  const oldSaves = path.join(directory, "saves");
  // Released main.js:91–103 and onImport recorded this exact default. An old
  // directory name alone cannot establish that this game actually used it.
  const proven = path.isAbsolute(entry.defaultSaveDir || "") && path.resolve(entry.defaultSaveDir) === oldSaves;
  let explicit = Boolean(entry.saveDirOverride || environment.MACLAUNCHER_AI5_SAVE_DIR);
  try { explicit ||= LaunchArguments.parse(entry.launchArguments || "").some(arg => /^--?(?:save[-_a-z]*|working-directory)(?:=|$)/i.test(arg)); }
  catch { explicit = true; }
  return [
    { mirrorRoot: oldSaves, sourceRoot, ...(proven ? { releasedSaveRoute: {
      directory: oldSaves, entryPatch: { saveDirOverride: oldSaves }, proven, explicit
    } } : {}) },
    { mirrorRoot: path.join(directory, "screenshots"), sourceRoot: path.join(sourceRoot, "Screenshots"), createSourceWithin: sourceRoot }
  ].filter(({ mirrorRoot }) => !override || override !== mirrorRoot && !override.startsWith(mirrorRoot + path.sep) && !mirrorRoot.startsWith(override + path.sep));
}

module.exports = { legacyGameMirrors };
