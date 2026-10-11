const path = require("node:path");
const { createPinnedNativeManager } = require("../../shared/runtime/pinned-native-manager");
const { throwIfAborted } = require("../../shared/runtime/download-utils");
const Catalog = require("./catalog");
const Payload = require("./payload");
const { extractDmg } = require("./dmg");

function createManager({ discoverCatalog = Catalog.createDiscovery(), dependencies = {} } = {}) {
  const base = createPinnedNativeManager({
    id: "rfvp", label: "RFVP", sourceUrl: Catalog.SOURCE_URL,
    catalog: [Catalog.DEFAULT_ENTRY], recommendedVersion: Catalog.DEFAULT_VERSION, discoverCatalog,
    resolveExecutable: root => path.join(root, "RFVP.app"),
    prepareInstall: options => Payload.preparePayload(options, dependencies),
    dependencies: { extractArchive: extractDmg, ...dependencies }
  });
  const resolvePayload = Payload.createPayloadResolver(dependencies);
  const resolveInstalled = options => resolvePayload(base.core.resolveInstalled(options), options).install;
  const explicitVersion = (entry, settings) => entry?.runtimeData?.rfvp?.version || settings?.runtimes?.rfvp?.defaultVersion || null;
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
      const version = options.version || explicitVersion(entry, settings) || base.core.listCatalog({ userDataDir })[0]?.version || Catalog.DEFAULT_VERSION;
      const selection = base.resolveSelection(entry, settings, userDataDir, { ...options, version });
      if (!selection.install) return selection;
      const resolved = resolvePayload(selection.install, options);
      return { ...selection, install: resolved.install, ready: Boolean(resolved.install), reason: resolved.reason };
    },
    async resolveForPlay(entry, context) {
      const current = manager.resolveSelection(entry, context.settings, context.userDataDir);
      if (current.ready) return current;
      try {
        await manager.refreshCatalog({ userDataDir: context.userDataDir, signal: context.signal, logger: context.logger, force: true });
      } catch (error) {
        throwIfAborted(context.signal);
        if (error.name === "AbortError" || error.code === "ABORT_ERR") throw error;
        // Catalog availability cannot invalidate an already identified download.
        // A changed rolling URL still fails the archive's full SHA-256 before
        // extraction, rather than silently installing a different build.
        const pin = base.core.catalog.find(row => row.version === current.version);
        if (!pin?.asset?.sha256 || !/^[a-f0-9]{40}$/i.test(pin.upstreamRevision || "")) throw error;
        const requirements = manager.getState({ userDataDir: context.userDataDir }).catalog.versionRequirements[current.version];
        if (requirements?.installReason) throw new Error(requirements.installReason);
        base.core.rememberResolvedVersion({ userDataDir: context.userDataDir, entry: pin });
        context.logger?.warn?.(`[rfvp] version refresh failed; retaining exact download ${pin.version}: ${error.message}`);
        context.onRuntimeStateChange?.();
        return current;
      }
      context.onRuntimeStateChange?.();
      const selection = manager.resolveSelection(entry, context.settings, context.userDataDir);
      const state = manager.getState({ userDataDir: context.userDataDir, settings: context.settings?.runtimes?.rfvp });
      if (!selection.ready && !state.catalog.installableVersions.includes(selection.version))
        throw new Error(state.catalog.versionRequirements[selection.version]?.installReason ||
          "The selected RFVP download is no longer available. Select an available version in Runtimes or the game settings.");
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
