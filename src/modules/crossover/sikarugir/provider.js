const fs = require("node:fs");
const path = require("node:path");
const Detection = require("../detect");
const Launch = require("./launch");
const Writable = require("../../shared/writable-input");

// The CrossOver evidence decorator has already checked the Windows executable.
// Provider selection consumes those cached facts; opening a runtime picker never
// repeats a directory scan or depends on whether Wine is already installed.
function supportsEntry(entry) {
  if (!entry || Detection.isNativeImport(entry)) return false;
  const evidence = Detection.cachedWindowsExecutable(entry);
  if (!evidence?.windowsExecutablePath || !["x86", "x86_64"].includes(evidence.executableArchitecture)) return false;
  if (!path.isAbsolute(evidence.sourceRoot || "") || !Detection.inside(evidence.sourceRoot, evidence.windowsExecutablePath)) return false;
  const explicitInput = entry.importPath;
  if (typeof explicitInput === "string" && /\.(?:appimage|sh|elf|x86_64|x86)$/i.test(explicitInput)) return false;
  try { return fs.statSync(evidence.windowsExecutablePath).isFile(); } catch { return false; }
}
function decorateEntry(entry) { return entry?.runtimeData?.crossover?.detectionComplete ? entry : Detection.decorateEntry(entry); }
function resolveSaveLocations(entry, context) {
  const directory = Launch.runtimeDirectory(entry, context), gameRoot = path.join(directory, "game");
  const directories = [{ directory: gameRoot, role: "primary", source: "Private Windows game files", confidence: "exact" }];
  const prefixPath = entry.runtimeData?.sikarugir?.prefixPath;
  if (typeof prefixPath === "string" && path.isAbsolute(prefixPath) && Detection.inside(path.join(directory, "prefixes"), prefixPath)) {
    const users = path.join(prefixPath, "drive_c", "users");
    if (fs.existsSync(users)) {
      Writable.assertOwnDirectory(directory, users, { create: false });
      directories.push({ directory: users, role: "alternate", source: "Private Windows profile files", confidence: "exact" });
    }
  }
  return { primaryDirectory: gameRoot, directories };
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
    resolveGraphicsInputs: (entry, context) => {
      const selected = runtimeManager().resolveSelection(entry, context.settings, context.userDataDir, context.runtimeSettings);
      if (!selected?.ready) return null;
      const source = require("../temporal").resolvePlan(entry, context, { install: selected.install, runtimeId: "sikarugir", allowDownload: true })?.inputs;
      return require("../graphics-inputs").inputs(selected.install, source, { fallback: "x86_64" });
    },
    getRuntimeRequirements: (entry, context) => require("../temporal").requirements(entry, { ...context, runtimeId: "sikarugir" }, { manager: runtimeManager() }),
    runtimeDirectory: launch.runtimeDirectory, resolveSaveLocations,
    supports: { cheats: false, cheatsPatcher: false, saveEditing: false, saveLocation: true },
    canLaunchRuntime: (runtimeId, entry) => runtimeId === "sikarugir" && platform === "darwin" && supportsEntry(entry),
    ensureRuntime: async (entry, context) => {
      if (!supportsEntry(entry)) throw new Error("Sikarugir requires an x86 or x64 Windows game.");
      const selected = await runtimeManager().resolveForPlay(entry, context);
      if (selected.ready) return null;
      if (!selected.version) throw new Error(selected.reason || "No compatible Sikarugir version is available.");
      return { managerId: "sikarugir", version: selected.version, installOptions: selected.installOptions || {},
        ...(selected.detail ? { detail: selected.detail } : {}), ...(selected.versionLabel ? { versionLabel: selected.versionLabel } : {}) };
    },
    launchRuntime: async (runtimeId, entry, context) => {
      if (runtimeId !== "sikarugir") return null;
      if (platform !== "darwin") throw new Error("Sikarugir requires macOS.");
      if (!supportsEntry(entry)) throw new Error("Sikarugir requires an x86 or x64 Windows game.");
      const plan = await launch.prepareLaunch(entry, context, { ...launchDependencies, manager: runtimeManager() });
      const log = createLog(plan.directory);
      try {
        const child = await context.spawnDetachedChecked("/bin/sh", launch.supervisorArguments(plan.winePath, plan.serverPath, "play", plan.args, plan.environment),
        { cwd: path.dirname(plan.executablePath), env: plan.environment, stdio: ["ignore", "pipe", "pipe"], graphicsExecutable: plan.winePath }, false);
        log.attach(child);
        return child;
      } catch (error) { log.close(); throw error; }
    }
  };
}
module.exports = { ...createProvider(), createProvider, createLog };
