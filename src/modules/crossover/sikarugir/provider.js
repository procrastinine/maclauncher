const fs = require("node:fs");
const path = require("node:path");
const Detection = require("../detect");
const Launch = require("./launch");
const Writable = require("../../shared/writable-input");
const Environments = require("../../shared/runtime/wine-environment");
const Processes = require("../../shared/runtime/wine-processes");
const Translators = require("../../shared/runtime/wine-translators");

// Both Windows runtimes share the executable evidence that detection records.
// The runtime picker reads that record and does not depend on whether Wine is
// already installed.
const supportsEntry = entry => Detection.supportsWindowsRuntimes(entry);
const decorateEntry = Detection.decorateEntry;
function resolveSaveLocations(entry, context) {
  const directory = Launch.runtimeDirectory(entry, context), gameRoot = Detection.cachedWindowsExecutable(entry)?.sourceRoot || entry.gamePath;
  const directories = path.isAbsolute(gameRoot || "") ? [{ directory: gameRoot, role: "primary", source: "Original Windows game files", confidence: "exact" }] : [];
  directories.push(...Environments.saveLocations(context.runtimeSettings));
  const prefixPath = entry.runtimeData?.sikarugir?.prefixPath;
  if (typeof prefixPath === "string" && path.isAbsolute(prefixPath) && Detection.inside(path.join(directory, "prefixes"), prefixPath)) {
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
function createProvider({ manager, launch = Launch, platform = process.platform, launchDependencies } = {}) {
  const runtimeManager = () => manager || require("./runtime/manager");
  return { runtimeId: "sikarugir", managerId: "sikarugir", supportsEntry, decorateEntry,
    resolveGraphicsInputs: async (entry, context) => {
      const reference = Environments.environmentReference(context.runtimeSettings?.environmentReference);
      const existing = reference ? Environments.readEnvironment(reference) : null;
      if (existing) context.wineEnvironment = existing;
      const selected = existing ? {ready:true,install:existing.install} : runtimeManager().resolveSelection(entry, context.settings, context.userDataDir, context.runtimeSettings);
      if (!selected?.ready) return null;
      const prepared = Translators.environmentContext(context, selected.install);
      if (prepared.wineEnvironment) context.wineEnvironment = prepared.wineEnvironment;
      const install = prepared.wineEnvironment?.install || selected.install;
      const translatorPlan = await Translators.resolve(install, "sikarugir", context, { entry, executableArchitecture: Detection.cachedWindowsExecutable(entry)?.executableArchitecture });
      const source = require("../temporal").resolvePlan(entry, context, { install, runtimeId: "sikarugir", translatorPlan, settings: Translators.settingsForPlan(context.runtimeSettings || {}, translatorPlan), allowDownload: true })?.inputs;
      return require("../graphics-inputs").inputs(install, source, { fallback: "x86_64" });
    },
    getRuntimeRequirements: async (entry, context) => {
      const existing = Environments.readEnvironment(context.runtimeSettings?.environmentReference);
      if (existing) context.wineEnvironment = existing;
      const manager = existing ? { resolveSelection: () => ({ ready: true, install: existing.install, version: existing.path }) } : runtimeManager();
      return [...await require("../temporal").requirements(entry, { ...context, runtimeId: "sikarugir" }, { manager }),
        ...await require("../temporal/vulkan-dlss").requirements(entry, context),
        ...await require("../runtime/steam-bridge").requirements(entry, { ...context, runtimeId: "sikarugir" })];
    },
    runtimeDirectory: launch.runtimeDirectory, resolveSaveLocations,
    supports: { cheats: false, cheatsPatcher: false, saveEditing: false, saveLocation: true },
    canLaunchRuntime: (runtimeId, entry) => runtimeId === "sikarugir" && platform === "darwin" && supportsEntry(entry),
    ensureRuntime: async (entry, context) => {
      if (!supportsEntry(entry)) throw new Error("Sikarugir requires an x86 or x64 Windows game.");
      const reference = Environments.environmentReference(context.runtimeSettings?.environmentReference);
      if (reference) {
        if (reference.kind !== "sikarugir-wrapper") throw new Error("Choose a Sikarugir wrapper for this runtime.");
        context.wineEnvironment = Environments.readEnvironment(reference);
        await Translators.resolve(context.wineEnvironment.install, "sikarugir", context, { entry, executableArchitecture: Detection.cachedWindowsExecutable(entry)?.executableArchitecture });
        return null;
      }
      const selected = await runtimeManager().resolveForPlay(entry, context);
      if (selected.ready) {
        if (!selected.install) return null;
        const prepared = Translators.environmentContext(context, selected.install);
        if (prepared.wineEnvironment) context.wineEnvironment = prepared.wineEnvironment;
        await Translators.resolve(prepared.wineEnvironment?.install || selected.install, "sikarugir", context, { entry, executableArchitecture: Detection.cachedWindowsExecutable(entry)?.executableArchitecture });
        return null;
      }
      if (!selected.version && !selected.discoveryRequired) throw new Error(selected.reason || "No compatible Sikarugir version is available.");
      return { managerId: "sikarugir", version: selected.version || null, ...(selected.discoveryRequired ? { discoveryRequired: true } : {}), installOptions: selected.installOptions || {},
        ...(selected.detail ? { detail: selected.detail } : {}), ...(selected.versionLabel ? { versionLabel: selected.versionLabel } : {}) };
    },
    launchRuntime: async (runtimeId, entry, context) => {
      if (runtimeId !== "sikarugir") return null;
      if (platform !== "darwin") throw new Error("Sikarugir requires macOS.");
      if (!supportsEntry(entry)) throw new Error("Sikarugir requires an x86 or x64 Windows game.");
      const plan = await launch.prepareLaunch(entry, context, { ...launchDependencies, manager: runtimeManager() });
      const log = createLog(plan.directory);
      try {
        Processes.installStopHandler(context, plan);
        const args = plan.existingEnvironment ? Processes.externalArguments(plan.winePath, plan.args, plan.environment) :
          launch.supervisorArguments(plan.winePath, plan.serverPath, "play", plan.args, plan.environment);
        const child = await context.spawnDetachedChecked("/bin/sh", args,
        { cwd: plan.workingDirectory || path.dirname(plan.executablePath), env: plan.environment, stdio: ["ignore", "pipe", "pipe"], graphicsExecutable: plan.winePath }, false);
        log.attach(child);
        require("../../shared/runtime/wine-activation").followWineActivation(child, context);
        return child;
      } catch (error) { log.close(); throw error; }
    }
  };
}
module.exports = { ...createProvider(), createProvider, createLog };
