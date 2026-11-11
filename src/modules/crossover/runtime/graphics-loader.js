const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { cloneOrCopy } = require("../../shared/copy-file");
const { execFile } = require("node:child_process"), { promisify } = require("node:util");
const Writable = require("../../shared/writable-input");
const { wineLayout } = require("../../shared/runtime/wine-layout");
const warn = require("../../shared/graphics-warning");
const executeFile = promisify(execFile), MAXIMUM = 16 * 1024 * 1024;
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function entitlements(xml) {
  const key = "com.apple.security.cs.allow-dyld-environment-variables";
  if (!/^\s*<\?xml\b/.test(xml) || !/<dict>/.test(xml) || !/<\/dict>\s*<\/plist>\s*$/.test(xml))
    throw new Error("CrossOver's loader permissions could not be read.");
  const existing = /(<key>com\.apple\.security\.cs\.allow-dyld-environment-variables<\/key>\s*)<(?:true|false)\s*\/>/;
  return existing.test(xml) ? xml.replace(existing, "$1<true/>")
    : xml.replace(/<\/dict>\s*<\/plist>\s*$/, `<key>${key}</key><true/></dict></plist>\n`);
}
async function prepare(installation, directory, { signal, execute = executeFile, cameraBridge, winemac, helperLibraries = [], translatorView, userDataDir, logger = console } = {}) {
  signal?.throwIfAborted();
  const vendor = fs.realpathSync(installation.crossoverRoot), layout = wineLayout(installation), unix = `lib/wine/${layout.unixName}`;
  if(cameraBridge?.kind === "d3dmetal-camera") helperLibraries=[...helperLibraries,cameraBridge.helper];
  const separateLoader = fs.existsSync(path.join(vendor, unix, "ntdll.so")) && fs.existsSync(path.join(vendor, unix, "wine"));
  const sources = [["bin/wineloader", installation.loaderPath, true], ...(separateLoader ? [
    [`${unix}/ntdll.so`, path.join(vendor, unix, "ntdll.so"), false],
    [`${unix}/wine`, path.join(vendor, unix, "wine"), true],
  ] : [])].map(([name, file, sign]) => {
    const source = fs.realpathSync(file), stat = fs.statSync(source);
    if (!stat.isFile() || stat.size > MAXIMUM) throw new Error("CrossOver's graphics loader is unavailable.");
    return { name, source, sign, mode: stat.mode & 0o777, sha256: digest(fs.readFileSync(source)) };
  });
  const links = separateLoader ? { "bin/wineserver": installation.serverPath || path.join(vendor, "bin/wineserver"), share: path.join(vendor, "share") } : {};
  if (separateLoader) {
    // Unix counterparts of built-in DLLs are loaded from the primary directory,
    // independently of the selected Windows DLL search path.
    for (const name of fs.readdirSync(path.join(vendor, unix)).sort()) {
      if (name !== "ntdll.so" && /\.(?:so|dylib)$/.test(name)) links[`${unix}/${name}`] = path.join(vendor, unix, name);
    }
    // Keep backend redirects relative to the private Wine root faithful to
    // the vendor layout; the wine view retains its explicit overrides below.
    for (const name of fs.readdirSync(path.join(vendor, "lib")).sort())
      if (name !== "wine") links[`lib/${name}`] = path.join(vendor, "lib", name);
    if (fs.existsSync(path.join(vendor, "lib64"))) links.lib64 = path.join(vendor, "lib64");
  }
  for (const architecture of separateLoader ? layout.windows : []) {
    // WoW64 also resolves builtins relative to the real ntdll.so's Wine root,
    // before WINEDLLPATH. Keep each vendor Windows view complete, then apply
    // the selected translator and camera overrides below.
    for (const name of fs.readdirSync(path.join(vendor, "lib/wine", architecture)).sort()) {
      const relative = `lib/wine/${architecture}/${name}`;
      links[relative] = path.join(vendor, relative);
    }
    for (const name of ["ntdll.dll", "apisetschema.dll"]) {
      const relative = `lib/wine/${architecture}/${name}`, source = path.join(vendor, relative);
      if (!fs.existsSync(source) && architecture === layout.primaryWindows) throw new Error("CrossOver's graphics loader is incomplete.");
    }
  }
  if (translatorView) Object.assign(links, translatorView.links);
  if (cameraBridge?.dxmt && separateLoader) {
    const Temporal = require("../temporal");
    for (const relative of Temporal.rendererFiles(cameraBridge)) links[`lib/wine/${relative}`] = path.join(cameraBridge.dxmt.directory, relative);
    links[`lib/wine/${layout.unixName}/maclauncher-dxmt-original.so`] = cameraBridge.dxmt.native;
    // The adapted PE closure retains the selected renderer's original native
    // thunk and NVIDIA capability bridge.
    for (const name of ["winemetal", "nvapi64", ...(!cameraBridge.dxmtRoles||cameraBridge.dxmtRoles.includes("d3d11")?["d3d10core"]:[])]) links[`lib/wine/${layout.primaryWindows}/${name}.dll`] = path.join(cameraBridge.baseRoot, layout.primaryWindows, name + ".dll");
  }
  if (winemac) {
    if (!separateLoader || layout.unixName !== 'x86_64-unix' || digest(fs.readFileSync(winemac.path)) !== winemac.sha256)
      throw new Error('The optional CrossOver graphics integration is unavailable.');
    links[`${unix}/winemac.so`] = winemac.path;
  }
  const helpers = [];
  if (helperLibraries.length && !separateLoader) throw new Error("The selected Wine loader cannot attach its native graphics helper.");
  for (const helper of helperLibraries) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(helper.name || ""))
      throw new Error("The native graphics helper has an invalid module name.");
    for (const [kind, extension, architecture] of [["windows", ".dll", layout.primaryWindows], ["unix", ".so", layout.unixName]]) {
      const source = fs.realpathSync(helper[kind]), stat = fs.statSync(source);
      if (!stat.isFile() || stat.size > MAXIMUM) throw new Error("The native graphics helper is unavailable.");
      const name = `lib/wine/${architecture}/${helper.name}${extension}`;
      if (Object.hasOwn(links, name)) throw new Error("The native graphics helper conflicts with an existing Wine module.");
      links[name] = source;helpers.push({ name, source, sha256: digest(fs.readFileSync(source)) });
    }
  }
  // The DXMT camera bridge opens the renderer's original native library through
  // an alias whose real file stays in the renderer package. dyld resolves that
  // library's @rpath/winemac.so from the real location, so the loader's own
  // Mac driver joins the private lookup directory beside ntdll.
  // Wine opens its Vulkan library by name, and dyld resolves that name through
  // win32u's rpath (CrossOver's lib64) before the fallback path; CrossOver reads
  // CX_LIBVULKAN only with the wined3d backend. A selected Vulkan driver's names
  // therefore join the same private lookup directory.
  const vulkanLinks = Object.fromEntries(require("../../shared/runtime/translator-files").VULKAN_LIBRARY_NAMES
    .filter(name => Object.hasOwn(translatorView?.links || {}, `${unix}/${name}`)).map(name => [`loader-libraries/${name}`, `../${unix}/${name}`]));
  const localLinks = separateLoader ? { "loader-libraries/ntdll.so": `../${unix}/ntdll.so`,
    ...(cameraBridge?.dxmt ? { "loader-libraries/winemac.so": `../${unix}/winemac.so` } : {}), ...vulkanLinks } : {};
  const sourceHash = digest(JSON.stringify([6, sources, links, localLinks, helpers, translatorView?.identity, ...(winemac ? [winemac.sha256] : [])])), store = userDataDir || directory, root = path.join(store, userDataDir ? "graphics/crossover-loaders" : "graphics-loader");
  let destination = path.join(root, sourceHash.slice(0, 24));
  Writable.assertOwnDirectory(store, root);
  while (fs.existsSync(destination)) {
    Writable.assertOwnDirectory(root, destination, { create: false });
    try {
      const record = JSON.parse(fs.readFileSync(path.join(destination, "loader.json"), "utf8"));
      const filesMatch = sources.every(({ name }) => {
        const file = path.join(destination, name);
        Writable.assertOwnDirectory(destination, path.dirname(file), { create: false });
        const stat = fs.lstatSync(file);
        return stat.isFile() && !stat.isSymbolicLink() && stat.size <= MAXIMUM && digest(fs.readFileSync(file)) === record.files?.[name];
      });
      const linksMatch = Object.entries(links).every(([name, source]) => {
        const file = path.join(destination, name);
        Writable.assertOwnDirectory(destination, path.dirname(file), { create: false });
        return fs.lstatSync(file).isSymbolicLink() && fs.realpathSync(file) === fs.realpathSync(source);
      }) && Object.entries(localLinks).every(([name, target]) => {
        const file = path.join(destination, name);
        return fs.lstatSync(file).isSymbolicLink() && fs.readlinkSync(file) === target &&
          fs.realpathSync(file) === fs.realpathSync(path.resolve(path.dirname(file), target));
      });
      if (record.schema === 2 && record.sourceHash === sourceHash && filesMatch && linksMatch) return path.join(destination, "bin/wineloader");
    } catch { /* An incomplete cache must not be executed. */ }
    warn(logger, "The prepared CrossOver graphics loader is stale. Preparing another shared generation; the old view is retained.");
    destination = path.join(root, digest(path.basename(destination)).slice(0, 24));
  }
  const temporary = await fs.promises.mkdtemp(path.join(root, "prepare-"));
  const permissions = path.join(temporary, "entitlements.plist");
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("DYLD_") || key.startsWith("RESHADE_")) delete env[key];
  const options = { signal, env, encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024 };
  try {
    const files = {};
    // Wine derives its child loader from the real path of ntdll.so. Keep a real
    // copy beside the distinct Unix loader so re-exec preserves both its address
    // space layout and permission to load the adapter. Vendor modules stay
    // linked in the complete loader-relative view, beneath graphics overrides.
    for (const { name, source, mode, sign } of sources) {
      signal?.throwIfAborted();
      const copy = path.join(temporary, name);
      await fs.promises.mkdir(path.dirname(copy), { recursive: true });
      await cloneOrCopy(source, copy, { signal, exclusive: true });
      await fs.promises.chmod(copy, mode);
      if (sign) {
        const metadata = await execute("/usr/bin/codesign", ["-d", "--entitlements", ":-", source], options);
        await fs.promises.writeFile(permissions, entitlements(metadata.stdout), { mode: 0o600 });
        await execute("/usr/bin/codesign", ["--force", "--sign", "-", "--options", "runtime", "--entitlements", permissions, copy], options);
        await execute("/usr/bin/codesign", ["--verify", "--strict", copy], options);
      }
      files[name] = digest(fs.readFileSync(copy));
    }
    for (const [name, source] of Object.entries(links)) {
      const file = path.join(temporary, name);
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.symlink(source, file);
    }
    for (const [name, target] of Object.entries(localLinks)) {
      const file = path.join(temporary, name);
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.symlink(target, file);
    }
    await fs.promises.rm(permissions);
    await fs.promises.writeFile(path.join(temporary, "loader.json"), JSON.stringify({ schema: 2, sourceHash, files,
      inputs: sources.map(item => ({ path: item.source, sha256: item.sha256 })) }) + "\n");
    signal?.throwIfAborted();
    try { await fs.promises.rename(temporary, destination); }
    catch (race) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(race.code)) throw race;
      return prepare(installation, directory, { signal, execute, cameraBridge, winemac, helperLibraries, translatorView, userDataDir, logger });
    }
    return path.join(destination, "bin/wineloader");
  } finally { await fs.promises.rm(temporary, { recursive: true, force: true }); }
}
function environment(loader, previous = {}, { cameraBridge, installation, translatorView } = {}) {
  const values = { WINELOADER: loader, CX_WINELOADER: loader };
  const layout = wineLayout(installation || { wineRoot: path.resolve(path.dirname(loader), "..") }), unix = path.join(path.dirname(loader), "..", "lib", "wine", ...(layout.unixName ? [layout.unixName] : []));
  // Unix modules link @rpath/ntdll.so. They must reuse the already initialized
  // private copy instead of loading a second copy from the vendor directory.
  const libraryOverride = path.resolve(path.dirname(loader), "../loader-libraries");
  if (fs.existsSync(path.join(unix, "ntdll.so"))) {
    if (fs.realpathSync(path.join(libraryOverride, "ntdll.so")) !== fs.realpathSync(path.join(unix, "ntdll.so")))
      throw new Error("The private Wine library anchor changed. Prepare the graphics loader again.");
    values.DYLD_LIBRARY_PATH = [libraryOverride, previous.DYLD_LIBRARY_PATH].filter(Boolean).join(path.delimiter);
  }
  if (cameraBridge?.dxmt) {
    const wine = layout.unixName ? path.resolve(unix, "..") : unix, vendor = installation.crossoverRoot;
    const windows = layout.primaryWindows || require("../temporal").FILES.find(file => file.endsWith(".dll"))?.split("/")[0];
    // CrossOver otherwise redirects these PE imports to its own DXMT before
    // considering WINEDLLPATH. The private closure supplies the selected DXMT.
    values.CX_GRAPHICS_BACKEND = "wined3d";
    values.WINEDLLPATH = [path.join(wine, windows), wine, path.join(vendor, "lib/dxmt", windows),
      path.join(vendor, "lib/wine", windows), path.join(vendor, "lib/wine")].join(path.delimiter);
    const names=[...(!cameraBridge.dxmtRoles||cameraBridge.dxmtRoles.includes("d3d11")?["d3d10core","d3d11","dxgi"]:[]),"winemetal","nvapi64","nvngx",...(cameraBridge.dxmt.temporalD3D12API===1&&cameraBridge.dxmtRoles?.includes("d3d12")?["d3d12"]:[])];
    values.WINEDLLOVERRIDES = [previous.WINEDLLOVERRIDES,names.join(",")+"=b"].filter(Boolean).join(";");
  }
  if (translatorView) {
    const wine = path.resolve(unix, '..');
    Object.assign(values, translatorView.env);
    // Translator dependencies are fallbacks; overriding system libraries also
    // affects Apple frameworks such as the Metal HUD in the Wine process.
    if (translatorView.libraryPaths.length) values.DYLD_FALLBACK_LIBRARY_PATH = [...translatorView.libraryPaths, previous.DYLD_FALLBACK_LIBRARY_PATH].filter(Boolean).join(path.delimiter);
    if (translatorView.frameworkPaths.length) values.DYLD_FALLBACK_FRAMEWORK_PATH = [...translatorView.frameworkPaths, previous.DYLD_FALLBACK_FRAMEWORK_PATH].filter(Boolean).join(path.delimiter);
    if (Object.keys(translatorView.links).some(name => name.endsWith('.dll'))) values.WINEDLLPATH =
      [...layout.windows.map(name => path.join(wine, name)), wine, values.WINEDLLPATH || previous.WINEDLLPATH, layout.dllRoot].filter(Boolean).join(path.delimiter);
    if (translatorView.dllOverrides.length) values.WINEDLLOVERRIDES = [values.WINEDLLOVERRIDES || previous.WINEDLLOVERRIDES, ...translatorView.dllOverrides].filter(Boolean).join(';');
    if (cameraBridge?.dxmt) values.CX_GRAPHICS_BACKEND = 'wined3d';
    if (values.CX_LIBVULKAN && (values.CX_GRAPHICS_BACKEND || previous.CX_GRAPHICS_BACKEND) !== 'wined3d') delete values.CX_LIBVULKAN;
  }
  if(cameraBridge?.kind === "d3dmetal-camera"){
    const wine=path.resolve(unix,"..");
    values.WINEDLLPATH=[path.join(wine,layout.primaryWindows),wine,values.WINEDLLPATH||previous.WINEDLLPATH,path.join(installation.crossoverRoot,"lib/wine")].filter(Boolean).join(path.delimiter);
    values.WINEDLLOVERRIDES=[values.WINEDLLOVERRIDES||previous.WINEDLLOVERRIDES,"maclauncher-temporal-camera=b"].filter(Boolean).join(";");
  }
  return values;
}
function withoutGraphics(current, previous, graphics) {
  const result = { ...current };
  const libraries = new Set(String(graphics.DYLD_INSERT_LIBRARIES || '').split(path.delimiter).filter(Boolean));
  for (const key of ['DYLD_INSERT_LIBRARIES', 'STEAM_DYLD_INSERT_LIBRARIES']) {
    const retained = String(result[key] || '').split(path.delimiter).filter(value => value && !libraries.has(value));
    if (retained.length) result[key] = retained.join(path.delimiter);
    else delete result[key];
  }
  // Roll back only shared-processor-owned settings. Wine, Steam, renderer and
  // arbitrary user environment values remain outside this optional fallback.
  const owned = key => key.startsWith('RESHADE_') || ['FSR4_ROOT', 'FSR4_BUILD_DIR'].includes(key);
  for (const key of Object.keys(graphics)) if (owned(key)) {
    if (Object.hasOwn(previous, key)) result[key] = previous[key];
    else delete result[key];
  }
  // The normal merge can remove stale shared keys. Preserve unrelated values
  // that were already supplied by the game's original environment.
  for (const key of Object.keys(previous)) if (owned(key)) result[key] = previous[key];
  return result;
}
module.exports = { prepare, entitlements, environment, withoutGraphics };
