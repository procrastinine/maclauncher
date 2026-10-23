const fs = require('node:fs'), path = require('node:path');
const {createProjectBuildManager} = require('../../shared/runtime/project-build-manager');

function includedRoot(record, options = {}, optional = false) {
  if (record.id !== 'android-art' || record.arch !== 'arm64' ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(record.version || '') ||
      record.directoryRelative !== `android-art/${record.version}/arm64` ||
      record.manifestRelative !== 'runtime.json' || record.sourceRelative !== 'source.tar.gz' ||
      !/^[a-f0-9]{64}$/.test(record.manifestSha256 || '') || !/^[a-f0-9]{64}$/.test(record.sourceSha256 || ''))
    throw new Error('The included Android ART runtime identity is invalid. Reinstall MacLauncher.');
  const roots = options.nativeResourceRoot ? [options.nativeResourceRoot] :
    [process.resourcesPath && path.join(process.resourcesPath, 'native-runtimes'), path.resolve(__dirname, '../../../resources/native-runtimes')].filter(Boolean);
  const root = roots.map(directory => path.join(directory, record.directoryRelative))
    .find(directory => fs.existsSync(optional ? directory : path.join(directory, 'runtime.json')));
  return root ? {root, record} : optional ? null : {root:path.join(roots[0], record.directoryRelative), record};
}

function included(options = {}) {
  const record = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../distribution-supplementals.json'), 'utf8'))
    .find(row => row.id === 'android-art');
  if (!record) return null;
  return includedRoot(record, options);
}

function retainedIncluded(options = {}) {
  const metadata = JSON.parse(fs.readFileSync(path.join(__dirname, 'retained-versions.json')));
  if (metadata.schemaVersion !== 1 || !Array.isArray(metadata.packages))
    throw new Error('The retained Android ART runtime metadata is invalid. Reinstall MacLauncher.');
  return metadata.packages.map(record => includedRoot(record, options, true)).filter(Boolean);
}

function createManager(dependencies = {}) {
  return createProjectBuildManager({projectId:'android-art', runtimeId:'android-art', label:'Android ART', repository:'procrastinine/maclauncher-builds',
    manifestRelative:'runtime.json', sourceRelative:manifest=>manifest.files.some(file=>file.path==='source.tar.gz')?'source.tar.gz':null,
    executableRelative:'art/host/linux-run',
    included:dependencies.included || included,
    retainedIncluded:dependencies.retainedIncluded || retainedIncluded,
    validateManifest:(manifest, record) => {
      if (record.arch !== 'arm64' || !manifest.architectures?.includes('arm64') || manifest.profile?.artExecutionVersion !== 1)
        throw new Error('The selected Android ART runtime profile is unsupported.');
    },
    verifyPayload:(selected, options) => require('../runtime-verifier').verifyPayload(selected.root, selected.declaration, options), dependencies});
}

const manager = createManager();
function requirements(entry, context) {
  const selected = manager.resolveSelection(entry, context.settings, context.userDataDir);
  if (selected.ready) return [];
  return [{managerId:manager.id, version:selected.version || 'auto', installOptions:{}, label:manager.label}];
}
async function resolveForLaunch(entry, context, {prepareSupplier} = {}) {
  const selected = manager.resolveSelection(entry, context.settings, context.userDataDir);
  if (!selected.ready) throw new Error(selected.reason);
  await context.useRuntime?.({managerId:manager.id, version:selected.version, sourcePath:selected.install.installDir});
  context.signal?.throwIfAborted();
  await require('../runtime-verifier').verifyPayload(selected.install.root, selected.install.declaration, {signal:context.signal});
  context.signal?.throwIfAborted();
  const prepare = prepareSupplier || require('./image').prepareSupplier;
  return prepare({install:selected.install, context});
}
module.exports = {manager, createManager, included, requirements, resolveForLaunch};
