const { installedRuntimeAvailability } = require("../../../core/runtime-install-availability.mjs");

// Inspector choices are installed copies. The saved choice stays visible when
// absent; other versions are acquired from Runtimes or consented Play.
function versionChoices(manager, { userDataDir, selectedVersion } = {}) {
  const state = manager.getState({ userDataDir }), rows = state.installed || [];
  const installed = rows.filter(row => installedRuntimeAvailability(row) !== "unavailable");
  const versions = [...new Set(installed.map(row => row.version))]
    .filter(version => typeof version === "string" && version);
  const saved = selectRuntimeVersion({ manual: selectedVersion }).version;
  if (typeof saved === "string" && !versions.includes(saved)) versions.push(saved);
  return versions.map(version => {
    const copies = rows.filter(row => row.version === version), label = state.versionLabels?.[version] || version;
    const status = copies.some(row => installedRuntimeAvailability(row) === "installed") ? ""
      : copies.some(row => installedRuntimeAvailability(row) === "needsRepair") ? " · Needs repair"
      : copies.length ? " · Unavailable" : " (not installed)";
    return { value: version, label: label + status };
  });
}

/** The `listRuntimeVersions` result for a manager's version field: the
 * field's fixed options, such as an automatic choice, then the versions. */
function runtimeVersionChoices(manifest, manager, context = {}) {
  const field = manifest.runtime?.entries?.[manager.id]?.settings?.fields?.find(item => item.optionsAction === "listRuntimeVersions");
  const selected = field?.key ? context.runtimeSettings?.[field.key] : undefined;
  const selectedVersion = field?.options?.some(option => option.value === selected) ? undefined : selected;
  return { runtimeVersions: [...field?.options || [], ...versionChoices(manager, { ...context, selectedVersion })] };
}

/** The version a game uses, in layer order: the game's manual choice, then the
 * version its own game data recommends, then the runtime's default. The default
 * is the one saved in Runtimes or, without one, the manager's own default
 * (`fallback`). Modules supply only the recommendation; compatibility checks
 * apply to the result. Play never asks for a choice: a null version means no
 * version is known yet, so Play refreshes the catalog with consent. */
function selectRuntimeVersion({ manual, recommended, defaultVersion, fallback } = {}) {
  for (const [source, value] of [["manual", manual], ["recommended", recommended], ["default", defaultVersion], ["default", fallback]]) {
    const version = typeof value === "string" ? value.trim() : Number.isFinite(value) ? value : "";
    if (version !== "" && version !== "auto") return { version, source };
  }
  return { version: null, source: null };
}

/** A manager's own default when none is saved: a ready compatible installed
 * version, or a compatible published version when none is installed.
 * Callers supply eligible candidates in preference order. */
function managerDefaultVersion({ listed = [], installed = [] } = {}) {
  return selectRuntimeVersion({ manual: installed.find(value => selectRuntimeVersion({ manual: value }).version),
    fallback: listed.find(value => selectRuntimeVersion({ manual: value }).version) }).version;
}

/** The saved default while it can still be used: a custom runtime path, a
 * listed or installed version, or any version while nothing is listed yet
 * (offline). A saved version that upstream removed and that is not installed
 * gives way to the manager's default. */
function savedDefaultVersion(saved, { listed = [], installed = [] } = {}) {
  const version = selectRuntimeVersion({ manual: saved }).version;
  return version && (String(version).startsWith("/") || !listed.length || listed.includes(version) || installed.includes(version)) ? version : null;
}

/** The default version Play uses from a manager or section state. The state
 * shows the saved choice; Play uses it while the state lists or has installed
 * it, and otherwise the newest listed or installed version. */
function usableDefaultVersion(state) {
  const listed = state?.catalog?.versions || [];
  const installed = (state?.installed || []).filter(row => row?.ready !== false).flatMap(row => [row?.version, row?.buildKey]).filter(Boolean);
  const requirements = state?.catalog?.versionRequirements || {};
  return savedDefaultVersion(state?.defaultVersion, { listed, installed }) ||
    managerDefaultVersion({ listed: listed.filter(version => !requirements[version]?.installReason), installed });
}

module.exports = { versionChoices, runtimeVersionChoices, selectRuntimeVersion, managerDefaultVersion, savedDefaultVersion, usableDefaultVersion };
