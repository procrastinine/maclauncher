const path = require("node:path");
const { AsyncLocalStorage } = require("node:async_hooks");
const { createPinnedNativeManager } = require("../../../shared/runtime/pinned-native-manager");
const { downloadToFile, throwIfAborted } = require("../../../shared/runtime/download-utils");
const Catalog = require("./catalog");
const Payload = require("./payload");
const { extractArchive } = require("./archive");
const fs = require("node:fs");
const Custom = require("../../../shared/runtime/custom-runtime");
const DEFAULT_VERSION = "10.0_8-template-1.0.21-1c9e9a0c3b96cf9d27ca4b01";

function createManager({ discoverCatalog = Catalog.createDiscovery(), dependencies = {} } = {}) {
  let base;
  const downloadContext = new AsyncLocalStorage();
  const downloader = dependencies.downloadToFile || downloadToFile;
  base = createPinnedNativeManager({
    id: "sikarugir", label: "Sikarugir Wine", sourceUrl: Catalog.SOURCE_URL,
    discoverCatalog, resolveExecutable: root => path.join(root, Payload.WINE_ROOT, "bin", "wine"),
    prepareInstall: options => Payload.preparePayload(options, dependencies),
    dependencies: { ...dependencies,
      extractArchive: async (archive, destination, signal) => {
        const context = downloadContext.getStore(), pin = context?.pin;
        context?.onProgress?.({ downloaded: pin.asset.bytes, total: pin.downloadBytes,
          detail: `${pin.versionLabel} · Extracting Wine engine…` });
        return (dependencies.extractArchive || extractArchive)(archive, destination, signal);
      },
      downloadToFile: async (url, destination, options = {}) => {
        const context = downloadContext.getStore(), pin = context?.pin;
        if (context) context.onProgress = options.onProgress;
        return downloader(url, destination, { ...options, onProgress: progress => options.onProgress?.({ ...progress,
          ...(pin ? { total: pin.asset.bytes + pin.template.asset.bytes,
            detail: `${pin.versionLabel} · Downloading Wine engine…` } : {}) }) });
      } }
  });
  const inspectPayload = Payload.createPayloadResolver(dependencies);
  const resolvePayload = (install, options) => {
    if (install) {
      const pin = base.core.catalog.find(row => row.version === install.version);
      if (!Catalog.validateEntry(pin) || install.archiveSha256 !== pin.asset.sha256 ||
        install.installationMetadata?.template?.archiveSha256 !== pin.template.asset.sha256)
        return { install: null, reason: "Sikarugir archive identities changed. Remove and install this version again." };
    }
    return inspectPayload(install, options);
  };
  function planned(selection) {
    const pin = base.core.catalog.find(row => row.version === selection.version);
    if (!pin) return selection;
    return { ...selection, versionLabel: pin.versionLabel, engineVersion: pin.engineVersion,
      downloadBytes: pin.downloadBytes, artifacts: [pin.asset, pin.template.asset],
      detail: `Downloads the Wine engine and its matching support libraries (${Math.ceil(pin.downloadBytes / 1024 / 1024)} MB total).`,
      installOptions: { sectionId: "default" } };
  }
  const manager = {
    ...base,
    ui: { groupId: "sikarugir", tabLabel: "Sikarugir", sectionLabel: "Sikarugir", memberOrder: 0, management: "managed", order: 201 },
    resolveSelection(entry, settings, userDataDir, options = {}) {
      const selection = base.resolveSelection(entry, settings, userDataDir, options);
      if (!selection.install) return planned(selection);
      const resolved = resolvePayload(selection.install, options);
      return planned({ ...selection, install: resolved.install, ready: Boolean(resolved.install), reason: resolved.reason });
    },
    async resolveForPlay(entry, context) {
      throwIfAborted(context.signal);
      const current = manager.resolveSelection(entry, context.settings, context.userDataDir, { signal: context.signal });
      if (current.ready || !current.version) return current;
      try {
        await manager.refreshCatalog({ userDataDir: context.userDataDir, signal: context.signal, logger: context.logger, force: true });
      } catch (error) {
        throwIfAborted(context.signal);
        if (error.name === "AbortError" || error.code === "ABORT_ERR") throw error;
        const pin = base.core.catalog.find(row => row.version === current.version);
        if (!Catalog.validateEntry(pin)) throw error;
        const requirements = manager.getState({ userDataDir: context.userDataDir }).catalog.versionRequirements[current.version];
        if (requirements?.installReason) throw new Error(requirements.installReason);
        base.core.rememberResolvedVersion({ userDataDir: context.userDataDir, entry: pin });
        context.logger?.warn?.(`[sikarugir] version refresh failed; retaining exact download ${pin.version}: ${error.message}`);
        context.onRuntimeStateChange?.();
        return current;
      }
      context.onRuntimeStateChange?.();
      const selection = manager.resolveSelection(entry, context.settings, context.userDataDir, { signal: context.signal });
      const state = manager.getState({ userDataDir: context.userDataDir, settings: context.settings?.runtimes?.sikarugir });
      if (!selection.ready && !state.catalog.installableVersions.includes(selection.version))
        throw new Error(state.catalog.versionRequirements[selection.version]?.installReason ||
          "The selected Wine download is no longer available. Select an available version in Runtimes or the game settings.");
      return selection;
    },
    getState(options = {}) {
      const state = base.getState(options), requirements = { ...state.catalog.versionRequirements };
      for (const pin of base.core.catalog) requirements[pin.version] = { ...requirements[pin.version],
        downloadBytes: pin.downloadBytes, engineVersion: pin.engineVersion, templateVersion: pin.template?.version,
        description: "Wine engine and matching support libraries" };
      const installed = state.installed.map(row => {
        if (row.ready === false) return row;
        const result = resolvePayload(row, { verification: "status" });
        requirements[row.version] = { ...requirements[row.version], available: Boolean(result.install),
          ...(result.minimumMacOS ? { minimumMacOS: result.minimumMacOS, ...(result.install ? {} : { installReason: result.reason }) } : {}) };
        return result.install ? { ...result.install, ready: true, status: "ready" }
          : { ...row, ready: false, status: result.minimumMacOS ? "unsupported-host" : "damaged", error: result.reason };
      });
      const catalog = { ...state.catalog, delivery: "download", importable: false, versionRequirements: requirements,
        installableVersions: state.catalog.installableVersions.filter(version => !requirements[version]?.installReason),
        latestInstalledVersion: installed.find(row => row.ready)?.version || null,
        installReason: state.catalog.installable || installed.some(row => row.ready) ? null
          : state.catalog.status === "success" ? "No compatible Wine downloads are currently available."
          : "Reload versions to select a Wine download. Play also prepares the required version automatically." };
      catalog.installable = catalog.installableVersions.length > 0;
      const output = { ...state, installed, catalog };
      return { ...output, sections: [{ ...state.sections[0], ...output, sections: undefined }] };
    },
    async installRuntime(options) {
      base.core.listCatalog({ userDataDir: options.userDataDir });
      const settings = options.settings?.runtimes ? options.settings : { runtimes: { sikarugir: options.settings } };
      const version = base.resolveSelection({}, settings, options.userDataDir, { version: options.version }).version;
      const pin = base.core.catalog.find(row => row.version === version);
      if (!Catalog.validateEntry(pin)) throw new Error("The selected Wine download has incomplete archive information. Reload versions and select a compatible download.");
      const downloads = typeof options.downloads?.runTask === "function" ? {
        runTask: (meta, runner) => options.downloads.runTask({ ...meta, detail: pin.versionLabel }, runner)
      } : options.downloads;
      const result = resolvePayload(await downloadContext.run({ pin }, () => base.installRuntime({ ...options, version, downloads })), { signal: options.signal });
      if (!result.install) throw new Error(result.reason);
      return result.install;
    },
    core: {
      ...base.core,
      get catalog() { return base.core.catalog; },
      resolveInstalled: options => resolvePayload(base.core.resolveInstalled(options), options).install,
      resolveRegistered: options => resolvePayload(base.core.resolveRegistered(options), options).install,
      listInstalled: userDataDir => base.core.listInstalled(userDataDir).map(row => resolvePayload(row).install).filter(Boolean),
      async installVersion(options) {
        base.core.listCatalog({ userDataDir: options.userDataDir });
        const settings = options.settings?.runtimes ? options.settings : { runtimes: { sikarugir: options.settings } };
        const version = base.resolveSelection({}, settings, options.userDataDir, { version: options.version }).version;
        const pin = base.core.catalog.find(row => row.version === version);
        if (!Catalog.validateEntry(pin)) throw new Error("The selected Wine download has incomplete archive information. Reload versions and select a compatible download.");
        const result = resolvePayload(await downloadContext.run({ pin }, () => base.core.installVersion({ ...options, version })), { signal: options.signal });
        if (!result.install) throw new Error(result.reason);
        return result.install;
      }
    }
  };
  Custom.configure(manager, { defaultsPath: () => ["defaultVersion"], providers: [{ core: manager.core,
    lists: { listInstalled: "default" }, resolves: { resolveInstalled: "default", resolveRegistered: "default" },
    versions: ["normalizeVersion"], directories: ["getInstallDir"] }], inspect(runtimePath, { verification } = {}) {
    let root = fs.statSync(runtimePath).isDirectory() ? runtimePath : path.dirname(runtimePath);
    for (let depth = 0; depth < 7 && !fs.existsSync(path.join(root, Payload.INVENTORY)); depth += 1) root = path.dirname(root);
    if (!fs.existsSync(path.join(root, Payload.INVENTORY))) throw new Error("Select the complete Sikarugir runtime directory, including its Wine engine and support libraries.");
    const file = path.join(root, "runtime.json");
    if (fs.statSync(file).size > 1024 * 1024) throw new Error("The Sikarugir runtime metadata exceeds its size limit.");
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    const native = Custom.inspectExecutable(path.join(root, Payload.WINE_ROOT, "bin", "wine"));
    const selected = inspectPayload({ ...record, ...native, installDir: root }, { verification: verification === "status" ? "status" : "full" });
    if (!selected.install) throw new Error(selected.reason);
    return { ...selected.install, runtimeVersion: record.version };
  } });
  return manager;
}

module.exports = createManager();
module.exports.createManager = createManager;
module.exports.DEFAULT_VERSION = DEFAULT_VERSION;
