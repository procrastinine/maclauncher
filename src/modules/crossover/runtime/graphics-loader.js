const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { execFile } = require("node:child_process"), { promisify } = require("node:util");
const Writable = require("../../shared/writable-input");
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
async function prepare(installation, directory, { signal, execute = executeFile, cameraBridge } = {}) {
  signal?.throwIfAborted();
  const vendor = fs.realpathSync(installation.crossoverRoot), unix = "lib/wine/x86_64-unix";
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
    if (fs.existsSync(path.join(vendor, "lib64"))) links.lib64 = path.join(vendor, "lib64");
  }
  for (const architecture of separateLoader ? ["x86_64-windows", "i386-windows"] : []) {
    for (const name of ["ntdll.dll", "apisetschema.dll"]) {
      const relative = `lib/wine/${architecture}/${name}`, source = path.join(vendor, relative);
      if (fs.existsSync(source)) links[relative] = source;
      else if (architecture === "x86_64-windows") throw new Error("CrossOver's graphics loader is incomplete.");
    }
  }
  if (cameraBridge && separateLoader) {
    const Temporal = require("../temporal");
    for (const relative of Temporal.FILES) links[`lib/wine/${relative}`] = path.join(cameraBridge.dxmt.directory, relative);
    links["lib/wine/x86_64-unix/maclauncher-dxmt-original.so"] = cameraBridge.dxmt.native;
    // The adapted PE closure retains the selected renderer's original native
    // thunk and NVIDIA capability bridge.
    for (const name of ["winemetal", "nvapi64", "d3d10core"]) links[`lib/wine/x86_64-windows/${name}.dll`] = path.join(cameraBridge.baseRoot, "x86_64-windows", name + ".dll");
  }
  const sourceHash = digest(JSON.stringify([2, sources, links])), root = path.join(directory, "graphics-loader");
  const destination = path.join(root, sourceHash.slice(0, 24)), loader = path.join(destination, "bin/wineloader");
  Writable.assertOwnDirectory(directory, root);
  if (fs.existsSync(destination)) {
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
        return fs.lstatSync(file).isSymbolicLink() && fs.readlinkSync(file) === source;
      });
      if (record.schema === 2 && record.sourceHash === sourceHash && filesMatch && linksMatch) return loader;
    } catch { /* An incomplete cache must not be executed. */ }
    throw new Error("The prepared CrossOver graphics loader has changed. Remove the game's graphics-loader folder and try again.");
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
    // space layout and permission to load the adapter. Remaining libraries come
    // from the supplied application through its normal WINEDLLPATH selection.
    for (const { name, source, mode, sign } of sources) {
      signal?.throwIfAborted();
      const copy = path.join(temporary, name);
      await fs.promises.mkdir(path.dirname(copy), { recursive: true });
      await fs.promises.copyFile(source, copy, fs.constants.COPYFILE_FICLONE | fs.constants.COPYFILE_EXCL);
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
    await fs.promises.rm(permissions);
    await fs.promises.writeFile(path.join(temporary, "loader.json"), JSON.stringify({ schema: 2, sourceHash, files }) + "\n");
    signal?.throwIfAborted();
    await fs.promises.rename(temporary, destination);
    return loader;
  } finally { await fs.promises.rm(temporary, { recursive: true, force: true }); }
}
function environment(loader, previous = {}, { cameraBridge, installation } = {}) {
  const values = { WINELOADER: loader, CX_WINELOADER: loader };
  const unix = path.join(path.dirname(loader), "..", "lib", "wine", "x86_64-unix");
  // Unix modules link @rpath/ntdll.so. They must reuse the already initialized
  // private copy instead of loading a second copy from the vendor directory.
  if (fs.existsSync(path.join(unix, "ntdll.so"))) values.DYLD_LIBRARY_PATH = [unix, previous.DYLD_LIBRARY_PATH].filter(Boolean).join(path.delimiter);
  if (cameraBridge) {
    const wine = path.resolve(unix, ".."), vendor = installation.crossoverRoot;
    // CrossOver otherwise redirects these PE imports to its own DXMT before
    // considering WINEDLLPATH. The private closure supplies the selected DXMT.
    values.CX_GRAPHICS_BACKEND = "wined3d";
    values.WINEDLLPATH = [path.join(wine, "x86_64-windows"), wine, path.join(vendor, "lib/dxmt/x86_64-windows"),
      path.join(vendor, "lib/wine/x86_64-windows"), path.join(vendor, "lib/wine")].join(path.delimiter);
    values.WINEDLLOVERRIDES = [previous.WINEDLLOVERRIDES, "d3d10core,d3d11,dxgi,winemetal,nvapi64,nvngx=b"].filter(Boolean).join(";");
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
