const {createProjectBuildManager} = require('../../shared/runtime/project-build-manager');
const {selectRuntimeVersion, managerDefaultVersion} = require('../../shared/runtime/version-choices');
const {compareRuntimeVersions} = require('../../shared/runtime/pinned-native-manager');
const {sourceCatalog} = require('../../shared/runtime/runtime-sources');

function createLegacyManager(dependencies = {}) {
  return createProjectBuildManager({projectId:'android-art', runtimeId:'android-art', label:'Android ART', repository:'procrastinine/maclauncher-builds', upstreamUrl:'https://github.com/procrastinine/maclauncher-android',
    manifestRelative:'runtime.json', sourceRelative:manifest=>manifest.files.some(file=>file.path==='source.tar.gz')?'source.tar.gz':null,
    executableRelative:'art/host/linux-run',
    validateManifest:(manifest, record) => {
      if (record.arch !== 'arm64' || !manifest.architectures?.includes('arm64') || manifest.profile?.artExecutionVersion !== 1)
        throw new Error('The selected Android ART runtime profile is unsupported.');
    },
    verifyPayload:(selected, options) => require('../runtime-verifier').verifyPayload(selected.root, selected.declaration, options), dependencies});
}

/** ART shares new Android installations; separate installed adapters retain
 * their original storage, version choices and removal operations. */
