const path = require("node:path");
const { createPinnedNativeManager } = require("../../../shared/runtime/pinned-native-manager");
const { throwIfAborted } = require("../../../shared/runtime/download-utils");
const Catalog = require("./catalog");
const Payload = require("./payload");
const { extractArchive } = require("./archive");
const fs = require("node:fs");
const Custom = require("../../../shared/runtime/custom-runtime");

// A paired installation reports one total for both archives and names the
// engine steps of the shared installer.
const ENGINE_STEPS = { "Downloading…": "Downloading Wine engine…", "Extracting files…": "Extracting Wine engine…" };
function pairedProgress(pin, onProgress) {
  return onProgress && (row => onProgress({ ...row, total: pin.downloadBytes,
    detail: String(row?.detail || "").startsWith(pin.versionLabel) ? row.detail : `${pin.versionLabel} · ${ENGINE_STEPS[row?.detail || "Downloading…"] || row.detail}` }));
}
// A recorded archive identity matches a listed one when the publisher lists a digest.
const sameArchive = (recorded, listed) => !listed || recorded === listed;

function createManager({ discoverCatalog = Catalog.discover, dependencies = {} } = {}) {
  const base = createPinnedNativeManager({
    id: "sikarugir", label: "Sikarugir Wine", sourceUrl: Catalog.SOURCE_URL, cacheDownloads: true,
    discoverCatalog, resolveExecutable: root => path.join(root, Payload.WINE_ROOT, "bin", "wine"),
    prepareInstall: options => Payload.preparePayload(options, dependencies),
    dependencies: { ...dependencies, extractArchive: dependencies.extractArchive || extractArchive }
  });
  const inspectPayload = Payload.createPayloadResolver(dependencies);
  const resolvePayload = (install, options) => {
    if (install) {
      const pin = base.core.catalog.find(row => row.version === install.version);
      if (!Catalog.validateEntry(pin) || !sameArchive(install.archiveSha256, pin.asset.sha256) ||
        !sameArchive(install.installationMetadata?.template?.archiveSha256, pin.template.asset.sha256))
        return { install: null, reason: "Sikarugir archive identities changed. Remove and install this version again." };
    }
    return inspectPayload(install, options);
  };
  function planned(selection) {
    const pin = base.core.catalog.find(row => row.version === selection.version);
    if (!pin) return selection;
    return { ...selection, versionLabel: pin.versionLabel, engineVersion: pin.engineVersion,
      downloadBytes: pin.downloadBytes, artifacts: [pin.asset, pin.template.asset],
      detail: `${selection.repairRequired ? "Reinstalls" : "Downloads"} the Wine engine and its matching support libraries${pin.downloadBytes ? ` (${Math.ceil(pin.downloadBytes / 1024 / 1024)} MB total)` : ""}.`,
      installOptions: { sectionId: "default" } };
  }
  // The selected pairing; without a listed one, the publisher's current list
  // is read first.
  async function selectedPin(options) {
    const settings = options.settings?.runtimes ? options.settings : { runtimes: { sikarugir: options.settings } };
    const choose = () => {
      base.core.listCatalog({ userDataDir: options.userDataDir });
      const version = base.resolveSelection({}, settings, options.userDataDir, { version: options.version }).version;
      return { version, pin: base.core.catalog.find(row => row.version === version) };
    };
    let choice = choose();
    if (!Catalog.validateEntry(choice.pin)) {
      await base.refreshCatalog({ userDataDir: options.userDataDir, signal: options.signal, logger: options.logger, force: true });
      choice = choose();
    }
    if (!Catalog.validateEntry(choice.pin)) throw new Error("No Wine download is listed for this selection. Select an available version in Runtimes or the game settings.");
    return choice;
  }
  const manager = {
    ...base,
    upstream: [Catalog.engines, Catalog.templates],
    ui: { groupId: "sikarugir", tabLabel: "Sikarugir", sectionLabel: "Sikarugir", memberOrder: 0, management: "managed", order: 201 },
    resolveSelection(entry, settings, userDataDir, options = {}) {
      const selection = base.resolveSelection(entry, settings, userDataDir, options);
      if (!selection.install) return planned(selection);
      const resolved = resolvePayload(selection.install, options);
      return planned({ ...selection, install: resolved.install, ready: Boolean(resolved.install),
        requiresDownload: !resolved.install, repairRequired: !resolved.install && !resolved.minimumMacOS, reason: resolved.reason });
    },
    async resolveForPlay(entry, context) {
      throwIfAborted(context.signal);
      return manager.resolveSelection(entry, context.settings, context.userDataDir, { signal: context.signal });
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
      const { version, pin } = await selectedPin(options);
      const downloads = typeof options.downloads?.runTask === "function" ? {
        runTask: (meta, runner) => options.downloads.runTask({ ...meta, detail: pin.versionLabel },
          task => runner({ ...task, onProgress: pairedProgress(pin, task.onProgress) }))
      } : options.downloads;
      const existing = base.core.resolveInstalled({ userDataDir: options.userDataDir, version });
      const replace = Boolean(existing && !resolvePayload(existing, { signal: options.signal }).install);
      const result = resolvePayload(await base.installRuntime({ ...options, version, downloads, replace,
        onProgress: pairedProgress(pin, options.onProgress) }), { signal: options.signal });
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
        const { version, pin } = await selectedPin(options);
        const existing = base.core.resolveInstalled({ userDataDir: options.userDataDir, version });
        const replace = Boolean(existing && !resolvePayload(existing, { signal: options.signal }).install);
        const result = resolvePayload(await base.core.installVersion({ ...options, version, replace,
          onProgress: pairedProgress(pin, options.onProgress) }), { signal: options.signal });
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
