const fs = require("node:fs");
const manifest = require("./temporal/catalog").withSettingsOptions(require("./manifest.json"));
const Detection = require("./detect");
const manager = require("./runtime/manager");
const Launch = require("./runtime/launch");
const { versionChoices } = require("../shared/runtime/version-choices");
function graphicsBridgeVersions(runtimeId, context) {
  const support = require("./temporal/support-manager").forRuntime(runtimeId);
  if (!support) throw new Error("Choose a Windows runtime.");
  return { graphicsBridgeVersions: [{ value: "auto", label: "Automatic" }, ...versionChoices(support, context)] };
}
const graphicsBridgeActions = { listGraphicsBridgeVersions: (entry, _payload, context) => graphicsBridgeVersions(context.runtimeId || entry.runtimeId, context) };
const graphicsBridgeSettingsActions = { listGraphicsBridgeVersions: (payload, context) => graphicsBridgeVersions(payload?.runtimeId, context) };
const sikarugirManager = require("./sikarugir/runtime/manager");
const sikarugirProvider = { ...require("./sikarugir/provider"),
  runtime: manifest.runtime.entries.sikarugir, supports: manifest.runtime.entries.sikarugir.supports,
  actions: graphicsBridgeActions, settingsActions: graphicsBridgeSettingsActions };
function hasWindowsExecutable(entry) {
  const evidence = Detection.cachedWindowsExecutable(entry);
  if (!evidence?.windowsExecutablePath) return false;
  try { return fs.statSync(evidence.windowsExecutablePath).isFile(); } catch { return false; }
}
function supportsEntry(entry, _moduleSettings, context = {}) {
  if (!hasWindowsExecutable(entry)) return false;
  const architecture = Detection.cachedWindowsExecutable(entry)?.executableArchitecture;
  return architecture !== "arm64" && manager.isAvailable(context.userDataDir);
}
function canLaunchRuntime(runtimeId, entry, moduleSettings, context) {
  return runtimeId === "crossover" && supportsEntry(entry, moduleSettings, context) &&
    entry?.runtimeData?.crossover?.executableArchitecture !== "arm64";
}
function ensureRuntime(entry, context) {
  const selected = manager.resolveSelection(entry, context.settings, context.userDataDir, context.runtimeSettings);
  if (!selected.ready) throw new Error(selected.reason);
  return null;
}
async function launchRuntime(runtimeId, entry, context) {
  if (runtimeId !== "crossover") return null;
  if (process.platform !== "darwin") throw new Error("CrossOver requires macOS.");
  const launch = await Launch.prepareLaunch(entry, context);
  return context.spawnDetachedChecked("/bin/sh", ["-c", Launch.SUPERVISOR, "maclauncher-crossover",
    launch.install.executablePath, launch.install.serverPath, ...launch.args],
  { cwd: launch.gameRoot, env: launch.environment, graphicsExecutable: launch.environment.WINELOADER || launch.install.loaderPath }, false);
}
const resolveSaveLocations = () => ({ primaryDirectory: null, directories: [] });
const crossoverProvider = { runtimeId: "crossover", runtime: manifest.runtime.entries.crossover, managerId: "crossover",
    actions: graphicsBridgeActions, settingsActions: graphicsBridgeSettingsActions,
    supports: manifest.supports, decorateEntry: Detection.decorateEntry,
    supportsEntry, canLaunchRuntime, ensureRuntime, launchRuntime, resolveSaveLocations,
    getRuntimeRequirements: (entry, context) => require("./temporal").requirements(entry, { ...context, runtimeId: "crossover" }),
    resolveGraphicsInputs: (entry, context) => resolveGraphicsInputs(entry, { ...context, runtimeId: "crossover" }) };
const runtimeProviders = [crossoverProvider, sikarugirProvider];
const runtimeManagers = [manager, sikarugirManager, ...Object.values(require("./temporal/support-manager").managers)];
const providerForRuntime = runtimeId => runtimeProviders.find(provider => provider.runtimeId === runtimeId);
const providerForEntry = (entry, context) => providerForRuntime(context?.runtimeId || entry?.runtimeId || manifest.runtime.default);
function resolveGraphicsInputs(entry, context = {}, resolved) {
  const runtimeId = providerForEntry(entry, context)?.runtimeId;
  const selectedManager = runtimeManagers.find(candidate => candidate.id === providerForEntry(entry, context)?.managerId);
  const selected = resolved || selectedManager?.resolveSelection(entry, context.settings, context.userDataDir, context.runtimeSettings);
  if (!selected?.ready) return null;
  const source = require("./temporal").resolvePlan(entry, context, { install: selected.install, runtimeId, allowDownload: true })?.inputs;
  return require("./graphics-inputs").inputs(selected.install, source, { fallback: runtimeId === "sikarugir" ? "x86_64" : null });
}

module.exports = { id: manifest.id, manifest, detectGame: Detection.detectGame,
  graphicsComputeHosts:[require("./runtime/compute-host"),require("./sikarugir/runtime/compute-host")],
  runtimeManagers, runtimeProviders, runtimeProvider: crossoverProvider,
  resolveGraphicsInputs,
  getRuntimeRequirements: (entry, context) => require("./temporal").requirements(entry, context),
  normalizeRuntimeId: runtimeId => providerForRuntime(runtimeId) ? runtimeId : manifest.runtime.default,
  filterRuntimeSupport: (entry, supported, settings, context) => supported.filter(runtimeId =>
    providerForRuntime(runtimeId)?.supportsEntry(entry, settings, context)),
  canLaunchRuntime: (runtimeId, entry, settings, context) => Boolean(providerForRuntime(runtimeId)?.canLaunchRuntime(runtimeId, entry, settings, context)),
  ensureRuntime: (entry, context) => providerForEntry(entry, context)?.ensureRuntime(entry, context),
  launchRuntime: (runtimeId, entry, context) => providerForRuntime(runtimeId)?.launchRuntime(runtimeId, entry, context) || null,
  resolveSaveLocations: (entry, context) => providerForEntry(entry, context)?.resolveSaveLocations?.(entry, context) || resolveSaveLocations(),
  settingsActions: graphicsBridgeSettingsActions,
  actions: {
    ...graphicsBridgeActions,
    runtimeStatus: (entry, _payload, context) => {
      const selectedManager = runtimeManagers.find(candidate => candidate.id === providerForEntry(entry, context)?.managerId) || manager;
      const selected = selectedManager.resolveSelection(entry, context.settings, context.userDataDir, context.runtimeSettings);
      return { ...selected, graphicsInputs: resolveGraphicsInputs(entry, context, selected), versionLabel: selected.versionLabel || selected.install?.versionLabel ||
        selected.install?.upstreamVersion || selected.install?.engineVersion || selected.version };
    },
    revealWindowsFiles: (entry, _payload, context) => {
      const directory = providerForEntry(entry, context)?.runtimeDirectory?.(entry, context) || Launch.runtimeDirectory(entry, context);
      if (!fs.existsSync(directory)) throw new Error("Play the game once to create its Windows files.");
      if (typeof context.ui?.shell?.openPath === "function") return context.ui.shell.openPath(directory);
      if (typeof context.ui?.openPath === "function") return context.ui.openPath(directory);
      return { directory };
    }
  },
  __test: { hasWindowsExecutable, supportsEntry } };

module.exports = require("../shared/decompilation/native").withTools(module.exports);
