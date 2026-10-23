const Models = require("../neural/models");
const Setup = require("../neural/setup");
const {runDownloadTask} = require("../../runtime/download-manager");

function importRuntime(context = {}) {
  return runDownloadTask(context.downloads, {managerId: Models.ID, sectionId: "default", kind: "import",
    label: "Neural model import", detail: "Reading neural model…",
    dedupeKey: `neural-import:${context.userDataDir}:${context.runtimePath}`}, task => {
    const signal = context.signal && task.signal ? AbortSignal.any([context.signal, task.signal]) : context.signal || task.signal || undefined;
    return Models.importModel({...context, signal, onProgress: progress => task.onProgress?.({...progress,
      downloaded: progress.completed, total: progress.total, detail: progress.label})});
  }, {onProgress: context.onProgress});
}

function normalizeSettings(value) { return { defaultVersion: Models.validVersion(value?.defaultVersion) ? value.defaultVersion : null }; }
function getState({ userDataDir, settings } = {}) {
  const source = Setup.sourceFor();
  const installed = Models.listManaged(userDataDir).map(item => ({ ...item, removalLabel: "Remove",
    removalConfirm: "Remove this imported neural model copy? The original package remains unchanged." }));
  const versions = installed.map(item => item.version), versionLabels = Object.fromEntries(installed.map(item => [item.version, item.versionLabel]));
  const catalog = { status: "success", delivery: "local-files", versions, versionLabels, installable: false, importable: true,
    importLabel: "Import model…", importBusyLabel: "Importing neural model…", importInputKinds: ["file", "directory"], importExtensions: ["dlssmodel", "app", "zip"],
    importDescription: "Imports local .dlssmodel packages, or compatible packages inside an application or ZIP, and verifies their weights checksums. Only models and accompanying notices are copied. Models are separate downloads or local imports; model terms apply separately.",
    sourceUrl: source.releaseUrl, source: source.releaseUrl,
    refreshLabel: "Reload imported models", supportsLatestOnly: false, fetchedAt: null, error: null,
    latestInstalledVersion: versions[0] || null, latestAvailableVersion: null, updateAvailable: false };
  const section = { id: "default", label: "Neural models", supportsDefault: true, managementTitle: "Neural model library",
    description: "Models can be selected in Simple or Advanced graphics and offline video processing. Download a compatible model or import a local source. Original local sources remain unchanged.",
    setupActions: [{ id: "downloadDlssMac", label: source.label, buttonLabel: "Download model…", available: true,
      description: source.description + " " + source.weightTerms }],
    installed, installing: null, variants: [], defaultVersion: normalizeSettings(settings).defaultVersion, versionLabels, catalog };
  return { ...section, id: Models.ID, sections: [section] };
}
module.exports = {
  id: Models.ID, label: "Neural models", distributionRequired: false,
  delivery: { included: "none", catalog: "remote", sourceBuild: false },
  ui: { groupId: "graphics", tabLabel: "Neural models", sectionLabel: "Neural models", order: 0, memberOrder: 5, management: "managed" },
  normalizeSettings, getState, importRuntime, coordinateImportRuntime: importRuntime, uninstallRuntime: Models.removeModel,
  performSetupAction: context => {
    if (context.setupActionId === "downloadDlssMac") return Setup.downloadDlssMac(context);
    throw new Error("Choose an available neural model action.");
  },
  refreshCatalog: async context => getState(context).catalog,
  applySettingsUpdate: (action, payload, settings) => action === "setDefault"
    ? normalizeSettings({ defaultVersion: payload?.version }) : normalizeSettings(settings),
  updateSettingsAfterInstall: (settings, installed) => normalizeSettings(settings).defaultVersion
    ? normalizeSettings(settings) : normalizeSettings({ defaultVersion: installed.version }),
  updateSettingsAfterSetup: (settings, installed) => normalizeSettings(settings).defaultVersion
    ? normalizeSettings(settings) : normalizeSettings({ defaultVersion: installed.version }),
  updateSettingsAfterUninstall: (settings, _payload, { userDataDir } = {}) => {
    const current = normalizeSettings(settings);
    return Models.listInstalled(userDataDir).some(item => item.version === current.defaultVersion) ? current : { defaultVersion: null };
  },
  core: Models,
};
