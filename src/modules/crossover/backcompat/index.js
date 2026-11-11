// Backcompat: MacLauncher v0.5.1 private Windows game/ and temporal-* layouts.
// Used only by the once-per-game migration, never Play, import or upkeep.
// Remove when support for profiles containing these released layouts is retired.
const fs = require("node:fs"), path = require("node:path");

function legacyGameMirrors(entry, { userDataDir } = {}) {
  if (!entry?.gameId) return [];
  const Writable = require("../../shared/backcompat/writable-input"), originalEntry = Writable.sourceEntry(entry);
  const protectedSaves = [entry.saveDirOverride, originalEntry.saveDirOverride].filter(value => typeof value === "string" && path.isAbsolute(value)).map(value => path.resolve(value));
  const descriptors = [];
  for (const [runtimeId, launch] of [["crossover", require("../runtime/launch")], ["sikarugir", require("../sources/wine-launch").forSource("sikarugir")]]) {
    const directory = launch.runtimeDirectory(entry, { userDataDir });
    for (const kind of ["camera", "original"]) {
      const legacy = path.join(directory, "temporal-" + kind);
      let present;
      try { present = fs.lstatSync(legacy); } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (present) throw new Error("An earlier MacLauncher version left a " + (runtimeId === "crossover" ? "CrossOver" : "Sikarugir") + " graphics launch folder at runtimes/" + runtimeId + "/temporal-" + kind + " that cannot be recovered automatically. Copy any needed files from it before removing the game.");
    }
    const imported = entry.contentRootDir || entry.gamePath;
    const recordedRoot = entry.runtimeData?.[runtimeId]?.sourceRoot || entry.runtimeData?.crossover?.sourceRoot ||
      (typeof imported === "string" && /\.exe$/i.test(imported) ? path.dirname(imported) : imported);
    const sourceRoot = Writable.sourceEntry({ ...entry, contentRootDir: recordedRoot }).contentRootDir;
    const mirrorRoot = path.join(directory, "game");
    if (typeof sourceRoot !== "string" || !path.isAbsolute(sourceRoot)) {
      // The shared Windows provider hook also sees non-Windows entries. Only
      // fixed owned legacy roots matter when no original Windows root is known.
      let present;
      try { present = fs.lstatSync(mirrorRoot); } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (present) throw new Error("An earlier MacLauncher version left a " + (runtimeId === "crossover" ? "CrossOver" : "Sikarugir") + " game copy at runtimes/" + runtimeId + "/game, and its original Windows game folder is unknown, so it was not recovered. Copy any needed files from it before removing the game.");
      continue;
    }
    if (protectedSaves.some(save => save === mirrorRoot || save.startsWith(mirrorRoot + path.sep) || mirrorRoot.startsWith(save + path.sep))) continue;
    descriptors.push({ mirrorRoot, sourceRoot, generated: [] });
  }
  return descriptors;
}

module.exports = { legacyGameMirrors, migrateLegacyGameData: require("./profiles").migrateLegacyGameData };
