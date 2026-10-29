const {createProjectBuildManager} = require('../../shared/runtime/project-build-manager');

function createManager(dependencies = {}) {
  return createProjectBuildManager({projectId:'android-art', runtimeId:'android-art', label:'Android ART', repository:'procrastinine/maclauncher-builds', upstreamUrl:'https://github.com/procrastinine/maclauncher-android',
    manifestRelative:'runtime.json', sourceRelative:manifest=>manifest.files.some(file=>file.path==='source.tar.gz')?'source.tar.gz':null,
    executableRelative:'art/host/linux-run',
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
  return [{managerId:manager.id, version:selected.version, ...(selected.discoveryRequired ? {discoveryRequired:true} : {}), installOptions:{}, label:manager.label}];
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
module.exports = {manager, createManager, requirements, resolveForLaunch};
