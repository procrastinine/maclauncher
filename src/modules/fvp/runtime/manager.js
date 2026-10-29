const path = require("node:path");
const { createPinnedNativeManager } = require("../../shared/runtime/pinned-native-manager");
const Catalog = require("./catalog");
const Payload = require("./payload");
const { throwIfAborted } = require("../../shared/runtime/download-utils");
const { extractDmg } = require("./dmg");

function createManager({ discoverCatalog = Catalog.createDiscovery(), dependencies = {} } = {}) {
  const base = createPinnedNativeManager({
    id: "rfvp", label: "RFVP", sourceUrl: Catalog.SOURCE_URL,
    catalog: [Catalog.DEFAULT_ENTRY], discoverCatalog,
    resolveExecutable: root => path.join(root, "RFVP.app"),
    prepareInstall: options => Payload.preparePayload(options, dependencies),
    dependencies: { extractArchive: extractDmg, ...dependencies }
  });
  const resolvePayload = Payload.createPayloadResolver(dependencies);
  const resolveInstalled = options => resolvePayload(base.core.resolveInstalled(options), options).install;
  const manager = {
    ...base,
    async refreshCatalog(options) {
      const result = await base.refreshCatalog(options);
      // Reload is explicit; refresh the consumed library identities as well as
      // the publisher launcher's shared registration check.
      manager.core.listInstalled(options?.userDataDir);
      return result;
    },
    resolveSelection(entry, settings, userDataDir, options = {}) {
      const selection = base.resolveSelection(entry, settings, userDataDir, options);
      if (!selection.install) return selection;
      const resolved = resolvePayload(selection.install, options);
      return { ...selection, install: resolved.install, ready: Boolean(resolved.install), reason: resolved.reason };
    },
    async resolveForPlay(entry, context) {
      throwIfAborted(context.signal);
      const selection = manager.resolveSelection(entry, context.settings, context.userDataDir);
      return selection;
    },
    getState(options = {}) {
      const state = base.getState(options);
      const requirements = { ...state.catalog.versionRequirements };
      const installed = state.installed.map(row => {
        if (row.ready === false) return row;
        const result = resolvePayload(row, { verification: "status" });
        requirements[row.version] = { ...requirements[row.version], available: Boolean(result.install),
          ...(result.minimumMacOS ? { minimumMacOS: result.minimumMacOS,
            ...(result.install ? {} : { installReason: result.reason }) } : {}) };
        return result.install ? { ...result.install, ready: true, status: "ready" }
          : { ...row, ready: false, status: result.minimumMacOS ? "unsupported-host" : "damaged", error: result.reason };
      });
      const catalog = { ...state.catalog, versionRequirements: requirements,
        installableVersions: state.catalog.installableVersions.filter(version => !requirements[version]?.installReason),
        latestInstalledVersion: installed.find(row => row.ready)?.version || null };
      catalog.installable = catalog.installableVersions.length > 0;
      const output = { ...state, installed, catalog };
      return { ...output, sections: [{ ...state.sections[0], ...output, sections: undefined }] };
    },
    async installRuntime(options) {
      if (!options.version || options.version === "auto") {
        const settings = options.settings?.runtimes ? options.settings : { runtimes: { rfvp: options.settings } };
        let selected = manager.resolveSelection({}, settings, options.userDataDir);
        if (!selected.ready && selected.discoveryRequired) {
          await manager.refreshCatalog({ ...options, force: true });
          selected = manager.resolveSelection({}, settings, options.userDataDir);
        }
        options = { ...options, version: selected.version };
      }
      const installed = await base.installRuntime(options);
      const result = resolvePayload(installed);
      if (!result.install) throw new Error(result.reason);
      return result.install;
    },
    core: {
      ...base.core,
      get catalog() { return base.core.catalog; },
      resolveInstalled,
      resolveRegistered: options => resolvePayload(base.core.resolveRegistered(options), options).install,
      listInstalled: userDataDir => base.core.listInstalled(userDataDir).map(install => resolvePayload(install).install).filter(Boolean),
      async installVersion(options) {
        const result = resolvePayload(await base.core.installVersion(options));
        if (!result.install) throw new Error(result.reason);
        return result.install;
      }
    }
  };
  return manager;
}

module.exports = createManager();
module.exports.createManager = createManager;
module.exports.DEFAULT_VERSION = Catalog.DEFAULT_VERSION;
