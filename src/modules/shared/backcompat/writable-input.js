// Backcompat: pre-restoration writable-input schema 1 records and private files.
// Runs lexically for old records; descriptors run only in the one-time migration.
// Delete after supported profiles no longer contain this obsolete layout.
const path = require("node:path");
const GameData = require("../game-data");
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative === "" || relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
};
function sourceRoot(entry) {
  const previous = entry?.moduleData?.writableInput;
  if (previous?.schemaVersion === 1 && entry.contentRootDir === previous.root) return previous.sourceRoot;
  return entry?.contentRootDir || entry?.gamePath;
}
function sourceEntry(entry) {
  const view = entry?.moduleData?.writableInput;
  if (view?.schemaVersion !== 1 || !path.isAbsolute(view.root || "") || !path.isAbsolute(view.sourceRoot || "")) return entry;
  const remap = file => typeof file === "string" && path.isAbsolute(file) && inside(view.root, file)
    ? path.join(view.sourceRoot, path.relative(view.root, file)) : file;
  const patch = {};
  for (const key of ["contentRootDir", "indexDir", "indexHtml", "defaultSaveDir", "saveDirOverride"]) {
    const value = remap(entry[key]);
    if (value !== entry[key]) patch[key] = value;
  }
  if (Array.isArray(entry.saveLocations)) {
    const locations = entry.saveLocations.map(row => row && remap(row.directory) !== row.directory
      ? {...row, directory: remap(row.directory)} : row);
    if (locations.some((row, i) => row !== entry.saveLocations[i])) patch.saveLocations = locations;
  }
  return Object.keys(patch).length ? {...entry, ...patch} : entry;
}
function legacyGameMirrors(entry, {userDataDir}) {
  const view = entry?.moduleData?.writableInput;
  const moduleId = entry?.moduleId || entry?.engine;
  if (!entry?.gameId || !moduleId) return [];
  const root = path.join(GameData.resolveGameModuleDir(userDataDir, entry.gameId, moduleId), "writable-input", "files");
  const original = view?.schemaVersion === 1 && path.isAbsolute(view.sourceRoot || "")
    ? view.sourceRoot : sourceRoot(entry);
  if (!path.isAbsolute(original || "")) return [];
  const normalized = sourceEntry(entry);
  const entryPatch = Object.fromEntries(Object.entries(normalized).filter(([key, value]) => value !== entry[key]));
  return [{mirrorRoot: root, sourceRoot: original, ...(Object.keys(entryPatch).length ? {entryPatch} : {})}];
}

module.exports = {sourceRoot, sourceEntry, legacyGameMirrors};
