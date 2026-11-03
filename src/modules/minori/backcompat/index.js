// Released v0.5.1: games/<id>/modules/minori/saves.
// Called only for existing pending entries by the one-time original-game-mirrors-v1 migration.
// Delete after migration from released v0.5.1 profiles is no longer supported.
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const Writable = require("../../shared/backcompat/writable-input");
const GameData = require("../../shared/game-data");
const Minori = require("../main");
const { applySaveIdentity } = require("../../../core/save-identity");

function legacyGameMirrors(entry, context) {
  const root = path.join(GameData.resolveGameModuleDir(context.userDataDir, entry.gameId, "minori"), "saves");
  const baseline = (Array.isArray(context.games) ? context.games.find(game => game.gameId === entry.gameId) : null) || entry;
  const matches = value => typeof value === "string" && path.isAbsolute(value) && path.resolve(value) === path.resolve(root);
  let proven = matches(baseline.defaultSaveDir) || (Array.isArray(baseline.saveLocations) && baseline.saveLocations.some(row => matches(row?.directory))) || false;
  if (!proven) {
    try { const stat = fs.lstatSync(root); proven = stat.isDirectory() && !stat.isSymbolicLink(); } catch { /* No proven released layout. */ }
  }
  const releasedSaveRoute = { directory: root, entryPatch: { saveDirOverride: root }, proven,
    explicit: Boolean(baseline.saveDirOverride || process.env.MACLAUNCHER_MINORI_SAVE_DIR) };
  try {
    const source = Writable.sourceEntry(entry);
    const prospective = applySaveIdentity(source, { games: context.games || [], describe: context.describeSaveIdentity || Minori.resolveSaveIdentity, context });
    const destination = Minori.resolveSaveLocations(prospective).primaryDirectory;
    const original = path.resolve(source.contentRootDir || source.gamePath), documents = path.join(os.homedir(), "Documents");
    const fallback = path.join(documents, "eden", "games", entry.gameId, "userdata");
    const anchor = destination === path.join(original, "userdata") ? original : [fallback, path.join(documents, "eden", "userdata")].includes(destination) ? documents : null;
    const entryPatch = { defaultSaveDir: destination, saveLocations: Minori.resolveSaveLocations(prospective).directories,
      ...(prospective.saveDirOverride !== source.saveDirOverride ? { saveDirOverride: prospective.saveDirOverride } : {}) };
    const overlap = (left, right) => {
      const relative = path.relative(left, right);
      return !relative || relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
    };
    const rows = entry.moduleData?.writableInput?.schemaVersion === 1 ? Writable.legacyGameMirrors(entry, context) : [];
    rows.push({ mirrorRoot: root, sourceRoot: destination, ...(anchor ? { createSourceWithin: anchor } : {}), entryPatch, releasedSaveRoute });
    return rows.filter(row => !overlap(row.mirrorRoot, destination) && !overlap(destination, row.mirrorRoot));
  } catch {
    // An unresolved original location leaves recovery pending; the shared
    // runner alone decides whether these released facts permit retention.
    return [{ mirrorRoot: root, sourceRoot: null, releasedSaveRoute }];
  }
}

module.exports = { legacyGameMirrors };
