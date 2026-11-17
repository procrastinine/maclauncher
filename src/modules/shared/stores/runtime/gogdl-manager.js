const fs = require('node:fs'), path = require('node:path');
const { createPinnedNativeManager } = require('../../runtime/pinned-native-manager');
const { confirmToolInstall } = require('../../runtime/tool-install');
const Architecture = require('../../runtime/architecture');
const Core = require('../../../../core/gogdl-tool');

function createManager(dependencies = {}) {
  const manager = createPinnedNativeManager({ id: 'gogdl', label: 'GOGdl', upstream: Core.source,
    sourceUrl: Core.GOGDL.source, maxEntries: 2000,
    resolveExecutable: root => path.join(root, 'gogdl'),
    dependencies: { extractArchive: async (file, root) => {
      const target = path.join(root, 'gogdl'); fs.copyFileSync(file, target); fs.chmodSync(target, 0o755);
    }, ...dependencies } });
  manager.ui = { groupId: 'tools', tabLabel: 'Tools', sectionLabel: 'GOGdl', order: 100, memberOrder: 170, management: 'managed' };
  const prepare = manager.prepareLocalState;
  // Earlier downloads stay in their existing folders. Only the ordinary
  // version registration is added; no publisher bytes are downloaded again.
  manager.prepareLocalState = async function(options = {}) {
    await prepare?.call(this, options);
    for (const architecture of ['arm64', 'x64']) for (const row of await Core.installed(path.join(options.userDataDir, 'external/tools'), architecture)) {
      options.signal?.throwIfAborted();
      try {
        if (!manager.core.resolveInstalled({ userDataDir: options.userDataDir, version: row.version, architecture }) &&
          !fs.existsSync(path.join(manager.core.getInstallDir({ userDataDir: options.userDataDir, version: row.version, architecture }), 'runtime.json')))
          manager.core.registerLocal({ userDataDir: options.userDataDir, version: row.version, runtimePath: row.executablePath, architecture });
      } catch (error) {
        options.signal?.throwIfAborted();
        options.logger?.warn?.(`[external] Earlier GOGdl ${row.version} is unavailable: ${error.message}`);
      }
    }
  };
  const removeLegacy = remove => async function(options = {}) {
    const Coordination = require('../../../../core/coordinated-runtime-managers');
    return Coordination.withRuntimeMutation({ managerId: manager.id, version: options.version }, async () => {
      const installed = manager.core.resolveInstalled(options);
      const architecture = Architecture.targetArchitecture(installed?.architecture) || Architecture.requestedArchitecture(options) || Architecture.selectedArchitecture();
      const legacy = installed && (await Core.installed(path.join(options.userDataDir, 'external/tools'), architecture))
        .find(row => row.executablePath === installed.runtimePath && row.sha256 === installed.binarySha256);
      const result = await remove.call(this, options);
      if (result !== false && legacy) fs.rmSync(path.dirname(legacy.executablePath), { recursive: true, force: true });
      return result;
    }, { userDataDir: options.userDataDir, coordinator: options.runtimeCoordinator });
  };
  manager.ensure = async function(context = {}) {
    await manager.prepareLocalState(context);
    let selected = manager.resolveSelection({}, context.settings, context.userDataDir, { version: context.version, architecture: context.arch });
    if (!selected.ready) {
      await confirmToolInstall(context, { manager, version: selected.version, requiresDownload: true, detail: 'Required to download this GOG Galaxy build.' });
      if (!selected.version || selected.discoveryRequired) await manager.refreshCatalog({ ...context, force: false });
      context.signal?.throwIfAborted();
      selected = manager.resolveSelection({}, context.settings, context.userDataDir, { version: context.version, architecture: context.arch });
      if (!selected.version) throw new Error('The GOG download helper has no published build for this Mac.');
      const install = await manager.installRuntime({ ...context, version: selected.version, architecture: selected.architecture || context.arch, automatic: selected.automatic });
      context.onRuntimeStateChange?.(); return { ...install, managerId: manager.id };
    }
    return { ...selected.install, managerId: manager.id };
  };
  require('../../../../core/coordinated-runtime-managers').instrumentRuntimeManagers([manager]);
  manager.uninstallRuntime = removeLegacy(manager.uninstallRuntime);
  return manager;
}
module.exports = Object.assign(createManager(), { createManager });
