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

module.exports = { versionChoices, runtimeVersionChoices, selectRuntimeVersion, managerDefaultVersion };
