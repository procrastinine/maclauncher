const fs = require("node:fs");
const { cloneOrCopy } = require("../../../shared/copy-file");
const path = require("node:path");
const crypto = require("node:crypto");
const { versionAtLeast, systemVersionSync } = require("../../../shared/runtime/bundled-native");
const Requirements = require("../../../shared/runtime/feature-requirements");
const Closure = require("./closure");
const Hardware = require("./hardware");
const DLSS = require("../../dlss");
const Writable = require("../../../shared/writable-input");
const { wineLayout } = require("../../../shared/runtime/wine-layout");

const GRAPHICS_BACKENDS = Object.freeze(["auto", "wined3d", "dxmt", "dxvk", "d3dmetal"]);
const VULKAN_BACKENDS = Object.freeze(["auto", "moltenvk", "kosmickrisp"]);
const CORE_DLLS = Object.freeze({ dxmt: ["d3d10core", "d3d11", "dxgi", "winemetal"],
  dxvk: ["d3d10core", "d3d11", "dxgi"], dxvk3: ["d3d8", "d3d9", "d3d10core", "d3d11", "dxgi"],
  d9vk: ["d3d8", "d3d9"], cnc_ddraw: ["ddraw"], d3dmetal: ["d3d11", "d3d12", "dxgi", "atidxx64", "nvapi64", "nvngx"] });
