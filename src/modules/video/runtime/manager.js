const fs = require("node:fs"), path = require("node:path"), { execFile } = require("node:child_process"), { promisify } = require("node:util");
const { createPinnedNativeManager } = require("../../shared/runtime/pinned-native-manager");
const { readMachOLoadCommands } = require("../../shared/runtime/macho-load-commands");
const { versionAtLeast, systemVersionSync } = require("../../shared/runtime/bundled-native");
const { throwIfAborted } = require("../../shared/runtime/download-utils");
const warn = require("../../shared/graphics-warning");
const Catalog = require("./catalog");
const Archive = require("../../shared/runtime/archive");
const execute = promisify(execFile);
async function inspectScaleFilters(executable, { signal, logger } = {}, dependencies = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("DYLD_") || key.startsWith("RESHADE_")) delete env[key];
  try {
    const result = await (dependencies.execute || execute)(executable, ["--no-config", "--load-scripts=no", "--scale=help"], { env, signal, timeout: 10000, maxBuffer: 128 * 1024 });
    return require("../scaling").parseHelp(result.stdout);
  } catch {
    throwIfAborted(signal);
    warn(logger, "mpv scaling options could not be inspected. Standard video filters remain available.");return [];
  }
}
async function prepareInstall({ unpacked, pin, signal, logger }, dependencies = {}) {
  // The publisher's ZIP wraps a tar archive that keeps the app's links.
  for (const name of fs.readdirSync(unpacked).filter(name => Archive.archiveKind(name) === "tar")) {
    await (dependencies.execute || execute)("/usr/bin/tar", ["-xf", path.join(unpacked, name), "-C", unpacked], { signal, timeout: 60000 });
    fs.unlinkSync(path.join(unpacked, name));
  }
  // An app that moved into a folder is used from the installation's root.
  const app = path.join(unpacked, "mpv.app"), executableDir = path.join(app, "Contents/MacOS");
  const found = Archive.findEntry(unpacked, (file, item) => item.isDirectory() && item.name.endsWith(".app") && fs.existsSync(path.join(file, "Contents/MacOS/mpv")));
  if (found && found !== app) fs.renameSync(found, app);
  const pending = [app], images = [];
  const architecture = pin.architecture || (pin.hostArchitectures?.length === 1 ? pin.hostArchitectures[0] : require("../../shared/runtime/architecture").selectedArchitecture());
  const nativeArchitecture = architecture === "x64" ? "x86_64" : architecture;
  let minimumMacOS = pin.minimumMacOS;
  while (pending.length) {
    throwIfAborted(signal);
    const directory = pending.pop();
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name);
      if (item.isDirectory()) pending.push(file);
      else if (item.isSymbolicLink()) {
        const target = fs.realpathSync(file);if (target !== app && !target.startsWith(app + path.sep)) throw new Error("The mpv archive contains a link outside its app.");
      } else if (item.isFile() && (item.name.endsWith(".dylib") || file === path.join(executableDir, "mpv"))) {
        const info = readMachOLoadCommands(file, { signal });
        if (!info.architectures.includes(nativeArchitecture)) throw new Error("The mpv download does not contain native images for its listed CPU.");
        for (const slice of info.slices) {
          if (slice.platform !== 1 || !slice.minimumMacOS) throw new Error("An mpv component has no supported macOS deployment version.");
          if (!versionAtLeast(minimumMacOS, slice.minimumMacOS)) minimumMacOS = slice.minimumMacOS;
          for (const dependency of slice.dependencies) {
            if (dependency.path.startsWith("/System/Library/") || dependency.path.startsWith("/usr/lib/")) continue;
            const target = dependency.path.startsWith("@executable_path/") ? path.resolve(executableDir, dependency.path.slice(17))
              : dependency.path.startsWith("@loader_path/") ? path.resolve(directory, dependency.path.slice(13)) : null;
            if (!target || !target.startsWith(app + path.sep) || !fs.existsSync(target)) throw new Error("The mpv download has a missing or external library dependency.");
          }
        }
        images.push(path.relative(unpacked, file));
      }
    }
    if (images.length > 512 || pending.length > 512) throw new Error("The mpv app exceeds its component limit.");
  }
  if (!images.includes("mpv.app/Contents/MacOS/mpv")) throw new Error("The mpv executable is missing.");
  // Published filenames identify a major macOS target. A bundled dependency
  // can require a later point release; retain and enforce the actual closure.
  if (!versionAtLeast((dependencies.systemVersionSync || systemVersionSync)(), minimumMacOS)) throw new Error(`This mpv build and its libraries require macOS ${minimumMacOS}.`);
  const scaleFilters = await inspectScaleFilters(path.join(executableDir, "mpv"), { signal, logger }, dependencies);
  const host=require("./render-host").verify(path.join(executableDir,"mpv"));
  return { schema: 1, minimumMacOS, images, ...(scaleFilters.length ? { scaleFilters } : {}),
    ...(host?{decodedFrameAPI:host.decodedFrameAPI,libraryVersion:host.libraryVersion}:{}) };
}
function createManager(dependencies = {}) {
  const manager = createPinnedNativeManager({
    // Media formats and the verified mpv command interface do not require a patch release.
    versionCompatibility: () => true,
     id: "mpv", label: "mpv", supportsDefault: true, projectBuilds:{projectId:"mpv",repository:"procrastinine/maclauncher-builds",upstreamMacDownloads:true},
    sourceUrl: Catalog.SOURCE_URL, upstream: Catalog.source,
    resolveExecutable: root => path.join(root, "mpv.app/Contents/MacOS/mpv"),
    prepareInstall: options => prepareInstall(options, dependencies), importLocal:true, dependencies });
  manager.resolveForPlay = (entry, context) => {
    const selection = manager.resolveSelection(entry, context.settings, context.userDataDir);
    return selection;
  };
  return manager;
}
module.exports = createManager();
module.exports.createManager = createManager;
module.exports.prepareInstall = prepareInstall;
module.exports.inspectScaleFilters = inspectScaleFilters;
