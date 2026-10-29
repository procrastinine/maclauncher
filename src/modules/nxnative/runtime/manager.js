const { createManagedPythonTool } = require("../../shared/runtime/managed-python-tool");
const { createGithubCommitDiscovery } = require("../../shared/runtime/github-runtime-catalog");
const Custom = require("../../shared/runtime/custom-runtime");
const { selectRuntimeVersion, managerDefaultVersion } = require("../../shared/runtime/version-choices");
const { createManager: createLegacyManager } = require("./legacy-manager");
const NativeTools = require("./native-tools");

const SOURCE_FILES = ["scripts/build_ipa_from_nsp.py", "dm/tools/nso2elf.py", "dm/host/front_mac.m", "LICENSE"];
const gitVersion = version => /^git-[a-f0-9]{40}$/.test(version || "");

function createManager(dependencies = {}) {
  const source = dependencies.sourceManager || createManagedPythonTool({ id: "nxnative", sourceId: "upstream", label: "nxnative",
    archiveLimits: { archive: 128 * 1024 ** 2, expanded: 512 * 1024 ** 2, entries: 10000 },
    scriptName: SOURCE_FILES[0], requiredFiles: SOURCE_FILES, sourceUrl: "https://github.com/seedds/nxnative",
    discoverCatalog: createGithubCommitDiscovery({ owner: "seedds", repo: "nxnative", dependencies }) });
  const legacy = dependencies.legacyManager || createLegacyManager(dependencies);
  const tools = dependencies.toolsManager || NativeTools.createManager(dependencies);
  const configured = (entry, settings, userDataDir, options = {}) => {
    const manual = [options.version, entry?.runtimeData?.nxnative?.version]
      .find(value => typeof value === "string" && !["", "auto", "latest"].includes(value.trim()));
    const recommendation = options.recommendedVersion ?? options.recommended;
    return selectRuntimeVersion({ manual, recommended: manual ? null : typeof recommendation === "function" ? recommendation() : recommendation,
      defaultVersion: source.normalizeSettings(settings?.runtimes?.nxnative).defaultVersion,
      fallback: manager.getState({ userDataDir, settings: settings?.runtimes?.nxnative, runtimeSettings: settings?.runtimes }).defaultVersion }).version;
  };
  const runtimeUses = (version, sourceInstall, native) => sourceInstall && native.ready ? [
    { managerId: "nxnative", version, sectionId: "default", sourcePath: sourceInstall.root || sourceInstall.installDir },
    { managerId: NativeTools.ID, version: native.version, sectionId: "default", sourcePath: native.install.installDir || native.install.root }
  ] : [];
  function fromSource(version, sourceInstall, settings, userDataDir) {
    const native = tools.resolveSelection(null, settings, userDataDir);
    return { version, sourceInstall, toolsVersion: native.version, toolsManagerId: NativeTools.ID,
      install: native.install, ready: Boolean(sourceInstall && native.ready),
      runtimeUses: runtimeUses(version, sourceInstall, native),
      reason: !sourceInstall ? "The selected nxnative source is not installed." : native.reason || null };
  }
  function resolveSelection(entry, settings, userDataDir, options = {}) {
    const version = configured(entry, settings, userDataDir, options);
    if (version) return gitVersion(version) ? fromSource(version, source.resolve({ userDataDir, version }), settings, userDataDir)
      : legacy.resolveSelection(entry, settings, userDataDir, { ...options, version });
    return { version: null, ready: false, install: null, sourceInstall: null, discoveryRequired: true,
      reason: "No nxnative versions are available to download." };
  }

  const manager = { ...source, id: "nxnative", label: "nxnative", sourceManager: source, legacyManager: legacy, toolsManager: tools,
    ui: { ...legacy.ui, tabLabel: "nxnative", sectionLabel: "nxnative", management: "managed" }, resolveSelection,
    getState(options = {}) {
      const state = source.getState(options), old = legacy.getState(options);
      const native = tools.resolveSelection(null, { runtimes: options.runtimeSettings || { nxnative: options.settings } }, options.userDataDir);
      const sources = state.installed.filter(row => !row.custom).map(row => ({ ...row, ready: row.ready !== false && native.ready,
        runtimeUses: runtimeUses(row.version, row, native),
        ...(!native.ready ? { reason: native.reason, status: "native-tools-required" } : {}) }));
      const installed = [...sources, ...old.installed.filter(row => !row.custom)];
      const sourceRequirements = Object.fromEntries([...new Set([...state.catalog.versions, ...sources.map(row => row.version)])].map(version => {
        const present = sources.some(row => row.version === version && row.ready);
        return [version, { ...state.catalog.versionRequirements[version], available: present, requiresDownload: !present,
          requiresBuild: false, installLabel: "Install" }];
      }));
      const { sections, ...view } = { ...state, installed, catalog: { ...state.catalog, latestInstalledVersion: installed[0]?.version || null,
        versionRequirements: { ...sourceRequirements, ...Object.fromEntries(old.installed.filter(row => !row.custom).map(row => [row.version,
          { available: row.ready !== false, requiresDownload: false, requiresBuild: false, installLabel: "Installed" }])) } } };
      const saved = source.normalizeSettings(options.settings).defaultVersion;
      const defaultVersion = selectRuntimeVersion({ defaultVersion: saved, fallback: managerDefaultVersion({
        listed: state.catalog.versions.filter(version => !sourceRequirements[version]?.installReason),
        installed: installed.filter(row => row.ready !== false).map(row => row.version) }) }).version;
      view.defaultVersion = defaultVersion;view.defaultSource = saved ? "saved" : "manager";
      return { ...view, sections: [{ ...sections[0], ...view, id: "default", label: "nxnative versions" }] };
    },
    async refreshCatalog(options = {}, ...args) { await source.refreshCatalog(options, ...args); return manager.getState(options).catalog; },
    async installRuntime(options = {}) {
      const selected = configured(null, options.settings, options.userDataDir, options) || resolveSelection(null, options.settings, options.userDataDir, options).version;
      if (Custom.isPath(selected)) return manager.installRuntime({ ...options, version: selected });
      if (selected && !gitVersion(selected)) return legacy.installRuntime({ ...options, version: selected });
      const sourceInstall = await source.installRuntime({ ...options, version: selected || undefined }, dependencies);
      const version = sourceInstall.version;
      const install = await tools.installRuntime({ ...options, version: undefined });
      const result = fromSource(version, sourceInstall, options.settings, options.userDataDir);
      if (!result.ready) throw new Error(result.reason);
      return { ...sourceInstall, sourceInstall, toolsVersion: install.version, toolsManagerId: NativeTools.ID, install,
        runtimeUses: result.runtimeUses };
    },
    uninstallRuntime(options = {}) { return (gitVersion(options.version) ? source : legacy).uninstallRuntime(options); },
    updateSettingsAfterUninstall(settings, payload) {
      return source.normalizeSettings(settings).defaultVersion === payload.version ? { ...settings, defaultVersion: null } : settings;
    }
  };
  const sourceInspect = source.customRuntime.inspect, legacyInspect = legacy.customRuntime.inspect;
  Custom.configure(manager, { inspect(runtimePath, options) {
    try {
      const sourceInstall = { ...sourceInspect(runtimePath, options), version: runtimePath, source: "custom" };
      const selected = fromSource(runtimePath, sourceInstall, null, options.userDataDir);
      return { ...sourceInstall, ...selected, selectionKind: "source", installable: true, requiresDownload: !selected.ready };
    }
    catch { return { ...legacyInspect(runtimePath, options), selectionKind: "legacy" }; }
  }, selection(install, { settings, userDataDir }) {
    return install.selectionKind === "source" ? fromSource(install.version, install.sourceInstall, settings, userDataDir) : { install, ready: true, reason: null };
  }, async prepareInstall(registered, options) {
    if (registered.selectionKind !== "source") return registered;
    await tools.installRuntime({ ...options, version: undefined });
    const selected = fromSource(registered.version, registered.sourceInstall, options.settings, options.userDataDir);
    if (!selected.ready) throw new Error(selected.reason);
    return { ...registered, ...selected, requiresDownload: false };
  } });
  Custom.instrumentManagers([manager]);
  return manager;
}
module.exports = createManager();
module.exports.createManager = createManager;
