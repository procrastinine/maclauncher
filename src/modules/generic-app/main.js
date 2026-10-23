const fs = require("node:fs");
const path = require("node:path");
const manifest = require("./manifest.json");
const AppBundle = require("../shared/runtime/app-bundle");
const { readMachOLoadCommands } = require("../shared/runtime/macho-load-commands");

function needsMac32(entry) {
  const architectures = entry?.runtimeData?.mac32?.executableArchitectures || [];
  return architectures.includes("i386") && !architectures.some(cpu => cpu === "arm64" || cpu === "x86_64");
}

function resolveDefaultRuntime(entry) { return needsMac32(entry) ? "mac32" : "native"; }

function mergeEntry(_previous, entry) {
  // Older libraries stored the former native-only default as a game choice.
  // That executable cannot be launched directly on supported macOS releases.
  return needsMac32(entry) && (!entry.runtimeId || entry.runtimeId === "native")
    ? { ...entry, runtimeId: "mac32" } : entry;
}

function filterRuntimeSupport(entry, supported) {
  return needsMac32(entry) ? supported.filter(runtime => runtime !== "native") : supported;
}

function resolveNativeLaunchPath(entry, context) {
  if (["script", "executable"].includes(entry?.moduleData?.launchKind)) {
    const executablePath = entry.gamePath;
    try { return path.isAbsolute(executablePath || "") && fs.statSync(executablePath).isFile() ? executablePath : null; }
    catch { return null; }
  }
  return context?.resolveNativeLaunchPath?.(entry) || null;
}

function detectNativeFile(context) {
  const executablePath = context?.inputPath;
  if (typeof executablePath !== "string" || !executablePath) return null;
  let fd;
  try {
    const stat = context.stat || (context.detection?.stat ? context.detection.stat(executablePath) : fs.statSync(executablePath));
    if (!stat?.isFile() || !stat.size) return null;
    let prefix;
    if (context.detection?.readBytes) prefix = context.detection.readBytes(executablePath, 0, Math.min(stat.size, 4096));
    else {
      fd = fs.openSync(executablePath, "r");
      const bytes = Buffer.alloc(Math.min(stat.size, 4096));
      prefix = bytes.subarray(0, fs.readSync(fd, bytes, 0, bytes.length, 0));
    }
    if (!prefix?.length) return null;
    const extension = path.extname(executablePath).toLowerCase();
    const shellFile = [".sh", ".command", ".bash", ".zsh"].includes(extension) && !prefix.includes(0);
    const shebang = /^#![\t ]*\/[^\s\0]+(?:[\t ]+[^\r\n\0]+)?\r?(?:\n|$)/.test(prefix.toString("utf8"));
    let launchKind, executableArchitectures;
    if (shellFile || shebang && (stat.mode & 0o111)) launchKind = "script";
    else if (stat.mode & 0o111) {
      const native = readMachOLoadCommands(executablePath);
      // Mach-O also contains iOS-family executables. Mac Catalyst is a Mac
      // target; absent deployment commands remain valid for static/older Macs.
      if (!native.slices.length || native.slices.some(slice => slice.fileType !== 2 ||
        !["arm64", "x86_64", "i386", "ppc", "ppc64"].includes(slice.architecture) ||
        slice.platform != null && ![1, 6].includes(slice.platform))) return null;
      launchKind = "executable";
      executableArchitectures = native.architectures;
    }
    if (!launchKind) return null;
    return {
      engine: manifest.id, moduleId: manifest.id, gameType: "native",
      name: path.basename(executablePath, shellFile ? path.extname(executablePath) : ""),
      gamePath: executablePath, contentRootDir: path.dirname(executablePath),
      moduleData: { executablePath, launchKind, ...(executableArchitectures ? { executableArchitectures } : {}) }
    };
  } catch (error) {
    if (error.code === "DETECTION_LIMIT") throw error;
    return null;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function detectGame(context) {
  if (!context?.isAppBundle) return detectNativeFile(context);
  const appPath = context.rootDir;
  const structural = context.applicationBundle;
  const directory = path.join(appPath, "Contents", "MacOS");
  const plist = structural?.plist || AppBundle.readInfoPlist(appPath, { detection: context.detection });
  let executablePath = structural?.executablePath;
  if (!executablePath) {
    let entries;
    try { entries = context.detection?.readdir ? context.detection.readdir(directory) : fs.readdirSync(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === "DETECTION_LIMIT") throw error; return null; }
    const plistName = typeof plist?.CFBundleExecutable === "string" ? plist.CFBundleExecutable.trim() : "";
    if (plistName && (path.basename(plistName) !== plistName || plistName.includes("\0") || plistName === "." || plistName === "..")) return null;
    const executableFiles = entries.filter(entry => {
      if (!entry.isFile()) return false;
      try { return Boolean(fs.statSync(path.join(directory, entry.name)).mode & 0o111); } catch { return false; }
    });
    const executable = plistName ? executableFiles.find(entry => entry.name === plistName)
      : executableFiles.find(entry => entry.name === path.basename(appPath, ".app")) || (executableFiles.length === 1 ? executableFiles[0] : null);
    if (!executable) return null;
    executablePath = path.join(directory, executable.name);
  }
  let executableArchitectures = [];
  try { executableArchitectures = readMachOLoadCommands(executablePath).architectures; }
  catch (error) { if (error.code === "DETECTION_LIMIT") throw error; }
  return {
    engine: manifest.id, moduleId: manifest.id, gameType: "native", name: plist?.CFBundleDisplayName || plist?.CFBundleName || path.basename(appPath, ".app"),
    gamePath: appPath, nativeAppPath: appPath, contentRootDir: appPath,
    runtimeData: { mac32: { appPath, executablePath, executableArchitectures, detectionComplete: true } },
    moduleData: { bundleVersion: plist?.CFBundleShortVersionString || plist?.CFBundleVersion || null,
      bundleIdentifier: plist?.CFBundleIdentifier || null, executablePath }
  };
}

module.exports = { id: manifest.id, manifest, detectGame, resolveDefaultRuntime, filterRuntimeSupport, mergeEntry, resolveNativeLaunchPath,
  resolveGraphicsInputs: (entry, context = {}) => require("../shared/runtime/native-graphics-inputs").withInputs(entry,
    {runtimeId: context.runtimeId || entry.runtimeId || "native"}),
  actions: require("./actions"),
  launchNativeRuntime: (...args) => require("./launch").launchNativeRuntime(...args) };
