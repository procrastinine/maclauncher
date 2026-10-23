const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { versionAtLeast, systemVersionSync } = require("../../../shared/runtime/bundled-native");
const Closure = require("./closure");
const Hardware = require("./hardware");
const DLSS = require("../../dlss");
const Writable = require("../../../shared/writable-input");

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
function capabilitiesFor(install, support, host) {
  let metadata = install.graphicsMetadata || install.installationMetadata?.graphics;
  if (!metadata) {
    const file = path.join(support, "graphics.json");
    try { metadata = JSON.parse(Closure.boundedText(file, 4 * 1024 * 1024)); }
    catch { fail("The selected graphics libraries are incomplete. Reinstall this version."); }
  }
  const recorded = metadata.graphicsCapabilities || install.graphicsCapabilities || {};
  const current = host.macOSVersion || systemVersionSync(), floors = recorded.minimumMacOS || {};
  if (metadata.minimumBaseMacOS && !versionAtLeast(current, metadata.minimumBaseMacOS)) fail(`This graphics package requires macOS ${metadata.minimumBaseMacOS} or later.`);
  const capable = name => recorded[name] === true && versionAtLeast(current, floors[name] || "11.0.0");
  const engine = engineRoot(install), modern = fs.existsSync(path.join(engine, "lib", "wine", "x86_64-unix", "ntdll.so")) &&
    !fs.existsSync(path.join(engine, "lib", "wine", "x86_32on64-unix", "ntdll.so"));
  const appleSilicon = host.arch === "arm64";
  return { ...install.capabilities, wined3d: true, dxmt: modern && capable("dxmt"), dxvk: modern && capable("dxvk"),
    dxvk3: modern && capable("dxvk3") && appleSilicon && versionAtLeast(current, "26.0.0"),
    d9vk: modern && capable("d9vk") && appleSilicon && versionAtLeast(current, "26.0.0"),
    d3dmetal: modern && capable("d3dmetal") && appleSilicon, cncDdraw: recorded.cncDdraw === true,
    moltenvk: capable("moltenvk"), kosmickrisp: capable("kosmickrisp") && appleSilicon,
    automaticKosmicKrisp: capable("kosmickrisp") && appleSilicon && host.physicalAppleGPU === true,
    componentVersions: metadata.componentVersions || {}, minimumMacOS: floors };
}
function selectGraphics(settings, capabilities, executableArchitecture) {
  const backend = settings.graphicsBackend || "auto", requestedVulkan = settings.vulkanBackend || "auto";
  if (!GRAPHICS_BACKENDS.includes(backend)) fail("Unsupported Direct3D implementation.");
  if (!VULKAN_BACKENDS.includes(requestedVulkan)) fail("Unsupported Vulkan implementation.");
  if (backend !== "auto" && !capabilities[backend]) fail(`${backend === "d3dmetal" ? "D3DMetal" : backend.toUpperCase()} is unavailable with this engine and macOS version. Choose Automatic or WineD3D.`);
  if (backend === "d3dmetal" && executableArchitecture === "x86") fail("D3DMetal supports 64-bit Windows applications. Choose Automatic, DXMT or WineD3D for this game.");
  if (requestedVulkan !== "auto" && !capabilities[requestedVulkan]) fail(`${requestedVulkan === "kosmickrisp" ? "KosmicKrisp requires Apple Silicon and macOS 26 or later" : "MoltenVK is unavailable in this graphics package"}. Choose Automatic or another Vulkan implementation.`);
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
      const pe = header.readUInt32LE(60), machine = path.basename(path.dirname(destination)) === "i386-windows" ? 0x14c : 0x8664;
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
  await fs.promises.symlink(source, destination);
}
async function linkDirectory(source, destination, signal) {
  signal?.throwIfAborted();
  if (!(await fs.promises.stat(source)).isDirectory()) fail("The selected Wine engine is incomplete. Reinstall this version.");
  const current = await fs.promises.lstat(destination).catch(error => { if (error.code !== "ENOENT") throw error; return null; });
  if (current) {
    if (!current.isSymbolicLink() || await fs.promises.realpath(destination) !== await fs.promises.realpath(source)) fail("The private Wine files changed. Remove the game's runtime files and try again.");
    return;
  }
  await fs.promises.symlink(source, destination);
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
  await fs.promises.copyFile(source, destination, fs.constants.COPYFILE_FICLONE | fs.constants.COPYFILE_EXCL);
  await fs.promises.chmod(destination, sourceStat.mode & 0o777);
  signal?.throwIfAborted();
}
async function prepareLoaderView(engine, viewRoot, install, signal) {
  const wineRoot = path.join(viewRoot, "wine"), dllRoot = path.join(wineRoot, "lib", "wine");
  const bin = path.join(wineRoot, "bin"), unix = path.join(dllRoot, "x86_64-unix");
  for (const directory of [wineRoot, bin, path.join(wineRoot, "lib"), dllRoot,
    ...["i386-windows", "x86_64-windows", "x86_64-unix"].map(name => path.join(dllRoot, name))]) ownDirectory(directory);
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
  const unixLoader = path.join(engine, "lib", "wine", "x86_64-unix", "wine");
  if (fs.existsSync(unixLoader)) await cloneLoaderFile(unixLoader, path.join(unix, "wine"), signal);
  else await linkFile(executablePath, path.join(unix, "wine"), signal);
  for (const architecture of ["i386-windows", "x86_64-windows"]) {
    for (const name of ["ntdll.dll", "apisetschema.dll"]) {
      const source = path.join(engine, "lib", "wine", architecture, name);
      if (fs.existsSync(source)) await linkFile(source, path.join(dllRoot, architecture, name), signal);
      else if (architecture === "x86_64-windows") fail("The selected Wine engine is incomplete. Reinstall this version.");
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
async function registerPrefixLibraries(prefixPath, viewRoot, dllRoot, signal) {
  // Wine 11 requires builtin files to exist in the prefix after bootstrap.
  // Existing prefix DLLs remain authoritative; only links into our renderer
  // views are replaced or removed as the selected renderer changes.
  const names = [...new Set([...Object.values(CORE_DLLS).flat(), ...DLSS.DLLS])];
  const views = path.dirname(viewRoot);
  for (const [architecture, system] of [["x86_64-windows", "system32"], ["i386-windows", "syswow64"]]) {
    const directory = path.join(prefixPath, "drive_c", "windows", system);
    Writable.assertOwnDirectory(prefixPath, directory);
    for (const name of names) {
      signal?.throwIfAborted();
      const filename = name + ".dll", destination = path.join(directory, filename), source = path.join(dllRoot, architecture, filename);
      const current = await fs.promises.lstat(destination).catch(error => { if (error.code !== "ENOENT") throw error; return null; });
      if (current) {
        if (!current.isSymbolicLink()) continue;
        const linked = path.resolve(directory, await fs.promises.readlink(destination));
        if (!Closure.inside(views, linked) || !linked.endsWith(path.join("wine", "lib", "wine", architecture, filename))) continue;
        if (linked === source && fs.existsSync(source)) continue;
        await fs.promises.unlink(destination);
      }
      if (fs.existsSync(source)) await fs.promises.symlink(source, destination);
    }
  }
}
async function prepareGraphicsView({ install, settings = {}, prefixPath, viewRoot, host = {}, signal, executableArchitecture, cameraBridge } = {}) {
  signal?.throwIfAborted();
  const support = supportRoot(install), engine = engineRoot(install), hostInfo = { arch: process.arch, ...host };
  let capabilities = capabilitiesFor(install, support, hostInfo);
  const hardware = capabilities.kosmickrisp && (!settings.vulkanBackend || settings.vulkanBackend === "auto")
    ? await Hardware.graphicsHardware(hostInfo, { signal }) : { physicalAppleGPU: hostInfo.physicalAppleGPU === true, source: "not-required" };
  hostInfo.physicalAppleGPU = hardware.physicalAppleGPU;
  capabilities = capabilitiesFor(install, support, hostInfo);
  if (cameraBridge) capabilities.dxmt = true;
  const selection = selectGraphics(settings, capabilities, executableArchitecture);
  const rendererRoot = path.join(support, "Frameworks", "renderer");
  const dlss = DLSS.checkSelection(settings, { ...hostInfo, executableArchitecture,
    backend: selection.components.includes("dxmt") ? "dxmt" : selection.graphicsBackend === "auto" ? "wined3d" : selection.graphicsBackend,
    dxmt: settings.dlss === true && capabilities.dxmt && (Boolean(cameraBridge) || DLSS.hasLibraries(path.join(rendererRoot, "dxmt", "wine", "x86_64-windows"))),
    d3dmetal: settings.dlss === true && capabilities.d3dmetal && DLSS.hasLibraries(path.join(rendererRoot, "d3dmetal", "wine", "x86_64-windows")) });
  if (dlss.d3dmetal && !await DLSS.hasD3DMetalPathBridge(engine))
    fail("The selected Wine engine cannot expose MetalFX Temporal through D3DMetal's game integration. Choose DXMT, select a compatible newer Wine version, or disable MetalFX Temporal.");
  const destination = prospectiveRealPath(viewRoot || ".");
  if (Closure.inside(support, destination) || Closure.inside(engine, destination)) fail("Per-game graphics state must be outside the shared runtime.");
  ownDirectory(viewRoot);
  const frameworks = path.join(support, "Frameworks"), renderers = path.join(frameworks, "renderer");
  const loader = selection.components.length ? await prepareLoaderView(engine, viewRoot, install, signal) : {
    wineRoot: engine, dllRoot: path.join(viewRoot, "dlls"), executablePath: install.executablePath || path.join(engine, "bin", "wine"),
    serverPath: install.serverPath || path.join(engine, "bin", "wineserver") };
  const dllRoot = loader.dllRoot, dllOverrides = [], selectedUnix = [];
  ownDirectory(dllRoot);
  for (const architecture of ["i386-windows", "x86_64-windows", "x86_64-unix"]) ownDirectory(path.join(dllRoot, architecture));
  await clearUnusedRenderers(dllRoot, renderers, selection.components, signal);
  for (const name of selection.components) {
    const root = name === "dxmt" && cameraBridge ? cameraBridge.baseRoot : path.join(renderers, name, "wine"),
      modules = name === "dxmt" && dlss.dxmt ? [...CORE_DLLS[name], ...DLSS.DLLS] : CORE_DLLS[name];
    for (const architecture of ["i386-windows", "x86_64-windows"]) {
      for (const module of modules) {
        const source = require("../../temporal").rendererFile(name === "dxmt" ? cameraBridge : null, architecture, module + ".dll", path.join(root, architecture, module + ".dll"));
        if (fs.existsSync(source)) await linkFile(source, path.join(dllRoot, architecture, module + ".dll"), signal);
      }
    }
    const unix = path.join(root, "x86_64-unix");
    if (fs.existsSync(unix)) {
      selectedUnix.push(unix);
      for (const file of await fs.promises.readdir(unix)) if (/\.(?:so|dylib)$/.test(file)) await linkFile(require("../../temporal").rendererFile(name === "dxmt" ? cameraBridge : null,
        "x86_64-unix", file, path.join(unix, file)), path.join(dllRoot, "x86_64-unix", file), signal);
    }
    dllOverrides.push(modules.join(",") + "=b");
  }
  if (cameraBridge && selection.components.includes("dxmt") && dlss.dxmt)
    await linkFile(cameraBridge.dxmt.native, path.join(dllRoot, "x86_64-unix/maclauncher-dxmt-original.so"), signal);
  const gstreamer = path.join(frameworks, "GStreamer.framework", "Versions", "1.0"), gstLib = path.join(gstreamer, "lib");
  const external = selection.components.includes("d3dmetal") ? path.join(renderers, "d3dmetal", "external") : null;
  const libraryPaths = [path.join(dllRoot, "x86_64-unix"), ...selectedUnix, ...(external ? [external] : []), path.join(engine, "lib", "wine", "x86_64-unix"), frameworks,
    ...(fs.existsSync(gstLib) ? [gstLib] : [])];
  const env = { WINEDLLPATH: path.join(engine, "lib", "wine"), DYLD_LIBRARY_PATH: libraryPaths.join(path.delimiter), DYLD_FALLBACK_LIBRARY_PATH: libraryPaths.join(path.delimiter),
    DYLD_FRAMEWORK_PATH: [frameworks, ...(external ? [external] : [])].join(path.delimiter),
    GST_REGISTRY_1_0: path.join(viewRoot, "gstreamer-registry.bin") };
  Object.assign(env, DLSS.environment(dlss));
  if (selection.components.includes("dxmt") && dlss.dxmt) Object.assign(env, require("../../temporal").environment(cameraBridge, dllRoot));
  if (fs.existsSync(gstLib)) {
    env.GST_PLUGIN_SYSTEM_PATH_1_0 = path.join(gstLib, "gstreamer-1.0");
    env.GST_PLUGIN_PATH_1_0 = "";
    const scanner = path.join(gstreamer, "libexec", "gstreamer-1.0", "gst-plugin-scanner");
    if (fs.existsSync(scanner)) env.GST_PLUGIN_SCANNER_1_0 = scanner;
  }
  if (selection.vulkanBackend !== "auto") {
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
  signal?.throwIfAborted();
  return { ...selection, ...loader, env, dllOverrides,
    ...(path.isAbsolute(prefixPath || "") ? { applyPrefix: () => registerPrefixLibraries(prefixPath, viewRoot, dllRoot, signal) } : {}),
    capabilities, hardware, dlss, componentVersions: capabilities.componentVersions, viewRoot, prefixPath };
}

module.exports = { GRAPHICS_BACKENDS, VULKAN_BACKENDS, ...Closure, prepareGraphicsView,
  __test: { capabilitiesFor, selectGraphics, ownDirectory, CORE_DLLS } };
