const fs = require("node:fs");
const path = require("node:path");
const AppBundle = require("../shared/runtime/app-bundle");
const MachO = require("../shared/runtime/macho-load-commands");
const NativeFocus = require("../shared/runtime/native-focus");
const Sandbox = require("../shared/runtime/macos-sandbox");
const GameData = require("../shared/game-data");
const Writable = require("../shared/writable-input");
const { boundedLog } = require("../shared/runtime/bounded-log");
const manifest = require("./manifest.json");

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative !== "" && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
}
function supportsEntry(entry) {
  const evidence = entry?.runtimeData?.mac32;
  if (evidence?.detectionComplete !== true || !path.isAbsolute(evidence.appPath || "") || !/\.app$/i.test(evidence.appPath) ||
    !path.isAbsolute(evidence.executablePath || "") || !inside(path.join(evidence.appPath, "Contents", "MacOS"), evidence.executablePath) ||
    !Array.isArray(evidence.executableArchitectures) || !evidence.executableArchitectures.includes("i386") ||
    evidence.executableArchitectures.some(arch => ["arm64", "x86_64"].includes(arch))) return false;
  try {
    return fs.statSync(evidence.executablePath).isFile() &&
      inside(fs.realpathSync(evidence.appPath), fs.realpathSync(evidence.executablePath));
  } catch { return false; }
}
function inspectEntry(entry) {
  if (!supportsEntry(entry)) throw new Error("mac32 requires a 32-bit Intel Mac app bundle without a 64-bit Mac executable.");
  const evidence = entry.runtimeData.mac32;
  const bundle = AppBundle.inspectApplicationBundle(evidence.appPath);
  if (!bundle || path.resolve(bundle.executablePath) !== path.resolve(evidence.executablePath))
    throw new Error("The Mac app executable changed. Import the app again before launching.");
  const info = MachO.readMachOLoadCommands(evidence.executablePath);
  if (!info.architectures.includes("i386") || info.architectures.some(arch => ["arm64", "x86_64"].includes(arch)) ||
    info.slices.find(slice => slice.architecture === "i386")?.fileType !== 2)
    throw new Error("mac32 requires a 32-bit Intel Mac app bundle without a 64-bit Mac executable.");
  return evidence;
}
function runtimeDirectory(entry, context) {
  if (!path.isAbsolute(context.userDataDir || "") || !/^[\w-]+$/.test(entry.gameId || ""))
    throw new Error("mac32 requires a saved app and launcher data directory.");
  return GameData.resolveGameRuntimeDir(context.userDataDir, entry.gameId, "mac32");
}
function resolveSaveLocations(entry, context) {
  const directory = runtimeDirectory(entry, context), home = path.join(directory, "home"), work = path.join(directory, "work");
  return { primaryDirectory: home, directories: [
    { directory: home, role: "primary", source: "Private Mac app home folder", confidence: "inferred" },
    { directory: work, role: "alternate", source: "Private Mac app working folder", confidence: "inferred" }
  ] };
}
function prepareDirectories(entry, context) {
  const directory = runtimeDirectory(entry, context);
  const source = fs.realpathSync(entry.runtimeData.mac32.appPath);
  const prospective = path.join(fs.realpathSync(context.userDataDir), path.relative(context.userDataDir, directory));
  if (source === prospective || inside(source, prospective)) throw new Error("Mac app data must be separate from the original app bundle.");
  for (const relative of ["work", "home/Library/Application Support", "home/Library/Preferences", "home/Library/Caches",
    "home/.config", "home/.local/share", "home/.cache", "tmp"])
    Writable.assertOwnDirectory(context.userDataDir, path.join(directory, relative));
  // The configured launcher data parent can itself be an alias.
  if (inside(source, fs.realpathSync(directory))) throw new Error("Mac app data must be separate from the original app bundle.");
  return { directory, cwd: path.join(directory, "work"), home: path.join(directory, "home"), temporary: path.join(directory, "tmp") };
}
function launchOptions(settings, directories, environment = process.env) {
  const appArgs = settings?.appArgs ?? [];
  if (!Array.isArray(appArgs) || appArgs.some(arg => typeof arg !== "string" || arg.includes("\0")))
    throw new Error("Application arguments must be a list of strings without NUL bytes.");
  const libraryDirectory = settings?.libraryDirectory || "";
  if (typeof libraryDirectory !== "string" || libraryDirectory.includes("\0") || libraryDirectory &&
    (!path.isAbsolute(libraryDirectory) || !fs.statSync(libraryDirectory).isDirectory()))
    throw new Error("The additional library directory must be an existing absolute folder.");
  const env = { ...Sandbox.environment(environment), HOME: directories.home, CFFIXED_USER_HOME: directories.home,
    TMPDIR: directories.temporary + path.sep, XDG_CONFIG_HOME: path.join(directories.home, ".config"),
    XDG_DATA_HOME: path.join(directories.home, ".local", "share"), XDG_CACHE_HOME: path.join(directories.home, ".cache") };
  // Upstream checks the variable's presence, including an empty or zero value.
  if (settings?.enableGamePatches === true) delete env.MAC32_NOPATCH;
  else env.MAC32_NOPATCH = "1";
  return { prefix: libraryDirectory ? ["-L", libraryDirectory] : [], appArgs, env };
}
function captureRuntimeOutput(directory, logger) {
  const file = path.join(directory, "runtime.log");
  fs.rmSync(file + ".previous", { force: true });
  const log = boundedLog(file, { limit: 512 * 1024, headLimit: 64 * 1024 });
  let child, complete = false, logClosed = false, drainTimer;
  let stderrTail = Buffer.alloc(0), stdoutTail = Buffer.alloc(0);
  const closeLog = () => {
    if (logClosed) return;
    logClosed = true;
    try { log.close(); } catch (error) { logger?.warn?.("[mac32] Cannot close runtime log: " + error.message); }
  };
  const retain = (tail, bytes) => bytes.length >= 8192 ? Buffer.from(bytes.subarray(bytes.length - 8192))
    : Buffer.concat([tail.subarray(Math.max(0, tail.length + bytes.length - 8192)), bytes]);
  const write = (chunk, stderr) => {
    if (complete) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (stderr) stderrTail = retain(stderrTail, bytes);
    else stdoutTail = retain(stdoutTail, bytes);
    if (logClosed) return;
    try { log.write(bytes); }
    catch (error) { logger?.warn?.("[mac32] Cannot write runtime log: " + error.message); closeLog(); }
  };
  const stdout = chunk => write(chunk, false), stderr = chunk => write(chunk, true);
  const streamError = error => stderr("\nRuntime output could not be read: " + error.message + "\n");
  const finish = (code, signal, error) => {
    if (complete) return;
    complete = true; clearTimeout(drainTimer);
    child?.stdout?.removeListener?.("data", stdout); child?.stderr?.removeListener?.("data", stderr);
    child?.stdout?.removeListener?.("error", streamError); child?.stderr?.removeListener?.("error", streamError);
    child?.removeListener?.("exit", exited); child?.removeListener?.("close", finish); child?.removeListener?.("error", failed);
    closeLog();
    if (!child) return;
    const failedExit = Boolean(error || signal || code != null && code !== 0);
    const message = (stderrTail.length ? stderrTail : stdoutTail).toString("utf8")
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "").trim().slice(-2048);
    child.completionDiagnostics = { pending: false, logFile: file,
      ...(failedExit && (message || error?.message) ? { message: message || error.message } : {}) };
    child.stdout?.destroy?.(); child.stderr?.destroy?.();
    child.emit?.("diagnostics");
    stderrTail = stdoutTail = Buffer.alloc(0);
  };
  const exited = (code, signal) => { drainTimer = setTimeout(() => finish(code, signal), 1000); drainTimer.unref?.(); };
  const failed = error => finish(child?.exitCode, child?.signalCode, error);
  return {
    attach(process) {
      if (child) return;
      child = process;
      child.completionDiagnostics = { pending: true, logFile: file };
      child.stdout?.on?.("data", stdout); child.stderr?.on?.("data", stderr);
      child.stdout?.on?.("error", streamError); child.stderr?.on?.("error", streamError);
      child.once?.("exit", exited); child.once?.("close", finish); child.once?.("error", failed);
      if (child.exitCode != null || child.signalCode != null) exited(child.exitCode, child.signalCode);
    },
    close: () => finish(child?.exitCode, child?.signalCode)
  };
}
function createProvider({ manager, platform = process.platform, spawn = NativeFocus.spawnForegroundNativeGame } = {}) {
  const runtimeManager = () => manager || require("./runtime/manager");
  return { runtimeId: "mac32", managerId: "mac32", runtime: manifest.runtime.entries.mac32, supportsEntry,
    supports: { cheats: false, cheatsPatcher: false, saveEditing: false, saveLocation: true },
    resolveSaveLocations,
    canLaunchRuntime: (runtimeId, entry) => runtimeId === "mac32" && platform === "darwin" && supportsEntry(entry),
    ensureRuntime: async (entry, context) => {
      inspectEntry(entry);
      const selected = runtimeManager().resolveSelection(entry, context.settings, context.userDataDir);
      if (selected.unsupportedHost) throw new Error(selected.reason);
      if (selected.ready) {
        context.recordRuntimeUse?.({ managerId: "mac32", version: selected.version, sectionId: "default", sourcePath: selected.install.installDir });
        return null;
      }
      const state = runtimeManager().getState({ userDataDir: context.userDataDir, settings: context.settings?.runtimes?.mac32 });
      const requirement = state.catalog.versionRequirements?.[selected.version];
      const pin = runtimeManager().core.catalog.find(pin => pin.version === selected.version);
      if (requirement?.installReason || !selected.discoveryRequired && (!pin?.asset || pin.deprecated))
        throw new Error(requirement?.installReason || selected.reason || "The selected mac32 version is unavailable.");
      return { managerId: "mac32", version: selected.version, ...(selected.discoveryRequired ? { discoveryRequired: true } : {}), requiresDownload: true, installOptions: {} };
    },
    launchRuntime: async (runtimeId, entry, context) => {
      if (runtimeId !== "mac32") return null;
      if (platform !== "darwin") throw new Error("mac32 requires macOS.");
      const evidence = inspectEntry(entry);
      const selected = runtimeManager().resolveSelection(entry, context.settings, context.userDataDir);
      if (!selected.ready) throw new Error(selected.reason);
      await context.useRuntime?.({ managerId: "mac32", version: selected.version, sectionId: "default", sourcePath: selected.install.installDir });
      await context.flushRuntimeUses?.();
      context.signal?.throwIfAborted();
      const directories = prepareDirectories(entry, context), options = launchOptions(context.runtimeSettings, directories);
      const output = captureRuntimeOutput(directories.directory, context.logger);
      const previous = context.onProcessSpawn;
      // Attach before the shared process owner awaits leases or sends its first
      // descriptor, so a fast failure already carries pending diagnostics.
      const onSpawn = async child => { output.attach(child); await previous?.(child); };
      context.onProcessSpawn = onSpawn;
      try {
        const child = await spawn({ context, executablePath: selected.install.executablePath,
          args: [...options.prefix, evidence.appPath, ...options.appArgs, ...(context.gameArguments || [])],
          options: { cwd: directories.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] }, needsRosetta: selected.install.needsRosetta });
        output.attach(child);
        return child;
      } catch (error) { output.close(); throw error; }
      finally {
        if (context.onProcessSpawn === onSpawn) {
          if (previous) context.onProcessSpawn = previous;
          else delete context.onProcessSpawn;
        }
      }
    }
  };
}

module.exports = { createProvider, supportsEntry, inspectEntry, runtimeDirectory, resolveSaveLocations, prepareDirectories, launchOptions, captureRuntimeOutput };
