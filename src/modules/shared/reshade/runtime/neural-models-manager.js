const Models = require("../neural/models");
const Setup = require("../neural/setup");
const {runDownloadTask} = require("../../runtime/download-manager");
const MODEL_GROUPS = [{id:"rendering",label:"Neural rendering"},{id:"upscaling",label:"Upscaling"},
  {id:"restoration",label:"Restoration"},{id:"generation",label:"Frame generation"},{id:"scene",label:"Scene reconstruction"},{id:"depth",label:"Depth estimation"}];
function modelGroup(method) {
  const operation=require('../../effects/operation-contracts.mjs').MODEL_OPERATIONS[method||'mlx-dlss'];
  return ({upscale:'upscaling',temporal:'scene','frame-generation':'generation',attachment:'depth'})[operation?.kind] ||
    (operation?.history==='optional-image'?'rendering':'restoration');
}
const {modelPresentation}=require('../../effects/presentation.mjs');

function importRuntime(context = {}) {
  return runDownloadTask(context.downloads, {managerId: Models.ID, sectionId: "default", kind: "import",
    label: "Neural model import", detail: "Reading neural model…",
    dedupeKey: `neural-import:${context.userDataDir}:${context.runtimePath}`}, task => {
    const signal = context.signal && task.signal ? AbortSignal.any([context.signal, task.signal]) : context.signal || task.signal || undefined;
    return Models.importModel({...context, signal, onProgress: progress => task.onProgress?.({...progress,
      downloaded: progress.completed, total: progress.total, detail: progress.label})});
  }, {onProgress: context.onProgress});
}

