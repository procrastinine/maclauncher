const path = require("node:path");
const fs = require("node:fs");
const { createPinnedNativeManager } = require("../../shared/runtime/pinned-native-manager");
const Catalog = require("./catalog");
const Payload = require("./payload");
const Host = require("../../shared/runtime/bundled-native");

function createManager({ dependencies = {}, discoverCatalog = Catalog.createDiscovery(dependencies), catalog = [Catalog.DEFAULT_ENTRY] } = {}) {
  const hostReason = () => Host.versionAtLeast((dependencies.systemVersionSync || Host.systemVersionSync)(), Catalog.MINIMUM_MACOS)
    ? null : `mac32 requires macOS ${Catalog.MINIMUM_MACOS}.`;
  const base = createPinnedNativeManager({ id: "mac32", label: "mac32", sourceUrl: Catalog.SOURCE_URL,
    catalog, discoverCatalog,
    resolveExecutable: (root, pin = {}) => {
      if (pin.version) return path.join(root, Payload.executableRelative(pin.version));
      const candidates = [path.join(root, "Contents/MacOS/mac32"), path.join(root, "Mac32.app/Contents/MacOS/mac32")];
      for (const item of fs.readdirSync(root, { withFileTypes: true }))
        if (item.isDirectory() && /^mac32-[A-Za-z0-9._-]+$/.test(item.name))
          candidates.push(path.join(root, item.name, "Mac32.app/Contents/MacOS/mac32"));
      const present = candidates.filter(file => fs.existsSync(file) && fs.statSync(file).isFile());
      if (present.length !== 1) throw new Error("Choose one mac32 application or package directory.");
      return present[0];
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
      const unsupported = hostReason();
      if (unsupported) return { ...selected, install: null, ready: false, discoveryRequired: false, unsupportedHost: true, reason: unsupported };
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
            (!pin.hostArchitectures || pin.hostArchitectures.includes(process.arch));
        })])];
      const catalog = { ...state.catalog, versions, installableVersions, installable: installableVersions.length > 0,
        latestAvailableVersion: versions[0] || null,
        installReason: installableVersions.length ? null : versions.map(version => state.catalog.versionRequirements[version]?.installReason)
          .filter(Boolean).join(" · ") || hostReason() || "No compatible mac32 download is available in the current release list.",
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
