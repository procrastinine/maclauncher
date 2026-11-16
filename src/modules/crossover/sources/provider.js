const fs = require("node:fs");
const path = require("node:path");
const Detection = require("../detect");
const WineLaunch = require("./wine-launch");
const Writable = require("../../shared/writable-input");
const Environments = require("../../shared/runtime/wine-environment");
const WineAdapter = require("../../../runtime-adapters/wine");
const { createLog } = WineAdapter;
const Lifecycle = require("../../../core/process-lifecycle");
const warnGraphics = require("../../shared/graphics-warning");
const Translators = require("../../shared/runtime/wine-translators");

// Every Windows runtime shares the executable evidence that detection records.
// The runtime picker reads that record and does not depend on whether Wine is
// already installed.
const supportsEntry = entry => Detection.supportsWindowsRuntimes(entry);
const decorateEntry = Detection.decorateEntry;
// Every Wine source offers the game's save folders and no save editing.
const SUPPORTS = Object.freeze({ cheats: false, cheatsPatcher: false, saveEditing: false, saveLocation: true });
// The game's own files, an existing environment's save folders and the
// profile files of the private Windows environment, for every Wine source.
function resolveSaveLocations(entry, context, { source }) {
  const directory = require("./launch-steps").runtimeDirectory(entry, context, source), gameRoot = Detection.cachedWindowsExecutable(entry)?.sourceRoot || entry.gamePath;
  const directories = path.isAbsolute(gameRoot || "") ? [{ directory: gameRoot, role: "primary", source: "Original Windows game files", confidence: "exact" }] : [];
  directories.push(...Environments.saveLocations(context.runtimeSettings));
  const record = entry.runtimeData?.[source.id], bottle = source.prefixModel === "bottleTemplate";
  const prefixPath = bottle ? record?.bottlePath : record?.prefixPath;
  if (typeof prefixPath === "string" && path.isAbsolute(prefixPath) && Detection.inside(path.join(directory, bottle ? "bottles" : "prefixes"), prefixPath)) {
    const users = path.join(prefixPath, "drive_c", "users");
    if (fs.existsSync(users)) {
      Writable.assertOwnDirectory(directory, users, { create: false });
      directories.push({ directory: users, role: "alternate", source: "Private Windows profile files", confidence: "exact" });
    }
  }
  return { primaryDirectory: directories[0]?.directory || null, directories };
}
// The runtime provider of a Wine source that runs its own Wine loader.
function createProvider({ source, manager, launch = WineLaunch.forSource(source), platform = process.platform, launchDependencies } = {}) {
  const runtimeManager = () => manager || source.manager();
  const id = source.id, notSupported = `${source.label} requires an x86 or x64 Windows game.`;
  const existingFor = reference => reference && reference.kind !== source.environmentKind ? null : reference;
  return { runtimeId: id, managerId: source.managerId, supportsEntry, decorateEntry,
    resolveGraphicsInputs: async (entry, context) => {
      const reference = existingFor(Environments.environmentReference(context.runtimeSettings?.environmentReference));
      const existing = reference ? Environments.readEnvironment(reference) : null;
      if (existing) context.wineEnvironment = existing;
      const selected = existing ? {ready:true,install:existing.install} : runtimeManager().resolveSelection(entry, context.settings, context.userDataDir, context.runtimeSettings);
      if (!selected?.ready) return null;
      const prepared = Translators.environmentContext(context, selected.install);
      if (prepared.wineEnvironment) context.wineEnvironment = prepared.wineEnvironment;
      const install = prepared.wineEnvironment?.install || selected.install;
      const translatorPlan = await Translators.resolve(install, id, context, { entry, executableArchitecture: Detection.cachedWindowsExecutable(entry)?.executableArchitecture });
      const inputs = require("../temporal").resolvePlan(entry, context, { install, runtimeId: id, translatorPlan, settings: Translators.settingsForPlan(context.runtimeSettings || {}, translatorPlan), allowDownload: true })?.inputs;
      return require("../graphics-inputs").inputs(install, inputs, { fallback: "x86_64" });
    },
    getRuntimeRequirements: async (entry, context) => {
      const reference = existingFor(Environments.environmentReference(context.runtimeSettings?.environmentReference));
      const existing = reference ? Environments.readEnvironment(reference) : null;
      if (existing) context.wineEnvironment = existing;
      const manager = existing ? { resolveSelection: () => ({ ready: true, install: existing.install, version: existing.path }) } : runtimeManager();
      return [...await require("../temporal").requirements(entry, { ...context, runtimeId: id }, { manager }),
        ...await Translators.driverRequirements(context),
        ...await require("../temporal/vulkan-dlss").requirements(entry, context),
        ...await require("../runtime/steam-bridge").requirements(entry, { ...context, runtimeId: id })];
    },
    runtimeDirectory: launch.runtimeDirectory, resolveSaveLocations: (entry, context) => resolveSaveLocations(entry, context, { source }),
    supports: SUPPORTS,
    // Whether the graphics layer can attach to a game of the selected version;
    // the game's settings leave out the Graphics section when it cannot.
    graphicsLayer: (entry, context = {}) => {
      const selected = runtimeManager().resolveSelection(entry, context.settings, context.userDataDir, { verification: "status" });
      return !selected?.ready || !selected.install || require("./wine-graphics").graphicsLayerAttachable(selected.install);
    },
    canLaunchRuntime: (runtimeId, entry) => runtimeId === id && platform === "darwin" && supportsEntry(entry),
    ensureRuntime: async (entry, context) => {
      if (!supportsEntry(entry)) throw new Error(notSupported);
      const reference = Environments.environmentReference(context.runtimeSettings?.environmentReference);
      if (reference) {
        if (reference.kind !== source.environmentKind) throw new Error(source.environmentKind ? `Choose a ${source.labels.environmentName} for this runtime.` : `${source.label} runs games in MacLauncher's own Windows environments.`);
        context.wineEnvironment = Environments.readEnvironment(reference);
        const plan = await Translators.resolve(context.wineEnvironment.install, id, context, { entry, executableArchitecture: Detection.cachedWindowsExecutable(entry)?.executableArchitecture });
        return Translators.requirement(plan, context);
      }
      const selected = await runtimeManager().resolveForPlay(entry, context);
      if (selected.ready) {
        if (!selected.install) return null;
        const prepared = Translators.environmentContext(context, selected.install);
        if (prepared.wineEnvironment) context.wineEnvironment = prepared.wineEnvironment;
        const plan = await Translators.resolve(prepared.wineEnvironment?.install || selected.install, id, context, { entry, executableArchitecture: Detection.cachedWindowsExecutable(entry)?.executableArchitecture });
        return Translators.requirement(plan, context);
      }
      if (!selected.version && !selected.discoveryRequired) throw new Error(selected.reason || `No compatible ${source.label} version is available.`);
      return { managerId: source.managerId, version: selected.version || null, ...(selected.discoveryRequired ? { discoveryRequired: true } : {}), installOptions: selected.installOptions || {},
        ...(selected.detail ? { detail: selected.detail } : {}), ...(selected.versionLabel ? { versionLabel: selected.versionLabel } : {}) };
    },
    launchRuntime: async (runtimeId, entry, context) => {
      if (runtimeId !== id) return null;
      if (platform !== "darwin") throw new Error(`${source.label} requires macOS.`);
      if (!supportsEntry(entry)) throw new Error(notSupported);
      const plan = await launch.prepareLaunch(entry, context, { ...launchDependencies, manager: runtimeManager() });
      if (typeof plan.graphics?.restore !== "function") return WineAdapter.launch(plan, context, { supervisorArguments: launch.supervisorArguments });
      let owned, restoration;
      const restore = () => restoration ||= Promise.resolve().then(() => plan.graphics.restore());
      const report = error => warnGraphics(context.logger, "[runtime] Wine graphics restoration failed", error.message);
      const register = child => {
        if (owned === child) return;
        owned = child;
        const previous = child.runtimeRetirement;
        let finished;
        const stopped = new Promise(resolve => { finished = resolve; });
        child.runtimeRetirement = stopped.then(async () => {
          await Promise.resolve();
          await Lifecycle.waitForProcessStop(child);
          await previous;
          return restore();
        });
        void child.runtimeRetirement.catch(report);
        child.once("exit", finished);child.once("close", finished);
        child.once("error", () => { if (!child.pid || child.exitCode != null || child.signalCode != null) finished(); });
        if (child.exitCode != null || child.signalCode != null) finished();
      };
      const spawned = context.onProcessSpawn;
      context.onProcessSpawn = child => { register(child);return spawned?.(child); };
      try {
        const child = await WineAdapter.launch(plan, context, { supervisorArguments: launch.supervisorArguments });
        register(child);return child;
      } catch (error) {
        if (owned && owned.exitCode == null && owned.signalCode == null) {
          try { await Lifecycle.requestProcessStop(owned);await Lifecycle.waitForProcessStop(owned); }
          catch (failure) { report(failure); }
        }
        if (!owned || owned.exitCode != null || owned.signalCode != null) {
          try { await restore(); } catch (failure) { report(failure); }
        }
        throw error;
      } finally { context.onProcessSpawn = spawned; }
    }
  };
}
module.exports = { createProvider, createLog, resolveSaveLocations, SUPPORTS };
