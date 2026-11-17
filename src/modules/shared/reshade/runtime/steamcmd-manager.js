// Copyright (c) MacLauncher contributors. MIT license.
const Source = require('../steamcmd-source'), Custom = require('../../runtime/custom-runtime');
function create(dependencies = {}) {
  const manager = require('../../runtime/pinned-native-manager').createPinnedNativeManager({id: 'steamcmd', label: 'SteamCMD',
    sourceUrl: Source.location, upstream: Source.upstream, versionCompatibility: () => true,
    resolveExecutable: Source.executable, inspectRuntime: Source.inspect,
    prepareInstall: context => Source.prepare(context, dependencies), dependencies});
  manager.ui = {groupId: 'tools', tabLabel: 'Tools', sectionLabel: 'SteamCMD', order: 200, memberOrder: 210, management: 'managed'};
  manager.description = "Valve SteamCMD for authenticated Steam downloads. Refresh reads Valve's current macOS package manifest; previously installed versions remain available locally.";
  Custom.configure(manager, {prepare: async runtimePath => {
    await (dependencies.verifySigner || ((file, options) => require('../../runtime/developer-id').verifyDeveloperId(file, 'MXGJJ98X76', options)))(Source.executable(runtimePath), {});
    return {};
  }, inspect: runtimePath => Source.inspect({runtimePath, runtimeVersion: 'custom', upstreamRevision: 'custom'})});
  return manager;
}
module.exports = create();
module.exports.create = create;
