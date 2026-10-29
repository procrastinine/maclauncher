const path = require("node:path");
const fs = require("node:fs");

// Presentation follows actual launcher storage ownership, independent of engine.
function isManagedSaveDirectory(directory, userDataDir) {
  if (typeof directory !== "string" || !path.isAbsolute(directory) || !userDataDir) return false;
  // Save folders may not exist yet; resolve their nearest existing ancestor.
  const canonical = value => {
    let ancestor = path.resolve(value); const suffix = [];
    for (;;) {
      try { return path.join(fs.realpathSync(ancestor), ...suffix); }
      catch { const parent = path.dirname(ancestor); if (parent === ancestor) return path.join(ancestor, ...suffix);
        suffix.unshift(path.basename(ancestor)); ancestor = parent; }
    }
  };
  const relative = path.relative(canonical(userDataDir), canonical(directory));
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep));
}

function providerFor(entry, registry, runtimeId = entry.runtimeId) {
  return registry.getModule(entry.moduleId || entry.engine)?.getRuntimeProvider?.(runtimeId);
}
function canOverrideSaveLocation(entry, registry, runtimeId = entry.runtimeId) {
  const mod = registry.getModule(entry.moduleId || entry.engine);
  return (mod?.getRuntimeProvider?.(runtimeId)?.supports?.saveLocationOverride ?? mod?.manifest?.supports?.saveLocationOverride) !== false;
}
function saveDirectoryForEntry(entry, registry, runtimeId = entry.runtimeId) {
  const provider = providerFor(entry, registry, runtimeId);
  if (provider?.supports?.saveLocation === false) return null;
  if (!canOverrideSaveLocation(entry, registry, runtimeId)) return entry.defaultSaveDir || null;
  const previous = entry.moduleData?.runtimeProviderSaveLocations;
  if (!provider && previous?.moduleId === (entry.moduleId || entry.engine)) {
    return (Object.hasOwn(previous, "saveDirOverride") ? previous.saveDirOverride : entry.saveDirOverride) || previous.defaultSaveDir || null;
  }
  if (provider && previous?.runtimeId !== runtimeId) return entry.runtimeData?.[runtimeId]?.saveDirOverride || null;
  return entry.saveDirOverride || entry.defaultSaveDir || null;
}

function hydrateGameSaveLocations(entry, registry, context = {}) {
  const mod = registry.getModule(entry.moduleId || entry.engine);
  const provider = providerFor(entry, registry, context.runtimeId || entry.runtimeId);
  const previous = entry.moduleData?.runtimeProviderSaveLocations;
  if (typeof mod?.resolveSaveLocations !== "function" && !provider && !previous) return entry;
  const working = { ...entry, moduleData: { ...entry.moduleData } };
  const rememberOverride = runtimeId => {
    if (!runtimeId) return;
    working.runtimeData = { ...working.runtimeData, [runtimeId]: {
      ...working.runtimeData?.[runtimeId], saveDirOverride: entry.saveDirOverride || null
    } };
  };
  // A provider can have different or unknown saves. Suspend the engine's last
  // locations so engines without a resolver recover them when selected again.
  if (provider) {
    if (previous?.moduleId !== (entry.moduleId || entry.engine)) {
      working.moduleData.runtimeProviderSaveLocations = {
        moduleId: entry.moduleId || entry.engine,
        defaultSaveDir: entry.defaultSaveDir || null,
        saveLocations: (entry.saveLocations || []).map(location => ({ ...location })),
        saveDirOverride: entry.saveDirOverride || null
      };
    }
    const runtimeId = provider.runtimeId || context.runtimeId || entry.runtimeId;
    if (previous?.runtimeId === runtimeId) {
      rememberOverride(runtimeId);
    } else {
      rememberOverride(previous?.runtimeId);
      working.saveDirOverride = working.runtimeData?.[runtimeId]?.saveDirOverride || null;
    }
    const suspended = working.moduleData.runtimeProviderSaveLocations;
    working.moduleData.runtimeProviderSaveLocations = { ...suspended, runtimeId,
      // Older providers kept the engine override on the entry itself.
      saveDirOverride: Object.hasOwn(suspended, "saveDirOverride") ? suspended.saveDirOverride : entry.saveDirOverride || null };
  } else if (previous) {
    rememberOverride(previous.runtimeId);
    if (previous.moduleId === (entry.moduleId || entry.engine)) {
      working.defaultSaveDir = previous.defaultSaveDir || null;
      working.saveLocations = (previous.saveLocations || []).map(location => ({ ...location }));
      working.saveDirOverride = Object.hasOwn(previous, "saveDirOverride") ? previous.saveDirOverride : entry.saveDirOverride || null;
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
  if (!canOverrideSaveLocation(entry, registry, context.runtimeId || entry.runtimeId)) throw new Error("This runtime uses a fixed private save folder.");
  const hydrated = hydrateGameSaveLocations(entry, registry, context);
  if (typeof directory !== "string" || !path.isAbsolute(directory) ||
    !hydrated.saveLocations?.some(location => location.directory === path.resolve(directory))) {
    throw new Error("Choose an engine-detected save location.");
  }
  const saveDirOverride = path.resolve(directory) === path.resolve(hydrated.defaultSaveDir || ".") ? null : path.resolve(directory);
  const provider = providerFor(hydrated, registry, context.runtimeId || hydrated.runtimeId);
  return { ...hydrated, saveDirOverride, ...(provider ? { runtimeData: { ...hydrated.runtimeData,
    [provider.runtimeId]: { ...hydrated.runtimeData?.[provider.runtimeId], saveDirOverride }
  } } : {}) };
}

module.exports = { isManagedSaveDirectory, hydrateGameSaveLocations, selectKnownSaveLocation, saveDirectoryForEntry, canOverrideSaveLocation };
