const Models = require("../models");
const Sources = require("../model-sources");
const SteamClient = require("../steam-client-models");
const {runDownloadTask} = require("../../runtime/download-manager");
const STEAMCMD_DESCRIPTION = "Downloads SteamCMD from Valve and opens Terminal for Steam sign-in and Steam Guard, separately from the Steam desktop app. An account that owns Lossless Scaling is required. Rosetta may be installed after consent. Compatible models are imported automatically; temporary downloads and sign-in files are removed. CrossOver and the Steam desktop app are not required.";

function runImport(context, action, detail) {
  return runDownloadTask(context.downloads, {managerId: "graphics-models", sectionId: "default", kind: "import",
    label: "Lossless Scaling models", detail,
    dedupeKey: `lossless-import:${context.userDataDir}:${context.runtimePath || "findInstalled"}`}, task => {
    const signal = context.signal && task.signal ? AbortSignal.any([context.signal, task.signal]) : context.signal || task.signal || undefined;
    return action({...context, signal, onProgress: task.onProgress});
  }, {onProgress: context.onProgress});
}
function importRuntime(context = {}) { return runImport(context, Models.importModel, "Inspecting models…"); }

// Imported files carry separate LS1 spatial upscaling and LSFG frame generation
// models; each family is available once one ready file is compatible with it.
const FAMILIES = Object.freeze([{ id: "ls1", label: "LS1 spatial upscaling" }, { id: "lsfg", label: "LSFG frame generation" }]);
const carries = (item, prefix) => item.ready !== false &&
  Object.entries(item.inspection?.capabilities || {}).some(([key, value]) => key.startsWith(prefix) && value?.compatible === true);
function modelFamilies(installed) {
  return FAMILIES.map(family => ({ ...family, available: installed.some(item => carries(item, family.id)) }));
}
// Each imported file names the families it provides.
function fileDetail(item) {
  const families = FAMILIES.filter(family => carries(item, family.id)).map(family => family.label);
  return families.length ? `Provides ${families.join(" and ")}.` : undefined;
}

function normalizeSettings(value) {
  return { defaultVersion: /^sha256-[a-f0-9]{64}$/.test(value?.defaultVersion || "") ? value.defaultVersion : null };
}
function getState({ userDataDir, settings, root, platform, macOSVersion } = {}) {
  const steamClient = process.platform === "darwin" && SteamClient.findClient();
  const installed = Models.listManaged(userDataDir).map(item => ({ ...item, detail: fileDetail(item), removalLabel: "Remove",
    removalConfirm: "Remove this imported model copy? The original Lossless Scaling files will remain unchanged." }));
  const versions = installed.map(item => item.version), versionLabels = Object.fromEntries(installed.map(item => [item.version, item.versionLabel]));
  const catalog = { status: "success", delivery: "local-files", versions, versionLabels, installable: false, importable: Models.inspectionAvailable(),
    importLabel: "Import Lossless Scaling DLL…", importBusyLabel: "Inspecting models…",
    importInputKinds: ["file"], importExtensions: ["dll"],
    importDescription: "Copy compatible models from an installed Lossless Scaling DLL. The original file remains unchanged. Graphics methods depend on the active renderer.",
    refreshLabel: "Reload installed models", supportsLatestOnly: false, fetchedAt: null, error: null,
    latestInstalledVersion: versions[0] || null, latestAvailableVersion: null, updateAvailable: false };
  const section = { id: "default", label: "Lossless Scaling", supportsDefault: true, installed, installing: null,
    managementTitle: "Lossless Scaling models", capabilities: modelFamilies(installed),
    components: require("./components").getComponents({ root, platform, macOSVersion, installed: installed.filter(item => item.ready !== false) }),
    componentsTitle: "Upscaling and frame generation",
    componentsDescription: "Included components follow MacLauncher updates; MetalFX follows macOS updates. Available game options depend on the renderer and the inputs it provides.",
    description: "Lossless Scaling provides LS1 spatial upscaling and LSFG frame generation models. They can be downloaded through Steam, found in an existing installation or imported from a DLL. An account that owns Lossless Scaling is required.",
    setupActions: [
      { id: "findInstalled", label: "Installed copies", buttonLabel: "Find in Steam / CrossOver", available: Models.inspectionAvailable(),
        description: "Find and import compatible DLLs in standard Steam libraries, Steam console downloads and CrossOver bottles. No network access." },
      { id: "downloadSteam", label: "Steam download", buttonLabel: "Download from Steam…", available: Models.inspectionAvailable() && process.platform === "darwin",
        description: steamClient ? "Uses the installed Mac Steam client and its signed-in account to download Windows files, then imports compatible models automatically. The account must own Lossless Scaling. Steam keeps the downloaded files. Cancel stops waiting and importing; Steam may finish its own download. CrossOver is not required." : STEAMCMD_DESCRIPTION },
      ...(steamClient ? [{ id: "downloadSteamCMD", label: "SteamCMD alternative", buttonLabel: "Use SteamCMD…",
        available: Models.inspectionAvailable(), description: STEAMCMD_DESCRIPTION }] : [])
    ],
    defaultVersion: normalizeSettings(settings).defaultVersion, versionLabels, catalog, variants: [] };
  catalog.sourceUrl = Sources.STORE_URL; catalog.source = Sources.STORE_URL;
  return { ...section, id: "graphics-models", sections: [section] };
}

