const Requirements = require("./feature-requirements");
const Host = require("./host-capabilities");
const { restoreRuntimeState } = require("../../../core/runtime-state-snapshot.mjs");

// A runtime setting or one of its choices names the feature it depends on, such
// as "WINE_TEMPORAL" or "TEMPLATE_RENDERERS.kosmickrisp" in feature-requirements.
// A Mac whose processor or macOS version can never meet that feature does not
// list it. An unknown name or an unmeasured host fact keeps it listed.
function featureRequirement(name) {
  if (typeof name !== "string" || !name) return null;
  const requirement = name.split(".").reduce((value, key) => value && Object.hasOwn(value, key) ? value[key] : null, Requirements);
  return requirement && typeof requirement === "object" && (requirement.minimumMacOS || requirement.hardwareArchitectures) ? requirement : null;
}

// The reason a feature can never be met on this Mac, or null.
function unavailableReason(name, host = Host.getHostCapabilities()) {
  const requirement = featureRequirement(name);
  if (!requirement) return null;
  const support = Requirements.requirementSupport(requirement, host);
  return support.supported === false ? support.reason || `Requires ${requirement.label}.` : null;
}
const unavailableHere = (name, host) => Boolean(unavailableReason(name, host));

// A runtime entry that names a feature this Mac can never meet, such as an
// Apple-Silicon-only Android host on an Intel Mac, leaves runtime.supported.
// runtime.unavailableHere keeps its reason for the game's launch requirement.
function withHostRuntimes(manifest, host) {
  const runtime = manifest.runtime, entries = runtime.entries || {};
  const removed = Object.fromEntries((runtime.supported || []).map(id => [id, unavailableReason(entries[id]?.hostFeature, host)]).filter(([, reason]) => reason));
  if (!Object.keys(removed).length) return manifest;
  const supported = runtime.supported.filter(id => !removed[id]);
  return { ...manifest, runtime: { ...runtime, supported, unavailableHere: removed,
    ...(removed[runtime.default] ? { default: supported[0] ?? runtime.default } : {}) } };
}

function withHostSettings(manifest, host = Host.getHostCapabilities()) {
  const entries = manifest?.runtime?.entries;
  if (!entries || typeof entries !== "object" || host?.platform !== "darwin") return manifest;
  manifest = withHostRuntimes(manifest, host);
  const listed = Object.fromEntries(Object.entries(entries).map(([id, entry]) => {
    const fields = entry?.settings?.fields;
    if (!Array.isArray(fields)) return [id, entry];
    return [id, { ...entry, settings: { ...entry.settings, fields: fields
      .filter(field => !unavailableHere(field?.hostFeature, host))
      .map(field => Array.isArray(field?.options) && field.options.some(option => option?.hostFeature)
        ? { ...field, options: field.options.filter(option => !unavailableHere(option?.hostFeature, host)) } : field) } }];
  }));
  return { ...manifest, runtime: { ...manifest.runtime, entries: listed } };
}

// Build choices for a CPU this Mac can never run, such as Apple Silicon builds
// on an Intel Mac, are not offered. Intel builds stay on Apple Silicon, where
// they run through Rosetta.
function withRunnableBuilds(state, support = architecture => Host.architectureSupport(architecture)) {
  state = restoreRuntimeState(state);
  if (!state || typeof state !== "object") return state;
  const catalog = value => {
    const catalogs = value?.architectureCatalogs;
    if (!catalogs || typeof catalogs !== "object") return value;
    const kept = Object.fromEntries(Object.entries(catalogs).filter(([architecture]) => support(architecture).supported !== false));
    return Object.keys(kept).length === Object.keys(catalogs).length ? value : { ...value, architectureCatalogs: kept };
  };
  return { ...state, ...(state.catalog ? { catalog: catalog(state.catalog) } : {}),
    ...(Array.isArray(state.sections) ? { sections: state.sections.map(section => section?.catalog ? { ...section, catalog: catalog(section.catalog) } : section) } : {}) };
}

module.exports = { featureRequirement, unavailableReason, withHostSettings, withRunnableBuilds };
