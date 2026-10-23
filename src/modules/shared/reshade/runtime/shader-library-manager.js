const Shaders = require("../managed-shaders");
const Presentation = require("./shader-library-ui.json");

function normalizeSettings(value) {
  const defaultVersions = {};
  for (const pack of Shaders.Catalog.packs) {
    const selected = value?.defaultVersions?.[pack.id];
    if (/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(selected || "")) defaultVersions[pack.id] = selected;
  }
  return { defaultVersions };
}
function getState({ userDataDir, settings } = {}) {
  const selected = normalizeSettings(settings), sections = Shaders.Catalog.packs.map(pack => {
    const previous = Shaders.cached(userDataDir, pack.id), available = previous?.entries || [],
      installed = Shaders.listInstalled(userDataDir, pack.id);
    let status;
    try { status = Shaders.states.get(Shaders.directory(userDataDir, pack.id)); } catch {}
    const rows = new Map(available.map(row => [row.version, row]));
    for (const row of installed) if (!rows.has(row.version)) rows.set(row.version, row.source);
    const versions = available.map(row => row.version), labels = Object.fromEntries([...rows].map(([key, row]) => [key,
      row.tag || row.date ? row.tag || `${row.date.slice(0, 10)} · ${row.commit.slice(0, 8)}` : key]));
    const recommended = available[0]?.version || null;
    return { id: pack.id, label: pack.label, supportsDefault: true, shaderFamily: pack.family, description: pack.description, managementTitle: pack.label,
      installed: installed.map(row => ({ ...row, versionLabel: labels[row.version], removalLabel: "Remove",
        removalConfirm: "Remove this installed shader pack version? Existing game settings are retained." })),
      installing: null, variants: [], defaultVersion: selected.defaultVersions[pack.id] || installed[0]?.version || null,
      versionLabels: labels,
      catalog: { status: status?.status || (previous ? "success" : "idle"), error: status?.error || null,
        fetchedAt: previous?.fetchedAt || null, source: `https://github.com/${pack.repository}`,
        sourceUrl: `https://github.com/${pack.repository}`, delivery: "download", mode: "all", versions,
        versionLabels: labels, installable: versions.length > 0, installableVersions: versions,
        includedVersions: [], buildableVersions: [], supportsLatestOnly: false, refreshLabel: "Refresh versions",
        recommendedVersion: recommended, latestAvailableVersion: recommended, latestInstalledVersion: installed[0]?.version || null,
        updateAvailable: Boolean(recommended && installed.length && !installed.some(row => row.version === recommended)),
        versionRequirements: Object.fromEntries(versions.map(key => [key, { requiresDownload: !installed.some(row => row.version === key),
          requiresBuild: false, available: installed.some(row => row.version === key), included: false, installLabel: "Install" }])) } };
  });
  return { ...sections[0], id: Shaders.ID, label: "Shader library", sections };
}
function updateDefault(settings, sectionId, selected) {
  const value = normalizeSettings(settings);
  if (!Shaders.Catalog.packs.some(pack => pack.id === sectionId)) return value;
  if (selected) value.defaultVersions[sectionId] = selected;
  else delete value.defaultVersions[sectionId];
  return normalizeSettings(value);
}
module.exports = {
  id: Shaders.ID, label: "Shader library", distributionRequired: false,
  delivery: { included: "none", catalog: "remote", sourceBuild: false },
  ui: Presentation.ui,
  normalizeSettings, getState, installRuntime: Shaders.installRuntime, uninstallRuntime: Shaders.uninstallRuntime,
  refreshCatalog: async context => {
    await Shaders.refreshCatalog(context);
    const state = getState(context);
    return (state.sections.find(section => section.id === context.sectionId) || state).catalog;
  },
  applySettingsUpdate: (action, payload, settings) => action === "setDefault"
    ? updateDefault(settings, payload?.sectionId, payload?.version) : normalizeSettings(settings),
  updateSettingsAfterInstall: (settings, installed) => updateDefault(settings, installed.packId, installed.version),
  updateSettingsAfterUninstall: (settings, payload, { userDataDir } = {}) => {
    const current = normalizeSettings(settings);
    return current.defaultVersions[payload.sectionId] === payload.version
      ? updateDefault(current, payload.sectionId, Shaders.listInstalled(userDataDir, payload.sectionId)[0]?.version) : current;
  },
  core: Shaders,
};
