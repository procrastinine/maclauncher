const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const Detection = require("../detect"), Streamline = require("./streamline");
const { versionAtLeast, systemVersionSync } = require("../../shared/runtime/bundled-native");
const { isAbortError } = require("../../shared/runtime/download-utils");
const warnGraphics = require("../../shared/graphics-warning");
const FILES = Object.freeze(["x86_64-windows/d3d11.dll", "x86_64-windows/dxgi.dll", "x86_64-windows/nvngx.dll", "x86_64-unix/winemetal.so"]);
const hashes = new Map();
function digest(file, verify) {
  const stat = fs.statSync(file);if (!stat.isFile() || stat.size > 128 * 1024 * 1024) throw Error("Unsupported graphics library.");
  const stamp = [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":"), cached = hashes.get(file);
  if (!verify && cached?.stamp === stamp) return cached.sha256;
  const sha256 = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  if (hashes.size > 128) hashes.clear();hashes.set(file, { stamp, sha256 });return sha256;
}
function adapter(root, { verify = false, macOSVersion = systemVersionSync() } = {}) {
  try {
    const directory = path.join(root, "temporal/dxmt"), record = JSON.parse(fs.readFileSync(path.join(directory, "camera-bridge.json"), "utf8"));
    if (record.schema !== 1 || record.id !== "dxmt-camera1" || record.architecture !== "x86_64" || record.tableCount !== 146 || !versionAtLeast(macOSVersion, record.minimumMacOS) ||
      FILES.some(file => !/^[a-f0-9]{64}$/.test(record.files?.[file]) || digest(path.join(directory, file), verify) !== record.files[file])) return null;
    return { directory, id: record.id, tableCount: record.tableCount, base: record.base, identity: crypto.createHash("sha256").update(JSON.stringify(record)).digest("hex"), files: record.files };
  } catch { return null; }
}
function payload(root, baseRoot, options = {}) {
  try {
    const result = adapter(root, options);if (!result) return null;
    const native = path.join(baseRoot, "x86_64-unix/winemetal.so"), thunk = path.join(baseRoot, "x86_64-windows/winemetal.dll");
    const nativeSha256 = digest(native, options.verify), thunkSha256 = digest(thunk, options.verify);
    const Catalog = require("./catalog");
    if (!(nativeSha256 === result.base?.nativeSha256 && thunkSha256 === result.base?.thunkSha256) && !Catalog.CATALOG.some(pin =>
      Catalog.compatible(pin, result) && nativeSha256 === pin.cameraBridge.nativeSha256 && thunkSha256 === pin.cameraBridge.thunkSha256)) return null;
    return { ...result, native };
  } catch { return null; }
}
function libraries(match, executable) {
  // Standard loader and plugin locations are checked directly. No game-tree
  // scan or runtime download is needed while opening the graphics inspector.
  const directories = new Set([path.dirname(executable), match.sourceRoot]);
  for (const directory of [...directories]) for (const child of ["plugins", "Plugins/Streamline", "Streamline", "Engine/Plugins/Runtime/Nvidia/Streamline/Binaries/ThirdParty/Win64"])
    directories.add(path.join(directory, child));
  const result = [];
  for (const directory of directories) {
    if (!Detection.inside(match.sourceRoot, directory)) continue;
    const file = path.join(directory, "sl.interposer.dll");
    try { if (fs.statSync(file).isFile() && Detection.inside(fs.realpathSync(match.sourceRoot), fs.realpathSync(file))) result.push(file); } catch {}
  }
  return result;
}
function supportSelection(entry, context, runtimeId, supportManager, verify = false) {
  const support = supportManager || require("./support-manager").forRuntime(runtimeId);
  const version = context.runtimeSettings?.graphicsBridgeVersion;
  return { support, selected: support.resolveSelection(entry, context.settings, context.userDataDir, { verification: verify ? "full" : "status", ...(version && version !== "auto" ? { version } : {}) }) };
}
function matchingSupport(context, root, { entry, runtimeId = context.runtimeId || entry?.runtimeId || "crossover", verify = false, host = {}, supportManager, wineManager } = {}) {
  const { support, selected: standalone } = supportSelection(entry, context, runtimeId, supportManager, verify), wine = wineManager || require("../sikarugir/runtime/manager");
  const pin = support.core.catalog.find(row => row.version === standalone.version), available = adapter(root, { verify, macOSVersion: host.macOSVersion });
  if (!require("./catalog").compatible(pin, available)) return null;
  const other = require("./support-manager").forRuntime(runtimeId === "crossover" ? "sikarugir" : "crossover");
  const reused = context.userDataDir ? other.core.listInstalled(context.userDataDir).filter(install => install.version === pin.version) : [];
  const choices = [...(standalone.ready ? [{ install: standalone.install, managerId: support.id, baseRoot: standalone.install.baseRoot }] : []),
    ...reused.map(install => ({ install, managerId: other.id, baseRoot: install.baseRoot })),
    ...(context.userDataDir ? wine.getState({ userDataDir: context.userDataDir }).installed.filter(row => row.ready !== false).map(install => ({ install, managerId: wine.id,
      baseRoot: path.join(install.supportRoot || install.templateRoot || path.join(install.installDir, "support"), "Frameworks/renderer/dxmt/wine") })) : [])];
  for (const choice of choices) {
    const dxmt = payload(root, choice.baseRoot, { verify, macOSVersion: host.macOSVersion });
    if (dxmt && (digest(dxmt.native, verify) !== pin.cameraBridge.nativeSha256 || digest(path.join(choice.baseRoot, "x86_64-windows/winemetal.dll"), verify) !== pin.cameraBridge.thunkSha256)) continue;
    if (dxmt) return { dxmt, baseRoot: choice.baseRoot, dependency: { managerId: choice.managerId, version: choice.install.version,
      sourcePath: choice.install.installDir || choice.install.root || choice.baseRoot } };
  }
  return null;
}
function resolvePlan(entry, context = {}, { install, runtimeId = context.runtimeId || entry?.runtimeId || "crossover", settings = context.runtimeSettings || {}, host = {}, root, verify = false, allowDownload = false } = {}) {
  try {
    if ((host.platform || process.platform) !== "darwin" || (host.arch || process.arch) !== "arm64" || !install || !["auto", "dxmt"].includes(settings.graphicsBackend || "auto")) return null;
    if ((settings.dllOverrides || []).some(rule => {
      const [names, order] = String(rule).split("=");
      return order?.trim().toLowerCase() !== "b" && order?.trim().toLowerCase() !== "builtin" && names.split(",").some(name => /^(?:\*|d3d10core|d3d11|dxgi|winemetal|nvapi64|nvngx)(?:\.dll)?$/i.test(name.trim()));
    })) return null;
    const match = Detection.cachedWindowsExecutable(entry);if (!match) return null;
    const executable = settings.executable ? path.resolve(match.sourceRoot, settings.executable) : match.windowsExecutablePath;
    if (!Detection.inside(match.sourceRoot, executable) || Detection.readWindowsExecutable(executable)?.executableArchitecture !== "x86_64") return null;
    const support = install.templateRoot || install.supportRoot || install.runtimeLibraries || (install.installDir && path.join(install.installDir, "support"));
    root ||= require("../../shared/reshade").runtimeRoot(context.app);
    const providerRoot = path.join(root, "temporal/streamline"), sources = libraries(match, executable);
    if (!sources.length || sources.some(file => !Streamline.inspect(file, providerRoot).available)) return null;
    const inputs = { cameraProjection: true, source: "streamline", methods: ["fsr2", "fsr3"] };
    let baseRoot, selectedSupport;
    if (runtimeId === "sikarugir") {
      if (!path.isAbsolute(support || "")) return null;
      const engine = install.engineRoot || install.wineRoot || (install.executablePath && path.dirname(path.dirname(install.executablePath)));
      if (!engine || !fs.existsSync(path.join(engine, "lib/wine/x86_64-unix/ntdll.so")) || fs.existsSync(path.join(engine, "lib/wine/x86_32on64-unix/ntdll.so"))) return null;
      baseRoot = path.join(support, "Frameworks/renderer/dxmt/wine");
    } else if (runtimeId === "crossover" && path.isAbsolute(install.crossoverRoot || "")) {
      // CrossOver's automatic selector can choose another renderer. Its
      // projection adapter requires an explicit matching DXMT selection.
      if (settings.graphicsBackend !== "dxmt") return null;
      baseRoot = path.join(install.crossoverRoot, "lib/dxmt");
      if (!fs.existsSync(path.join(install.crossoverRoot, "lib/wine/x86_64-unix/wine"))) return null;
    } else return null;
    const manager = require("./support-manager").forRuntime(runtimeId), explicit = settings.graphicsBridgeVersion && settings.graphicsBridgeVersion !== "auto" ||
      entry?.runtimeData?.[manager.id]?.version || context.settings?.runtimes?.[manager.id]?.defaultVersion;
    if (explicit || !payload(root, baseRoot, { verify, macOSVersion: host.macOSVersion })) {
      selectedSupport = matchingSupport({ ...context, runtimeSettings: settings }, root, { entry, runtimeId, verify, host });
      if (!selectedSupport) {
        const available = adapter(root, { verify, macOSVersion: host.macOSVersion }), { support: selectedManager, selected } = supportSelection(entry, { ...context, runtimeSettings: settings }, runtimeId);
        const pin = selectedManager.core.catalog.find(row => row.version === selected.version);
        if (allowDownload && require("./catalog").compatible(pin, available)) return {
          inputs: { ...inputs, requiresDownload: true }, requiresDownload: true, download: { managerId: selectedManager.id, version: pin.version } };
        return null;
      }
      baseRoot = selectedSupport.baseRoot;
    }
    const dxmt = payload(root, baseRoot, { verify, macOSVersion: host.macOSVersion });if (!dxmt) return null;
    return { dxmt, baseRoot, dependency: selectedSupport?.dependency, providerRoot, sourceRoot: match.sourceRoot, libraries: sources.map(sourcePath => ({ sourcePath, relativePath: path.relative(match.sourceRoot, sourcePath) })),
      inputs };
  } catch { return null; }
}
function restoreLibraries(libraries, gameRoot, cause, logger) {
  const failures = [];
  for (const library of libraries) {
    try { Streamline.restore({ gameRoot, relativePath: library.relativePath }); }
    catch (error) {
      // A separately changed mod is no longer our proxy. Preserve its bytes;
      // failure to restore an owned proxy must prevent the renderer fallback.
      if (error?.code === "STREAMLINE_LIBRARY_CHANGED") warnGraphics(logger, "Streamline camera adapter was not restored: " + error.message);
      else failures.push(error);
    }
  }
  if (failures.length) {
    const error = Object.assign(new AggregateError(failures,
      "The original Streamline libraries could not be restored. Restore the game's private Streamline files before starting again.", { cause }),
      { code: "STREAMLINE_RESTORE_FAILED" });
    if (isAbortError(cause)) error.name = "AbortError";
    throw error;
  }
}
function prepareGame(plan, gameRoot, signal) {
  const prepared = [];let current, available = true, failed = false, failure;
  try {
    for (const library of plan.libraries) {
      current = library;
      const result = Streamline.prepare({ ...library, providerRoot: plan.providerRoot, gameRoot, signal });
      current = null;
      if (!result.available) { available = false;break; }
      prepared.push(library);
    }
  } catch (error) { failed = true;failure = error; }
  if (failed || !available) restoreLibraries([...prepared, ...(current ? [current] : [])], gameRoot, failure);
  if (failed) throw failure;
  return available;
}
function restoreGame(entry, context, gameRoot, settings = context.runtimeSettings || {}) {
  const match = Detection.cachedWindowsExecutable(entry);if (!match) return;
  const executable = settings.executable ? path.resolve(match.sourceRoot, settings.executable) : match.windowsExecutablePath;
  restoreLibraries(libraries(match, executable).map(source => ({ relativePath: path.relative(match.sourceRoot, source) })), gameRoot, undefined, context.logger);
}
function environment(plan, dllRoot) { return plan ? { MACLAUNCHER_DXMT_BASE_LIBRARY: path.join(dllRoot, "x86_64-unix/maclauncher-dxmt-original.so") } : {}; }
function rendererFile(plan, architecture, filename, fallback) {
  const relative = architecture + "/" + filename;
  return plan && FILES.includes(relative) ? path.join(plan.dxmt.directory, relative) : fallback;
}
function requirements(entry, context, { manager, root } = {}) {
  const runtimeId = context.runtimeId || entry?.runtimeId;
  if (!["crossover", "sikarugir"].includes(runtimeId) ||
      !require("../../shared/effects/execution-requirements").analyze(entry).methods.temporal.some(method => ["fsr2", "fsr3"].includes(method))) return [];
  manager ||= runtimeId === "sikarugir" ? require("../sikarugir/runtime/manager") : require("../runtime/manager");
  const selected = manager.resolveSelection(entry, context.settings, context.userDataDir, context.runtimeSettings);
  const plan = selected.ready && resolvePlan(entry, context, { install: selected.install, runtimeId, root, allowDownload: true });
  return plan?.requiresDownload ? [{ ...plan.download, installOptions: { sectionId: "default" },
    detail: "Downloads matching DXMT support libraries for the selected temporal upscaler. The selected Wine engine remains unchanged." }] : [];
}
module.exports = { FILES, adapter, payload, libraries, matchingSupport, resolvePlan, prepareGame, restoreGame, environment, rendererFile, requirements };
