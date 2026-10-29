const { createPinnedNativeManager } = require("../../shared/runtime/pinned-native-manager");
const { createBundledNativeRuntime } = require("../../shared/runtime/bundled-native");
const Downloads = require("./butterscotch-downloads");

function supportsGameArguments(pin) {
  return (pin?.capabilities?.gameArguments || pin?.gameArguments || pin?.projectPackage?.capabilities?.gameArguments) === "repeat-game-arg-v1";
}
const discoverCatalog = Downloads.createDownloadDiscovery();
function createManager(dependencies = {}) {
  const runtime = createPinnedNativeManager({ id: "butterscotch", label: "Butterscotch", catalog: [],
    projectBuilds: { projectId: "butterscotch", repository: "procrastinine/maclauncher-builds", upstreamMacDownloads: true },
    distributionRequired: false, importLocal: true,
    discoverCatalog: Downloads.createDownloadDiscovery({ dependencies }),
    legacyInstalledRuntime: createBundledNativeRuntime({ managerId: "butterscotch" }),
    sourceUrl: "https://github.com/ButterscotchRunner/Butterscotch/actions/workflows/build.yml",
    resolveExecutable: Downloads.resolveExecutable, prepareInstall: options => Downloads.prepareInstall(options, dependencies), dependencies });
  const refreshCatalog = runtime.refreshCatalog.bind(runtime), getState = runtime.getState.bind(runtime);
  runtime.refreshCatalog = options => refreshCatalog({ latestOnly: true, ...options });
  runtime.getState = options => {
    const state = getState(options), catalog = { ...state.catalog, supportsLatestOnly: true };
    return { ...state, catalog, sections: state.sections.map(section => ({ ...section, catalog })) };
  };
  const resolveSelection = runtime.resolveSelection.bind(runtime);
  runtime.resolveSelection = (entry, settings, userDataDir, { gameArgumentsRequired, ...options } = {}) => {
    const argumentsRequired = gameArgumentsRequired || typeof entry?.launchArguments === "string" && entry.launchArguments.trim();
    const constraints = argumentsRequired ? { ...options, compatible: pin => supportsGameArguments(pin) && (!options.compatible || options.compatible(pin)) } : options;
    if (!argumentsRequired) return resolveSelection(entry, settings, userDataDir, constraints);
    // Games with launch arguments recommend the first build that repeats them,
    // including cold Play before its exact package has been discovered.
    const recommendedVersion = "MCLv1-1007";
    return { ...resolveSelection(entry, settings, userDataDir, { ...constraints,
      recommendedVersion: options.recommendedVersion ?? options.recommended ?? recommendedVersion }), recommendedVersion };
  };
  const installRuntime = runtime.installRuntime.bind(runtime);
  runtime.installRuntime = async (options = {}) => {
    if (!options.gameArgumentsRequired) return installRuntime(options);
    // Install is called after consent. Status and selection never refresh.
    const select = () => runtime.resolveSelection({}, options.settings, options.userDataDir,
      { version: options.version, gameArgumentsRequired: true });
    let selection = select();
    if (!selection.ready && selection.discoveryRequired) {
      await runtime.refreshCatalog({ userDataDir: options.userDataDir, logger: options.logger, signal: options.signal });
      selection = select();
    }
    const pin = runtime.core.listCatalog({ userDataDir: options.userDataDir }).find(row => row.version === selection.version);
    if (!selection.version || !supportsGameArguments(pin))
      throw new Error(selection.reason || "The selected Butterscotch runtime does not support game arguments.");
    return installRuntime({ ...options, version: selection.version });
  };
  return runtime;
}
const manager = createManager();
module.exports = { manager, createManager, discoverCatalog };
