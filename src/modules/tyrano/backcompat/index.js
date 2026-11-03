// Backcompat: MacLauncher 0.5.1 Tyrano Electron module saves and schema-1 views.
// Runs once for existing games through the persisted profile migration.
// Delete when upgrades from these released layouts are no longer supported.
const path = require("node:path");
const GameData = require("../../shared/game-data");
const Writable = require("../../shared/backcompat/writable-input");

function legacyGameMirrors(entry, context) {
  const original = Writable.sourceEntry(entry), sourceRoot = original.gamePath || original.contentRootDir;
  if (!entry.gameId || !path.isAbsolute(sourceRoot || "")) return [];
  const mirrorRoot = path.join(GameData.resolveGameModuleDir(context.userDataDir, entry.gameId, "tyrano"), "saves");
  const saveRoot = entry.saveDirOverride || sourceRoot;
  const overlap = (left, right) => { const relative = path.relative(left, right); return !relative ||
    relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative); };
  const mirrors = entry.moduleData?.writableInput?.schemaVersion === 1 ? Writable.legacyGameMirrors(entry, context) : [];
  mirrors.push({ mirrorRoot, sourceRoot: saveRoot, entryPatch: { defaultSaveDir: saveRoot,
    saveLocations: [{ directory: saveRoot, label: "Tyrano file saves", source: "original game folder" }] } });
  return mirrors.filter(row => !entry.saveDirOverride || !overlap(row.mirrorRoot, entry.saveDirOverride) && !overlap(entry.saveDirOverride, row.mirrorRoot));
}

module.exports = { legacyGameMirrors };
