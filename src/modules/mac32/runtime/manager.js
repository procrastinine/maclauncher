const fs = require("node:fs");
const { createPinnedNativeManager } = require("../../shared/runtime/pinned-native-manager");
const Catalog = require("./catalog");
const Payload = require("./payload");
const { locatePackaged } = require("../../shared/runtime/release-files");
const Architecture = require("../../shared/runtime/architecture");

function createManager({ dependencies = {} } = {}) {
  const base = createPinnedNativeManager({
    // Guest programs do not name a mac32 release; each ready package retains its guest/helper interfaces together.
    versionCompatibility: () => true,
     id: "mac32", label: "mac32", sourceUrl: Catalog.SOURCE_URL,
    upstream: Catalog.source,
    resolveExecutable: root => {
      const executable = locatePackaged(root, [Payload.HOST, "Contents/MacOS/mac32"]);
      if (!executable || !fs.statSync(executable).isFile()) throw new Error("Choose one mac32 application or package directory.");
      return executable;
    },
    prepareInstall: options => Payload.preparePayload(options, dependencies), dependencies });
  const resolvePayload = Payload.createPayloadResolver(dependencies);
  const resolveInstalled = options => resolvePayload(base.core.resolveInstalled(options), options).install;
  const manager = { ...base,
    async refreshCatalog(options) {
      // Explicit Reload also verifies the guest libraries used by the engine.
      if (options?.userDataDir) manager.core.listInstalled(options.userDataDir);
      await base.refreshCatalog(options);
      return manager.getState({ userDataDir: options?.userDataDir }).catalog;
    },
    resolveSelection(entry, settings, userDataDir, options = {}) {
      const selected = base.resolveSelection(entry, settings, userDataDir, options);
      if (!selected.install) return selected;
      const result = resolvePayload(selected.install, options);
      return { ...selected, install: result.install, ready: Boolean(result.install), reason: result.reason };
    },
    getState(options = {}) {
      const state = base.getState(options);
      const installed = state.installed.map(row => {
        if (row.ready === false) return row;
        const result = resolvePayload(row, { verification: "status" });
        return result.install ? { ...result.install, ready: true, status: "ready" }
          : { ...row, ready: false, status: "damaged", error: result.reason };
      });
      const versions = state.catalog.versions;
      const pins = new Map(base.core.catalog.map(pin => [pin.version, pin]));
      const installableVersions = [...new Set([...state.catalog.installableVersions,
        ...versions.filter(version => {
          const pin = pins.get(version), requirement = state.catalog.versionRequirements[version];
          return pin?.asset && !pin.deprecated && !requirement?.installReason &&
            (!pin.hostArchitectures || pin.hostArchitectures.includes(Architecture.selectedArchitecture()));
        })])];
      const catalog = { ...state.catalog, versions, installableVersions, installable: installableVersions.length > 0,
        latestAvailableVersion: versions[0] || null,
        installReason: installableVersions.length ? null : versions.map(version => state.catalog.versionRequirements[version]?.installReason)
          .filter(Boolean).join(" · ") || "No compatible mac32 download is available in the current release list.",
        versionRequirements: Object.fromEntries(Object.entries(state.catalog.versionRequirements).map(([version, requirement]) =>
          [version, { ...requirement, available: installed.some(row => row.version === version && row.ready) }])),
        latestInstalledVersion: installed.find(row => row.ready)?.version || null };
      const versionLabels = { ...state.versionLabels,
        ...Object.fromEntries(versions.map(version => [version, state.versionLabels[version] || pins.get(version)?.versionLabel || version])) };
      const output = { ...state, installed, catalog, versionLabels };
      return { ...output, sections: [{ ...state.sections[0], ...output, sections: undefined }] };
    },
    async installRuntime(options) {
      const result = resolvePayload(await base.installRuntime(options));
      if (!result.install) throw new Error(result.reason);
      return result.install;
    },
    core: { ...base.core, get catalog() { return base.core.catalog; }, resolveInstalled,
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