module.exports = {
  id: "graphics-models", label: "Graphics",
  ui: { groupId: "graphics", tabLabel: "Graphics", sectionLabel: "Lossless Scaling", order: 0, memberOrder: 0, management: "managed" },
  normalizeSettings, getState, importRuntime, coordinateImportRuntime: importRuntime,
  prepareLocalState: ({root, app, ...options} = {}) => require("../hardware-support").inspect(root || require("..").runtimeRoot(app), options),
  performSetupAction: context => {
    if (context.setupActionId === "findInstalled") return runImport(context, Sources.importFound, "Finding installed models…");
    if (context.setupActionId === "downloadSteam" && SteamClient.findClient()) return SteamClient.downloadWithClient(context);
    if (["downloadSteam", "downloadSteamCMD"].includes(context.setupActionId)) return require("../steam-models").downloadFromSteam(context);
    throw new Error("Unknown graphics model action.");
  },
  updateSettingsAfterSetup: (settings, installed) => normalizeSettings(settings).defaultVersion
    ? normalizeSettings(settings) : normalizeSettings({ defaultVersion: installed.version }),
  refreshCatalog: async context => getState(context).catalog,
  uninstallRuntime: ({ userDataDir, version }) => Models.removeModel(userDataDir, version),
  applySettingsUpdate: (action, payload, settings) => action === "setDefault"
    ? normalizeSettings({ defaultVersion: payload?.version }) : normalizeSettings(settings),
  updateSettingsAfterInstall: (settings, installed) => normalizeSettings(settings).defaultVersion
    ? normalizeSettings(settings) : { defaultVersion: installed.version },
  updateSettingsAfterUninstall: (settings, _payload, { userDataDir } = {}) => {
    const current = normalizeSettings(settings);
    return Models.listInstalled(userDataDir).some(item => item.version === current.defaultVersion) ? current : { defaultVersion: null };
  },
  core: Models
};
require("../../runtime/custom-runtime").configure(module.exports, { defaultsPath: () => ["defaultVersion"],
  prepare: Models.prepareCustom, inspect: Models.inspectCustom, providers: [{ core: Models, lists: { listInstalled: "default" },
    resolves: { resolveModel: { section: "default", userDataDir: ({ args }) => args[0], version: ({ args }) => args[1],
      compatible: (install, { args }) => install.inspection?.capabilities?.[args[2]]?.compatible,
      missing: "The registered graphics model is unavailable or incompatible." } } }] });
