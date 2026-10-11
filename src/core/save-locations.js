const path = require("node:path");

function hydrateGameSaveLocations(entry, registry, context = {}) {
  const mod = registry.getModule(entry.moduleId || entry.engine);
  if (typeof mod?.resolveSaveLocations !== "function") return entry;
  const working = { ...entry, moduleData: { ...entry.moduleData } };
  const locations = mod.resolveSaveLocations(working, context);
  if (!locations || typeof locations !== "object" || typeof locations.then === "function") throw new Error("Invalid engine save-location result.");
  const primary = locations.primaryDirectory;
  if (primary != null && (typeof primary !== "string" || !path.isAbsolute(primary))) throw new Error("Engine save locations must be absolute paths.");
  const directories = [];
  const seen = new Set();
  for (const location of locations.directories || []) {
    if (typeof location?.directory !== "string" || !path.isAbsolute(location.directory)) throw new Error("Engine save locations must be absolute paths.");
    const directory = path.resolve(location.directory);
    if (seen.has(directory)) continue;
    seen.add(directory);
    directories.push({ ...location, directory });
  }
  return { ...working, defaultSaveDir: primary || null, saveLocations: directories };
}

function selectKnownSaveLocation(entry, directory, registry, context = {}) {
  const hydrated = hydrateGameSaveLocations(entry, registry, context);
  if (typeof directory !== "string" || !path.isAbsolute(directory) ||
    !hydrated.saveLocations?.some(location => location.directory === path.resolve(directory))) {
    throw new Error("Choose an engine-detected save location.");
  }
  return { ...hydrated, saveDirOverride: path.resolve(directory) === path.resolve(hydrated.defaultSaveDir || ".") ? null : path.resolve(directory) };
}

module.exports = { hydrateGameSaveLocations, selectKnownSaveLocation };
