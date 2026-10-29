// Runtime providers add a format-gated backend to independently detected engines.
// Their hooks own that backend's preparation and execution; engine hooks retain
// all ordinary behavior for the engine's other runtime choices.
function listRuntimeProviders(modules) {
  const providers = new Map();
  for (const mod of modules) {
    const declared = Array.isArray(mod.runtimeProviders) ? mod.runtimeProviders : [mod.runtimeProvider];
    for (const provider of declared) {
      if (!provider || typeof provider.runtimeId !== "string" || !provider.runtimeId ||
          typeof provider.supportsEntry !== "function" || typeof provider.launchRuntime !== "function") continue;
      if (providers.has(provider.runtimeId)) throw new Error(`Duplicate runtime provider: ${provider.runtimeId}`);
      providers.set(provider.runtimeId, provider);
    }
  }
  return [...providers.values()].sort((left, right) =>
    (Number.isFinite(left.runtime?.uiOrder) ? left.runtime.uiOrder : 0) -
    (Number.isFinite(right.runtime?.uiOrder) ? right.runtime.uiOrder : 0));
}

// Settings describes possible input formats for a module; the inspector uses
// supportsEntry below to narrow those choices to the actual imported program.
function providerAppliesToModule(provider, manifest) {
  if (manifest.runtime?.supported?.includes(provider.runtimeId)) return true;
  const input = provider.runtime?.input;
  if (!input) return true;
  const detection = manifest.detection || {};
  const extensions = [...(detection.fileExtensions || []), ...(detection.directoryFileExtensions || []),
    ...(detection.extensions || []).map(item => item.extension)];
  const formats = [...(detection.binaryFormats || []), ...(manifest.runtime?.inputFormats || [])];
  return Boolean(input.gameTypes?.includes(manifest.gameType) ||
    input.fileExtensions?.some(extension => extensions.includes(extension)) ||
    input.binaryFormats?.some(format => formats.includes(format)) ||
    input.webContent && (detection.webContent || detection.webRoots?.length));
}

function composeRuntimeProviders(mod, providers) {
  const allowed = mod.manifest?.runtime?.providers;
  if (Array.isArray(allowed)) providers = providers.filter(provider => allowed.includes(provider.runtimeId));
  if (!providers.length) return mod;
  const original = mod.manifest || {};
  const runtime = original.runtime || {};
  const providerIds = new Set(providers.map(provider => provider.runtimeId));
  const baseSupported = (runtime.supported || []).filter(id => !providerIds.has(id));
  const byId = new Map(providers.map(provider => [provider.runtimeId, provider]));
  const manifest = { ...original, runtime: { ...runtime,
    supported: [...baseSupported, ...providers.filter(provider => providerAppliesToModule(provider, original)).map(provider => provider.runtimeId)],
    entries: { ...runtime.entries }, labels: { ...runtime.labels }, manager: { ...runtime.manager }
  } };
  for (const provider of providers) {
    manifest.runtime.entries[provider.runtimeId] = { ...provider.runtime,
      ...(provider.supports ? { supports: provider.supports } : {}), runtimeProvider: true };
    manifest.runtime.labels[provider.runtimeId] = provider.runtime?.label || provider.runtimeId;
    if (provider.managerId) manifest.runtime.manager[provider.runtimeId] = provider.managerId;
  }
  const composed = { ...mod, manifest };
  composed.getRuntimeProvider = runtimeId => byId.get(runtimeId) || mod.getRuntimeProvider?.(runtimeId) || null;
  for (const kind of ["actions", "settingsActions"]) {
    const names = new Set(providers.flatMap(provider => Object.keys(provider[kind] || {})));
    if (!names.size) continue;
    composed[kind] = { ...mod[kind] };
    for (const name of names) composed[kind][name] = (...args) => {
      const runtimeId = kind === "actions" ? args[2]?.runtimeId || args[0]?.runtimeId : args[0]?.runtimeId;
      const action = byId.get(runtimeId)?.[kind]?.[name] || mod[kind]?.[name];
      if (typeof action !== "function") throw new Error("Runtime settings action is unavailable.");
      return action(...args);
    };
  }
  composed.filterRuntimeSupport = (entry, _supported, moduleSettings, context = {}) => {
    const base = typeof mod.filterRuntimeSupport === "function"
      ? mod.filterRuntimeSupport(entry, [...baseSupported], moduleSettings, context) : baseSupported;
    const supported = Array.isArray(base) ? base.filter(id => !providerIds.has(id)) : [];
    for (const provider of providers) {
      if (provider.supportsEntry(entry, moduleSettings, context)) supported.push(provider.runtimeId);
    }
    return [...new Set(supported)];
  };
  composed.canLaunchRuntime = (runtimeId, entry, moduleSettings, context = {}) => {
    const provider = byId.get(runtimeId);
    if (provider) return Boolean(provider.supportsEntry(entry, moduleSettings, context) &&
      (typeof provider.canLaunchRuntime !== "function" || provider.canLaunchRuntime(runtimeId, entry, moduleSettings, context)));
    if (original.supports?.launch === false || runtime.entries?.[runtimeId]?.launch === false) return false;
    return typeof mod.canLaunchRuntime !== "function" || mod.canLaunchRuntime(runtimeId, entry, moduleSettings, context);
  };
  if (typeof mod.normalizeRuntimeId === "function") {
    composed.normalizeRuntimeId = (runtimeId, ...args) => byId.has(runtimeId) ? runtimeId : mod.normalizeRuntimeId(runtimeId, ...args);
  }
  for (const hook of ["ensureRuntime", "prepareLaunch", "prepareInput", "getRuntimeRequirements", "getSteamApiRequirement", "resolveGraphicsInputs"]) {
    composed[hook] = (entry, context, ...args) => {
      const provider = byId.get(context?.runtimeId || entry?.runtimeId);
      if (provider) {
        if (typeof provider[hook] === "function") return provider[hook](entry, context, ...args);
        if (hook === "prepareInput") return entry;
        return hook === "getRuntimeRequirements" ? [] : null;
      }
      if (typeof mod[hook] === "function") return mod[hook](entry, context, ...args);
      // An absent ensureRuntime hook must leave shared manager planning intact.
      return hook === "getRuntimeRequirements" ? [] : null;
    };
    // Core distinguishes an absent engine setup hook from a null setup plan.
    if (hook === "ensureRuntime" && typeof mod[hook] !== "function") {
      delete composed[hook];
    }
  }
  composed.launchRuntime = (runtimeId, entry, context) => {
    const provider = byId.get(runtimeId);
    return provider ? provider.launchRuntime(runtimeId, entry, context) : mod.launchRuntime?.(runtimeId, entry, context);
  };
  if (typeof mod.resolveSaveLocations === "function" || providers.some(provider => typeof provider.resolveSaveLocations === "function")) {
    composed.resolveSaveLocations = (entry, context = {}) => {
      const owner = byId.get(context.runtimeId || entry.runtimeId) || mod;
      return typeof owner.resolveSaveLocations === "function" ? owner.resolveSaveLocations(entry, context)
        : { primaryDirectory: entry.defaultSaveDir || null, directories: entry.saveLocations || [] };
    };
  }
  return composed;
}

function decorateRuntimeEntry(entry, providers) {
  let decorated = entry;
  for (const provider of providers) if (typeof provider.decorateEntry === "function") decorated = provider.decorateEntry(decorated) || decorated;
  return decorated;
}

module.exports = { listRuntimeProviders, composeRuntimeProviders, decorateRuntimeEntry, providerAppliesToModule };
