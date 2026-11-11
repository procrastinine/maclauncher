const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Upstream = require("../../../shared/runtime/upstream");
const { createPinnedNativeManager } = require("../../../shared/runtime/pinned-native-manager");
const { throwIfAborted } = require("../../../shared/runtime/download-utils");
const { extractArchive } = require("../../../shared/runtime/safe-archive");
const Catalog = require("./catalog");
const Payload = require("./payload");
const Shared = require("../../sources/wine-payload");
const Host = require("../../../shared/runtime/bundled-native");

// The archive must match the SHA-256 that the publisher's checksum file names,
// in addition to any digest the release listing states. The checksum file is
// itself a listed release file, read through the shared download layer.
async function verifyChecksumFile({ archiveSha256, pin, signal }, dependencies = {}) {
  throwIfAborted(signal);
  if (!pin?.checksum?.url) throw new Error("The WineCX release lists no checksum file. No runtime was installed.");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-winecx-")), target = path.join(directory, "checksum");
  let text;
  try {
    await (dependencies.download || Upstream.download)(Upstream.listedFile(pin.checksum), target, { signal, headers: { "User-Agent": "maclauncher" } });
    if (fs.statSync(target).size > 64 * 1024) throw new Error("it is larger than a checksum file");
    text = fs.readFileSync(target, "utf8");
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    throw new Error(`The WineCX checksum file could not be read (${error.message}). No runtime was installed.`);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  const listed = Catalog.readChecksum(text, pin.asset.filename);
  if (!listed) throw new Error("The WineCX checksum file names no SHA-256 for the archive. No runtime was installed.");
  if (listed !== archiveSha256) throw new Error("The WineCX archive does not match its published SHA-256. No runtime was installed.");
  return { verified: true, archiveSha256, identity: `publisher-sha256-file:${listed}` };
}
function createManager({ discoverCatalog = Catalog.discover, dependencies = {} } = {}) {
  const base = createPinnedNativeManager({
    id: "winecx", label: "WineCX", sourceUrl: Catalog.SOURCE_URL, sourceName: "dappermint/winecx-gptk",
    sourceDescription: "Wine runtimes published by dappermint as winecx-gptk releases, with DXVK and DXMT included.",
    formatVersionLabel: Catalog.versionLabel, discoverCatalog,
    resolveExecutable: root => path.join(root, Payload.WINE, "bin", "wine"),
    verifyArtifact: options => verifyChecksumFile(options, dependencies),
    prepareInstall: options => Payload.preparePayload(options, dependencies),
    // Each launch checks the sealed file inventory that only a managed
    // installation records, so no folder can be registered as a version.
    customRuntime: false,
    dependencies: { ...dependencies, extractArchive: dependencies.extractArchive || extractArchive }
  });
  const resolvePayload = Payload.createPayloadResolver(dependencies);
  const planned = selection => {
    const pin = base.core.catalog.find(row => row.version === selection.version);
    if (!pin) return selection;
    return { ...selection, versionLabel: selection.install ? Catalog.versionLabel(pin, selection.install) : pin.versionLabel,
      downloadBytes: pin.downloadBytes, artifacts: [pin.asset],
      detail: `${selection.repairRequired ? "Reinstalls" : "Downloads"} the WineCX Wine runtime${pin.downloadBytes ? ` (${Math.ceil(pin.downloadBytes / 1024 / 1024)} MB)` : ""}.`,
      installOptions: { sectionId: "default" } };
  };
  async function selectedVersion(options) {
    const settings = options.settings?.runtimes ? options.settings : { runtimes: { winecx: options.settings } };
    const choose = () => {
      base.core.listCatalog({ userDataDir: options.userDataDir });
      // Install installs the saved default itself, not the installed version Play would use instead.
      const selection = base.resolveSelection({}, settings, options.userDataDir, { version: options.version }), version = selection.preferredVersion || selection.version;
      return Catalog.validateEntry(base.core.catalog.find(row => row.version === version)) ? version : null;
    };
    let version = choose();
    if (!version) {
      await base.refreshCatalog({ userDataDir: options.userDataDir, signal: options.signal, logger: options.logger, force: true });
      version = choose();
    }
    if (!version) throw new Error("No WineCX download is listed for this selection. Select an available version in Runtimes or the game settings.");
    // The floor is read from the archive's start before the download, for a version Refresh did not read.
    const pin = base.core.catalog.find(row => row.version === version);
    const floor = pin.minimumMacOS || await (dependencies.archiveFloor || Catalog.archiveFloor)(pin.asset, { signal: options.signal }).catch(error => {
      if (error?.name === "AbortError") throw error;
      options.logger?.warn?.(`[winecx] The macOS requirement of ${version} could not be read before download: ${error.message}`); return null;
    });
    if (floor && !Host.versionAtLeast(systemVersion(), floor)) throw new Error(Shared.requiresMacOS(floor));
    return version;
  }
  const systemVersion = () => (dependencies.systemVersionSync || Host.systemVersionSync)();
  const manager = {
    ...base,
    upstream: [Catalog.source],
    ui: { groupId: "winecx", tabLabel: "WineCX", sectionLabel: "WineCX", memberOrder: 0, management: "managed", order: 202 },
    resolveSelection: require("../../sources/wine-selection").createSelection({ base, resolvePayload, planned }),
    preparePayloads: options => require("../../sources/wine-payload").prepareInstalled(base.core, resolvePayload.prepare, options),
    async resolveForPlay(entry, context) {
      throwIfAborted(context.signal);
      return manager.resolveSelection(entry, context.settings, context.userDataDir, { signal: context.signal });
    },
    async prepareLocalState(options = {}) {
      const Translators = require("../../../shared/runtime/wine-translators");
      for (const row of base.core.listInstalled(options.userDataDir)) {
        const result = row.ready === false ? null : resolvePayload(row, { verification: "status" });
        if (result?.install) await Translators.describedIncluded(result.install, "winecx", options);
      }
    },
    getState(options = {}) {
      const state = base.getState(options), requirements = { ...state.catalog.versionRequirements };
      const installed = state.installed.map(row => {
        if (row.ready === false) return row;
        const result = resolvePayload(row, { verification: "status" });
        requirements[row.version] = { ...requirements[row.version], available: Boolean(result.install),
          ...(result.minimumMacOS ? { minimumMacOS: result.minimumMacOS, ...(result.install ? {} : { installReason: result.reason }) } : {}) };
        if (!result.install) return { ...row, ready: false, status: result.minimumMacOS ? "unsupported-host" : "damaged", error: result.reason };
        const componentSummary = options.componentSummaries === false ? "" : require("../../../shared/runtime/wine-translators").includedSummary(result.install, "winecx", options);
        return { ...result.install, versionLabel: Catalog.versionLabel(row.catalogEntry, result.install), ready: true, status: "ready", ...(componentSummary ? { componentSummary } : {}) };
      });
      for (const pin of base.core.catalog) requirements[pin.version] = { ...requirements[pin.version],
        downloadBytes: pin.downloadBytes, description: "Wine runtime with DXVK and DXMT",
        contents: "The Wine and translator versions in this release are known after download.",
        ...(pin.minimumMacOS ? { minimumMacOS: pin.minimumMacOS } : {}),
        ...(pin.minimumMacOS && !Host.versionAtLeast(systemVersion(), pin.minimumMacOS) ? { installReason: Shared.requiresMacOS(pin.minimumMacOS) } : {}) };
      const catalog = { ...state.catalog, delivery: "download", importable: false, versionRequirements: requirements,
        installableVersions: state.catalog.installableVersions.filter(version => !requirements[version]?.installReason),
        latestInstalledVersion: installed.find(row => row.ready)?.version || null,
        installReason: state.catalog.installable || installed.some(row => row.ready) ? null
          : state.catalog.status === "success" ? "No compatible WineCX downloads are currently available."
          : "Reload versions to select a WineCX download. Play also prepares the required version automatically." };
      catalog.installable = catalog.installableVersions.length > 0;
      const output = { ...state, installed, catalog };
      return { ...output, sections: [{ ...state.sections[0], ...output, sections: undefined }] };
    },
    async installRuntime(options) {
      const version = await selectedVersion(options);
      const existing = base.core.resolveInstalled({ userDataDir: options.userDataDir, version });
      const replace = Boolean(existing && !resolvePayload(existing, { signal: options.signal }).install);
      const result = resolvePayload(await base.installRuntime({ ...options, version, replace }), { signal: options.signal });
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
        const version = await selectedVersion(options);
        const existing = base.core.resolveInstalled({ userDataDir: options.userDataDir, version });
        const replace = Boolean(existing && !resolvePayload(existing, { signal: options.signal }).install);
        const result = resolvePayload(await base.core.installVersion({ ...options, version, replace }), { signal: options.signal });
        if (!result.install) throw new Error(result.reason);
        return result.install;
      }
    }
  };
  return manager;
}

module.exports = createManager();
module.exports.createManager = createManager;
module.exports.verifyChecksumFile = verifyChecksumFile;
