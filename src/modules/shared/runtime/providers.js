// Runtime providers add a format-gated backend to independently detected engines.
// Their hooks own that backend's preparation and execution; engine hooks retain
// all ordinary behavior for the engine's other runtime choices.
function listRuntimeProviders(modules) {
  const providers = new Map();
  for (const mod of modules) {
    const provider = mod.runtimeProvider;
    if (!provider || typeof provider.runtimeId !== "string" || !provider.runtimeId ||
        typeof provider.supportsEntry !== "function" || typeof provider.launchRuntime !== "function") continue;
    if (providers.has(provider.runtimeId)) throw new Error(`Duplicate runtime provider: ${provider.runtimeId}`);
    providers.set(provider.runtimeId, provider);
  }
  return [...providers.values()];
}

function composeRuntimeProviders(mod, providers) {
  if (!providers.length) return mod;
  const original = mod.manifest || {};
  const runtime = original.runtime || {};
  const providerIds = new Set(providers.map(provider => provider.runtimeId));
  const baseSupported = (runtime.supported || []).filter(id => !providerIds.has(id));
  const byId = new Map(providers.map(provider => [provider.runtimeId, provider]));
  const manifest = { ...original, runtime: { ...runtime,
    supported: [...baseSupported, ...providerIds],
    entries: { ...runtime.entries }, labels: { ...runtime.labels }, manager: { ...runtime.manager }
  } };
  for (const provider of providers) {
    manifest.runtime.entries[provider.runtimeId] = { ...provider.runtime,
      ...(provider.supports ? { supports: provider.supports } : {}), runtimeProvider: true };
    manifest.runtime.labels[provider.runtimeId] = provider.runtime?.label || provider.runtimeId;
    if (provider.managerId) manifest.runtime.manager[provider.runtimeId] = provider.managerId;
  }
  const composed = { ...mod, manifest };
  composed.getRuntimeProvider = runtimeId => byId.get(runtimeId) || null;
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
    return typeof mod.canLaunchRuntime !== "function" || mod.canLaunchRuntime(runtimeId, entry, moduleSettings, context);
  };
  if (typeof mod.normalizeRuntimeId === "function") {
    composed.normalizeRuntimeId = (runtimeId, ...args) => byId.has(runtimeId) ? runtimeId : mod.normalizeRuntimeId(runtimeId, ...args);
  }
  for (const hook of ["ensureRuntime", "prepareLaunch", "prepareInput", "getRuntimeRequirements", "getSteamApiRequirement"]) {
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

module.exports = { listRuntimeProviders, composeRuntimeProviders, decorateRuntimeEntry };
