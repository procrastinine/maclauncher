const path = require("node:path");

function providerFor(entry, registry, runtimeId = entry.runtimeId) {
  return registry.getModule(entry.moduleId || entry.engine)?.getRuntimeProvider?.(runtimeId);
}
function saveDirectoryForEntry(entry, registry, runtimeId = entry.runtimeId) {
  const provider = providerFor(entry, registry, runtimeId);
  if (provider?.supports?.saveLocation === false) return null;
  const previous = entry.moduleData?.runtimeProviderSaveLocations;
  const defaultDirectory = !provider && previous?.moduleId === (entry.moduleId || entry.engine)
    ? previous.defaultSaveDir : entry.defaultSaveDir;
  return entry.saveDirOverride || defaultDirectory || null;
}

function hydrateGameSaveLocations(entry, registry, context = {}) {
  const mod = registry.getModule(entry.moduleId || entry.engine);
  const provider = providerFor(entry, registry, context.runtimeId || entry.runtimeId);
  const previous = entry.moduleData?.runtimeProviderSaveLocations;
  if (typeof mod?.resolveSaveLocations !== "function" && !provider && !previous) return entry;
  const working = { ...entry, moduleData: { ...entry.moduleData } };
  // A provider can have different or unknown saves. Suspend the engine's last
  // locations so engines without a resolver recover them when selected again.
  if (provider) {
    if (previous?.moduleId !== (entry.moduleId || entry.engine)) {
      working.moduleData.runtimeProviderSaveLocations = {
        moduleId: entry.moduleId || entry.engine,
        defaultSaveDir: entry.defaultSaveDir || null,
        saveLocations: (entry.saveLocations || []).map(location => ({ ...location }))
      };
    }
  } else if (previous) {
    if (previous.moduleId === (entry.moduleId || entry.engine)) {
      working.defaultSaveDir = previous.defaultSaveDir || null;
      working.saveLocations = (previous.saveLocations || []).map(location => ({ ...location }));
    }
    // An explicit null also invalidates cached metadata patches.
    working.moduleData.runtimeProviderSaveLocations = null;
  }
  if (typeof mod?.resolveSaveLocations !== "function") return working;
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

module.exports = { hydrateGameSaveLocations, selectKnownSaveLocation, saveDirectoryForEntry };