function fail(message) { throw new Error(`Sikarugir graphics: ${message}`); }
function supportRoot(install) {
  const value = install.templateRoot || install.supportRoot || install.runtimeLibraries ||
    (install.installDir && path.join(install.installDir, "support"));
  if (typeof value !== "string" || !path.isAbsolute(value)) fail("The selected engine has no installed graphics libraries. Reinstall this version.");
  return fs.realpathSync(value);
}
function engineRoot(install) {
  const root = install.engineRoot || install.wineRoot || (install.executablePath && path.dirname(path.dirname(install.executablePath)));
  if (!path.isAbsolute(root || "")) fail("The selected Wine engine is unavailable.");
  return fs.realpathSync(root);
}
function capabilitiesFor(install, support, host = {}) {
  let metadata = install.graphicsMetadata || install.installationMetadata?.graphics;
  if (!metadata) {
    const file = path.join(support, "graphics.json");
    try { metadata = JSON.parse(Closure.boundedText(file, 4 * 1024 * 1024)); }
    catch { fail("The selected graphics libraries are incomplete. Reinstall this version."); }
  }
  const recorded = metadata.graphicsCapabilities || install.graphicsCapabilities || {};
  const current = Object.hasOwn(host, "macOSVersion") ? host.macOSVersion : systemVersionSync(), floors = recorded.minimumMacOS || {};
  const actual = { platform: process.platform, ...host, macOSVersion: current };
  if (Requirements.requirementSupport({ minimumMacOS: metadata.minimumBaseMacOS }, actual).supported === false)
    fail(`This graphics package requires macOS ${metadata.minimumBaseMacOS} or later.`);
  const capable = (name, required = Requirements.TEMPLATE_RENDERERS[name] || {}) => {
    // An installed Template keeps its measured floor, including an earlier
    // compatible renderer. Static defaults describe an unmeasured closure.
    const measured = floors[name] || required.minimumMacOS;
    const apiFloor = Requirements.WINE_BACKENDS[name]?.minimumMacOS || required.minimumMacOS;
    const minimumMacOS = measured && apiFloor && versionAtLeast(apiFloor, measured) ? apiFloor : measured;
    return recorded[name] === true && Requirements.requirementSupport({ ...required, minimumMacOS }, actual).supported !== false;
  };
  const engine = engineRoot(install), modern = fs.existsSync(path.join(engine, "lib", "wine", wineLayout(install).unixName, "ntdll.so")) &&
    !fs.existsSync(path.join(engine, "lib", "wine", "x86_32on64-unix", "ntdll.so"));
  return { ...install.capabilities, wined3d: true, dxmt: modern && capable("dxmt"), dxvk: modern && capable("dxvk"),
    dxvk3: modern && capable("dxvk3", Requirements.WINE_MODERN_VULKAN),
    d9vk: modern && capable("d9vk", Requirements.WINE_MODERN_VULKAN),
    d3dmetal: modern && capable("d3dmetal"), cncDdraw: recorded.cncDdraw === true,
    moltenvk: capable("moltenvk"), kosmickrisp: capable("kosmickrisp"),
    automaticKosmicKrisp: capable("kosmickrisp") && host.physicalAppleGPU === true,
    componentVersions: metadata.componentVersions || {}, minimumMacOS: floors };
}
function selectGraphics(settings, capabilities, executableArchitecture) {
  const backend = settings.graphicsBackend || "auto", requestedVulkan = settings.vulkanBackend || "auto";
  if (!GRAPHICS_BACKENDS.includes(backend)) fail("Unsupported Direct3D implementation.");
  if (!VULKAN_BACKENDS.includes(requestedVulkan)) fail("Unsupported Vulkan implementation.");
  if (backend !== "auto" && !capabilities[backend]) fail(`${backend === "d3dmetal" ? "D3DMetal" : backend.toUpperCase()} is unavailable with this engine and macOS version. Choose Automatic or WineD3D.`);
  if (backend === "d3dmetal" && executableArchitecture === "x86") fail("D3DMetal supports 64-bit Windows applications. Choose Automatic, DXMT or WineD3D for this game.");
  if (requestedVulkan !== "auto" && !capabilities[requestedVulkan]) {
    const required = Requirements.TEMPLATE_RENDERERS.kosmickrisp.minimumMacOS;
    const measured = capabilities.minimumMacOS?.kosmickrisp;
    const floor = measured && versionAtLeast(measured, required) ? measured : required;
    fail(`${requestedVulkan === "kosmickrisp" ? `KosmicKrisp requires Apple Silicon and macOS ${floor.replace(/(?:\.0)+$/, "")} or later` : "MoltenVK is unavailable in this graphics package"}. Choose Automatic or another Vulkan implementation.`);
  }
  const vulkan = requestedVulkan === "auto" ? capabilities.automaticKosmicKrisp ? "kosmickrisp" : capabilities.moltenvk ? "moltenvk" : null : requestedVulkan;
  const components = [];
  if (backend === "auto") {
    if (capabilities.dxmt) components.push("dxmt");
    if (vulkan === "kosmickrisp" && capabilities.d9vk) components.push("d9vk");
  } else if (backend === "dxvk") {
    if (!vulkan) fail("DXVK requires an installed Vulkan implementation. Reinstall the graphics package.");
    components.push(vulkan === "kosmickrisp" && capabilities.dxvk3 ? "dxvk3" : "dxvk");
  } else if (backend !== "wined3d") components.push(backend);
  // Software DirectDraw stays on the Wine path unless this optional wrapper
  // is enabled. It is independent of the selected Direct3D implementation.
  if (settings.cncDdraw === true) {
    if (executableArchitecture !== "x86") fail("DirectDraw compatibility supports 32-bit Windows applications. Select a 32-bit executable or disable this option.");
    if (!capabilities.cncDdraw) fail("DirectDraw compatibility is unavailable in this graphics package. Reinstall the graphics package or disable this option.");
    components.push("cnc_ddraw");
  }
  return { graphicsBackend: backend, vulkanBackend: vulkan || "auto", components };
}
function ownDirectory(root) {
  if (!path.isAbsolute(root || "")) fail("A private runtime directory is required.");
  // macOS itself aliases /var and /tmp. The caller owns and validates the game
  // directory; reject links at each directory created beneath that boundary.
  if (fs.existsSync(root) && fs.lstatSync(root).isSymbolicLink()) fail("The private runtime directory must not use symbolic links.");
  fs.mkdirSync(root, { recursive: true });
  if (!fs.lstatSync(root).isDirectory()) fail("The private runtime directory is unavailable.");
}
function prospectiveRealPath(file) {
  const missing = []; let current = path.resolve(file);
  while (!fs.existsSync(current)) { missing.unshift(path.basename(current)); current = path.dirname(current); }
  return path.join(fs.realpathSync(current), ...missing);
}
async function linkFile(source, destination, signal) {
  signal?.throwIfAborted();
  const stat = await fs.promises.stat(source);
  if (!stat.isFile()) fail("A selected renderer library is unavailable.");
  if (source.endsWith(".dll")) {
    const handle = await fs.promises.open(source, "r");
    try {
      const header = Buffer.alloc(128), coff = Buffer.alloc(24);
      if ((await handle.read(header, 0, header.length, 0)).bytesRead !== header.length || header.readUInt16LE(0) !== 0x5a4d ||
        !header.subarray(64).includes(Buffer.from("Wine builtin DLL\0"))) fail("The selected renderer requires a supported Wine builtin DLL package.");
      const pe = header.readUInt32LE(60), machine = require("../../../shared/runtime/binary-compatibility").requiredMachine(path.basename(path.dirname(destination)).replace(/-windows$/, "")) || 0x8664;
      if (pe < 80 || pe > stat.size - coff.length || (await handle.read(coff, 0, coff.length, pe)).bytesRead !== coff.length ||
        coff.readUInt32LE(0) !== 0x4550 || coff.readUInt16LE(4) !== machine || !(coff.readUInt16LE(22) & 0x2000))
        fail("A selected renderer DLL does not match its Windows architecture.");
    } finally { await handle.close(); }
  }
  const current = await fs.promises.lstat(destination).catch(error => { if (error.code !== "ENOENT") throw error; return null; });
  if (current) {
    if (!current.isSymbolicLink() || await fs.promises.realpath(destination) !== await fs.promises.realpath(source)) fail("The private renderer selection changed. Remove the game's runtime files and try again.");
    return;
  }
  try { await fs.promises.symlink(source, destination); }
  catch (race) { if (race.code !== 'EEXIST') throw race; return linkFile(source, destination, signal); }
}
async function linkDirectory(source, destination, signal) {
  signal?.throwIfAborted();
  if (!(await fs.promises.stat(source)).isDirectory()) fail("The selected Wine engine is incomplete. Reinstall this version.");
  const current = await fs.promises.lstat(destination).catch(error => { if (error.code !== "ENOENT") throw error; return null; });
  if (current) {
    if (!current.isSymbolicLink() || await fs.promises.realpath(destination) !== await fs.promises.realpath(source)) fail("The private Wine files changed. Remove the game's runtime files and try again.");
    return;
  }
  try { await fs.promises.symlink(source, destination); }
  catch (race) { if (race.code !== 'EEXIST') throw race; return linkDirectory(source, destination, signal); }
}
async function cloneLoaderFile(source, destination, signal) {
  signal?.throwIfAborted();
  const sourceStat = await fs.promises.stat(source);
  if (!sourceStat.isFile() || sourceStat.size > 16 * 1024 * 1024) fail("The selected Wine loader is unavailable. Reinstall this version.");
  const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
  const current = await fs.promises.lstat(destination).catch(error => { if (error.code !== "ENOENT") throw error; return null; });
  if (current) {
    if (!current.isFile() || current.isSymbolicLink() || current.size !== sourceStat.size ||
      digest(await fs.promises.readFile(source)) !== digest(await fs.promises.readFile(destination))) {
      fail("The private Wine loader changed. Remove the game's runtime files and try again.");
    }
    return;
  }
  try { await cloneOrCopy(source, destination, { signal, exclusive: true }); }
  catch (race) { if (race.code !== 'EEXIST') throw race; return cloneLoaderFile(source, destination, signal); }
  await fs.promises.chmod(destination, sourceStat.mode & 0o777);
  signal?.throwIfAborted();
}
async function prepareLoaderView(engine, viewRoot, install, signal) {
  const wineRoot = path.join(viewRoot, "wine"), dllRoot = path.join(wineRoot, "lib", "wine");
  const layout = wineLayout(install), bin = path.join(wineRoot, "bin"), unix = path.join(dllRoot, layout.unixName);
  for (const directory of [wineRoot, bin, path.join(wineRoot, "lib"), dllRoot,
    ...[...layout.windows, layout.unixName].map(name => path.join(dllRoot, name))]) ownDirectory(directory);
  // Wine derives its primary builtin directory from the real path of ntdll.so.
  // A separate loader and ntdll copy give selected renderer links priority,
  // while WINEDLLPATH supplies the unchanged shared engine as a fallback.
  const executablePath = path.join(bin, "wine"), serverPath = path.join(bin, "wineserver");
  await cloneLoaderFile(install.executablePath || path.join(engine, "bin", "wine"), executablePath, signal);
  await cloneLoaderFile(path.join(engine, "lib", "wine", "x86_64-unix", "ntdll.so"), path.join(unix, "ntdll.so"), signal);
  await linkFile(install.serverPath || path.join(engine, "bin", "wineserver"), serverPath, signal);
  // Newer engines re-exec a separate loader with the address-space layout
  // required by Windows. Reusing bin/wine here can retain its 4 GB PAGEZERO
  // mapping and prevent Wine from reserving the shared user-data address.
  const unixLoader = path.join(engine, "lib", "wine", layout.unixName, "wine");
  if (fs.existsSync(unixLoader)) await cloneLoaderFile(unixLoader, path.join(unix, "wine"), signal);
  else await linkFile(executablePath, path.join(unix, "wine"), signal);
  for (const architecture of layout.windows) {
    for (const name of ["ntdll.dll", "apisetschema.dll"]) {
      const source = path.join(engine, "lib", "wine", architecture, name);
      if (fs.existsSync(source)) await linkFile(source, path.join(dllRoot, architecture, name), signal);
      else if (architecture === layout.primaryWindows) fail("The selected Wine engine is incomplete. Reinstall this version.");
    }
  }
  await linkDirectory(path.join(engine, "share"), path.join(wineRoot, "share"), signal);
  return { wineRoot, dllRoot, executablePath, serverPath };
}
async function clearUnusedRenderers(dllRoot, renderers, components, signal) {
  const selected = new Set(components.flatMap(name => CORE_DLLS[name].map(module => module + ".dll")));
  const known = new Set(Object.values(CORE_DLLS).flat().map(module => module + ".dll"));
  for (const architecture of ["i386-windows", "x86_64-windows", "x86_64-unix"]) {
    for (const name of await fs.promises.readdir(path.join(dllRoot, architecture))) {
      signal?.throwIfAborted();
      if (architecture !== "x86_64-unix" && (!known.has(name) || selected.has(name))) continue;
      if (architecture === "x86_64-unix" && !/\.(?:so|dylib)$/.test(name)) continue;
      const file = path.join(dllRoot, architecture, name), stat = await fs.promises.lstat(file);
      if (!stat.isSymbolicLink()) continue;
      const target = await fs.promises.realpath(file);
      if (!Closure.inside(renderers, target)) continue;
      const component = path.relative(renderers, target).split(path.sep)[0];
      if (!components.includes(component)) await fs.promises.unlink(file);
    }
  }
}
async function registerPrefixLibraries(prefixPath, viewRoot, dllRoot, signal, layout = {}) {
  // Wine 11 requires builtin files to exist in the prefix after bootstrap.
  // Existing prefix DLLs remain authoritative; only links into our renderer
  // views are replaced or removed as the selected renderer changes.

  const views = path.dirname(viewRoot);
  for (const architecture of layout.windows || fs.readdirSync(dllRoot).filter(name => name.endsWith("-windows"))) {
    const system = architecture === "i386-windows" ? "syswow64" : "system32";
    const directory = path.join(prefixPath, "drive_c", "windows", system);
    Writable.assertOwnDirectory(prefixPath, directory);
    const names = [...new Set([...(fs.existsSync(path.join(dllRoot, architecture)) ? fs.readdirSync(path.join(dllRoot, architecture)) : []), ...fs.readdirSync(directory)])].filter(name => name.endsWith(".dll"));
    for (const filename of names) {
      signal?.throwIfAborted();
      const destination = path.join(directory, filename), source = path.join(dllRoot, architecture, filename);
      const current = await fs.promises.lstat(destination).catch(error => { if (error.code !== "ENOENT") throw error; return null; });
      if (current) {
        if (!current.isSymbolicLink()) continue;
        const linked = path.resolve(directory, await fs.promises.readlink(destination));
        if ((!Closure.inside(views, linked) && !Closure.inside(path.join(path.dirname(path.dirname(prefixPath)), "runtime-view"), linked)) || !linked.endsWith(path.join("wine", "lib", "wine", architecture, filename))) continue;
        if (linked === source && fs.existsSync(source)) continue;
        await fs.promises.unlink(destination);
      }
      if (fs.existsSync(source)) await fs.promises.symlink(source, destination);
    }
  }
}
async function prepareGraphicsView({ install, settings = {}, prefixPath, viewRoot, host = {}, signal, executableArchitecture, cameraBridge, helperLibraries = [], translatorPlan, translatorView, environment, context, userDataDir } = {}) {
  signal?.throwIfAborted();
  if (!translatorPlan && context) {
    const shared = require('../../../shared/runtime/wine-translators');
    if (environment) context.wineEnvironment = environment;
    context.runtimeSettings ||= settings;
    translatorPlan = context.translatorPlan?.layout?.root === wineLayout(install).root ? context.translatorPlan :
      await shared.resolve(install, 'sikarugir', context, { executableArchitecture, host });
    settings = shared.settingsForPlan(settings, translatorPlan);
  }
  if (translatorPlan && !translatorView) translatorView = await require('../../../shared/runtime/translator-files').prepareTranslatorFiles(translatorPlan,
    { userDataDir: userDataDir || context?.userDataDir, layout: translatorPlan.layout, signal });
  const support = supportRoot(install), engine = engineRoot(install), hostInfo = {
    hardwareArch: require("../../../shared/runtime/host-capabilities").getHostCapabilities().hardwareArch, ...host };
  const layout = translatorPlan?.layout || wineLayout(install);
  let capabilities = translatorPlan ? { ...install.capabilities, wined3d: true, componentVersions: {} } : capabilitiesFor(install, support, hostInfo);
  const hardware = capabilities.kosmickrisp && (!settings.vulkanBackend || settings.vulkanBackend === "auto")
    ? await Hardware.graphicsHardware(hostInfo, { signal }) : { physicalAppleGPU: hostInfo.physicalAppleGPU === true, source: "not-required" };
  hostInfo.physicalAppleGPU = hardware.physicalAppleGPU;
  if (!translatorPlan) capabilities = capabilitiesFor(install, support, hostInfo);
  if (cameraBridge) capabilities.dxmt = true;
  const selection = translatorPlan ? { graphicsBackend: translatorPlan.apiMode ? 'wined3d' : translatorPlan.components["d3d-renderer"].used?.engine || "auto",
    vulkanBackend: translatorPlan.components["vulkan-driver"].used?.engine || "auto", components: [] } : selectGraphics(settings, capabilities, executableArchitecture);
  const rendererRoot = path.join(support, "Frameworks", "renderer");
  const dlss = DLSS.checkSelection(settings, { ...hostInfo, executableArchitecture, translatorPlan,
    backend: selection.components.includes("dxmt") ? "dxmt" : selection.graphicsBackend === "auto" ? "wined3d" : selection.graphicsBackend,
    dxmt: settings.dlss === true && (translatorPlan ? Boolean(cameraBridge) || DLSS.hasPlanLibraries(translatorPlan, "dxmt") : capabilities.dxmt && (Boolean(cameraBridge) || DLSS.hasLibraries(path.join(rendererRoot, "dxmt", "wine", layout.primaryWindows)))),
    d3dmetal: settings.dlss === true && (translatorPlan ? DLSS.hasPlanLibraries(translatorPlan, "d3dmetal") : capabilities.d3dmetal && DLSS.hasLibraries(path.join(rendererRoot, "d3dmetal", "wine", layout.primaryWindows))) });
  if (dlss.d3dmetal && !await DLSS.hasD3DMetalPathBridge(engine))
    fail("The selected Wine engine cannot expose MetalFX Temporal through D3DMetal's game integration. Choose DXMT, select a compatible newer Wine version, or disable MetalFX Temporal.");
  const destination = prospectiveRealPath(viewRoot || ".");
  if (Closure.inside(support, destination) || Closure.inside(engine, destination)) fail("Per-game graphics state must be outside the shared runtime.");
  ownDirectory(viewRoot);
  const frameworks = path.join(support, "Frameworks"), renderers = path.join(frameworks, "renderer");
  if (!Array.isArray(helperLibraries) || helperLibraries.length > 8) fail("The GPU helper declaration is invalid.");
  const helpers = [], helperNames = new Set();
  for (const item of helperLibraries) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(item?.name || "") || helperNames.has(item.name) ||
        ["wine", "wineserver", "ntdll", "apisetschema", ...Object.values(CORE_DLLS).flat()].includes(item.name))
      fail("The GPU helper name is invalid.");
    const windows = fs.realpathSync(item.windows), unix = fs.realpathSync(item.unix);
    if (!fs.statSync(windows).isFile() || !fs.statSync(unix).isFile() ||
        path.basename(windows) !== item.name + ".dll" || path.basename(unix) !== item.name + ".so")
      fail("The GPU helper pair is unavailable.");
    const image = require("../../../shared/runtime/macho-load-commands").readMachOLoadCommands(unix, { architecture: layout.architecture, signal });
    if (!image.slices.some(slice => slice.architecture === layout.architecture && slice.platform === 1)) fail("The GPU helper requires an Intel macOS library.");
    helperNames.add(item.name); helpers.push({ name: item.name, windows, unix });
  }
  const loader = selection.components.length || helpers.length || translatorView && Object.keys(translatorView.links).length ? await prepareLoaderView(engine, viewRoot, install, signal) : {
    wineRoot: engine, dllRoot: path.join(viewRoot, "dlls"), executablePath: install.executablePath || path.join(engine, "bin", "wine"),
    serverPath: install.serverPath || path.join(engine, "bin", "wineserver") };
  const dllRoot = loader.dllRoot, dllOverrides = [], selectedUnix = [];
  ownDirectory(dllRoot);
  for (const architecture of [...layout.windows, layout.unixName]) ownDirectory(path.join(dllRoot, architecture));
  if (!translatorPlan) await clearUnusedRenderers(dllRoot, renderers, selection.components, signal);
  if (translatorView) {
    for (const [relative, original] of Object.entries(translatorView.links)) {
      const source = cameraBridge ? require("../../temporal").rendererFile(cameraBridge, path.basename(path.dirname(relative)), path.basename(relative), original) : original;
      await linkFile(source, path.join(loader.wineRoot, relative), signal);
    }
    dllOverrides.push(...translatorView.dllOverrides);
  }
  for (const helper of helpers) {
    await linkFile(helper.windows, path.join(dllRoot, layout.primaryWindows, helper.name + ".dll"), signal);
    await linkFile(helper.unix, path.join(dllRoot, layout.unixName, helper.name + ".so"), signal);
    dllOverrides.push(helper.name + "=b");
  }
  for (const name of selection.components) {
    const root = name === "dxmt" && cameraBridge ? cameraBridge.baseRoot : path.join(renderers, name, "wine"),
      modules = name === "dxmt" && dlss.dxmt ? [...CORE_DLLS[name], ...DLSS.DLLS] : CORE_DLLS[name];
    for (const architecture of ["i386-windows", layout.primaryWindows]) {
      for (const module of modules) {
        const source = require("../../temporal").rendererFile(name === "dxmt" ? cameraBridge : null, architecture, module + ".dll", path.join(root, architecture, module + ".dll"));
        if (fs.existsSync(source)) await linkFile(source, path.join(dllRoot, architecture, module + ".dll"), signal);
      }
    }
    const unix = path.join(root, layout.unixName);
    if (fs.existsSync(unix)) {
      selectedUnix.push(unix);
      for (const file of await fs.promises.readdir(unix)) if (/\.(?:so|dylib)$/.test(file)) await linkFile(require("../../temporal").rendererFile(name === "dxmt" ? cameraBridge : null,
        layout.unixName, file, path.join(unix, file)), path.join(dllRoot, layout.unixName, file), signal);
    }
    dllOverrides.push(modules.join(",") + "=b");
  }
  if (cameraBridge && selection.components.includes("dxmt") && dlss.dxmt)
    await linkFile(cameraBridge.dxmt.native, path.join(dllRoot, "x86_64-unix/maclauncher-dxmt-original.so"), signal);
  const gstreamer = Closure.gstreamerPaths(support), gstLib = gstreamer.lib;
  const external = selection.components.includes("d3dmetal") ? path.join(renderers, "d3dmetal", "external") : null;
  const libraryPaths = [path.join(dllRoot, layout.unixName), ...selectedUnix, ...(external ? [external] : []), path.join(engine, "lib", "wine", layout.unixName), frameworks,
    ...(fs.existsSync(gstLib) ? [gstLib] : [])];
  const env = { WINEDLLPATH: path.join(engine, "lib", "wine"), DYLD_LIBRARY_PATH: libraryPaths.join(path.delimiter), DYLD_FALLBACK_LIBRARY_PATH: libraryPaths.join(path.delimiter),
    DYLD_FRAMEWORK_PATH: [frameworks, ...(external ? [external] : [])].join(path.delimiter),
    GST_REGISTRY_1_0: path.join(viewRoot, "gstreamer-registry.bin") };
  Object.assign(env, DLSS.environment(dlss));
  if (selection.components.includes("dxmt") && dlss.dxmt) Object.assign(env, require("../../temporal").environment(cameraBridge, dllRoot));
  if (fs.existsSync(gstLib)) {
    env.GST_PLUGIN_SYSTEM_PATH_1_0 = gstreamer.plugins;
    env.GST_PLUGIN_PATH_1_0 = "";
    const scanner = gstreamer.scanner;
    if (fs.existsSync(scanner)) env.GST_PLUGIN_SCANNER_1_0 = scanner;
  }
  if (!translatorPlan && selection.vulkanBackend !== "auto") {
    const icd = path.join(viewRoot, "vulkan-icd.json"), sourceIcd = path.join(support, Closure.RELATIVE_PATHS.vulkan,
      selection.vulkanBackend === "kosmickrisp" ? "kosmickrisp_mesa_icd.json" : "MoltenVK_icd.json");
    const descriptor = JSON.parse(Closure.boundedText(sourceIcd));
    if (!descriptor.ICD || typeof descriptor.ICD.library_path !== "string") fail("The Vulkan driver description is invalid.");
    const native = path.resolve(path.dirname(sourceIcd), descriptor.ICD.library_path);
    if (!Closure.inside(frameworks, fs.realpathSync(native))) fail("The Vulkan driver escapes its graphics package.");
    // The private manifest selects exactly one driver, without rewriting the
    // immutable upstream manifest or depending on a machine-wide Vulkan SDK.
    descriptor.ICD.library_path = native;
    // Windows applications do not opt into macOS portability enumeration.
    // Wine forwards their instance flags, so allow its selected MoltenVK driver
    // to be discovered without that opt-in. Driver features stay unchanged.
    if (selection.vulkanBackend === "moltenvk") descriptor.ICD.is_portability_driver = false;
    const text = JSON.stringify(descriptor, null, 2) + "\n";
    if (fs.existsSync(icd) && fs.lstatSync(icd).isSymbolicLink()) fail("The private Vulkan driver description must be a regular file.");
    if (!fs.existsSync(icd) || fs.readFileSync(icd, "utf8") !== text) await fs.promises.writeFile(icd, text);
    env.VK_DRIVER_FILES = icd; env.VK_ICD_FILENAMES = icd;
    env.MVK_CONFIG_LOG_LEVEL = "0";
  }
  if (translatorView) {
    Object.assign(env, translatorView.env);
    env.DYLD_LIBRARY_PATH = [path.join(dllRoot, layout.unixName), ...translatorView.libraryPaths, env.DYLD_LIBRARY_PATH].filter(Boolean).join(path.delimiter);
    env.DYLD_FRAMEWORK_PATH = [...translatorView.frameworkPaths, env.DYLD_FRAMEWORK_PATH].filter(Boolean).join(path.delimiter);
    if (Object.keys(translatorView.links).some(name => name.endsWith(".dll"))) env.WINEDLLPATH = [...layout.windows.map(name => path.join(dllRoot, name)), dllRoot, layout.dllRoot].join(path.delimiter);
  }
  signal?.throwIfAborted();
  const writesBuiltinPrefix = !environment || Object.values(translatorPlan?.components || {}).some(row => row.used && !row.inherited && row.used.files.some(file => file.format === 'pe' && file.form === 'builtin'));
  return { ...selection, ...loader, env, dllOverrides, translatorPlan,
    ...(path.isAbsolute(prefixPath || "") && writesBuiltinPrefix ? { applyPrefix: () => registerPrefixLibraries(prefixPath, viewRoot, dllRoot, signal, layout) } : {}),
    capabilities, hardware, dlss, componentVersions: capabilities.componentVersions, viewRoot, prefixPath };
}

module.exports = { GRAPHICS_BACKENDS, VULKAN_BACKENDS, ...Closure, prepareGraphicsView, capabilitiesFor,
  __test: { capabilitiesFor, selectGraphics, ownDirectory, CORE_DLLS } };
