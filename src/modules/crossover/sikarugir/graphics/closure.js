const fs = require("node:fs");
const path = require("node:path");
const { readMachOLoadCommands } = require("../../../shared/runtime/macho-load-commands");
const { versionAtLeast } = require("../../../shared/runtime/bundled-native");

const RELATIVE_PATHS = Object.freeze({ frameworks: "Frameworks", renderers: "Frameworks/renderer", vulkan: "Resources/vulkan/icd.d" });
const MAGIC = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca]);
const inside = (root, file) => file === root || file.startsWith(root + path.sep);
function fail(message) { throw new Error(`Sikarugir graphics: ${message}`); }
function contentsDirectory(input) {
  const root = fs.realpathSync(input);
  if (fs.existsSync(path.join(root, "Frameworks"))) return root;
  if (fs.existsSync(path.join(root, "Contents", "Frameworks"))) return path.join(root, "Contents");
  fail("The selected graphics package has no runtime libraries.");
}
function boundedText(file, maximum = 128 * 1024) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > maximum) fail("Runtime metadata exceeds its supported size.");
  return fs.readFileSync(file, "utf8");
}
function walk(root, signal) {
  const records = [];
  function visit(directory) {
    signal?.throwIfAborted();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name), relative = path.relative(root, file);
      if (records.length >= 10000) fail("The graphics package contains too many files.");
      if (entry.isSymbolicLink()) {
        const target = fs.readlinkSync(file), real = fs.realpathSync(file);
        if (path.isAbsolute(target) || !inside(root, real)) fail("A runtime library link escapes its package.");
        records.push({ file, relative, target });
      } else if (entry.isDirectory()) { records.push({ file, relative, directory: true }); visit(file); }
      else if (entry.isFile()) records.push({ file, relative });
      else fail("The graphics package contains a nonregular file.");
    }
  }
  visit(root); return records;
}
function nativeImage(file, signal) {
  const fd = fs.openSync(file, "r"), bytes = Buffer.alloc(4);
  try { if (fs.readSync(fd, bytes, 0, 4, 0) !== 4 || !MAGIC.has(bytes.readUInt32BE(0))) return null; }
  finally { fs.closeSync(fd); }
  return readMachOLoadCommands(file, { architecture: "x86_64", signal });
}
function later(a, b) { return versionAtLeast(a, b) ? a : b; }
function inspectTemplateClosure(templateRoot, { signal } = {}) {
  const root = contentsDirectory(templateRoot), frameworks = path.join(root, RELATIVE_PATHS.frameworks);
  const records = walk(frameworks, signal), nativeDependencies = [], floors = {};
  let minimumBaseMacOS = "11.0.0";
  for (const record of records) {
    if (record.directory || record.target || record.relative.startsWith("SikarugirSdk.framework")) continue;
    signal?.throwIfAborted();
    const image = nativeImage(record.file, signal);
    if (!image) continue;
    const slice = image.slices[0];
    if (slice.platform !== 1 || !slice.minimumMacOS) fail("A native runtime library has no macOS deployment version.");
    const component = record.relative.startsWith("renderer/") ? record.relative.split("/")[1]
      : record.relative === "libvulkan_kosmickrisp.dylib" ? "kosmickrisp" : "base";
    floors[component] = later(floors[component] || "0.0.0", slice.minimumMacOS);
    if (component === "base") minimumBaseMacOS = later(minimumBaseMacOS, slice.minimumMacOS);
    nativeDependencies.push({ path: record.relative, architecture: slice.architecture, minimumMacOS: slice.minimumMacOS,
      dependencies: slice.dependencies.map(item => item.path) });
  }
  const rendererRoot = path.join(frameworks, "renderer"), componentVersions = {};
  for (const name of ["dxmt", "dxvk", "dxvk3", "d9vk", "cnc_ddraw"]) {
    const file = path.join(rendererRoot, name, "version");
    if (fs.existsSync(file)) componentVersions[name] = boundedText(file, 4096).trim();
  }
  const versionPlist = path.join(rendererRoot, "d3dmetal", "external", "D3DMetal.framework", "Versions", "A", "Resources", "version.plist");
  if (fs.existsSync(versionPlist)) {
    const bytes = boundedText(versionPlist);
    componentVersions.d3dmetal = bytes.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/)?.[1] || "D3DMetal";
  }
  const graphicsCapabilities = {
    dxmt: fs.existsSync(path.join(rendererRoot, "dxmt", "wine", "x86_64-unix", "winemetal.so")),
    dxvk: fs.existsSync(path.join(rendererRoot, "dxvk", "wine", "x86_64-windows", "d3d11.dll")),
    dxvk3: fs.existsSync(path.join(rendererRoot, "dxvk3", "wine", "x86_64-windows", "d3d11.dll")),
    d9vk: fs.existsSync(path.join(rendererRoot, "d9vk", "wine", "i386-windows", "d3d9.dll")),
    cncDdraw: fs.existsSync(path.join(rendererRoot, "cnc_ddraw", "wine", "i386-windows", "ddraw.dll")),
    d3dmetal: fs.existsSync(path.join(rendererRoot, "d3dmetal", "wine", "x86_64-windows", "d3d12.dll")),
    moltenvk: fs.existsSync(path.join(frameworks, "libMoltenVK.dylib")) && fs.existsSync(path.join(root, RELATIVE_PATHS.vulkan, "MoltenVK_icd.json")),
    kosmickrisp: fs.existsSync(path.join(frameworks, "libvulkan_kosmickrisp.dylib")) && fs.existsSync(path.join(root, RELATIVE_PATHS.vulkan, "kosmickrisp_mesa_icd.json")),
    minimumMacOS: { ...floors, dxmt: later(floors.dxmt || "14.0.0", "14.0.0"), d3dmetal: later(floors.d3dmetal || "14.0.0", "14.0.0"),
      kosmickrisp: later(floors.kosmickrisp || "26.0.0", "26.0.0") }
  };
  return { relativePaths: { ...RELATIVE_PATHS }, minimumBaseMacOS, graphicsCapabilities, componentVersions, nativeDependencies };
}
async function copyTree(source, destination, sourceRoot, signal) {
  signal?.throwIfAborted();
  const stat = await fs.promises.lstat(source);
  if (stat.isSymbolicLink()) {
    const target = await fs.promises.readlink(source), real = await fs.promises.realpath(source);
    if (path.isAbsolute(target) || !inside(sourceRoot, real)) fail("A runtime library link escapes its package.");
    await fs.promises.symlink(target, destination); return;
  }
  if (stat.isDirectory()) {
    await fs.promises.mkdir(destination, { mode: stat.mode & 0o777 });
    for (const name of await fs.promises.readdir(source)) await copyTree(path.join(source, name), path.join(destination, name), sourceRoot, signal);
    return;
  }
  if (!stat.isFile()) fail("The graphics package contains a nonregular file.");
  await fs.promises.copyFile(source, destination, fs.constants.COPYFILE_FICLONE);
  await fs.promises.chmod(destination, stat.mode & 0o777);
}
async function stageTemplateClosure({ templateRoot, destinationRoot, signal } = {}) {
  const root = contentsDirectory(templateRoot), destination = path.resolve(destinationRoot);
  if (!path.isAbsolute(destinationRoot || "") || inside(root, destination) || inside(destination, root)) fail("Runtime libraries require a separate installation directory.");
  if (fs.existsSync(destination)) fail("The graphics installation directory already exists.");
  const metadata = inspectTemplateClosure(root, { signal });
  try {
    await fs.promises.mkdir(destination, { recursive: true });
    await fs.promises.mkdir(path.join(destination, "Frameworks"));
    const sourceFrameworks = path.join(root, "Frameworks");
    for (const entry of await fs.promises.readdir(sourceFrameworks, { withFileTypes: true })) {
      if (entry.name === "SikarugirSdk.framework") continue;
      if (entry.name !== "renderer" && entry.name !== "GStreamer.framework" && !entry.name.endsWith(".dylib")) continue;
      await copyTree(path.join(sourceFrameworks, entry.name), path.join(destination, "Frameworks", entry.name), sourceFrameworks, signal);
    }
    await fs.promises.mkdir(path.join(destination, "Resources"));
    if (fs.existsSync(path.join(root, "Resources", "vulkan"))) {
      walk(path.join(root, "Resources", "vulkan"), signal);
      await copyTree(path.join(root, "Resources", "vulkan"), path.join(destination, "Resources", "vulkan"), root, signal);
    }
    await fs.promises.writeFile(path.join(destination, "graphics.json"), JSON.stringify({ schemaVersion: 1, ...metadata }, null, 2) + "\n");
    signal?.throwIfAborted();
    return metadata;
  } catch (error) { await fs.promises.rm(destination, { recursive: true, force: true }); throw error; }
}

module.exports = { RELATIVE_PATHS, stageTemplateClosure, inspectTemplateClosure, inside, boundedText };
