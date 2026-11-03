// Compatibility: MacLauncher 0.5.1 DOSBox full-root drive-c and save override layouts.
// Invoked only by the persisted original-game-mirrors-v1 migration, never Play.
// Remove with that migration after these released profile layouts are no longer supported.
const path = require("node:path");
const { gameDirectory, driveDirectory } = require("../prepare");
const { inside } = require("../detect");

// Called only by the shared one-time migration, never by Play.
function legacyGameMirrors(entry, context) {
  const sourceRoot = entry.contentRootDir || entry.gamePath;
  if (!path.isAbsolute(sourceRoot || "")) return [];
  const mirrorRoot = path.join(gameDirectory(entry, context), "drive-c");
  const override = entry.saveDirOverride;
  // Explicit overrides are current DOS-drive adapters, never obsolete data.
  // Keep the whole tree when either path contains the other.
  if (path.isAbsolute(override || "")) {
    const selected = path.resolve(override);
    if (inside(mirrorRoot, selected) || inside(selected, mirrorRoot)) return [];
  }
  const drive = driveDirectory(entry);
  const entryPatch = { defaultSaveDir: drive };
  if (Array.isArray(entry.saveLocations)) entryPatch.saveLocations = entry.saveLocations.map(location => {
    if (!path.isAbsolute(location?.directory || "")) return location;
    const relative = path.relative(mirrorRoot, location.directory);
    if (relative === "") return { ...location, directory: drive };
    if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) return location;
    return { ...location, directory: path.join(sourceRoot, relative) };
  });
  // The released default binds this game's old full drive. The current visible
  // override retains the same executable-relative mapping if recovery fails;
  // the shared once-only runner decides whether that retained root is safe.
  const executable = entry.moduleData?.executablePath;
  const releasedSaveRoute = {
    directory: mirrorRoot,
    entryPatch: { saveDirOverride: mirrorRoot },
    proven: entry.defaultSaveDir === mirrorRoot && path.isAbsolute(executable || "") &&
      !/[\0\r\n]/.test(sourceRoot + executable) && inside(sourceRoot, executable) && executable !== sourceRoot,
    explicit: Boolean(entry.saveDirOverride || entry.launchArguments || context.gameArguments?.length)
  };
  return [{ mirrorRoot, sourceRoot, entryPatch, releasedSaveRoute }];
}
module.exports = { legacyGameMirrors };
