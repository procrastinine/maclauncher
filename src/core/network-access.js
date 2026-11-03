// Each game stores a current concrete choice. Old records converge once at the
// shared record-format boundary, before launch reads this preference.
function overrideForEntry(entry, runtimeId) {
  if (Object.hasOwn(entry || {}, "networkAccess")) {
    return typeof entry.networkAccess === "boolean" ? entry.networkAccess : null;
  }
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
