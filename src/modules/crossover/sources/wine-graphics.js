const fs = require("node:fs");
const { cloneOrCopy } = require("../../shared/copy-file");
const path = require("node:path");
const crypto = require("node:crypto");
const { versionAtLeast, systemVersionSync } = require("../../shared/runtime/bundled-native");
const Requirements = require("../../shared/runtime/feature-requirements");
const Closure = require("../sikarugir/runtime/template-closure");
const Hardware = require("../../shared/runtime/graphics-hardware");
const DLSS = require("../dlss");
const Writable = require("../../shared/writable-input");
const { wineLayout } = require("../../shared/runtime/wine-layout");

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
  const capable = (name, required = Requirements.TEMPLATE_RENDERERS[name] || Requirements.WINE_BACKENDS[name] || {}) => {
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
      const pe = header.readUInt32LE(60), machine = require("../../shared/runtime/binary-compatibility").requiredMachine(path.basename(path.dirname(destination)).replace(/-windows$/, "")) || 0x8664;
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
// The loader's embedded application properties (__TEXT,__info_plist) from a
// thin 64-bit or universal Intel Mach-O image.
function embeddedInfo(bytes) {
  const thin = offset => {
    if (offset + 32 > bytes.length || bytes.readUInt32LE(offset) !== 0xfeedfacf) return null;
    const count = bytes.readUInt32LE(offset + 16), end = offset + 32 + bytes.readUInt32LE(offset + 20);
    if (count > 4096 || end > bytes.length) return null;
    const name = at => bytes.subarray(at, at + 16).toString("latin1").split("\0")[0];
    for (let command = offset + 32, index = 0; index < count && command + 8 <= end; index++) {
      const type = bytes.readUInt32LE(command), size = bytes.readUInt32LE(command + 4);
      if (size < 8 || command + size > end) return null;
      if (type === 0x19 && size >= 72) for (let section = 0, sections = bytes.readUInt32LE(command + 64); section < sections && 72 + (section + 1) * 80 <= size; section++) {
        const at = command + 72 + section * 80;
        if (name(at) !== "__info_plist" || name(at + 16) !== "__TEXT") continue;
        const length = Number(bytes.readBigUInt64LE(at + 40)), start = offset + bytes.readUInt32LE(at + 48);
        return length > 0 && length <= 65536 && start + length <= bytes.length ? bytes.subarray(start, start + length).toString("utf8").replace(/\0+$/, "") : null;
      }
      command += size;
    }
    return null;
  };
  if (bytes.length >= 8 && bytes.readUInt32BE(0) === 0xcafebabe) {
    for (let index = 0, count = Math.min(bytes.readUInt32BE(4), 16); index < count; index++) {
      const at = 8 + index * 20;
      if (at + 20 <= bytes.length && bytes.readUInt32BE(at) === 0x01000007) return thin(bytes.readUInt32BE(at + 8));
    }
    return null;
  }
  return thin(0);
}
// macOS turns on Game Mode for a full-screen application in the games
// category. The application properties are the loader's own, with the bundle's
// executable name, a MacLauncher identifier, that category and the text that
// macOS shows when it asks for local network access for the bundle.
const GAME_BUNDLE = "MacLauncher Game.app";
const LOCAL_NETWORK_USE = "Windows games started by MacLauncher use the local network to find and join games, players and devices nearby.";
// Views of an earlier layout are never reused; a new layout gets new paths.
const VIEW_LAYOUT = 4;
function gameBundleInfo(embedded) {
  const value = (key, text) => `    <key>${key}</key>\n    <string>${text}</string>\n`;
  let text = /^\s*<\?xml[\s\S]*<dict>[\s\S]*<\/dict>\s*<\/plist>\s*$/.test(embedded || "") ? embedded.trim() + "\n" :
    '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    '<plist version="1.0">\n<dict>\n' + value("CFBundleName", "MacLauncher Game") + value("CFBundlePackageType", "APPL") + '</dict>\n</plist>\n';
  for (const [key, setting] of [["CFBundleExecutable", "wine"], ["CFBundleIdentifier", "com.maclauncher.wine-game"], ["LSApplicationCategoryType", "public.app-category.games"],
    ["NSLocalNetworkUsageDescription", LOCAL_NETWORK_USE]]) {
    const pattern = new RegExp(`(<key>${key}</key>\\s*<string>)[^<]*(</string>)`);
    text = pattern.test(text) ? text.replace(pattern, `$1${setting}$2`) : text.replace(/<\/dict>\s*<\/plist>\s*$/, value(key, setting) + "</dict>\n</plist>\n");
  }
  return text;
}
// macOS associates a process with a bundle only when the process starts from
// the bundle's own Contents/MacOS path; a symbolic or hard link elsewhere
// leaves it unbundled. Wine starts each Windows program from "wine" beside the
// real path of ntdll.so. With a separate loader, the bundle therefore holds
// real copies of the loader and ntdll.so, and the view's names for them lead
// into the bundle. From Contents/MacOS, links give Wine its builtin folders,
// the files beside ntdll.so, and the bin and share folders it derives two
// levels up. A single-file loader starts the game itself from the bundle and
// keeps the view's ntdll.so.
async function prepareGameBundle({ loader, engine, wineRoot, dllRoot, layout, separate, signal }) {
  const bundle = path.join(wineRoot, GAME_BUNDLE), contents = path.join(bundle, "Contents"), macos = path.join(contents, "MacOS");
  const unix = path.join(dllRoot, layout.unixName), engineUnix = path.join(engine, "lib", "wine", layout.unixName);
  for (const directory of [bundle, contents, macos]) ownDirectory(directory);
  const executable = path.join(macos, "wine");
  await cloneLoaderFile(loader, executable, signal);
  if (separate) {
    await cloneLoaderFile(path.join(engineUnix, "ntdll.so"), path.join(macos, "ntdll.so"), signal);
    for (const name of [...layout.windows, layout.unixName]) await linkDirectory(path.join(dllRoot, name), path.join(macos, name), signal);
    for (const entry of await fs.promises.readdir(engineUnix, { withFileTypes: true }))
      if (entry.isFile() && entry.name.endsWith(".so") && entry.name !== "ntdll.so") await linkFile(path.join(engineUnix, entry.name), path.join(macos, entry.name), signal);
    for (const name of ["bin", "share"]) await linkDirectory(path.join(wineRoot, name), path.join(bundle, name), signal);
    await keepBundleLoader(executable, path.join(macos, "ntdll.so"));
  } else {
    await linkFile(path.join(unix, "ntdll.so"), path.join(macos, "ntdll.so"), signal);
    await linkDirectory(path.join(wineRoot, "lib"), path.join(contents, "lib"), signal);
  }
  const info = path.join(contents, "Info.plist"), text = gameBundleInfo(embeddedInfo(await fs.promises.readFile(loader)));
  if (fs.existsSync(info) && fs.lstatSync(info).isSymbolicLink()) fail("The private Wine application properties must be a regular file.");
  if (!fs.existsSync(info) || fs.readFileSync(info, "utf8") !== text) Writable.atomicWrite(info, text, { root: wineRoot });
  return executable;
}
// CrossOver's Wine, which WineCX carries, starts each Windows program from a
// hard link named after the program in the user's temporary folder, in a
// folder named winetemp-<inode>-<size>-<seconds>-<nanoseconds> after the
// loader's file. macOS associates that link with no bundle. A file in place
// of the loader's folder leaves Wine without the link, so it starts the
// program from the bundle; the process still carries the program's name. A
// folder that Wine made earlier for the same loader holds only links to it,
// and is replaced. Anything else there is left alone.
const PROGRAM_LINKS = Buffer.from("/winetemp-%llu-%llu-%lu-%lu/");
let userTemporary;
async function userTemporaryDirectory() {
  userTemporary ??= require("node:util").promisify(require("node:child_process").execFile)("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8", timeout: 5000 })
    .then(({ stdout }) => stdout.trim(), () => "");
  return userTemporary;
}
async function keepBundleLoader(executable, ntdll, temporary) {
  try {
    if (!(await fs.promises.readFile(ntdll)).includes(PROGRAM_LINKS)) return null;
    const root = temporary || await userTemporaryDirectory(), loader = fs.statSync(executable, { bigint: true }), second = 1000000000n;
    if (!path.isAbsolute(root)) return null;
    const entry = path.join(root, `winetemp-${loader.ino}-${loader.size}-${loader.mtimeNs / second}-${loader.mtimeNs % second}`);
    const current = fs.lstatSync(entry, { throwIfNoEntry: false });
    if (current?.isFile()) return entry;
    if (current?.isDirectory()) {
      const names = fs.readdirSync(entry);
      const ours = name => { const stat = fs.lstatSync(path.join(entry, name), { bigint: true }); return stat.isSymbolicLink() ? name === "ntdll.so" : stat.isFile() && stat.ino === loader.ino; };
      if (!names.every(ours)) return null;
      for (const name of names) fs.unlinkSync(path.join(entry, name));
      fs.rmdirSync(entry);
    } else if (current) return null;
    fs.writeFileSync(entry, "Wine starts this loader's programs from its MacLauncher Game.app bundle.\n", { mode: 0o600, flag: "wx" });
    return entry;
  } catch { return null; }
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
  await linkFile(install.serverPath || path.join(engine, "bin", "wineserver"), serverPath, signal);
  await linkDirectory(path.join(engine, "share"), path.join(wineRoot, "share"), signal);
  for (const architecture of layout.windows) {
    for (const name of ["ntdll.dll", "apisetschema.dll"]) {
      const source = path.join(engine, "lib", "wine", architecture, name);
      if (fs.existsSync(source)) await linkFile(source, path.join(dllRoot, architecture, name), signal);
      else if (architecture === layout.primaryWindows) fail("The selected Wine engine is incomplete. Reinstall this version.");
    }
  }
  // Newer engines re-exec a separate loader with the address-space layout
  // required by Windows. Reusing bin/wine here can retain its 4 GB PAGEZERO
  // mapping and prevent Wine from reserving the shared user-data address.
  // Either loader runs the game from the Game Mode bundle.
  const unixLoader = path.join(engine, "lib", "wine", layout.unixName, "wine"), separate = fs.existsSync(unixLoader);
  if (!separate) await cloneLoaderFile(path.join(engine, "lib", "wine", "x86_64-unix", "ntdll.so"), path.join(unix, "ntdll.so"), signal);
  const gameLoader = await prepareGameBundle({ loader: separate ? unixLoader : executablePath, engine, wineRoot, dllRoot, layout, separate, signal });
  if (separate) {
    await linkFile(path.join(path.dirname(gameLoader), "ntdll.so"), path.join(unix, "ntdll.so"), signal);
    await linkFile(gameLoader, path.join(unix, "wine"), signal);
  }
  const libraryOverride = path.join(wineRoot, "loader-libraries");
  ownDirectory(libraryOverride);
  await linkFile(path.join(unix, "ntdll.so"), path.join(libraryOverride, "ntdll.so"), signal);
  return { wineRoot, dllRoot, executablePath: separate ? executablePath : gameLoader, serverPath, libraryOverride };
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
// `source` is the Wine source descriptor (sources/<id>.js). Without a
// translator plan, the Sikarugir Template's own renderer selection applies.
async function prepareGraphicsView({ source = require(".").get("sikarugir"), install, settings = {}, prefixPath, viewRoot, host = {}, signal, executableArchitecture, cameraBridge, vulkanDLSS, helperLibraries = [], translatorPlan, translatorView, environment, context, userDataDir } = {}) {
  signal?.throwIfAborted();
  if (!translatorPlan && context) {
    const shared = require('../../shared/runtime/wine-translators');
    if (environment) context.wineEnvironment = environment;
    context.runtimeSettings ||= settings;
    translatorPlan = context.translatorPlan?.layout?.root === wineLayout(install).root ? context.translatorPlan :
      await shared.resolve(install, source.id, context, { executableArchitecture, host });
    settings = shared.settingsForPlan(settings, translatorPlan);
  }
  if (translatorPlan && !translatorView) translatorView = await require('../../shared/runtime/translator-files').prepareTranslatorFiles(translatorPlan,
    { userDataDir: userDataDir || context?.userDataDir, layout: translatorPlan.layout, signal });
  const native = source.nativeLibraries(install);
  const support = translatorPlan ? null : supportRoot(install), engine = engineRoot(install), hostInfo = {
    hardwareArch: require("../../shared/runtime/host-capabilities").getHostCapabilities().hardwareArch, ...host };
  const layout = translatorPlan?.layout || wineLayout(install);
  let capabilities = translatorPlan ? { ...install.capabilities, wined3d: true, componentVersions: {} } : capabilitiesFor(install, support, hostInfo);
  const hardware = capabilities.kosmickrisp && (!settings.vulkanBackend || settings.vulkanBackend === "auto")
    ? await Hardware.graphicsHardware(hostInfo, { signal }) : { physicalAppleGPU: hostInfo.physicalAppleGPU === true, source: "not-required" };
  hostInfo.physicalAppleGPU = hardware.physicalAppleGPU;
  if (!translatorPlan) capabilities = capabilitiesFor(install, support, hostInfo);
  if (cameraBridge) capabilities.dxmt = true;
  const selection = translatorPlan ? { graphicsBackend: translatorPlan.apiMode ? 'wined3d' : translatorPlan.components["d3d-renderer"].used?.engine || "auto",
    vulkanBackend: translatorPlan.components["vulkan-driver"].used?.engine || "auto", components: [] } : selectGraphics(settings, capabilities, executableArchitecture);
  const rendererRoot = support && path.join(support, "Frameworks", "renderer");
  let dlss = DLSS.checkSelection(settings, { ...hostInfo, executableArchitecture, translatorPlan, vulkan: vulkanDLSS?.enabled===true,
    backend: selection.components.includes("dxmt") ? "dxmt" : selection.graphicsBackend === "auto" ? "wined3d" : selection.graphicsBackend,
    dxmt: settings.dlss === true && (translatorPlan ? Boolean(cameraBridge) || DLSS.hasPlanLibraries(translatorPlan, "dxmt") : capabilities.dxmt && (Boolean(cameraBridge) || DLSS.hasLibraries(path.join(rendererRoot, "dxmt", "wine", layout.primaryWindows)))),
    d3dmetal: settings.dlss === true && (translatorPlan ? DLSS.hasPlanLibraries(translatorPlan, "d3dmetal") : capabilities.d3dmetal && DLSS.hasLibraries(path.join(rendererRoot, "d3dmetal", "wine", layout.primaryWindows))) });
  if (dlss.d3dmetal && !await DLSS.hasD3DMetalPathBridge(engine)) {
    if (settings.dlssOptional !== true) fail("The selected Wine engine cannot expose MetalFX Temporal through D3DMetal's game integration. Choose DXMT, select a compatible newer Wine version, or disable MetalFX Temporal.");
    dlss = { ...dlss, d3dmetal: false, enabled: dlss.dxmt || dlss.vulkan === true };
  }
  const destination = prospectiveRealPath(viewRoot || ".");
  const installed = install.installDir && fs.existsSync(install.installDir) ? fs.realpathSync(install.installDir) : null;
  if ((support && Closure.inside(support, destination)) || (installed && Closure.inside(installed, destination)) || Closure.inside(engine, destination)) fail("Per-game graphics state must be outside the shared runtime.");
  ownDirectory(viewRoot);
  const renderers = support && path.join(support, "Frameworks", "renderer");
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
    const image = require("../../shared/runtime/macho-load-commands").readMachOLoadCommands(unix, { architecture: layout.architecture, signal });
    if (!image.slices.some(slice => slice.architecture === layout.architecture && slice.platform === 1)) fail("The GPU helper requires an Intel macOS library.");
    helperNames.add(item.name); helpers.push({ name: item.name, windows, unix });
  }
  // Every game runs from the private loader view and its Game Mode bundle.
  const loader = await prepareLoaderView(engine, viewRoot, install, signal);
  const dllRoot = loader.dllRoot, dllOverrides = [], selectedUnix = [];
  ownDirectory(dllRoot);
  for (const architecture of [...layout.windows, layout.unixName]) ownDirectory(path.join(dllRoot, architecture));
  if (!translatorPlan) await clearUnusedRenderers(dllRoot, renderers, selection.components, signal);
  if (translatorView) {
    for (const [relative, original] of Object.entries(translatorView.links)) {
      const source = cameraBridge ? require("../temporal").rendererFile(cameraBridge, path.basename(path.dirname(relative)), path.basename(relative), original) : original;
      await linkFile(source, path.join(loader.wineRoot, relative), signal);
    }
    // Wine opens a builtin's Unix module beside the folder it loaded the
    // builtin from. A set that supplies a builtin without its Unix module,
    // such as WineCX's DXMT winemetal.dll, uses the engine's module of that name.
    for (const relative of Object.keys(translatorView.links)) {
      const name = /^lib\/wine\/[^/]+-windows\/([^/]+)\.dll$/i.exec(relative)?.[1], unix = name && `lib/wine/${layout.unixName}/${name}.so`;
      if (!unix || Object.hasOwn(translatorView.links, unix) || fs.existsSync(path.join(loader.wineRoot, unix))) continue;
      const own = path.join(engine, unix);
      if (fs.existsSync(own)) await linkFile(own, path.join(loader.wineRoot, unix), signal);
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
        const source = require("../temporal").rendererFile(name === "dxmt" ? cameraBridge : null, architecture, module + ".dll", path.join(root, architecture, module + ".dll"));
        if (fs.existsSync(source)) await linkFile(source, path.join(dllRoot, architecture, module + ".dll"), signal);
      }
    }
    const unix = path.join(root, layout.unixName);
    if (fs.existsSync(unix)) {
      selectedUnix.push(unix);
      for (const file of await fs.promises.readdir(unix)) if (/\.(?:so|dylib)$/.test(file)) await linkFile(require("../temporal").rendererFile(name === "dxmt" ? cameraBridge : null,
        layout.unixName, file, path.join(unix, file)), path.join(dllRoot, layout.unixName, file), signal);
    }
    dllOverrides.push(modules.join(",") + "=b");
  }
  if (cameraBridge && selection.components.includes("dxmt") && dlss.dxmt)
    await linkFile(cameraBridge.dxmt.native, path.join(dllRoot, "x86_64-unix/maclauncher-dxmt-original.so"), signal);
  const gstreamer = native.gstreamer;
  const external = selection.components.includes("d3dmetal") ? path.join(renderers, "d3dmetal", "external") : null;
  const libraryPaths = [...new Set([path.join(dllRoot, layout.unixName), ...selectedUnix, ...(external ? [external] : []), path.join(engine, "lib", "wine", layout.unixName), ...native.libraries,
    ...(gstreamer ? [gstreamer.lib] : [])])];
  // Only ntdll's private anchor overrides lookup: Unix Wine modules must reuse
  // its initialized copy. Vendor dependencies must not replace system libraries
  // loaded by Apple frameworks in the same process.
  const env = { WINEDLLPATH: path.join(engine, "lib", "wine"),
    DYLD_LIBRARY_PATH: loader.libraryOverride,
    DYLD_FALLBACK_LIBRARY_PATH: libraryPaths.join(path.delimiter),
    ...(native.frameworks.length || external ? { DYLD_FALLBACK_FRAMEWORK_PATH: [...native.frameworks, ...(external ? [external] : [])].join(path.delimiter) } : {}),
    GST_REGISTRY_1_0: path.join(viewRoot, "gstreamer-registry.bin") };
  Object.assign(env, DLSS.environment(dlss), DLSS.adapterEnvironment(dlss, install?.capabilities));
  if (selection.components.includes("dxmt") && dlss.dxmt) Object.assign(env, require("../temporal").environment(cameraBridge, dllRoot));
  if (gstreamer) {
    env.GST_PLUGIN_SYSTEM_PATH_1_0 = gstreamer.plugins;
    env.GST_PLUGIN_PATH_1_0 = "";
    if (gstreamer.scanner && fs.existsSync(gstreamer.scanner)) env.GST_PLUGIN_SCANNER_1_0 = gstreamer.scanner;
  }
  if (!translatorPlan && selection.vulkanBackend !== "auto") {
    const icd = path.join(viewRoot, "vulkan-icd.json"), sourceIcd = path.join(support, Closure.RELATIVE_PATHS.vulkan,
      selection.vulkanBackend === "kosmickrisp" ? "kosmickrisp_mesa_icd.json" : "MoltenVK_icd.json");
    const descriptor = JSON.parse(Closure.boundedText(sourceIcd));
    if (!descriptor.ICD || typeof descriptor.ICD.library_path !== "string") fail("The Vulkan driver description is invalid.");
    const driver = path.resolve(path.dirname(sourceIcd), descriptor.ICD.library_path);
    if (!Closure.inside(path.join(support, "Frameworks"), fs.realpathSync(driver))) fail("The Vulkan driver escapes its graphics package.");
    // The private manifest selects exactly one driver, without rewriting the
    // immutable upstream manifest or depending on a machine-wide Vulkan SDK.
    descriptor.ICD.library_path = driver;
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
    env.DYLD_FALLBACK_LIBRARY_PATH = [...translatorView.libraryPaths, env.DYLD_FALLBACK_LIBRARY_PATH].filter(Boolean).join(path.delimiter);
    env.DYLD_FALLBACK_FRAMEWORK_PATH = [...translatorView.frameworkPaths, env.DYLD_FALLBACK_FRAMEWORK_PATH].filter(Boolean).join(path.delimiter);
    if (Object.keys(translatorView.links).some(name => name.endsWith(".dll"))) env.WINEDLLPATH = [...layout.windows.map(name => path.join(dllRoot, name)), dllRoot, layout.dllRoot].join(path.delimiter);
  }
  signal?.throwIfAborted();
  const writesBuiltinPrefix = !environment || Object.values(translatorPlan?.components || {}).some(row => row.used && !row.inherited && row.used.files.some(file => file.format === 'pe' && file.form === 'builtin'));
  return { ...selection, ...loader, env, dllOverrides, translatorPlan,
    ...(path.isAbsolute(prefixPath || "") && writesBuiltinPrefix ? { applyPrefix: () => registerPrefixLibraries(prefixPath, viewRoot, dllRoot, signal, layout) } : {}),
    capabilities, hardware, dlss, componentVersions: capabilities.componentVersions, viewRoot, prefixPath };
}

module.exports = { GRAPHICS_BACKENDS, VULKAN_BACKENDS, VIEW_LAYOUT, keepBundleLoader, prepareGraphicsView, capabilitiesFor,
  __test: { capabilitiesFor, selectGraphics, ownDirectory, CORE_DLLS } };
