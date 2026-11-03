// Released v0.5.1 stored VNDS saves under games/<id>/modules/vnds/saves.
// Invoked only by the shared one-time existing-library migration.
// Remove with that migration once support for this released layout ends.
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { moduleRoot, defaultSaveDirectory, saveLocations } = require("../prepare");
const WritableBackcompat = require("../../shared/backcompat/writable-input");

function legacyGameMirrors(entry, context) {
  const mirrorRoot = path.join(moduleRoot(entry, context), "saves");
  const baseline = (Array.isArray(context.games) ? context.games.find(game => game.gameId === entry.gameId) : null) || entry;
  const matches = value => typeof value === "string" && path.isAbsolute(value) && path.resolve(value) === path.resolve(mirrorRoot);
  let proven = matches(baseline.defaultSaveDir) || (Array.isArray(baseline.saveLocations) && baseline.saveLocations.some(row => matches(row?.directory))) || false;
  if (!proven) {
    try { const stat = fs.lstatSync(mirrorRoot); proven = stat.isDirectory() && !stat.isSymbolicLink(); } catch { /* No proven released layout. */ }
  }
  const releasedSaveRoute = { directory: mirrorRoot, entryPatch: { saveDirOverride: mirrorRoot }, proven,
    explicit: Boolean(baseline.saveDirOverride) };
  try {
    entry = WritableBackcompat.sourceEntry(entry);
    const selected = entry.saveDirOverride && path.resolve(entry.saveDirOverride);
    const contains = (root, file) => file === root || file.startsWith(root + path.sep);
    if (selected && (contains(mirrorRoot, selected) || contains(selected, mirrorRoot))) return [];
    const directory = entry.saveDirOverride || defaultSaveDirectory(entry);
    const locations = saveLocations({ ...entry, saveDirOverride: directory });
    const anchor = path.join(os.homedir(), "Library", "Application Support");
    const target = path.resolve(directory);
    return [{ mirrorRoot, sourceRoot: directory,
      ...(target !== anchor && contains(anchor, target) ? { createSourceWithin: anchor } : {}), entryPatch: {
      saveDirOverride: entry.saveDirOverride || null, defaultSaveDir: locations.primaryDirectory, saveLocations: locations.directories
    }, releasedSaveRoute }];
  } catch {
    return [{ mirrorRoot, sourceRoot: null, releasedSaveRoute }];
  }
}

module.exports = { legacyGameMirrors };
