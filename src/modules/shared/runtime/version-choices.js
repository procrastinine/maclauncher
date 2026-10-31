// Version choices for a runtime setting: the manager's installed versions and
// the listed versions this Mac can install, in catalog order. Only the local
// catalog cache is read; listing does not choose a version.
function versionChoices(manager, { userDataDir } = {}) {
  const state = manager.getState({ userDataDir }), requirements = state.catalog?.versionRequirements || {};
  const installed = (state.installed || []).map(row => row.version);
  const listed = (state.catalog?.versions || []).filter(version => !requirements[version]?.installReason);
  const versions = [...new Set([...listed, ...installed])]
    .filter(version => typeof version === "string" && version);
  return versions.slice(0, 255).map(version => ({ value: version, label: state.versionLabels?.[version] || version }));
}

/** The `listRuntimeVersions` result for a manager's version field: the
 * field's fixed options, such as an automatic choice, then the versions. */
function runtimeVersionChoices(manifest, manager, context) {
  const field = manifest.runtime?.entries?.[manager.id]?.settings?.fields?.find(item => item.optionsAction === "listRuntimeVersions");
  return { runtimeVersions: [...field?.options || [], ...versionChoices(manager, context)] };
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

/** A manager's own default when none is saved: the newest compatible stable
 * published version, or the newest ready installed version when nothing is
 * listed. Lists are newest first; a version missing locally downloads with
 * consent, and an installed one plays offline. */
function managerDefaultVersion({ listed = [], installed = [] } = {}) {
  return selectRuntimeVersion({ manual: listed.find(value => selectRuntimeVersion({ manual: value }).version),
    fallback: installed.find(value => selectRuntimeVersion({ manual: value }).version) }).version;
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
