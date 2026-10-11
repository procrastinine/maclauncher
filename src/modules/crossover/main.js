const fs = require("node:fs");
const manifest = require("./manifest.json");
const Detection = require("./detect");
const manager = require("./runtime/manager");
const Launch = require("./runtime/launch");
const legacyEvidence = new WeakMap();

function hasWindowsExecutable(entry) {
  if (Detection.isNativeImport(entry)) return false;
  const known = entry?.runtimeData?.crossover?.windowsExecutablePath;
  if (known) {
    try { return fs.statSync(known).isFile(); } catch { return false; }
  }
  if (entry?.runtimeData?.crossover?.detectionComplete) return false;
  if (!entry || typeof entry !== "object") return false;
  if (!legacyEvidence.has(entry)) legacyEvidence.set(entry, Detection.findWindowsExecutable(entry));
  return Boolean(legacyEvidence.get(entry));
}
function supportsEntry(entry, _moduleSettings, context = {}) {
  if (!hasWindowsExecutable(entry)) return false;
  const architecture = entry?.runtimeData?.crossover?.executableArchitecture || legacyEvidence.get(entry)?.executableArchitecture;
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
  { cwd: launch.gameRoot, env: launch.environment }, false);
}
const resolveSaveLocations = () => ({ primaryDirectory: null, directories: [] });
module.exports = { id: manifest.id, manifest, detectGame: Detection.detectGame, runtimeManagers: [manager],
  normalizeRuntimeId: () => "crossover", filterRuntimeSupport: (entry, supported, settings, context) =>
    supportsEntry(entry, settings, context) ? supported : [],
  canLaunchRuntime, ensureRuntime, launchRuntime, resolveSaveLocations,
  runtimeProvider: { runtimeId: "crossover", runtime: manifest.runtime.entries.crossover, managerId: "crossover",
    supports: manifest.supports, decorateEntry: Detection.decorateEntry,
    supportsEntry, canLaunchRuntime, ensureRuntime, launchRuntime, resolveSaveLocations },
  actions: {
    runtimeStatus: (entry, _payload, context) => manager.resolveSelection(entry, context.settings, context.userDataDir, context.runtimeSettings),
    revealWindowsFiles: (entry, _payload, context) => {
      const directory = Launch.runtimeDirectory(entry, context);
      if (!fs.existsSync(directory)) throw new Error("Play the game once to create its Windows files.");
      if (typeof context.ui?.shell?.openPath === "function") return context.ui.shell.openPath(directory);
      if (typeof context.ui?.openPath === "function") return context.ui.openPath(directory);
      return { directory };
    }
  },
  __test: { hasWindowsExecutable, supportsEntry } };
