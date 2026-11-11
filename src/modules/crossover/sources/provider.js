const fs = require("node:fs");
const path = require("node:path");
const Detection = require("../detect");
const WineLaunch = require("./wine-launch");
const Writable = require("../../shared/writable-input");
const Environments = require("../../shared/runtime/wine-environment");
const Processes = require("../../shared/runtime/wine-processes");
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
function createLog(directory) {
  const file = path.join(directory, "wine.log");
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | (fs.constants.O_NOFOLLOW || 0), 0o600);
  let bytes = 0, closed = false;
  const write = chunk => {
    if (closed) return;
    const size = Math.min(chunk.length, 512 * 1024 - bytes);
    if (size > 0) {
      try { fs.writeSync(fd, chunk, 0, size); bytes += size; }
      catch { close(); }
    }
  };
  const close = () => { if (!closed) { closed = true; try { fs.closeSync(fd); } catch {} } };
  return { close, attach: child => {
    child.stdout?.on("data", write); child.stderr?.on("data", write);
    child.once("close", close); child.once("error", close);
    if (child.exitCode != null || child.signalCode != null) close();
  } };
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
      const log = createLog(plan.directory);
      try {
        Processes.installStopHandler(context, plan);
        const args = plan.existingEnvironment ? Processes.externalArguments(plan.winePath, plan.args, plan.environment, plan.sessionPath) :
          launch.supervisorArguments(plan.winePath, plan.serverPath, "play", plan.args, plan.environment, plan.sessionPath);
        const child = await context.spawnDetachedChecked("/bin/sh", args,
        { cwd: plan.workingDirectory || path.dirname(plan.executablePath), env: plan.environment, stdio: ["ignore", "pipe", "pipe"], graphicsExecutable: plan.winePath }, false);
        log.attach(child);
        require("../../shared/runtime/wine-activation").followWineActivation(child, context);
        return child;
      } catch (error) { log.close(); throw error; }
    }
  };
}
module.exports = { createProvider, createLog, resolveSaveLocations, SUPPORTS };
