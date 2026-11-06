const formerProjectId = 'vulkan-kosmickrisp-gles32';
const formerIds = [formerProjectId];
function normalizeSelection(value, logger = console) {
  const { manager, projectId, selectionId } = require("../managed");
  if (value === "kosmickrisp:maclauncher-gles32") return selectionId;
  if (typeof value === "string") {
    if (!value.startsWith("kosmickrisp-gles32:")) return value;
    try { return (projectId + ":") + manager.core.normalizeVersion(value.slice("kosmickrisp-gles32:".length)); } catch {}
  }
  logger?.warn?.("[runtimes] The saved MacLauncher KosmicKrisp choice could not be read; using Automatic.");
  return "auto";
}
function adapt(manager, dependencies) {
  const projectId = manager.id;
  function previousSettings(runtimes, logger = dependencies.logger || console) {
    const previous = runtimes?.[formerProjectId];
    if (previous === undefined) return undefined;
    if (previous && typeof previous === "object" && !Array.isArray(previous) &&
        (previous.defaultVersion == null || typeof previous.defaultVersion === "string")) try {
      const normalized = manager.normalizeSettings(previous);
      if (normalized.defaultVersion) manager.core.normalizeVersion(normalized.defaultVersion);
      return normalized;
    } catch {}
    logger?.warn?.("[runtimes] The saved MacLauncher KosmicKrisp settings could not be read; using the manager default.");
    return undefined;
  }
  const withPreviousSettings = settings => settings?.runtimes?.[projectId] !== undefined ? settings :
    { ...settings, runtimes: { ...settings?.runtimes, [projectId]: previousSettings(settings?.runtimes) } };
  const withPreviousEntry = entry => entry?.runtimeData?.[projectId] !== undefined || entry?.runtimeData?.[formerProjectId] === undefined ? entry :
    { ...entry, runtimeData: { ...entry.runtimeData, [projectId]: entry.runtimeData[formerProjectId] } };
  function resolveSelection(entry, settings, data, options = {}) {
    entry = withPreviousEntry(entry);
    const effective = withPreviousSettings(settings);
    const result = manager.resolveSelection(entry, effective, data, options);
    if (effective.runtimes?.[projectId]?.defaultVersion && !settings?.runtimes?.[projectId] &&
        !options.version && !result.ready && result.discoveryRequired) {
      (dependencies.logger || console).warn?.("[runtimes] The saved MacLauncher KosmicKrisp version is unavailable; using the manager default.");
      return manager.resolveSelection(entry, settings, data, options);
    }
    return result;
  }
  return { ...manager, formerIds,
    chooseArchitecture: (entry, settings, data, options) => manager.chooseArchitecture(withPreviousEntry(entry), withPreviousSettings(settings), data, options),
    resolveSelection,
    getState: (options = {}) => manager.getState({ ...options,
      settings: options.settings ?? options.runtimeSettings?.[projectId] ?? previousSettings(options.runtimeSettings, options.logger) }),
    installRuntime: (options = {}) => manager.installRuntime({ ...options, settings: withPreviousSettings(options.settings) }) };
}
module.exports = { formerProjectId, formerIds, normalizeSelection, adapt };
