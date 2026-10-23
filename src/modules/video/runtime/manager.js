const fs = require("node:fs"), path = require("node:path"), { execFile } = require("node:child_process"), { promisify } = require("node:util");
const { createPinnedNativeManager } = require("../../shared/runtime/pinned-native-manager");
const { readMachOLoadCommands } = require("../../shared/runtime/macho-load-commands");
const { versionAtLeast } = require("../../shared/runtime/bundled-native");
const { throwIfAborted } = require("../../shared/runtime/download-utils");
const warn = require("../../shared/graphics-warning");
const Catalog = require("./catalog");
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
  const archive = path.join(unpacked, "mpv.tar.gz");
  if (fs.existsSync(archive)) {
    await (dependencies.execute || execute)("/usr/bin/tar", ["-xzf", archive, "-C", unpacked], { signal, timeout: 60000 });
    fs.unlinkSync(archive);
  }
  const app = path.join(unpacked, "mpv.app"), executableDir = path.join(app, "Contents/MacOS");
  const pending = [app], images = [];
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
        if (!info.architectures.includes("arm64")) throw new Error("The mpv download requires native Apple Silicon images.");
        for (const slice of info.slices) {
          if (slice.platform !== 1 || !slice.minimumMacOS || !versionAtLeast(pin.minimumMacOS, slice.minimumMacOS)) throw new Error("An mpv component requires a newer macOS version than this download declares.");
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
  const scaleFilters = await inspectScaleFilters(path.join(executableDir, "mpv"), { signal, logger }, dependencies);
  return { schema: 1, minimumMacOS: pin.minimumMacOS, images, ...(scaleFilters.length ? { scaleFilters } : {}) };
}
function createManager(dependencies = {}) {
  const manager = createPinnedNativeManager({ id: "mpv", label: "mpv", catalog: [Catalog.DEFAULT_ENTRY], recommendedVersion: Catalog.DEFAULT_ENTRY.version,
    sourceUrl: Catalog.SOURCE_URL, discoverCatalog: Catalog.createDiscovery(dependencies),
    resolveExecutable: root => path.join(root, "mpv.app/Contents/MacOS/mpv"),
    prepareInstall: options => prepareInstall(options, dependencies), dependencies });
  manager.resolveForPlay = (entry, context) => {
    const selection = manager.resolveSelection(entry, context.settings, context.userDataDir);
    if (!selection.ready && selection.version === Catalog.DEFAULT_ENTRY.version) manager.core.rememberResolvedVersion({ userDataDir: context.userDataDir, entry: Catalog.DEFAULT_ENTRY });
    return selection;
  };
  return manager;
}
module.exports = createManager();
module.exports.createManager = createManager;
module.exports.prepareInstall = prepareInstall;
module.exports.inspectScaleFilters = inspectScaleFilters;
