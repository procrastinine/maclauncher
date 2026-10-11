function resolveRuntimeSupportForEntry(mod, info, entry, moduleSettings) {
  const supported = Array.isArray(info?.runtime?.supported) ? [...info.runtime.supported] : [];
  const filtered = typeof mod?.filterRuntimeSupport === "function"
    ? mod.filterRuntimeSupport(entry, supported, moduleSettings) : supported;
  return Array.isArray(filtered) ? filtered.filter(value => typeof value === "string" && value) : [];
}

// Display and execution share the same cheap, module-owned format/host gate.
// Installation is deliberately separate: an absent runtime can be prepared by Play.
function canLaunchEntry({ mod, info, entry, runtimeId, moduleSettings = {}, context = {} }) {
  if (info?.supports?.launch === false || !runtimeId ||
      info?.runtime?.entries?.[runtimeId]?.launch === false) return false;
  if (!resolveRuntimeSupportForEntry(mod, info, entry, moduleSettings).includes(runtimeId)) return false;
  return typeof mod?.canLaunchRuntime !== "function" ||
    Boolean(mod.canLaunchRuntime(runtimeId, entry, moduleSettings, context));
}

module.exports = { canLaunchEntry, resolveRuntimeSupportForEntry };
