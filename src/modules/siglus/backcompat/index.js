// Released v0.5.1: games/<id>/modules/siglus/{project,saves}.
// Called only for existing pending entries by the one-time original-game-mirrors-v1 migration.
// Delete after migration from released v0.5.1 profiles is no longer supported.
const path = require("node:path");
const fs = require("node:fs");
const Writable = require("../../shared/backcompat/writable-input");
const Launch = require("../launch");

function legacyGameMirrors(entry, context) {
  const source = Writable.sourceEntry(entry), original = source.contentRootDir || source.gamePath;
  const directory = Launch.moduleRoot(entry, context), info = entry.moduleData || {};
  const baseline = context.games?.find(game => game.gameId === entry.gameId) || entry;
  const runtime = context.runtimeId || baseline.runtimeId || context.settings?.modules?.siglus?.defaultRuntime || "siglus";
  const explicit = Boolean(baseline.saveDirOverride ||
    info.engineKind === "reallive" && process.env.REALLIVE_SAVE_DIR || info.engineKind === "avg32" && process.env.AVG32_SAVE_DIR);
  const releasedSaveDirectory = info.engineKind === "siglus" ? path.join(directory, "project", "savedata") : path.join(directory, "saves");
  let releasedSaveRoute;
  try {
    if (fs.lstatSync(releasedSaveDirectory).isDirectory()) releasedSaveRoute = { directory: releasedSaveDirectory,
      entryPatch: { saveDirOverride: releasedSaveDirectory },
      proven: runtime === "siglus" && ["siglus", "reallive", "avg32"].includes(info.engineKind) && baseline.moduleData?.engineKind === info.engineKind, explicit };
  } catch (error) { if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error; }
  if (!path.isAbsolute(original || "")) {
    const mirrorRoot = info.engineKind === "siglus" ? path.join(directory, "project") : path.join(directory, "saves");
    return releasedSaveRoute ? [{ mirrorRoot, sourceRoot: null, releasedSaveRoute }] : [];
  }
  const resolved = Launch.resolveSaveLocations(source, context), saves = resolved.primaryDirectory;
  const entryPatch = { defaultSaveDir: saves, saveLocations: resolved.directories.map(({ exists, ...row }) => row) };
  const mirrors = [{ mirrorRoot: path.join(directory, "project"), sourceRoot: original,
    ...(info.engineKind === "siglus" ? { entryPatch, ...(releasedSaveRoute ? { releasedSaveRoute } : {}) } : {}) }];
  if (["reallive", "avg32"].includes(info.engineKind)) mirrors.push({
    mirrorRoot: path.join(directory, "saves"),
    sourceRoot: saves,
    ...(info.engineKind === "reallive" && saves === path.join(original, "savedata_rs") ? { createSourceWithin: original } : {}),
    entryPatch, ...(releasedSaveRoute ? { releasedSaveRoute } : {})
  });
  if (entry.moduleData?.writableInput?.schemaVersion === 1) mirrors.push(...Writable.legacyGameMirrors(entry, context));
  const overlap = (left, right) => {
    const relative = path.relative(left, right);
    return !relative || relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
  };
  return mirrors.filter(row => !entry.saveDirOverride ||
    !overlap(row.mirrorRoot, entry.saveDirOverride) && !overlap(entry.saveDirOverride, row.mirrorRoot));
}

module.exports = { legacyGameMirrors };