function createManager({commonManager, legacyManager, ...dependencies} = {}) {
  commonManager ||= Object.keys(dependencies).length ? require('../runtime-manager').createManager(dependencies) : require('../runtime-manager');
  const legacy = legacyManager || createLegacyManager(dependencies);
  const hasArt = selected => selected?.ready && selected.install?.manifest?.profile?.artExecutionVersion === 1;
  const pinSupportsArt = (pin, userDataDir) => pin.projectPackage?.capabilities?.artExecutionVersion === 1 ||
    hasArt(commonManager.resolveSelection(null, {}, userDataDir, {version:pin.version, verification:'status'}));
  const withOwner = (selected, owner) => ({...selected, managerId:owner.id,
    ...(selected.ready && selected.install ? {runtimeUses:[{managerId:owner.id, version:selected.version,
      sourcePath:selected.install.installDir || selected.install.root}]} : {})});
  function resolveSelection(entry, settings, userDataDir, options = {}) {
    const configured = legacy.normalizeSettings(settings?.runtimes?.['android-art']);
    const requested = selectRuntimeVersion({manual:options.version,
      recommended:entry?.runtimeData?.['android-art']?.version,
      defaultVersion:configured.customDefaults?.default || configured.defaultVersion}).version;
    if (requested) {
      const previous = legacy.resolveSelection(entry, settings, userDataDir, {...options, version:requested});
      if (previous.ready) return withOwner(previous, legacy);
      const unified = commonManager.resolveSelection(entry, settings, userDataDir, {...options, version:requested});
      if (hasArt(unified) || commonManager.core.listDiscoveredCatalog({userDataDir}).some(pin => pin.version === requested && pinSupportsArt(pin, userDataDir)))
        return withOwner(unified, commonManager);
      return withOwner(previous, legacy);
    }
    const unified = commonManager.resolveSelection(entry, settings, userDataDir, {...options,
      compatible:pin => pinSupportsArt(pin, userDataDir) && (!options.compatible || options.compatible(pin))});
    if (hasArt(unified)) return withOwner(unified, commonManager);
    const previous = legacy.resolveSelection(entry, settings, userDataDir, options);
    if (previous.ready) return withOwner(previous, legacy);
    const state = commonManager.getState({userDataDir}), pins = commonManager.core.listDiscoveredCatalog({userDataDir});
    const version = managerDefaultVersion({listed:pins.filter(pin => pinSupportsArt(pin, userDataDir) &&
      !state.catalog.versionRequirements[pin.version]?.installReason).map(pin => pin.version).sort(compareRuntimeVersions),
      installed:state.installed.filter(row => hasArt(commonManager.resolveSelection(null, {}, userDataDir, {version:row.version, verification:'status'})))
        .map(row => row.version).sort(compareRuntimeVersions)});
    if (version) return withOwner(commonManager.resolveSelection(entry, settings, userDataDir, {...options, version}), commonManager);
    return {version:null, ready:false, install:null, managerId:commonManager.id, requiresDownload:true, discoveryRequired:true,
      reason:'No Android versions with ART are available to download.'};
  }
  const owner = (options = {}) => options.legacyAdapter === true || options.version &&
    legacy.getState({userDataDir:options.userDataDir}).installed.some(row => row.version === options.version) ? legacy : commonManager;
  const manager = {...legacy, resolveSelection,
    resolveCommonSelection(entry, settings, userDataDir, options = {}) {
      const selected = manager.resolveSelection(entry, settings, userDataDir, options);
      return selected.managerId === commonManager.id ? selected : commonManager.resolveSelection(entry, settings, userDataDir, options);
    },
    refreshCatalog:options => commonManager.refreshCatalog(options),
    installRuntime:options => owner(options).installRuntime(options),
    importRuntime:options => owner(options).importRuntime(options),
    registerCustomRuntime:options => owner(options).registerCustomRuntime(options),
    uninstallRuntime:options => owner(options).uninstallRuntime(options),
    getState(options = {}) {
      const common = commonManager.getState({...options, settings:options.runtimeSettings?.android || options.settings});
      const previous = legacy.getState(options), pins = commonManager.core.listDiscoveredCatalog({userDataDir:options.userDataDir});
      const versions = new Set(pins.filter(pin => pinSupportsArt(pin, options.userDataDir)).map(pin => pin.version));
      const installed = common.installed.filter(row => hasArt(commonManager.resolveSelection(null, {}, options.userDataDir, {version:row.version, verification:'status'})));
      const catalog = {...common.catalog, versions:common.catalog.versions.filter(version => versions.has(version)),
        installableVersions:common.catalog.installableVersions.filter(version => versions.has(version))};
      catalog.installable = catalog.installableVersions.length > 0;
      // ART versions are installed through the Android runtime, which lists
      // the downloads; this view keeps earlier ART installs and the ART default.
      catalog.packagesFrom = {managerId:commonManager.id, label:common.label || commonManager.label};
      if (catalog.sources) catalog.sources = catalog.sources.map(source => sourceCatalog(source, {
        id:source.id, label:source.label, source:source.source, versions:source.versions.filter(version => versions.has(version))}));
      const retainedVersions = new Set(previous.installed.map(row => row.version));
      const current = {...common, installed:[...installed.filter(row => !retainedVersions.has(row.version)), ...previous.installed],
        catalog:{...catalog, versionRequirements:{...catalog.versionRequirements, ...Object.fromEntries(previous.installed
          .filter(row => previous.catalog.versionRequirements[row.version]).map(row => [row.version, previous.catalog.versionRequirements[row.version]]))}},
        versionLabels:{...previous.versionLabels, ...common.versionLabels}, label:legacy.label};
      const selected = resolveSelection(null, {runtimes:options.runtimeSettings || {'android-art':options.settings}}, options.userDataDir);
      current.defaultVersion = selected.version;
      return {...current, sections:[{...current, id:'default', label:'Android ART versions'}]};
    }
  };
  return manager;
}

const manager = createManager();
function requirements(entry, context) {
  const selected = manager.resolveSelection(entry, context.settings, context.userDataDir);
  if (selected.ready) return [];
  const managerId = selected.managerId || manager.id;
  return [{managerId, version:selected.version, ...(selected.discoveryRequired ? {discoveryRequired:true} : {}),
    installOptions:managerId === manager.id ? {legacyAdapter:true} : {}, label:manager.label}];
}
async function resolveForLaunch(entry, context, {prepareSupplier} = {}) {
  const selected = manager.resolveSelection(entry, context.settings, context.userDataDir);
  if (!selected.ready) throw new Error(selected.reason);
  await context.useRuntime?.({managerId:selected.managerId || manager.id, version:selected.version, sourcePath:selected.install.installDir});
  context.signal?.throwIfAborted();
  await require('../runtime-verifier').verifyPayload(selected.install.root, selected.install.declaration, {signal:context.signal});
  context.signal?.throwIfAborted();
  const prepare = prepareSupplier || require('./image').prepareSupplier;
  return prepare({install:selected.install, context});
}
module.exports = {manager, createManager, createLegacyManager, requirements, resolveForLaunch};