function normalizeSettings(value) {
  const methods=require('../../effects/operation-contracts.mjs').MODEL_OPERATIONS,valid=version=>Models.validVersion(version)||require('../../runtime/custom-runtime').isPath(version),defaults={};
  for(const [method,version]of Object.entries(value?.defaultVersions||{}))if(Object.hasOwn(methods,method)&&valid(version))defaults[method]=version;
  return {defaultVersion:Models.validVersion(value?.defaultVersion)?value.defaultVersion:null,...(Object.keys(defaults).length||Object.hasOwn(value||{},'defaultVersions')?{defaultVersions:defaults}:{})};
}
function getState({ userDataDir, settings } = {}) {
  const source = Setup.sourceFor();
  const installed = Models.listManaged(userDataDir).map(item => ({ ...item,...modelPresentation(item.operation||item.method,item.intrinsicScale),itemGroup:modelGroup(item.operation||item.method), removalLabel: "Remove",
    removalConfirm: "Remove this imported neural model copy? The original package remains unchanged." }));
  const choices=Models.listInstalled(userDataDir),preferences={...normalizeSettings(settings),defaultVersion:require('../../runtime/custom-runtime').defaultVersion({runtimes:{[Models.ID]:settings}},Models.ID)};
  const {selectNeuralModel,compatibleNeuralModel}=require('../../effects/neural-selection.mjs'),{MODEL_OPERATIONS}=require('../../effects/operation-contracts.mjs');
  const defaultSelections=Object.entries(MODEL_OPERATIONS).flatMap(([id,operation])=>{const model=selectNeuralModel(id,choices,preferences);return model?[{id,label:operation.label,version:model.version,
    compatibleVersions:choices.filter(row=>row.ready!==false&&compatibleNeuralModel(row,id)).map(row=>row.version)}]:[];});
  const versions = installed.map(item => item.version), versionLabels = Object.fromEntries(installed.map(item => [item.version, item.versionLabel]));
  const catalog = { status: "success", delivery: "local-files", versions, versionLabels, installable: false, importable: true,
    importLabel: "Import compatible model…", importBusyLabel: "Importing neural model…", importInputKinds: ["file", "directory"], importExtensions:require('../neural/model-sources').PICKER_EXTENSIONS,
    importDescription: "Imports rendering, super-resolution, restoration, interpolation and relative-depth models with their checksums and original notices. Compatible raw weights are packaged automatically. Model terms apply separately.",
    sourceUrl: source.releaseUrl, source: source.releaseUrl,
    refreshLabel: "Reload imported models", supportsLatestOnly: false, fetchedAt: null, error: null,
    latestInstalledVersion: versions[0] || null, latestAvailableVersion: null, updateAvailable: false };
  const section = { id: "default", label: "Neural models", supportsDefault: true, managementTitle: "Neural model library",
    description: "Models can be selected in Graphics and video processing. Compatible models install from local packages or downloads. Original local sources remain unchanged.",
    itemGroups:MODEL_GROUPS.map(group=>({...group,operations:Object.keys(MODEL_OPERATIONS).filter(method=>modelGroup(method)===group.id)})),
    setupActions: Setup.sourcesFor().map(row=>{const present=Setup.sourceInstalled(choices,row),presentation=modelPresentation(row.method,present?.intrinsicScale||row.intrinsicScale||MODEL_OPERATIONS[row.method]?.scale);
      return {id:row.files?'downloadModel:'+row.version:'downloadDlssMac',label:row.label,itemGroup:modelGroup(row.method),group:'Neural',...presentation,buttonLabel:'Download model…',available:true,installed:Boolean(present),installedVersion:present?.version,description:presentation.purpose+' '+row.description+' '+row.weightTerms};}),
    setupPresentation:{mode:'table',label:'Models'},defaultSelections,
    registrationPresentation:{label:'Use existing package…',description:'Use a compatible prepared model package in its current location. Import model converts raw weights or creates a managed copy.'},
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
    if(context.setupActionId?.startsWith('downloadModel:'))return Setup.downloadModel({...context,sourceVersion:context.setupActionId.slice('downloadModel:'.length)});
    throw new Error("Choose an available neural model action.");
  },
  refreshCatalog: async context => getState(context).catalog,
  applySettingsUpdate: (action, payload, settings, {userDataDir}={}) => {
    if(action!=="setDefault")return normalizeSettings(settings);
    if(payload?.selectionId===undefined)return normalizeSettings({...settings,defaultVersion:payload?.version});
    const {MODEL_OPERATIONS}=require('../../effects/operation-contracts.mjs'),{compatibleNeuralModel}=require('../../effects/neural-selection.mjs');
    if(!Object.hasOwn(MODEL_OPERATIONS,payload.selectionId))throw Error("Choose a supported model operation.");
    const current=normalizeSettings(settings),defaults={...current.defaultVersions};
    if(payload.version===null)delete defaults[payload.selectionId];
    else {
      const selected=Models.listInstalled(userDataDir).find(row=>row.version===payload.version&&row.ready!==false&&compatibleNeuralModel(row,payload.selectionId));
      if(!selected)throw Error("Choose an installed model compatible with this operation.");
      defaults[payload.selectionId]=selected.version;
    }
    return {...settings,...current,defaultVersions:defaults};
  },
  updateSettingsAfterDefault:(settings,payload,{userDataDir,previousSettings}={})=>{
    if(payload?.selectionId!==undefined)return settings;
    const rows=Models.listInstalled(userDataDir),previous=require('../../runtime/custom-runtime').defaultVersion({runtimes:{[Models.ID]:previousSettings}},Models.ID),old=rows.find(row=>row.version===previous),selected=rows.find(row=>row.version===payload?.version),defaults={...normalizeSettings(previousSettings).defaultVersions};
    for(const row of [old,selected])if(row)for(const method of row.compatibleMethods||[row.operation||row.method])if(row===selected||!defaults[method])defaults[method]=row.version;
    if(!payload?.version)for(const [method,version]of Object.entries(defaults))if(version===previous)delete defaults[method];
    return {...settings,defaultVersions:defaults};
  },
  updateSettingsAfterInstall: (settings, installed) => normalizeSettings(settings).defaultVersion
    ? normalizeSettings(settings) : normalizeSettings({...settings, defaultVersion: installed.version }),
  updateSettingsAfterSetup: (settings, installed) => normalizeSettings(settings).defaultVersion
    ? normalizeSettings(settings) : normalizeSettings({...settings, defaultVersion: installed.version }),
  updateSettingsAfterUninstall: (settings, _payload, { userDataDir } = {}) => {
    const current = normalizeSettings(settings);
    const versions=new Set(Models.listInstalled(userDataDir).map(item=>item.version));
    return {...current,defaultVersion:versions.has(current.defaultVersion)?current.defaultVersion:null,...(current.defaultVersions?{defaultVersions:Object.fromEntries(Object.entries(current.defaultVersions).filter(([,version])=>versions.has(version)))}:{})};
  },
  core: Models,
};
require("../../runtime/custom-runtime").configure(module.exports, { defaultsPath: () => ["defaultVersion"], inspect: Models.inspectCustom,
  providers: [{ core: Models, lists: { listInstalled: "default" }, resolves: { resolveModel: { section: "default",
    userDataDir: ({ args }) => args[0], version: ({ args }) => args[1], missing: "The registered neural model is unavailable or changed. Check its path in Runtimes." } } }] });
