const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const Sources = require("../sources");
const Detection = require("../detect"), Streamline = require("./streamline"), XeSS = require("./xess"), FidelityFX = require("./fidelityfx");
function libraryAdapter(library) {
  const name = path.basename(library?.relativePath || library?.sourcePath || "").toLowerCase();
  if (library?.adapter === "fidelityfx" || FidelityFX.backendOf(name)) return FidelityFX;
  return library?.adapter === "xess" || name === "libxess_dx11.dll" ? XeSS : Streamline;
}
const { systemVersionSync } = require("../../shared/runtime/bundled-native");
const Host = require("../../shared/runtime/host-capabilities");
const Requirements = require("../../shared/runtime/feature-requirements");
const { usedForApi } = require("../../shared/runtime/translator-roles");
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
    if (record.schema !== 1 || record.id !== "dxmt-camera1" || record.architecture !== "x86_64" || record.tableCount !== 146 ||
      Requirements.requirementSupport({ minimumMacOS: record.minimumMacOS }, { macOSVersion }).supported === false ||
      !/^[a-f0-9]{64}$/.test(record.base?.nativeSha256 || "") || !/^[a-f0-9]{64}$/.test(record.base?.thunkSha256 || "") ||
      FILES.some(file => !/^[a-f0-9]{64}$/.test(record.files?.[file]) || digest(path.join(directory, file), verify) !== record.files[file])) return null;
    const d3d12=record.temporalD3D12API===1&&/^[a-f0-9]{64}$/.test(record.files?.["x86_64-windows/d3d12.dll"]||"")&&digest(path.join(directory,"x86_64-windows/d3d12.dll"),verify)===record.files["x86_64-windows/d3d12.dll"];
    return { directory, temporalD3D12API:d3d12?1:0,id: record.id, tableCount: record.tableCount, base: record.base, identity: crypto.createHash("sha256").update(JSON.stringify(record)).digest("hex"), files: record.files };
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
  // CrossOver and Sikarugir share one support package, then fall back to the
  // DXMT libraries of an installed Sikarugir engine.
  const choices = [...(standalone.ready ? [{ install: standalone.install, managerId: support.id, baseRoot: standalone.install.baseRoot }] : []),
    ...(context.userDataDir ? wine.getState({ userDataDir: context.userDataDir }).installed.filter(row => row.ready !== false).map(install => ({ install, managerId: wine.id,
      baseRoot: path.join(install.supportRoot || install.templateRoot || path.join(install.installDir, "support"), "Frameworks/renderer/dxmt/wine") })) : [])];
  for (const choice of choices) {
    const dxmt = payload(root, choice.baseRoot, { verify, macOSVersion: host.macOSVersion });
    if (dxmt) return { dxmt, baseRoot: choice.baseRoot, dependency: { managerId: choice.managerId, version: choice.install.version,
      sourcePath: choice.install.installDir || choice.install.root || choice.baseRoot } };
  }
  return null;
}
function resolvePlan(entry, context = {}, { install, runtimeId = context.runtimeId || entry?.runtimeId || "crossover", settings = context.runtimeSettings || {}, host = {}, root, verify = false, allowDownload = false, automatic = false, translatorPlan = context.translatorPlan } = {}) {
  try {
    const d3d11=usedForApi(translatorPlan,"d3d11"),d3d12=usedForApi(translatorPlan,"d3d12");
    const translator=d3d11?.engine==="dxmt"?d3d11:d3d12?.engine==="dxmt"?d3d12:d3d11;
    const roles=[...(d3d11?.engine==="dxmt"?["d3d11"]:[]),...(d3d12?.engine==="dxmt"?["d3d12"]:[])];
    const d3dmetal = Sources.get(runtimeId)?.invocation === "crossover" && settings.dlss === true && translator?.engine !== "dxmt" &&
      (usedForApi(translatorPlan, "d3d12")?.engine || translator?.engine || settings.graphicsBackend) === "d3dmetal";
    if (!d3dmetal && Object.hasOwn(translatorPlan?.components || {}, "d3d11") && !translator) return null;
    if (Requirements.requirementSupport(Requirements.WINE_TEMPORAL, { ...Host.getHostCapabilities(), ...host }).supported === false ||
      !install || !d3dmetal && !["auto", "dxmt"].includes(translator?.engine || settings.graphicsBackend || "auto")) return null;
    if ((settings.dllOverrides || []).some(rule => {
      const [names, order] = String(rule).split("=");
      return order?.trim().toLowerCase() !== "b" && order?.trim().toLowerCase() !== "builtin" && names.split(",").some(name => /^(?:\*|d3d10core|d3d11|dxgi|winemetal|nvapi64|nvngx)(?:\.dll)?$/i.test(name.trim())||roles.includes("d3d12")&&/^d3d12(?:\.dll)?$/i.test(name.trim()));
    })) return null;
    const match = Detection.cachedWindowsExecutable(entry);if (!match) return null;
    const executable = settings.executable ? path.resolve(match.sourceRoot, settings.executable) : match.windowsExecutablePath;
    if (!Detection.inside(match.sourceRoot, executable) || Detection.readWindowsExecutable(executable)?.executableArchitecture !== "x86_64") return null;
    root ||= require("../../shared/reshade").runtimeRoot(context.app);
    const sources = libraries(match, executable).flatMap(sourcePath => {
      const selected = libraryAdapter({sourcePath}), adapter = selected === XeSS ? "xess" : "streamline", providerRoot = path.join(root, "temporal", adapter);
      // In-game XeSS translation is a compatibility path, independent of the
      // optional shared graph. Streamline replacement remains explicitly selected.
      if (automatic && selected !== XeSS || d3dmetal && selected !== Streamline) return [];
      const inspected = selected.inspect(sourcePath, providerRoot);
      return inspected.available ? [{sourcePath, relativePath: path.relative(match.sourceRoot, sourcePath), sourceSha256: inspected.sourceSha256, adapter, providerRoot}] : [];
    });
    const directNgx=settings.dlss===true&&translator?.engine==="dxmt";
    if (!sources.length&&!directNgx) return null;
    const hasProjection = sources.some(row => row.adapter === "streamline"), hasXeSS = sources.some(row => row.adapter === "xess");
    const inputs = { depth:true,motionVectors:true,jitter:true,exposure:true,cameraProjection: hasProjection, source: hasProjection && hasXeSS ? "streamline+xess" : hasXeSS ? "xess" : directNgx&&!sources.length?"ngx":"streamline",
      methods: [...(hasProjection ? ["fsr2", "fsr3"] : []), ...(hasXeSS||directNgx&&!sources.length ? ["metalfx"] : [])],
      routes: sources.map(row => ({source: row.adapter, depth:true,motionVectors:true,jitter:true,exposure:true,cameraProjection: row.adapter === "streamline", methods: row.adapter === "xess" ? ["metalfx"] : ["fsr2", "fsr3"]})) };
    if(d3dmetal){
      const helper=require("./d3dmetal-camera").helper(path.join(root,"temporal/streamline"));
      return helper ? {kind:"d3dmetal-camera",helper,sourceRoot:match.sourceRoot,libraries:sources,inputs} : null;
    }
    let baseRoot, selectedSupport;
    if (translator && translator.engine !== "dxmt") return null;
    // The source's own DXMT is the base of the camera adapter's libraries.
    baseRoot = Sources.get(runtimeId)?.dxmtBase?.(install, { translator, settings });
    if (!baseRoot) return null;
    if (translator?.engine === "dxmt") {
      baseRoot = require("../../shared/runtime/wine-layout").wineRoot(translator.root);
      const dxmt = payload(root, baseRoot, { verify, macOSVersion: host.macOSVersion });
      if (!dxmt) {
        context.cameraAdapterNotice = `The camera adapter does not match the selected ${require("../../shared/runtime/translator-description").label(translator)}.`;
        warnGraphics(context.logger, `[translators] ${context.cameraAdapterNotice}`);
        return null;
      }
      if(roles.length===1&&roles[0]==="d3d12"&&dxmt.temporalD3D12API!==1)return null;
      return { dxmt, dxmtRoles:roles.length?roles:["d3d11"],baseRoot, sourceRoot: match.sourceRoot, libraries: sources, inputs, dependency: translator.managerId ? { managerId: translator.managerId, version: translator.runtimeVersion, sourcePath: translator.root } : null };
    }
    const manager = require("./support-manager").forRuntime(runtimeId), explicit = settings.graphicsBridgeVersion && settings.graphicsBridgeVersion !== "auto" ||
      entry?.runtimeData?.[manager.id]?.version || context.settings?.runtimes?.[manager.id]?.defaultVersion;
    if (explicit || !payload(root, baseRoot, { verify, macOSVersion: host.macOSVersion })) {
      selectedSupport = matchingSupport({ ...context, runtimeSettings: settings }, root, { entry, runtimeId, verify, host });
      if (!selectedSupport) {
        const available = adapter(root, { verify, macOSVersion: host.macOSVersion }), { support: selectedManager, selected } = supportSelection(entry, { ...context, runtimeSettings: settings }, runtimeId, undefined, verify, available);
        const pin = selectedManager.core.catalog.find(row => row.version === selected.version);
        if (allowDownload && available && !pin && selected.discoveryRequired) return {
          inputs: { ...inputs, requiresDownload: true }, requiresDownload: true,
          download: { managerId: selectedManager.id, version: null, discoveryRequired: true } };
        if (allowDownload && pin && available && !(context.userDataDir && selectedManager.core.resolveInstalled({ userDataDir: context.userDataDir, version: pin.version, verification: verify ? "full" : "status" }))) return {
          inputs: { ...inputs, requiresDownload: true }, requiresDownload: true, download: { managerId: selectedManager.id, version: pin.version } };
        return null;
      }
      baseRoot = selectedSupport.baseRoot;
    }
    const dxmt = payload(root, baseRoot, { verify, macOSVersion: host.macOSVersion });if (!dxmt) return null;
    return { dxmt, dxmtRoles:roles.length?roles:["d3d11"],baseRoot, dependency: selectedSupport?.dependency, sourceRoot: match.sourceRoot, libraries: sources,
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
function environment(plan, dllRoot) { return plan?.dxmt ? { MACLAUNCHER_DXMT_BASE_LIBRARY: path.join(dllRoot, "x86_64-unix/maclauncher-dxmt-original.so") } : {}; }
function rendererFiles(plan){
  const roles=plan?.dxmtRoles;
  return [...FILES.filter(file=>!roles||roles.includes("d3d11")||!file.endsWith("/d3d11.dll")&&!file.endsWith("/dxgi.dll")),...(plan?.dxmt?.temporalD3D12API===1&&roles?.includes("d3d12")?["x86_64-windows/d3d12.dll"]:[])];
}
function rendererFile(plan, architecture, filename, fallback) {
  const relative = architecture + "/" + filename;
  if(!plan?.dxmt)return fallback;
  if(filename==="d3d12.dll")return architecture==="x86_64-windows"&&plan.dxmt.temporalD3D12API===1&&plan.dxmtRoles?.includes("d3d12")?path.join(plan.dxmt.directory,relative):fallback;
  return rendererFiles(plan).includes(relative) ? path.join(plan.dxmt.directory, relative) : fallback;
}
function cameraRequirements(entry, context, { manager, root } = {}) {
  const runtimeId = context.runtimeId || entry?.runtimeId;
  if (!Sources.get(runtimeId)) return [];
  const settings = require("../dlss").withTemporalSelection(context.runtimeSettings || {}, entry.effects, context.translatorPlan);
  const automatic = settings.dlss !== true;
  if (automatic) {
    const match = Detection.cachedWindowsExecutable(entry);
    const executable = match && (settings.executable ? path.resolve(match.sourceRoot, settings.executable) : match.windowsExecutablePath);
    if (!match || !Detection.inside(match.sourceRoot, executable) || !libraries(match, executable).some(file => libraryAdapter({sourcePath: file}) === XeSS)) return [];
  }
  manager ||= Sources.get(runtimeId).manager();
  const selected = manager.resolveSelection(entry, context.settings, context.userDataDir, settings);
  const plan = selected.ready && resolvePlan(entry, context, { install: selected.install, runtimeId, root, settings, automatic, allowDownload: true });
  return plan?.requiresDownload ? [{ ...plan.download, installOptions: { sectionId: "default" },
    detail: "Downloads matching DXMT support libraries for the game's temporal API. The selected Wine engine remains unchanged." }] : [];
}
// The game's FidelityFX API libraries beside its executable or in its common plugin folders.
function sceneLibraries(entry, settings = {}) {
  const match = Detection.cachedWindowsExecutable(entry);if (!match) return [];
  const executable = settings.executable ? path.resolve(match.sourceRoot, settings.executable) : match.windowsExecutablePath;
  if (!Detection.inside(match.sourceRoot, executable)) return [];
  const directories = new Set([path.dirname(executable), match.sourceRoot]);
  for (const directory of [...directories]) for (const child of ["plugins", "Plugins", "FidelityFX", "FSR"])
    directories.add(path.join(directory, child));
  const result = [], PE = require("./streamline/pe-exports");
  for (const directory of directories) for (const name of Object.values(require("./catalog").FIDELITYFX_PROFILE.libraries)) {
    const file = path.join(directory, name);
    try {
      if (!Detection.inside(fs.realpathSync(match.sourceRoot), fs.realpathSync(file)) || !FidelityFX.apiExports(PE.inspect(file))) continue;
      result.push({ adapter: "fidelityfx", backend: FidelityFX.backendOf(file), sourcePath: file, sourceSha256: digest(file), relativePath: path.relative(match.sourceRoot, file) });
    } catch {}
  }
  return result;
}
// Wine games present through the shared window adapter as x86_64 processes.
function sceneDemand(entry, context = {}, {root} = {}) {
  return require("../../shared/effects/scene-demand").sceneDemand(entry, context, {root, graphicsHost: "window", graphicsArchitecture: "x86_64"});
}
// FidelityFX upscale dispatches recorded as MacLauncher temporal frames: a
// Vulkan game's on a carrier-capable Vulkan driver, a Direct3D 12 game's
// through VKD3D-Proton's MetalFX command-list interface on that driver.
function resolveScenePlan(entry, context = {}, { settings = context.runtimeSettings || {}, verify = false,
  requested, root, support, translatorPlan = context.translatorPlan, hasCarrier } = {}) {
  // Pure demand precedes DLL inspection and package reads.
  if (requested === false) return null;
  const demanded = sceneDemand(entry, context, {root});
  if (!demanded.length) return null;
  context.signal?.throwIfAborted();
  const driver = require("./vulkan-dlss").carrierDriver(translatorPlan, hasCarrier);
  const sources = sceneLibraries(entry, settings).filter(item => item.backend === "vk" || usedForApi(translatorPlan, "d3d12")?.engine === "vkd3d-proton");
  if (!sources.length) return null;
  // Without a translator plan the driver is checked at launch. A carrier driver
  // that this Play downloads (wine-translators.js vulkanPending) forwards once installed.
  if (!driver && translatorPlan && !translatorPlan.vulkanPending) {
    context.graphicsBridgeFailure = { provider: "fidelityfx", reason: "FidelityFX frames reach graphics only on a Vulkan driver that forwards temporal frames." };
    return null;
  }
  support ||= require("./support-manager");
  const manager = support.apiManagers["fidelityfx-api"], selected = manager.resolvePayload(entry, context, { verification: verify ? "full" : "status" });
  const result = { libraries: sources, sceneRequirements: demanded, packageReady: false, driver: driver?.engine || null,
    requirements: !selected.ready && (selected.version || selected.discoveryRequired) ? [{ managerId: "fidelityfx-api", version: selected.version || null,
      ...(selected.discoveryRequired ? { discoveryRequired: true } : {}), requiresDownload: true, installOptions: { sectionId: "default" },
      detail: "Installs the FidelityFX API adapter. The game's own FidelityFX library is kept beside it." }] : [] };
  if (!selected.ready || !selected.install || !driver) return result;
  const payloadRoot = selected.install.payloadRoot, libraries = sources.filter(item => FidelityFX.inspect(item.sourcePath, payloadRoot).available);
  if (!libraries.length) return { ...result, reason: "The FidelityFX API adapter has no proxy for the game's libraries." };
  return { ...result, packageReady: true, providerRoot: payloadRoot,
    libraries: libraries.map(item => ({ ...item, proxySha256: FidelityFX.provider(payloadRoot).backends[item.backend].sha256, providerRoot: payloadRoot })),
    dependencies: [{ managerId: "fidelityfx-api", version: selected.version, sourcePath: selected.install.installDir }] };
}
function requirements(entry, context, options = {}) {
  const source = Sources.get(context.runtimeId || entry?.runtimeId);
  if (!source) return [];
  // The camera and scene plans of one Play share one version resolution.
  const manager = options.manager || source.manager();let selected;
  const once = { resolveSelection: (...args) => selected ||= manager.resolveSelection(...args) };
  const camera = cameraRequirements(entry, context, { ...options, manager: once });
  if (!sceneDemand(entry, context, { root: options.root }).length) return camera;
  const scene = once.resolveSelection(entry, context.settings, context.userDataDir, context.runtimeSettings).ready && resolveScenePlan(entry, context, { root: options.root });
  return [...camera, ...(scene?.requirements || [])];
}
module.exports = { FILES, rendererFiles,adapter, payload, libraries, libraryAdapter, matchingSupport, resolvePlan, prepareGame, restoreGame, environment, rendererFile,
  requirements, sceneLibraries, sceneDemand, resolveScenePlan, restoreLibraries };
