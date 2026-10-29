const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const Detection = require("../detect"), Streamline = require("./streamline"), XeSS = require("./xess"), FidelityFX = require("./fidelityfx");
function libraryAdapter(library) {
  const name = path.basename(library?.relativePath || library?.sourcePath || "").toLowerCase();
  if (library?.adapter === "fidelityfx" || name === require("./catalog").FIDELITYFX_PROFILE.library) return FidelityFX;
  return library?.adapter === "xess" || name === "libxess_dx11.dll" ? XeSS : Streamline;
}
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
      !/^[a-f0-9]{64}$/.test(record.base?.nativeSha256 || "") || !/^[a-f0-9]{64}$/.test(record.base?.thunkSha256 || "") ||
      FILES.some(file => !/^[a-f0-9]{64}$/.test(record.files?.[file]) || digest(path.join(directory, file), verify) !== record.files[file])) return null;
    return { directory, id: record.id, tableCount: record.tableCount, base: record.base, identity: crypto.createHash("sha256").update(JSON.stringify(record)).digest("hex"), files: record.files };
  } catch { return null; }
}
function payload(root, baseRoot, options = {}) {
  try {
    const result = adapter(root, options);if (!result) return null;
    const native = path.join(baseRoot, "x86_64-unix/winemetal.so"), thunk = path.join(baseRoot, "x86_64-windows/winemetal.dll");
    const nativeSha256 = digest(native, options.verify), thunkSha256 = digest(thunk, options.verify);
    if (nativeSha256 !== result.base.nativeSha256 || thunkSha256 !== result.base.thunkSha256) return null;
    return { ...result, native };
  } catch { return null; }
}
function libraries(match, executable) {
  // Standard loader and plugin locations are checked directly. No game-tree
  // scan or runtime download is needed while opening the graphics inspector.
  const directories = new Set([path.dirname(executable), match.sourceRoot]);
  for (const directory of [...directories]) for (const child of ["plugins", "Plugins/Streamline", "Streamline", "XeSS", "Engine/Plugins/Runtime/Nvidia/Streamline/Binaries/ThirdParty/Win64", "Engine/Plugins/Runtime/Intel/XeSS/Binaries/ThirdParty/Win64"])
    directories.add(path.join(directory, child));
  const result = [];
  for (const directory of directories) {
    if (!Detection.inside(match.sourceRoot, directory)) continue;
    for (const name of ["sl.interposer.dll", "libxess_dx11.dll"]) {
      const file = path.join(directory, name);
      try { if (fs.statSync(file).isFile() && Detection.inside(fs.realpathSync(match.sourceRoot), fs.realpathSync(file))) result.push(file); } catch {}
    }
  }
  return result;
}
function supportSelection(entry, context, runtimeId, supportManager, verify = false, available) {
  const support = supportManager || require("./support-manager").forRuntime(runtimeId);
  const version = context.runtimeSettings?.graphicsBridgeVersion, verification = verify ? "full" : "status";
  const compatible = available && (pin => {
    const install = context.userDataDir && support.core.resolveInstalled({ userDataDir: context.userDataDir, version: pin.version, verification });
    // Uninstalled releases remain candidates for inspection after consent.
    return !install || install.installationMetadata?.files?.["wine/x86_64-unix/winemetal.so"] === available.base.nativeSha256 &&
      install.installationMetadata?.files?.["wine/x86_64-windows/winemetal.dll"] === available.base.thunkSha256;
  });
  return { support, selected: support.resolveSelection(entry, context.settings, context.userDataDir, { verification, compatible, ...(version && version !== "auto" ? { version } : {}) }) };
}
function matchingSupport(context, root, { entry, runtimeId = context.runtimeId || entry?.runtimeId || "crossover", verify = false, host = {}, supportManager, wineManager } = {}) {
  const available = adapter(root, { verify, macOSVersion: host.macOSVersion });if (!available) return null;
  const { support, selected: standalone } = supportSelection(entry, context, runtimeId, supportManager, verify, available), wine = wineManager || require("../sikarugir/runtime/manager");
  const pin = support.core.catalog.find(row => row.version === standalone.version);if (!pin) return null;
  if (!standalone.ready && context.userDataDir && support.core.resolveInstalled({ userDataDir: context.userDataDir, version: pin.version, verification: verify ? "full" : "status" })) return null;
  const other = require("./support-manager").forRuntime(runtimeId === "crossover" ? "sikarugir" : "crossover");
  const reused = context.userDataDir ? other.core.listInstalled(context.userDataDir).filter(install => install.version === pin.version) : [];
  const choices = [...(standalone.ready ? [{ install: standalone.install, managerId: support.id, baseRoot: standalone.install.baseRoot }] : []),
    ...reused.map(install => ({ install, managerId: other.id, baseRoot: install.baseRoot })),
    ...(context.userDataDir ? wine.getState({ userDataDir: context.userDataDir }).installed.filter(row => row.ready !== false).map(install => ({ install, managerId: wine.id,
      baseRoot: path.join(install.supportRoot || install.templateRoot || path.join(install.installDir, "support"), "Frameworks/renderer/dxmt/wine") })) : [])];
  for (const choice of choices) {
    const dxmt = payload(root, choice.baseRoot, { verify, macOSVersion: host.macOSVersion });
    if (dxmt) return { dxmt, baseRoot: choice.baseRoot, dependency: { managerId: choice.managerId, version: choice.install.version,
      sourcePath: choice.install.installDir || choice.install.root || choice.baseRoot } };
  }
  return null;
}
function resolvePlan(entry, context = {}, { install, runtimeId = context.runtimeId || entry?.runtimeId || "crossover", settings = context.runtimeSettings || {}, host = {}, root, verify = false, allowDownload = false, automatic = false } = {}) {
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
    const sources = libraries(match, executable).flatMap(sourcePath => {
      const selected = libraryAdapter({sourcePath}), adapter = selected === XeSS ? "xess" : "streamline", providerRoot = path.join(root, "temporal", adapter);
      // In-game XeSS translation is a compatibility path, independent of the
      // optional shared graph. Streamline replacement remains explicitly selected.
      if (automatic && selected !== XeSS) return [];
      const inspected = selected.inspect(sourcePath, providerRoot);
      return inspected.available ? [{sourcePath, relativePath: path.relative(match.sourceRoot, sourcePath), sourceSha256: inspected.sourceSha256, adapter, providerRoot}] : [];
    });
    if (!sources.length) return null;
    const hasProjection = sources.some(row => row.adapter === "streamline"), hasXeSS = sources.some(row => row.adapter === "xess");
    const inputs = { depth:true,motionVectors:true,jitter:true,exposure:true,cameraProjection: hasProjection, source: hasProjection && hasXeSS ? "streamline+xess" : hasXeSS ? "xess" : "streamline",
      methods: [...(hasProjection ? ["fsr2", "fsr3"] : []), ...(hasXeSS ? ["metalfx"] : [])],
      routes: sources.map(row => ({source: row.adapter, depth:true,motionVectors:true,jitter:true,exposure:true,cameraProjection: row.adapter === "streamline", methods: row.adapter === "xess" ? ["metalfx"] : ["fsr2", "fsr3"]})) };
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
        const available = adapter(root, { verify, macOSVersion: host.macOSVersion }), { support: selectedManager, selected } = supportSelection(entry, { ...context, runtimeSettings: settings }, runtimeId, undefined, verify, available);
        const pin = selectedManager.core.catalog.find(row => row.version === selected.version);
        if (allowDownload && pin && available && !(context.userDataDir && selectedManager.core.resolveInstalled({ userDataDir: context.userDataDir, version: pin.version, verification: verify ? "full" : "status" }))) return {
          inputs: { ...inputs, requiresDownload: true }, requiresDownload: true, download: { managerId: selectedManager.id, version: pin.version } };
        return null;
      }
      baseRoot = selectedSupport.baseRoot;
    }
    const dxmt = payload(root, baseRoot, { verify, macOSVersion: host.macOSVersion });if (!dxmt) return null;
    return { dxmt, baseRoot, dependency: selectedSupport?.dependency, sourceRoot: match.sourceRoot, libraries: sources,
      inputs };
  } catch { return null; }
}
function restoreLibraries(libraries, gameRoot, cause, logger) {
  const failures = [];
  for (const library of libraries) {
    try { libraryAdapter(library).restore({ gameRoot, relativePath: library.relativePath }); }
    catch (error) {
      // A separately changed mod is no longer our proxy. Preserve its bytes;
      // failure to restore an owned proxy must prevent the renderer fallback.
      if (["STREAMLINE_LIBRARY_CHANGED", "XESS_LIBRARY_CHANGED", "FIDELITYFX_LIBRARY_CHANGED"].includes(error?.code)) warnGraphics(logger, "The temporal game adapter was not restored: " + error.message);
      else failures.push(error);
    }
  }
  if (failures.length) {
    const error = Object.assign(new AggregateError(failures,
      "The original temporal libraries could not be restored. Restore the game's private temporal files before starting again.", { cause }),
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
      const result = libraryAdapter(library).prepare({ ...library, providerRoot: library.providerRoot || plan.providerRoot, gameRoot, signal });
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
function cameraRequirements(entry, context, { manager, root } = {}) {
  const runtimeId = context.runtimeId || entry?.runtimeId;
  if (!["crossover", "sikarugir"].includes(runtimeId)) return [];
  const settings = require("../dlss").withTemporalSelection(context.runtimeSettings || {}, entry.effects);
  const automatic = settings.dlss !== true;
  if (automatic) {
    const match = Detection.cachedWindowsExecutable(entry);
    const executable = match && (settings.executable ? path.resolve(match.sourceRoot, settings.executable) : match.windowsExecutablePath);
    if (!match || !Detection.inside(match.sourceRoot, executable) || !libraries(match, executable).some(file => libraryAdapter({sourcePath: file}) === XeSS)) return [];
  }
  manager ||= runtimeId === "sikarugir" ? require("../sikarugir/runtime/manager") : require("../runtime/manager");
  const selected = manager.resolveSelection(entry, context.settings, context.userDataDir, settings);
  const plan = selected.ready && resolvePlan(entry, context, { install: selected.install, runtimeId, root, settings, automatic, allowDownload: true });
  return plan?.requiresDownload ? [{ ...plan.download, installOptions: { sectionId: "default" },
    detail: "Downloads matching DXMT support libraries for the game's temporal API. The selected Wine engine remains unchanged." }] : [];
}
function sceneLibraries(entry, settings = {}) {
  const match = Detection.cachedWindowsExecutable(entry);if (!match) return [];
  const executable = settings.executable ? path.resolve(match.sourceRoot, settings.executable) : match.windowsExecutablePath;
  if (!Detection.inside(match.sourceRoot, executable)) return [];
  const directories = new Set([path.dirname(executable), match.sourceRoot]);
  for (const directory of [...directories]) for (const child of ["plugins", "Plugins", "FidelityFX", "FSR"])
    directories.add(path.join(directory, child));
  const profile = require("./catalog").FIDELITYFX_PROFILE, result = [];
  for (const directory of directories) {
    const file = path.join(directory, profile.library);
    try {
      if (!Detection.inside(fs.realpathSync(match.sourceRoot), fs.realpathSync(file)) || digest(file) !== profile.referenceSha256) continue;
      result.push({ adapter: "fidelityfx", sourcePath: file, sourceSha256: profile.referenceSha256,
        relativePath: path.relative(match.sourceRoot, file) });
    } catch {}
  }
  return result;
}
function sceneDemand(entry, context = {}, {root} = {}) {
  const Contracts = require("../../shared/effects/operation-contracts.mjs"), plan = require("../../shared/effects/plan.mjs").salvage(entry.effects).plan;
  if (!plan || plan.enabled === false) return [];
  const inputs = new Set(), add = requirements => Contracts.sceneInputNames(requirements).forEach(name => inputs.add(name));
  for (const node of plan.video) {
    if (!node.enabled) continue;
    const neural = Contracts.NEURAL[node.method], operation = node.kind === "temporal" ? Contracts.TEMPORAL[node.method]
      : node.kind === "frame-generation" ? Contracts.GENERATION[node.method] : null;
    const scene = neural ? neural.kind === node.kind && neural.history === "scene"
      : operation && (node.kind === "temporal" || operation.scene === true);
    if (scene) add(["depth", "motion", ...(operation?.matrices ? ["viewMatrix", "projectionMatrix"] : operation?.camera ? ["camera"] : []), ...(operation?.requires || [])]);
    if (node.kind !== "shader") continue;
    // Only selected source metadata is inspected; its shared cache revalidates
    // source/dependency identity. A fresh implicit FX input remains unknown
    // until ordinary shader preparation reports its compiled requirements.
    const shaders = node.shader.preset === "chain" ? (node.shader.effects || []).map(preset => ({...node.shader, preset})) : [node.shader];
    for (const shader of shaders) try {
      const selected = require("../../shared/reshade").resolveShaderSelection({reshade: {...shader, enabled: true}},
        {userDataDir: context.userDataDir, settings: context.settings, graphicsHost: "window", graphicsArchitecture: "x86_64", ...(root ? {root} : {})});
      if (!selected || selected.traits?.sourceError) continue;
      add(selected.requirements);add(selected.traits?.sceneInputs);
      add(require("../../shared/reshade/shader-scene-bindings").requirements(selected.sceneBindings || selected.traits?.sceneBindings));
    } catch {} // Unknown or invalid optional metadata never authorizes an API install.
  }
  return [...inputs];
}
function resolveScenePlan(entry, context = {}, { install, settings = context.runtimeSettings || {}, verify = false,
  requested, root,
  support, vulkan } = {}) {
  // Pure demand precedes DLL inspection, package reads and private preparation.
  if (requested === false || !install?.crossoverRoot || !path.isAbsolute(install.crossoverRoot)) return null;
  const demanded = sceneDemand(entry, context, {root});
  if (!demanded.length) return null;
  context.signal?.throwIfAborted();
  if ((settings.dllOverrides || []).some(rule => {
    const [names, order] = String(rule).split("=");
    return !["b", "builtin"].includes(order?.trim().toLowerCase()) && names.split(",").some(name => /^(?:\*|winevulkan)(?:\.dll)?$/i.test(name.trim()));
  })) return null;
  const sources = sceneLibraries(entry, settings);if (!sources.length) return null;
  support ||= require("./support-manager");vulkan ||= require("../../shared/vulkan/managed");
  const verification = verify ? "full" : "status", selections = {};
  for (const id of ["winevulkan-scene", "fidelityfx-api"]) selections[id] = support.apiManagers[id].resolvePayload(entry, context, { verification });
  const driverSelection = vulkan.sceneManager.resolveSelection(entry, context.settings, context.userDataDir, { verification });
  const required = Object.entries(selections).map(([id, selected]) => ({ id, selected, manager: support.apiManagers[id] }));
  required.push({ id: vulkan.sceneProjectId, selected: driverSelection, manager: vulkan.sceneManager });
  const requirements = required.filter(item => !item.selected.ready && item.selected.version).map(item => ({ managerId: item.id,
    version: item.selected.version, requiresDownload: true, installOptions: { sectionId: "default" },
    detail: "Installs matching Vulkan scene support. The selected Windows renderer and original game libraries are preserved." }));
  const result = { libraries: sources, sceneRequirements: demanded, packageReady: false, activationReady: false, requirements,
    reason: "The matched loaded Wine profile and actual Vulkan device handshake are pending." };
  if (required.some(item => !item.selected.ready || !item.selected.install)) return result;
  try {
    const drivers = require("../../shared/vulkan").installed(context, { managers: [], adapted: vulkan.sceneProvider, architecture: "x64" });
    const available = drivers.find(item => item.version === driverSelection.version);
    if (!available) return { ...result, requirements: [], reason: "The installed scene driver has no compatible x86_64 library." };
    const driver = vulkan.sceneProvider.resolve(available, context), wine = selections["winevulkan-scene"], ffx = selections["fidelityfx-api"];
    const modules = Object.fromEntries(Object.entries(wine.provider.libraries).map(([architecture, relative]) => {
      const file = wine.install.manifest.files.find(item => item.path === relative);
      return [architecture, { path: path.join(wine.install.payloadRoot, relative), sha256: file.sha256 }];
    }));
    const driverFile = driver.install.manifest.files.find(item => item.path === driver.descriptor.library);
    const sceneClosure = { profile: wine.provider.profile, runtimeProfile: wine.provider.runtimeProfile, modules,
      driver: { path: driver.library, sha256: driverFile.sha256 } };
    // This verifies the declared runtime/payload closure, not the loaded native
    // interface. Context BEGIN owns the marker/factory/real-device handshake.
    require("../runtime/graphics-loader").sceneSelection(install, sceneClosure);
    return { ...result, packageReady: true, sceneClosure, providerRoot: ffx.install.payloadRoot,
      libraries: sources.map(item => ({ ...item, proxySha256: ffx.provider.sha256, providerRoot: ffx.install.payloadRoot })),
      dependencies: required.map(item => ({ managerId: item.id, version: item.selected.version,
        sourcePath: item.selected.install.installDir })) };
  } catch (error) {
    if (context.signal?.aborted || isAbortError(error)) throw error;
    return { ...result, requirements: [], reason: String(error.message || error) };
  }
}
function requirements(entry, context, options = {}) {
  const camera = cameraRequirements(entry, context, options), runtimeId = context.runtimeId || entry?.runtimeId;
  if (runtimeId !== "crossover") return camera;
  const manager = options.manager || require("../runtime/manager"), selected = manager.resolveSelection(entry, context.settings, context.userDataDir, context.runtimeSettings);
  const scene = selected.ready && resolveScenePlan(entry, context, { install: selected.install, root: options.root });
  return [...camera, ...(scene?.requirements || [])];
}
module.exports = { FILES, adapter, payload, libraries, libraryAdapter, matchingSupport, resolvePlan, prepareGame, restoreGame, environment, rendererFile,
  requirements, sceneLibraries, sceneDemand, resolveScenePlan, restoreLibraries };
