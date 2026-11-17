const BinaryArch = require('../../../core/binary-arch');
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
        coff.readUInt32LE(0) !== 0x4550 || BinaryArch.peHeaderFacts(coff).machineCode !== machine || !(BinaryArch.peHeaderFacts(coff).characteristics & 0x2000))
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
    if (offset + 32 > bytes.length) return null;
    const format = BinaryArch.machoMagic(bytes.readUInt32BE(offset));
    if (!format || format.fat || !format.little || !format.wide) return null;
    const facts = BinaryArch.machoHeader(bytes.subarray(offset, offset + 32)), count = facts.commandCount, end = offset + 32 + facts.commandBytes;
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
  const format = bytes.length >= 8 && BinaryArch.machoMagic(bytes.readUInt32BE(0));
  if (format?.fat && !format.wide && !format.little) {
    const container = BinaryArch.machoFatHeader(bytes);
    for (let index = 0, count = Math.min(container.count, 16); index < count; index++) {
      const at = 8 + index * 20;
      if (at + 20 <= bytes.length) { const entry = BinaryArch.machoFatEntry(bytes.subarray(8), index, container); if (BinaryArch.machoArchitecture(entry.cpu) === "x86_64") return thin(entry.offset); }
    }
    return null;
  }
  return thin(0);
}
// macOS turns on Game Mode for a full-screen application in the games
// category. The application properties are the loader's own, with the bundle's
// executable name, that category, an identifier for the Wine source and the
// text that macOS shows when it asks for local network access. macOS keeps a
// Local Network answer per identifier, so each source is asked at most once
// and its Wine versions share the answer.
const GAME_BUNDLE = "MacLauncher Game.app";
const gameIdentifier = source => {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(source?.id || "")) fail("The Wine source has no valid identifier.");
  return `com.maclauncher.wine-game.${source.id}`;
};
const localNetworkUse = source => `Windows games that MacLauncher starts with ${source.label} use the local network to find and join games, players and devices nearby.`;
// Views of an earlier layout are never reused; a new layout gets new paths.
const VIEW_LAYOUT = 4;
function gameBundleInfo(embedded, source) {
  const value = (key, text) => `    <key>${key}</key>\n    <string>${text}</string>\n`;
  let text = /^\s*<\?xml[\s\S]*<dict>[\s\S]*<\/dict>\s*<\/plist>\s*$/.test(embedded || "") ? embedded.trim() + "\n" :
    '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    '<plist version="1.0">\n<dict>\n' + value("CFBundleName", "MacLauncher Game") + value("CFBundlePackageType", "APPL") + '</dict>\n</plist>\n';
  for (const [key, setting] of [["CFBundleExecutable", "wine"], ["CFBundleIdentifier", gameIdentifier(source)], ["LSApplicationCategoryType", "public.app-category.games"],
    ["NSLocalNetworkUsageDescription", localNetworkUse(source)]]) {
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
async function prepareGameBundle({ loader, engine, wineRoot, dllRoot, layout, separate, source, signal }) {
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
  const info = path.join(contents, "Info.plist"), text = gameBundleInfo(embeddedInfo(await fs.promises.readFile(loader)), source);
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
// A loader that its publisher signed inside an application bundle holding the
// provisioning profile its entitlements need runs only from that bundle; macOS
// stops a copy of it anywhere else. The view links such a loader instead.
function publisherLoader(file) {
  let real;
  try { real = fs.realpathSync(file); } catch { return null; }
  const bundle = /^(.*\.app)\/Contents\/MacOS\/[^/]+$/.exec(real)?.[1];
  return bundle && fs.existsSync(path.join(bundle, "Contents", "embedded.provisionprofile")) ? real : null;
}
// Whether the Wine runs from a publisher-signed loader; its view keeps links
// where other views keep copies, so it has its own view folder.
// A Wine without a separate Unix loader directory has only its launcher to check.
const publisherSigned = install => {
  const unixName = wineLayout(install).unixName;
  return Boolean(publisherLoader(install.executablePath || path.join(engineRoot(install), "bin", "wine")) ||
    (unixName && publisherLoader(path.join(engineRoot(install), "lib", "wine", unixName, "wine"))));
};
// The publisher-signed loader that runs the game's processes, or null when the
// game runs from the view's own bundle.
function gameLoader(install) {
  const engine = engineRoot(install), unixName = wineLayout(install).unixName;
  const unixLoader = unixName && path.join(engine, "lib", "wine", unixName, "wine");
  return unixLoader && fs.existsSync(unixLoader) ? publisherLoader(unixLoader) : publisherLoader(install.executablePath || path.join(engine, "bin", "wine"));
}
function codesignOutput(file) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(?:DYLD_|RESHADE_)/.test(key)) delete env[key];
  const result = require("node:child_process").spawnSync("/usr/bin/codesign", ["--display", "--verbose=4", "--entitlements", "-", file],
    { env, timeout: 10000, maxBuffer: 1024 * 1024, encoding: "utf8" });
  return `${result.stdout || ""}\n${result.stderr || ""}`;
}
// How MacLauncher's graphics layer attaches to the game's process, read from
// the signature of the loader the game runs from. "dyld": through
// DYLD_INSERT_LIBRARIES, which dyld ignores for the hardened runtime without
// allow-dyld-environment-variables. "runtime-library": such a loader that
// still loads unsigned libraries (disable-library-validation) loads the layer
// through maclauncher-winemetal.so (runtimeLibraryRoute). null: neither. Each
// loader file is read once; a signature that cannot be read counts as "dyld".
const layerFacts = new Map();
function loaderFacts(install, readSignature) {
  let loader, identity;
  try {
    loader = gameLoader(install);
    if (!loader) return null;
    const stat = fs.statSync(loader, { bigint: true });
    identity = [stat.dev, stat.ino, stat.size, stat.mtimeNs].join(":");
  } catch { return null; }
  const known = layerFacts.get(loader);
  if (known?.identity === identity) return known.facts;
  const signature = require("../../shared/runtime/native-injection").parseSignature(readSignature(loader));
  const hardened = signature.flags !== null && Boolean(signature.flags & 0x10000);
  const facts = { dyld: !hardened || signature.allowDyld, libraries: !hardened || signature.disableLibraryValidation };
  if (layerFacts.size >= 64) layerFacts.delete(layerFacts.keys().next().value);
  layerFacts.set(loader, { identity, facts });
  return facts;
}
function graphicsLayerRoute(install, { readSignature = codesignOutput } = {}) {
  const facts = loaderFacts(install, readSignature);
  if (!facts || facts.dyld) return "dyld";
  return facts.libraries && runtimeLibraryRoute(install) ? "runtime-library" : null;
}
function graphicsLayerAttachable(install, options = {}) {
  return graphicsLayerRoute(install, options) !== null;
}
// Whether the loader the game runs from ignores DYLD variables but loads
// unsigned libraries, so a Unix module of the game's process applies the
// graphics libraries itself (graphics-library-attach.h).
function loadsUnsignedLibraries(install, { readSignature = codesignOutput } = {}) {
  const facts = loaderFacts(install, readSignature);
  return Boolean(facts && !facts.dyld && facts.libraries);
}
// Whether such a module is prepared: the view's Metal shim (runtimeLibraryRoot),
// or a selected WineVulkan client that carries the graphics libraries' loader.
// A running Wine session keeps the processes it has.
function inProcessGraphics(install, { runtimeLibraryRoot, vulkanSelection, environment } = {}) {
  return Boolean(runtimeLibraryRoot || !environment && vulkanSelection?.graphicsLibraries === true && loadsUnsignedLibraries(install));
}
// A Wine whose ntdll reads DXMT_RUNTIME_DIR loads <dir>/aarch64-unix/winemetal.so
// as the Unix side of its Metal library, and its Windows libraries from the
// folders beside it. The runtime's own folder is lib/mullion; a separately
// installed DXMT build that the plan's graphics policy loads from its own
// folder takes its place. The graphics payload's maclauncher-winemetal.so
// takes winemetal.so's place in a folder of the view and re-exports the
// runtime's own.
const RUNTIME_LIBRARY = "maclauncher-winemetal.so";
const runtimeDirectoryReaders = new Map();
function readsRuntimeDirectory(ntdll) {
  const stat = fs.statSync(ntdll, { bigint: true }), identity = [stat.dev, stat.ino, stat.size, stat.mtimeNs].join(":");
  const known = runtimeDirectoryReaders.get(ntdll);
  if (known?.identity === identity) return known.reads;
  const reads = fs.readFileSync(ntdll).includes(Buffer.from("DXMT_RUNTIME_DIR\0"));
  if (runtimeDirectoryReaders.size >= 16) runtimeDirectoryReaders.delete(runtimeDirectoryReaders.keys().next().value);
  runtimeDirectoryReaders.set(ntdll, { identity, reads });
  return reads;
}
function runtimeLibraryRoute(install, directory = null) {
  try {
    const engine = engineRoot(install), unixName = wineLayout(install).unixName;
    const runtime = directory || path.join(engine, "lib", "mullion"), base = path.join(runtime, "aarch64-unix", "winemetal.so");
    const library = path.join(require("../../shared/reshade").runtimeRoot(), RUNTIME_LIBRARY);
    if (!unixName || !fs.statSync(base).isFile() || !fs.statSync(library).isFile()) return null;
    return readsRuntimeDirectory(path.join(engine, "lib", "wine", unixName, "ntdll.so")) ? { runtime, base, library } : null;
  } catch { return null; }
}
async function linkRuntimeFile(source, destination, signal) {
  signal?.throwIfAborted();
  const current = await fs.promises.lstat(destination).catch(error => { if (error.code !== "ENOENT") throw error; return null; });
  if (current?.isSymbolicLink() && await fs.promises.readlink(destination) === source) return;
  if (current) await fs.promises.rm(destination, { force: true });
  await fs.promises.symlink(source, destination);
}
// The view's DXMT runtime folder: links to every file of the runtime's own
// Windows folders, the runtime's winemetal.so as winemetal-runtime.so, and a
// copy of maclauncher-winemetal.so as winemetal.so, which finds the runtime's
// library beside itself. Links a previous runtime left that this one lacks are
// removed, because the loader takes every DXMT library it finds there.
async function prepareRuntimeLibraryView(route, viewRoot, signal) {
  const root = path.join(viewRoot, "graphics-runtime");
  ownDirectory(root);
  const folders = new Set();
  for (const folder of fs.readdirSync(route.runtime, { withFileTypes: true })) {
    if (!folder.isDirectory() || folder.name === "aarch64-unix") continue;
    const from = path.join(route.runtime, folder.name), to = path.join(root, folder.name), names = new Set();
    ownDirectory(to); folders.add(folder.name);
    for (const file of fs.readdirSync(from, { withFileTypes: true }))
      if (file.isFile() || file.isSymbolicLink()) { names.add(file.name); await linkRuntimeFile(path.join(from, file.name), path.join(to, file.name), signal); }
    for (const name of fs.readdirSync(to)) if (!names.has(name) && fs.lstatSync(path.join(to, name)).isSymbolicLink()) fs.rmSync(path.join(to, name));
  }
  for (const folder of fs.readdirSync(root, { withFileTypes: true })) {
    if (!folder.isDirectory() || folder.name === "aarch64-unix" || folders.has(folder.name)) continue;
    for (const name of fs.readdirSync(path.join(root, folder.name))) if (fs.lstatSync(path.join(root, folder.name, name)).isSymbolicLink()) fs.rmSync(path.join(root, folder.name, name));
  }
  const unix = path.join(root, "aarch64-unix");
  ownDirectory(unix);
  await linkRuntimeFile(route.base, path.join(unix, "winemetal-runtime.so"), signal);
  const library = path.join(unix, "winemetal.so"), wanted = fs.readFileSync(route.library);
  let current = null;
  try { current = fs.lstatSync(library).isFile() ? fs.readFileSync(library) : null; } catch {}
  if (!current?.equals(wanted)) {
    const temporary = `${library}.${process.pid}.tmp`;
    fs.rmSync(temporary, { force: true });
    require("../../shared/copy-file").cloneOrCopySync(route.library, temporary);
    fs.renameSync(temporary, library);
  }
  return root;
}
async function prepareLoaderView(engine, viewRoot, install, signal, source) {
  const wineRoot = path.join(viewRoot, "wine"), dllRoot = path.join(wineRoot, "lib", "wine");
  const layout = wineLayout(install), bin = path.join(wineRoot, "bin"), unix = path.join(dllRoot, layout.unixName);
  for (const directory of [wineRoot, bin, path.join(wineRoot, "lib"), dllRoot,
    ...[...layout.windows, layout.unixName].map(name => path.join(dllRoot, name))]) ownDirectory(directory);
  // Wine derives its primary builtin directory from the real path of ntdll.so.
  // A separate loader and ntdll copy give selected renderer links priority,
  // while WINEDLLPATH supplies the unchanged shared engine as a fallback.
  const executablePath = path.join(bin, "wine"), serverPath = path.join(bin, "wineserver");
  const launcher = install.executablePath || path.join(engine, "bin", "wine"), signedLauncher = publisherLoader(launcher);
  if (signedLauncher) await linkFile(signedLauncher, executablePath, signal);
  else await cloneLoaderFile(launcher, executablePath, signal);
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
  // A publisher-signed loader runs from its own bundle rather than ours.
  const signedLoader = separate ? publisherLoader(unixLoader) : signedLauncher;
  const gameLoader = signedLoader ? (separate ? signedLoader : executablePath)
    : await prepareGameBundle({ loader: separate ? unixLoader : executablePath, engine, wineRoot, dllRoot, layout, separate, source, signal });
  if (separate) {
    await linkFile(signedLoader ? path.join(path.dirname(unixLoader), "ntdll.so") : path.join(path.dirname(gameLoader), "ntdll.so"), path.join(unix, "ntdll.so"), signal);
    await linkFile(gameLoader, path.join(unix, "wine"), signal);
  }
  const libraryOverride = path.join(wineRoot, "loader-libraries");
  ownDirectory(libraryOverride);
  await linkFile(path.join(unix, "ntdll.so"), path.join(libraryOverride, "ntdll.so"), signal);
  return { wineRoot, dllRoot, executablePath: separate ? executablePath : gameLoader, serverPath, libraryOverride, sourceMainExecutablePath: separate ? unixLoader : install.executablePath || path.join(engine,"bin","wine"), plannedMainExecutablePath: gameLoader };
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
// The graphics component declares complete WineVulkan client/native pairs.
// CPU selection comes from their headers and the selected Wine's native loader.
// The Wine release in the Wine's own ntdll.so build string, such as
// "wine-11.20 (MetalSharp Wine 7.0)" or "wine-11.0-8726-g2e2f5fca349".
const wineReleases=new Map();
function wineRelease(layout){
  const file=layout?.unixRoot&&path.join(layout.unixRoot,"ntdll.so");
  try{
    const stat=fs.statSync(file,{bigint:true}),identity=[stat.dev,stat.ino,stat.size,stat.mtimeNs].join(":"),known=wineReleases.get(file);
    if(known?.identity===identity)return known.release;
    const release=/wine-(\d+\.\d+(?:\.\d+)?)(?=[ (\-\0])/.exec(fs.readFileSync(file).toString("latin1"))?.[1]||null;
    if(wineReleases.size>=16)wineReleases.delete(wineReleases.keys().next().value);
    wineReleases.set(file,{identity,release});
    return release;
  }catch{return null;}
}
// A WineVulkan module's Wine binding. A module that names its Wine release
// (`wineVersion`) applies to a Wine whose ntdll.so reports that release; its
// Unix side's imports are then checked against the Wine's own libraries.
// An older module lists its Wine files by digest instead.
function wineVulkanProfile(profile,layout){
  if(typeof profile?.wineVersion==="string")
    return wineRelease(layout)===profile.wineVersion?{measured:true,has:file=>fs.existsSync(file),get:()=>null}:null;
  const Native=require("../../shared/runtime/bundled-native"),Identity=require("../../shared/runtime/verified-identity"),files=new Map();
  if(!Array.isArray(profile?.files)||!profile.files.length)return null;
  for(const row of profile.files){
    if(typeof row?.relative!=="string"||!/^[a-f0-9]{64}$/.test(row.sha256||""))return null;
    Native.relativeFile(row.relative);const file=path.join(layout.root,row.relative);
    try{
      if(!Closure.inside(fs.realpathSync(layout.root),fs.realpathSync(file))||Identity.fileDigest(file).sha256!==row.sha256)return null;
      files.set(fs.realpathSync(file),row.sha256);
    }catch(error){if(!["ENOENT","ENOTDIR"].includes(error.code))throw error;return null;}
  }
  return files;
}
function wineVulkanSelection(root, install, { layout = wineLayout(install), signal, module: supplied, record } = {}) {
  const relative = supplied ? "manifest.json" : "temporal/vulkan/selection.json", descriptor = path.join(root, relative);
  if (!fs.existsSync(descriptor)) return null;
  const Native = require("../../shared/runtime/bundled-native");
  const Identity = require("../../shared/runtime/verified-identity");
  const manifest = supplied?.manifest || require("../../shared/reshade/publication").forRoot(root);
  const read = (name, expected, maximum) => {
    Native.relativeFile(name);
    const file = path.join(root, name), fact = manifest.files.find(row => row.path === name);
    if (!fact || expected && fact.sha256 !== expected || !Closure.inside(fs.realpathSync(root), fs.realpathSync(file)))
      fail("The WineVulkan graphics declaration differs from its package.");
    const bytes = Native.readRegular(file, maximum);
    if (bytes.sha256 !== fact.sha256 || bytes.size !== fact.size) fail("The WineVulkan graphics input changed.");
    return { file, sha256: bytes.sha256, bytes: bytes.bytes };
  };
  let declaration, value;
  if (supplied) {
    const stored = Native.readRegular(descriptor, Native.LIMITS.manifestBytes);
    if (JSON.stringify(JSON.parse(stored.bytes)) !== JSON.stringify(supplied.manifest)) fail("The selected WineVulkan module changed during preparation.");
    declaration = {file:descriptor,sha256:stored.sha256};
    const entry = item => ({file:path.relative(root,item.file).split(path.sep).join("/"),sha256:item.sha256});
    value = {schema:1,pairs:supplied.pairs.map(pair=>({...pair,client:entry(pair.client),native:entry(pair.native)}))};
  } else { declaration = read(relative, null, 64 * 1024);value = JSON.parse(declaration.bytes.toString("utf8")); }
  if (value?.schema !== 1 || !Array.isArray(value.pairs) || value.pairs.length > 8)
    fail("The WineVulkan graphics declaration is invalid.");
  const machine = require("../../shared/runtime/binary-compatibility").requiredMachine(layout.primaryWindows?.replace(/-windows$/, ""));
  const matches = [];
  for (const pair of value.pairs) {
    signal?.throwIfAborted();
    if (![pair?.client, pair?.native].every(item => typeof item?.file === "string" && /^[a-f0-9]{64}$/.test(item.sha256 || "")))
      fail("The WineVulkan graphics pair is invalid.");
    const client = read(pair.client.file, pair.client.sha256, 64 * 1024 * 1024);
    const native = read(pair.native.file, pair.native.sha256, 64 * 1024 * 1024);
    const pe = require("../../shared/runtime/pe-exports").readPeExports(client.file, { headersOnly: true });
    const images = require("../../shared/runtime/macho-load-commands").readMachOLoadCommands(native.file, { signal, imports: true });
    const image = images.slices.find(row => row.architecture === layout.architecture && row.platform === 1);
    if (!pe?.isDll || pe.form !== "builtin") fail("The WineVulkan client is not a Wine builtin DLL.");
    if (!machine || pe.machine !== machine || !image) continue;
    const profile = wineVulkanProfile(pair.runtimeProfile,layout);
    // A release binding needs the Wine's measured library exports.
    if(!profile||profile.measured&&!record?.modules)continue;
    let compatible = true;
    const dependencies = [];
    for (const dependency of image.dependencies) {
      if (/^\/(?:usr\/lib|System\/Library)\//.test(dependency.path)) continue;
      const name = /^@(?:rpath|loader_path)\/([^/]+)$/.exec(dependency.path)?.[1];
      if (!name || !/^[a-zA-Z0-9_.-]+\.so$/.test(name)) fail("The WineVulkan native dependency is unsupported.");
      if (dependencies.some(row => row.name === name)) continue;
      const file = path.join(layout.unixRoot, name);
      if (!fs.existsSync(file) || !profile.has(fs.realpathSync(file))) { compatible = false;break; }
      const header = require("../../shared/runtime/macho-load-commands").readMachOLoadCommands(file, { signal });
      if (!header.slices.some(row => row.architecture === layout.architecture && row.platform === 1)) { compatible = false;break; }
      const sha256 = Identity.fileDigest(file).sha256;
      if (!profile.measured && profile.get(fs.realpathSync(file)) !== sha256) { compatible = false;break; }
      dependencies.push({ name, file, sha256 });
    }
    // Every symbol the Unix side imports from a Wine library is one that library exports.
    const BinaryCompatibility = require("../../shared/runtime/binary-compatibility");
    if (compatible && profile.measured) compatible = image.importsComplete === true && image.imports.every(item => item.weak ||
      /^\/(?:usr\/lib|System\/Library)\//.test(item.library || "") || BinaryCompatibility.moduleExport(record, path.basename(item.library || ""), item.symbol) === true);
    const original = path.join(layout.primaryWindowsRoot, "winevulkan.dll");
    if (!compatible || !fs.existsSync(original) || !profile.measured && profile.get(fs.realpathSync(original)) !== Identity.fileDigest(original).sha256) continue;
    try { require("../temporal/vulkan/selection").inspectClientName({file:client.file,sha256:client.sha256}); }
    catch(error){if(error.message==="WineVulkan client needs a distinct builtin export name.")continue;throw error;}
    matches.push({ client: { file: client.file, sha256: client.sha256, original: { file: original, sha256: Identity.fileDigest(original).sha256 } },
      native: { file: native.file, sha256: native.sha256, dependencies }, graphicsLibraries: (supplied?.provider || pair).graphicsLibraryAPI === 1,
      inputs: [declaration, client, native].map(({ file, sha256 }) => ({ path: file, sha256 })) });
  }
  if (matches.length > 1) fail("The WineVulkan graphics package has more than one matching pair.");
  return matches[0] || null;
}
function wineVulkanRuntimeSelection(entry, context, install, {translatorPlan=context.translatorPlan, root, manager=require("../temporal/vulkan/manager")}={}) {
  if (!translatorPlan?.components?.["vulkan-driver"]?.used) return {selection:null};
  const layout=translatorPlan.layout||wineLayout(install), Architecture=require("../../shared/runtime/architecture");
  if(!Architecture.targetArchitecture(layout.architecture))return {selection:null};
  const selected=Architecture.withArchitecture(Architecture.normalizeArchitecture(layout.architecture),()=>manager.resolveSelection({...entry,runtimeId:manager.id},context.settings,context.userDataDir,{verification:"status"}));
  if(selected.ready&&selected.install){
    const module=manager.inspectPayload(selected.install.modulePayloadRoot||selected.install.payloadRoot||selected.install.executablePath);
    const selection=wineVulkanSelection(module.root,install,{layout,signal:context.signal,module,record:translatorPlan.record});
    if(selection)return {selection,manager,selected,managed:true};
  }
  root ||= require("../../shared/reshade").runtimeRoot(context.app);
  return {selection:wineVulkanSelection(root,install,{layout,signal:context.signal,record:translatorPlan.record}),manager,selected};
}
async function prepareWineVulkan(entry, context, install, options) {
  const resolved=wineVulkanRuntimeSelection(entry,context,install,options);
  if(resolved.selection&&resolved.managed){
    await context.useRuntime?.({managerId:resolved.manager.id,version:resolved.selected.version,
      sourcePath:resolved.selected.install.installDir||resolved.selected.install.modulePayloadRoot||resolved.selected.install.executablePath});
  }
  return resolved.selection;
}
async function prepareWineVulkanView(selection,{prefixPath,dllRoot,layout,signal}){
  const directory=path.join(dllRoot,"maclauncher-vulkan",crypto.createHash("sha256").update(prefixPath).digest("hex").slice(0,20));
  Writable.assertOwnDirectory(dllRoot,directory);
  const dependencies=selection.native.dependencies.map(dependency=>{
    const file=path.join(dllRoot,layout.unixName,dependency.name);
    if(!fs.existsSync(file))return dependency;
    if(require("../../shared/runtime/verified-identity").fileDigest(file).sha256!==dependency.sha256)fail("The prepared WineVulkan dependency differs from the selected Wine.");
    return {...dependency,file:fs.realpathSync(file)};
  });
  return require("../temporal/vulkan/selection").prepareSelection({...selection,prefixPath,dllRoot:directory,windows:layout.primaryWindows,unixName:layout.unixName,
    native:{...selection.native,dependencies},signal});
}
async function wineVulkanRequirements(entry,context,{install,translatorPlan=context.translatorPlan,root,manager=require("../temporal/vulkan/manager")}={}){
  if(!translatorPlan?.components?.["vulkan-driver"]?.used)return [];
  if(!install){
    const source=require(".").get(context.runtimeId||entry.runtimeId||"crossover");
    install=context.wineEnvironment?.install||source.manager().resolveSelection(entry,context.settings,context.userDataDir,context.runtimeSettings).install;
  }
  if(!install)return [];
  // On a loader that ignores DYLD variables, a graphics value that renders
  // through Vulkan loads no Metal shim, so processing needs a client that
  // applies the graphics libraries.
  const attaches=require("../../shared/effects/execution-requirements").analyze(entry).needed.processor&&
    require("../../../core/runtime-resolution/graphics-policy").rendersThroughVulkan(translatorPlan)&&loadsUnsignedLibraries(install);
  const resolved=wineVulkanRuntimeSelection(entry,context,install,{translatorPlan,root,manager});
  if(resolved.selection&&(!attaches||resolved.selection.graphicsLibraries)){
    if(resolved.managed)context.recordRuntimeUse?.({managerId:manager.id,version:resolved.selected.version,sourcePath:resolved.selected.install.installDir||resolved.selected.install.modulePayloadRoot||resolved.selected.install.executablePath});
    return [];
  }
  // Only an explicitly requested scene feature or that attachment asks for an
  // absent module. Unprofiled or incompatible Wine versions keep their
  // publisher renderer.
  if(!attaches&&context.runtimeSettings?.dlss!==true&&!DLSS.needsSceneInputs(entry.effects))return [];
  const layout=translatorPlan.layout||wineLayout(install),Architecture=require("../../shared/runtime/architecture");
  if(!Architecture.targetArchitecture(layout.architecture)||!layout.primaryWindowsRoot||!layout.unixRoot)return [];
  const compatible=pin=>{
    const binding=pin.runtimeProfile||pin.capabilities?.runtimeProfile||pin.projectPackage?.capabilities?.runtimeProfile;
    if(attaches&&(pin.graphicsLibraryAPI??pin.capabilities?.graphicsLibraryAPI??pin.projectPackage?.capabilities?.graphicsLibraryAPI)!==1)return false;
    const files=wineVulkanProfile(binding,layout),original=path.join(layout.primaryWindowsRoot,"winevulkan.dll"),native=path.join(layout.unixRoot,"winevulkan.so");
    if(!files||!fs.existsSync(original)||!fs.existsSync(native)||!files.has(fs.realpathSync(original))||!files.has(fs.realpathSync(native)))return false;
    const image=require("../../shared/runtime/macho-load-commands").readMachOLoadCommands(native,{signal:context.signal}).slices.find(row=>row.architecture===layout.architecture);
    return Boolean(image&&image.dependencies.every(row=>{
      if(/^\/(?:usr\/lib|System\/Library)\//.test(row.path))return true;
      if(!/^@(?:rpath|loader_path)\/([^/]+)$/.test(row.path))return false;
      const file=path.join(layout.unixRoot,path.basename(row.path));return fs.existsSync(file)&&files.has(fs.realpathSync(file));
    }));
  };
  const catalog=Architecture.withArchitecture(Architecture.normalizeArchitecture(layout.architecture),()=>manager.core.catalog);
  if(!catalog.some(compatible))return [];
  const selected=Architecture.withArchitecture(Architecture.normalizeArchitecture(layout.architecture),()=>manager.resolveSelection({...entry,runtimeId:manager.id},context.settings,context.userDataDir,{verification:"status",compatible}));
  const pin=catalog.find(pin=>pin.version===selected.version);
  if(selected.ready||!pin||!compatible(pin))return [];
  return [{managerId:manager.id,version:selected.version,requiresDownload:true,companion:true,installOptions:{architecture:Architecture.normalizeArchitecture(layout.architecture)},
    label:manager.label,...(pin.asset?.bytes?{bytes:pin.asset.bytes}:{}),detail:"Provides scene frames through the selected Wine's matching Vulkan interface."}];
}
// `source` is the Wine source descriptor (sources/<id>.js). Without a
// translator plan, the Sikarugir Template's own renderer selection applies.
async function prepareGraphicsView({ source = require(".").get("sikarugir"), install, settings = {}, prefixPath, viewRoot, host = {}, signal, executableArchitecture, cameraBridge, vulkanDLSS, vulkanSelection, helperLibraries = [], translatorPlan, translatorView, environment, context, userDataDir } = {}) {
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
  if(!translatorPlan)throw new Error('A resolved runtime plan is required before preparing Wine graphics.');
  const native = source.nativeLibraries(install);
  const engine = engineRoot(install), hostInfo = {
    hardwareArch: require("../../shared/runtime/host-capabilities").getHostCapabilities().hardwareArch, ...host };
  const layout = translatorPlan?.layout || wineLayout(install);
  let capabilities = { ...install.capabilities, wined3d: true, componentVersions: {} };
  const hardware = capabilities.kosmickrisp && (!settings.vulkanBackend || settings.vulkanBackend === "auto")
    ? await Hardware.graphicsHardware(hostInfo, { signal }) : { physicalAppleGPU: hostInfo.physicalAppleGPU === true, source: "not-required" };
  hostInfo.physicalAppleGPU = hardware.physicalAppleGPU;
  if (cameraBridge) capabilities.dxmt = true;
  const selection = { graphicsBackend: translatorPlan.apiMode ? 'wined3d' : translatorPlan.components["d3d-renderer"].used?.engine || "auto",
    vulkanBackend: translatorPlan.components["vulkan-driver"].used?.engine || "auto", components: [] };
  // The DXMT builds the plan uses; one of them renders the camera route.
  const dxmt = require("../../shared/runtime/translator-roles").usedRenderers(translatorPlan).filter(item => item.engine === "dxmt");
  let dlss = DLSS.checkSelection(settings, { ...hostInfo, executableArchitecture, translatorPlan, vulkan: vulkanDLSS?.enabled===true,
    backend: dxmt.length ? "dxmt" : selection.graphicsBackend === "auto" ? "wined3d" : selection.graphicsBackend,
    dxmt: settings.dlss === true && (Boolean(cameraBridge) || DLSS.hasPlanLibraries(translatorPlan, "dxmt")),
    d3dmetal: settings.dlss === true && DLSS.hasPlanLibraries(translatorPlan, "d3dmetal") });
  if (dlss.d3dmetal && !await DLSS.hasD3DMetalPathBridge(engine)) {
    if (settings.dlssOptional !== true) fail("The selected Wine engine cannot expose MetalFX Temporal through D3DMetal's game integration. Choose DXMT, select a compatible newer Wine version, or disable MetalFX Temporal.");
    dlss = { ...dlss, d3dmetal: false, enabled: dlss.dxmt || dlss.vulkan === true };
  }
  const destination = prospectiveRealPath(viewRoot || ".");
  // The engine, its installation and its support libraries are shared by every game.
  const shared = [engine, ...[install.installDir, install.templateRoot || install.supportRoot].filter(root => path.isAbsolute(root || "") && fs.existsSync(root)).map(root => fs.realpathSync(root))];
  if (shared.some(root => Closure.inside(root, destination))) fail("Per-game graphics state must be outside the shared runtime.");
  ownDirectory(viewRoot);
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
  const loader = await prepareLoaderView(engine, viewRoot, install, signal, source);
  const runtimeLibrary = !environment && graphicsLayerRoute(install) === "runtime-library" ? runtimeLibraryRoute(install, translatorPlan.graphicsPolicy?.env?.DXMT_RUNTIME_DIR) : null;
  const runtimeLibraryRoot = runtimeLibrary ? await prepareRuntimeLibraryView(runtimeLibrary, viewRoot, signal) : null;
  const dllRoot = loader.dllRoot, dllOverrides = [];
  ownDirectory(dllRoot);
  for (const architecture of [...layout.windows, layout.unixName]) ownDirectory(path.join(dllRoot, architecture));
  if (translatorView) {
    // DXMT's NVIDIA libraries join the view only while its DLSS integration is on.
    const dxmtRoots = dxmt.filter(item => item.root && fs.existsSync(item.root)).map(item => fs.realpathSync(item.root)), withheld = new Set();
    for (const [relative, original] of Object.entries(translatorView.links)) {
      const name = path.basename(relative, ".dll").toLowerCase();
      if (!dlss.dxmt && relative.endsWith(".dll") && DLSS.DLLS.includes(name) && dxmtRoots.some(root => Closure.inside(root, fs.realpathSync(original)))) { withheld.add(name); continue; }
      const source = cameraBridge ? require("../temporal").rendererFile(cameraBridge, path.basename(path.dirname(relative)), path.basename(relative), original) : original;
      await linkFile(source, path.join(loader.wineRoot, relative), signal);
    }
    // The camera adapter forwards to the selected DXMT's own native library through a private alias.
    if (cameraBridge && dxmt.length && dlss.dxmt) await linkFile(cameraBridge.dxmt.native, require("../temporal").environment(cameraBridge, dllRoot).MACLAUNCHER_DXMT_BASE_LIBRARY, signal);
    // Wine opens a builtin's Unix module beside the folder it loaded the
    // builtin from. A set that supplies a builtin without its Unix module,
    // such as WineCX's DXMT winemetal.dll, uses the engine's module of that name.
    for (const relative of Object.keys(translatorView.links)) {
      const name = /^lib\/wine\/[^/]+-windows\/([^/]+)\.dll$/i.exec(relative)?.[1], unix = name && `lib/wine/${layout.unixName}/${name}.so`;
      if (!unix || Object.hasOwn(translatorView.links, unix) || fs.existsSync(path.join(loader.wineRoot, unix))) continue;
      const own = path.join(engine, unix);
      if (fs.existsSync(own)) await linkFile(own, path.join(loader.wineRoot, unix), signal);
    }
    // Wine opens its Vulkan library by name, and dyld resolves that name through
    // the Unix module's own rpath (the engine's library folder) before the
    // fallback path. Wine reads CX_LIBVULKAN only with the wined3d backend. The
    // names of a selected Vulkan driver therefore join ntdll in the folder that
    // DYLD_LIBRARY_PATH searches first.
    for (const name of require('../../shared/runtime/translator-files').VULKAN_LIBRARY_NAMES) {
      const relative = `lib/wine/${layout.unixName}/${name}`;
      if (Object.hasOwn(translatorView.links, relative)) await linkFile(translatorView.links[relative], path.join(loader.libraryOverride, name), signal);
    }
    for (const line of translatorView.dllOverrides) {
      const [names, mode] = line.split("="), kept = names.split(",").filter(name => !withheld.has(name.toLowerCase()));
      if (kept.length) dllOverrides.push(kept.join(",") + "=" + mode);
    }
  }
  for (const helper of helpers) {
    await linkFile(helper.windows, path.join(dllRoot, layout.primaryWindows, helper.name + ".dll"), signal);
    await linkFile(helper.unix, path.join(dllRoot, layout.unixName, helper.name + ".so"), signal);
    dllOverrides.push(helper.name + "=b");
  }
  const gstreamer = native.gstreamer;
  const libraryPaths = [...new Set([path.join(dllRoot, layout.unixName), path.join(engine, "lib", "wine", layout.unixName), ...native.libraries,
    ...(gstreamer ? [gstreamer.lib] : [])])];
  // Only ntdll's private anchor overrides lookup: Unix Wine modules must reuse
  // its initialized copy. Vendor dependencies must not replace system libraries
  // loaded by Apple frameworks in the same process.
  const env = { WINEDLLPATH: path.join(engine, "lib", "wine"),
    DYLD_LIBRARY_PATH: loader.libraryOverride,
    DYLD_FALLBACK_LIBRARY_PATH: libraryPaths.join(path.delimiter),
    ...(native.frameworks.length ? { DYLD_FALLBACK_FRAMEWORK_PATH: native.frameworks.join(path.delimiter) } : {}),
    GST_REGISTRY_1_0: path.join(viewRoot, "gstreamer-registry.bin"),
    ...(runtimeLibraryRoot ? { DXMT_RUNTIME_DIR: runtimeLibraryRoot } : {}) };
  Object.assign(env, DLSS.environment(dlss), DLSS.adapterEnvironment(dlss, install?.capabilities));
  if (dxmt.length && dlss.dxmt) Object.assign(env, require("../temporal").environment(cameraBridge, dllRoot));
  if (gstreamer) {
    env.GST_PLUGIN_SYSTEM_PATH_1_0 = gstreamer.plugins;
    env.GST_PLUGIN_PATH_1_0 = "";
    if (gstreamer.scanner && fs.existsSync(gstreamer.scanner)) env.GST_PLUGIN_SCANNER_1_0 = gstreamer.scanner;
  }

  if (translatorView) {
    Object.assign(env, translatorView.env);
    // The graphics layer's runtime folder stands in for the plan's DXMT folder.
    if (runtimeLibraryRoot) env.DXMT_RUNTIME_DIR = runtimeLibraryRoot;
    env.DYLD_FALLBACK_LIBRARY_PATH = [...translatorView.libraryPaths, env.DYLD_FALLBACK_LIBRARY_PATH].filter(Boolean).join(path.delimiter);
    env.DYLD_FALLBACK_FRAMEWORK_PATH = [...translatorView.frameworkPaths, env.DYLD_FALLBACK_FRAMEWORK_PATH].filter(Boolean).join(path.delimiter);
    if (Object.keys(translatorView.links).some(name => name.endsWith(".dll"))) env.WINEDLLPATH = [...layout.windows.map(name => path.join(dllRoot, name)), dllRoot, layout.dllRoot].join(path.delimiter);
  }
  signal?.throwIfAborted();
  const writesBuiltinPrefix = !environment || Object.values(translatorPlan?.components || {}).some(row => row.used && !row.inherited && row.used.files.some(file => file.format === 'pe' && file.form === 'builtin'));
  let prepared, restored = false;
  const lifecycle = vulkanSelection ? {
    async restore() { restored = true;await prepared?.restore(); },
    async applyPrefix() {
      signal?.throwIfAborted();
      if (restored) fail("The WineVulkan selection has already been restored.");
      if (writesBuiltinPrefix) await registerPrefixLibraries(prefixPath, viewRoot, dllRoot, signal, layout);
      if (!prepared) {
        prepared = await prepareWineVulkanView(vulkanSelection,{prefixPath,dllRoot,layout,signal});
        // Publish cleanup before the first prefix replacement, including aborts.
        if (restored) { await prepared.restore();fail("The WineVulkan selection was cancelled."); }
        env.WINEDLLPATH = [prepared.env.WINEDLLPATH, env.WINEDLLPATH].filter(Boolean).join(path.delimiter);
        dllOverrides.push(...prepared.env.WINEDLLOVERRIDES.split(";").filter(Boolean));
      }
      signal?.throwIfAborted();
      await prepared.applyPrefix();
    },
  } : path.isAbsolute(prefixPath || "") && writesBuiltinPrefix ? { applyPrefix: () => registerPrefixLibraries(prefixPath, viewRoot, dllRoot, signal, layout) } : {};
  const result = { ...selection, ...loader, env, dllOverrides, translatorPlan, ...lifecycle,
    capabilities, hardware, dlss, componentVersions: capabilities.componentVersions, viewRoot, prefixPath,
    ...(inProcessGraphics(install, { runtimeLibraryRoot, vulkanSelection, environment }) ? { inProcessGraphics: true } : {}) };
  if (vulkanSelection) Object.defineProperty(result, "vulkanNative", { enumerable: true, get: () => prepared?.native });
  return result;
}

module.exports = { GRAPHICS_BACKENDS, VULKAN_BACKENDS, VIEW_LAYOUT, publisherSigned, graphicsLayerAttachable, graphicsLayerRoute, loadsUnsignedLibraries, inProcessGraphics, runtimeLibraryRoute, prepareRuntimeLibraryView, gameLoader, keepBundleLoader, gameBundleInfo, prepareGraphicsView, wineVulkanSelection, wineVulkanRuntimeSelection, prepareWineVulkan, prepareWineVulkanView, wineVulkanRequirements, capabilitiesFor,
  __test: { capabilitiesFor, ownDirectory, prepareLoaderView, CORE_DLLS } };
