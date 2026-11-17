// Copyright (c) MacLauncher contributors. MIT license.
const fs = require('node:fs');
const Library = require('../temporal/fsr4/models'), Releases = require('../temporal/fsr4/model-catalog');
const {descriptor} = Library, Custom = require('../../runtime/custom-runtime');
const {selectRuntimeVersion, managerDefaultVersion} = require('../../runtime/version-choices');
const PROFILES = [{id: 'int8-lite', label: 'FSR 4.1.2 Lite'}, {id: 'int8-lite-lossy', label: 'FSR 4.1.2 Lite Lossy'}];
const options = context => ({...context, root: context.root || require('..').runtimeRoot(context.app)});
const complete = current => PROFILES.every(profile => current?.profiles.includes(profile.id));
const installedLabel = current => current.profiles.includes('int8-lite-lossy') ? 'FSR 4.1.2 Lite and Lite Lossy' : 'FSR 4.1.2 Lite';
function normalizeSettings(value) { return {defaultVersion: Releases.validVersion(value?.defaultVersion) ? value.defaultVersion : null}; }
function selection(context = {}) {
  const settings = context.settings?.runtimes ? context.settings : {runtimes: {[descriptor.managerId]: context.settings}};
  const saved = Custom.defaultVersion(settings, descriptor.managerId);
  const installed = Library.listInstalled(context.userDataDir), sources = Releases.sources(context.userDataDir);
  const chosen = selectRuntimeVersion({manual: context.version, defaultVersion: saved,
    fallback: managerDefaultVersion({installed: installed.map(row => row.version), listed: sources.map(row => row.version)})});
  if (Custom.isPath(chosen.version)) return {...chosen, automatic: false, current: Custom.forManager(module.exports).resolve(context.userDataDir, chosen.version, 'default')};
  return {...chosen, automatic: !selectRuntimeVersion({manual: context.version}).version && !saved, current: installed.find(row => row.version === chosen.version) || null,
    sourceSpec: sources.find(row => row.version === chosen.version)};
}
function getState(context = {}) {
  const installed = Library.listInstalled(context.userDataDir).map(current => ({...current, versionLabel: installedLabel(current), removalLabel: 'Remove'}));
  const sourceRows = Releases.sources(context.userDataDir), sources = new Map(sourceRows.map(row => [row.version, row]));
  const versions = [...new Set([...sources.keys(), ...installed.map(row => row.version)])];
  const provider = require('../temporal/fsr4').inspect(options(context).root), available = provider?.profiles.includes('int8-lite') === true;
  const selected = selection(context), current = selected.current;
  const catalog = {status: Releases.read(context.userDataDir) ? 'success' : 'idle', delivery: 'download', versions,
    versionLabels: Object.fromEntries(versions.map(version => [version, 'FSR 4.1.2 Lite and Lite Lossy'])),
    installable: available, installableVersions: available ? [...sources.keys()] : [], includedVersions: [], buildableVersions: [],
    versionRequirements: Object.fromEntries(versions.map(version => { const row = installed.find(row => row.version === version), source = sources.get(version);
      return [version, {requiresDownload: !complete(row), requiresBuild: false, available: complete(row), included: false,
        ...(source ? {downloadBytes: source.archiveBytes + source.lossy.archiveBytes} : {}),
        ...(!available ? {reason: 'The selected graphics processor does not include FSR 4.1.2 Lite.'} : {})}]; })),
    importable: available, importInputKinds: ['file', 'directory'], importExtensions: ['zip'], importLabel: 'Import FSR 4 model data…',
    importDescription: 'Imports the selected original release archive or compatible model data directory. Prepared model directories can also be registered in place.',
    sourceUrl: Releases.sourceUrl, source: Releases.sourceUrl, refreshLabel: 'Refresh upstream releases', supportsLatestOnly: false,
    fetchedAt: Releases.read(context.userDataDir)?.fetchedAt || null, error: null,
    latestInstalledVersion: installed[0]?.version || null, latestAvailableVersion: sourceRows[0]?.version || null, updateAvailable: false};
  const section = {id: 'default', label: 'FSR 4 models', managementTitle: descriptor.label, supportsDefault: true,
    defaultVersion: normalizeSettings(context.settings).defaultVersion, defaultSource: selected.automatic ? 'manager' : 'saved',
    installed, variants: [], capabilities: PROFILES.map(profile => ({...profile, available: current?.profiles.includes(profile.id) === true})), installing: null, catalog,
    sourceLinks: [{label: 'Upstream releases', url: Releases.sourceUrl}],
    description: 'FSR 4.1.2 Lite and Lite Lossy model data. Downloads and imports retain their selected version and are checked against the model preparation format.'};
  return {...section, id: descriptor.managerId, sections: [section]};
}
function launchPlan(context = {}, profile) {
  if (!PROFILES.some(item => item.id === profile)) return null;
  const chosen = selection(context);
  if (chosen.current?.profiles.includes(profile) || !chosen.sourceSpec || !getState(context).catalog.installable) return null;
  return {managerId: descriptor.managerId, version: chosen.version, label: descriptor.label, automatic: chosen.automatic,
    bytes: chosen.sourceSpec.archiveBytes + (profile === 'int8-lite-lossy' ? chosen.sourceSpec.lossy.archiveBytes : 0),
    installOptions: {sectionId: 'default', fsr4Profile: profile}};
}
async function installRuntime(context = {}) {
  const chosen = selection(context), profile = context.fsr4Profile || 'int8-lite-lossy';
  if (chosen.current?.profiles.includes(profile)) return chosen.current;
  if (!chosen.sourceSpec) throw Error('Refresh FSR 4 releases or choose an installed compatible model version.');
  return Library.install({...options(context), sourceSpec: chosen.sourceSpec, fsr4Profile: profile});
}
async function remove(context = {}) {
  const root = Library.directory(context.userDataDir, context.version || selection(context).version);
  require('../../writable-input').assertOwnDirectory(context.userDataDir, root, {create: false});
  return require('../../../../core/coordinated-runtime-managers').withRuntimeMutation({managerId: descriptor.managerId, version: context.version, sourcePath: root},
    () => fs.promises.rm(root, {recursive: true, force: true}), {userDataDir: context.userDataDir});
}
function importRuntime(context = {}) {
  const chosen = selection(context);
  return Library.importRuntime({...options(context), sourceSpec: chosen.sourceSpec});
}
module.exports = {id: descriptor.managerId, label: 'FSR 4 models', distributionRequired: false,
  delivery: {included: 'none', catalog: 'remote', sourceBuild: false},
  ui: {groupId: 'graphics', tabLabel: 'Graphics', sectionLabel: 'FSR 4 models', order: 0, memberOrder: 7, management: 'managed'},
  getState, launchPlan, selection, normalizeSettings, installRuntime, coordinateImportRuntime: importRuntime, importRuntime,
  uninstallRuntime: remove, refreshCatalog: async context => { await Releases.refresh(context);return getState(context).catalog; },
  applySettingsUpdate: (action, payload, settings) => action === 'setDefault' ? normalizeSettings({...settings, defaultVersion: payload.version}) : normalizeSettings(settings),
  performSetupAction: context => { if (context.setupActionId === 'download') return installRuntime(context);throw Error('Choose an available FSR 4 model action.'); }, core: Library};
Custom.configure(module.exports, {defaultsPath: () => ['defaultVersion'], inspect: Library.inspectCustom});
