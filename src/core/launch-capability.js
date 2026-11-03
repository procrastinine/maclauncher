const Included = require("../modules/shared/runtime/included-helpers");
const Host = require("../modules/shared/runtime/host-capabilities");

function resolveRuntimeSupportForEntry(mod, info, entry, moduleSettings, context = {}) {
  const supported = Array.isArray(info?.runtime?.supported) ? [...info.runtime.supported] : [];
  const filtered = typeof mod?.filterRuntimeSupport === "function"
    ? mod.filterRuntimeSupport(entry, supported, moduleSettings, context) : supported;
  return Array.isArray(filtered) ? filtered.filter(value => typeof value === "string" && value) : [];
}

// A module whose included helpers have no build for this Mac's CPU cannot play
// here. The helpers' package records name the Mac it needs.
function hostRequirement(mod, arch = Host.getHostCapabilities().hardwareArch) {
  let declarations;
  try { declarations = mod?.distributionSupplementals; } catch { return null; }
  return Array.isArray(declarations) && declarations.length ? Included.hostRequirement(declarations, { arch }) : null;
}

// Display and execution share the same cheap, module-owned format/host gate.
// Installation is deliberately separate: an absent runtime can be prepared by Play.
function canLaunchEntry({ mod, info, entry, runtimeId, moduleSettings = {}, context = {} }) {
  if (hostRequirement(mod, context.arch)) return false;
  if ((info?.supports?.launch === false && info?.runtime?.entries?.[runtimeId]?.runtimeProvider !== true) || !runtimeId ||
      info?.runtime?.entries?.[runtimeId]?.launch === false) return false;
  if (!resolveRuntimeSupportForEntry(mod, info, entry, moduleSettings, context).includes(runtimeId)) return false;
  return typeof mod?.canLaunchRuntime !== "function" ||
    Boolean(mod.canLaunchRuntime(runtimeId, entry, moduleSettings, context));
}

module.exports = { canLaunchEntry, hostRequirement, resolveRuntimeSupportForEntry };
