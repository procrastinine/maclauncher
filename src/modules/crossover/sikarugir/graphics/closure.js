const fs = require("node:fs");
const { cloneOrCopy } = require("../../../shared/copy-file");
const path = require("node:path");
const { readMachOLoadCommands } = require("../../../shared/runtime/macho-load-commands");
const { versionAtLeast } = require("../../../shared/runtime/bundled-native");
const { TEMPLATE_RENDERERS } = require("../../../shared/runtime/feature-requirements");

// Installed support copies always use this layout, whatever the Template's own.
const RELATIVE_PATHS = Object.freeze({ frameworks: "Frameworks", renderers: "Frameworks/renderer", vulkan: "Resources/vulkan/icd.d" });
// Lowest macOS versions for optional components. A component library that
// declares a later deployment target raises its floor. D3DMetal's compiler
// dependency floor is recorded with the shared Template requirements.
const MINIMUM_MACOS = Object.freeze(Object.fromEntries(Object.entries(TEMPLATE_RENDERERS).map(([name, required]) => [name, required.minimumMacOS])));
const MAGIC = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca]);
const inside = (root, file) => file === root || file.startsWith(root + path.sep);
function fail(message) { throw new Error(`Sikarugir graphics: ${message}`); }
function contentsDirectory(input) {
  const root = fs.realpathSync(input);
  if (fs.existsSync(path.join(root, "Frameworks"))) return root;
  if (fs.existsSync(path.join(root, "Contents", "Frameworks"))) return path.join(root, "Contents");
  fail("The selected graphics package has no runtime libraries.");
}
// Templates unpack to Template-<version>.app. A package that renames the
// bundle or moves it deeper is found by its Contents/Frameworks folder.
function templateContents(root, version) {
  const known = path.join(root, `Template-${version}.app`, "Contents"), found = [];
  if (fs.existsSync(path.join(known, "Frameworks"))) return known;
  (function visit(directory, depth) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === "__MACOSX") continue;
      const child = path.join(directory, entry.name);
      if (entry.name.endsWith(".app") && fs.existsSync(path.join(child, "Contents", "Frameworks"))) found.push(path.join(child, "Contents"));
      else if (depth < 3 && !entry.name.endsWith(".app")) visit(child, depth + 1);
    }
  })(root, 0);
  return found.length === 1 ? found[0] : known;
}
// Templates keep their renderer packages in a "renderer" folder directly inside
// one top-level folder of the bundle's Contents: Frameworks in earlier
// releases and SharedSupport in later ones. Returns its Contents-relative path.
function templateRenderers(root, version) {
  const directory = relative => {
    try { return fs.lstatSync(path.join(root, relative)).isDirectory(); } catch { return false; }
  };
  const modern = typeof version === "string" && versionAtLeast(version, "1.0.24");
  const preferred = modern ? ["SharedSupport/renderer", "Frameworks/renderer"] : ["Frameworks/renderer", "SharedSupport/renderer"];
  for (const relative of preferred) if (directory(relative)) return relative;
  // A later Template may move the packages again. Search the contents only
  // when neither known layout exists, without following directory aliases.
  const found = [];
  let visited = 0;
  function visit(relative, depth) {
    if (++visited > 10000) fail("The graphics package contains too many folders.");
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const child = path.posix.join(relative, entry.name);
      if (entry.name === "renderer") found.push(child);
      else if (depth < 4) visit(child, depth + 1);
    }
  }
  visit("", 0);
  if (found.length > 1) fail("The graphics package contains more than one renderer folder.");
  return found[0] || null;
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
function inspectTemplateClosure(templateRoot, { signal, templateVersion } = {}) {
  const root = contentsDirectory(templateRoot), frameworks = path.join(root, RELATIVE_PATHS.frameworks);
  const templateRendererPath = templateRenderers(root, templateVersion), rendererRoot = templateRendererPath && path.join(root, templateRendererPath);
  // Renderer files are recorded at their installed location, Frameworks/renderer.
  const records = [...walk(frameworks, signal).filter(record => record.relative !== "renderer" && !record.relative.startsWith("renderer" + path.sep)),
    ...(rendererRoot ? walk(rendererRoot, signal).map(record => ({ ...record, relative: path.join("renderer", record.relative) })) : [])];
  const nativeDependencies = [], floors = {};
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
  const componentVersions = {}, rendererFile = (...parts) => rendererRoot ? path.join(rendererRoot, ...parts) : null;
  const exists = file => Boolean(file) && fs.existsSync(file);
  for (const name of ["dxmt", "dxvk", "dxvk3", "d9vk", "cnc_ddraw"]) {
    const file = rendererFile(name, "version");
    if (exists(file)) componentVersions[name] = boundedText(file, 4096).trim();
  }
  const versionPlist = rendererFile("d3dmetal", "external", "D3DMetal.framework", "Versions", "A", "Resources", "version.plist");
  if (exists(versionPlist)) {
    const bytes = boundedText(versionPlist);
    componentVersions.d3dmetal = bytes.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/)?.[1] || "D3DMetal";
  }
  const graphicsCapabilities = {
    dxmt: exists(rendererFile("dxmt", "wine", "x86_64-unix", "winemetal.so")),
    dxvk: exists(rendererFile("dxvk", "wine", "x86_64-windows", "d3d11.dll")),
    dxvk3: exists(rendererFile("dxvk3", "wine", "x86_64-windows", "d3d11.dll")),
    d9vk: exists(rendererFile("d9vk", "wine", "i386-windows", "d3d9.dll")),
    cncDdraw: exists(rendererFile("cnc_ddraw", "wine", "i386-windows", "ddraw.dll")),
    d3dmetal: exists(rendererFile("d3dmetal", "wine", "x86_64-windows", "d3d12.dll")),
    moltenvk: fs.existsSync(path.join(frameworks, "libMoltenVK.dylib")) && fs.existsSync(path.join(root, RELATIVE_PATHS.vulkan, "MoltenVK_icd.json")),
    kosmickrisp: fs.existsSync(path.join(frameworks, "libvulkan_kosmickrisp.dylib")) && fs.existsSync(path.join(root, RELATIVE_PATHS.vulkan, "kosmickrisp_mesa_icd.json")),
    minimumMacOS: { ...floors, ...Object.fromEntries(Object.entries(MINIMUM_MACOS).map(([name, floor]) => [name, later(floors[name] || floor, floor)])) }
  };
  return { relativePaths: { ...RELATIVE_PATHS, templateRenderers: templateRendererPath }, minimumBaseMacOS, graphicsCapabilities, componentVersions, nativeDependencies };
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
  await cloneOrCopy(source, destination, { signal });
  await fs.promises.chmod(destination, stat.mode & 0o777);
}
async function stageTemplateClosure({ templateRoot, destinationRoot, signal, templateVersion } = {}) {
  const root = contentsDirectory(templateRoot), destination = path.resolve(destinationRoot);
  if (!path.isAbsolute(destinationRoot || "") || inside(root, destination) || inside(destination, root)) fail("Runtime libraries require a separate installation directory.");
  if (fs.existsSync(destination)) fail("The graphics installation directory already exists.");
  const metadata = inspectTemplateClosure(root, { signal, templateVersion });
  try {
    await fs.promises.mkdir(destination, { recursive: true });
    await fs.promises.mkdir(path.join(destination, "Frameworks"));
    const sourceFrameworks = path.join(root, "Frameworks");
    for (const entry of await fs.promises.readdir(sourceFrameworks, { withFileTypes: true })) {
      if (entry.name !== "GStreamer.framework" && !entry.name.endsWith(".dylib")) continue;
      await copyTree(path.join(sourceFrameworks, entry.name), path.join(destination, "Frameworks", entry.name), sourceFrameworks, signal);
    }
    if (metadata.relativePaths.templateRenderers) {
      const sourceRenderers = path.join(root, metadata.relativePaths.templateRenderers);
      await copyTree(sourceRenderers, path.join(destination, RELATIVE_PATHS.renderers), sourceRenderers, signal);
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

module.exports = { RELATIVE_PATHS, MINIMUM_MACOS, templateContents, templateRenderers, stageTemplateClosure, inspectTemplateClosure, inside, boundedText };
