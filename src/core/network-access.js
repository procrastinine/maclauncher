// Each game stores a concrete choice. Legacy explicit values remain readable
// when normalizing an older record for the first time.
function overrideForEntry(entry, runtimeId) {
  if (Object.hasOwn(entry || {}, "networkAccess")) {
    return typeof entry.networkAccess === "boolean" ? entry.networkAccess : null;
  }
  const selected = typeof entry?.runtimeId === "string" && entry.runtimeId
    ? entry.runtimeId : runtimeId;
  const legacy = entry?.runtimeSettings?.[selected];
  if (Object.hasOwn(legacy || {}, "networkIsolation") && typeof legacy.networkIsolation === "boolean")
    return !legacy.networkIsolation;
  if (Object.hasOwn(legacy || {}, "enableProtections") && typeof legacy.enableProtections === "boolean")
    return !legacy.enableProtections;
  return null;
}

function allowedForEntry(entry, settings, moduleInfo, runtimeId) {
  if (moduleInfo?.runtime?.entries?.[runtimeId]?.networkAccess === false) return false;
  return preferenceForEntry(entry, settings, runtimeId);
}

function preferenceForEntry(entry, settings, runtimeId) {
  return overrideForEntry(entry, runtimeId) ?? settings?.launcher?.networkAccess === true;
}

module.exports = { overrideForEntry, preferenceForEntry, allowedForEntry };
