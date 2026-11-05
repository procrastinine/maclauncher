const fs = require("node:fs");
const path = require("node:path");
const Writable = require("../writable-input");
const AppBundle = require("./app-bundle");
const os = require("node:os");

const INHERIT = "inherit";
const privateEnvironments = new WeakSet();
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative === "" || relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
};

// Only these launcher-owned roots may issue an initialization capability.
// An external reference is data, and can never be used as this capability.
function privateEnvironment(userDataDir, directory, relativePath) {
  if (!path.isAbsolute(userDataDir || "") || !path.isAbsolute(directory || "") ||
      typeof relativePath !== "string" || !relativePath || path.isAbsolute(relativePath)) {
    throw new Error("A private Windows environment requires its launcher data directory.");
  }
  const relative = path.relative(userDataDir, directory).split(path.sep);
  const game = relative.length === 4 && relative[0] === "games" && /^[\w-]+$/.test(relative[1]) &&
    relative[2] === "runtimes" && ["crossover", "sikarugir"].includes(relative[3]);
  const compute = relative.length === 3 && relative[0] === "graphics" && relative[1] === "compute-hosts" && /^[a-f0-9]+$/.test(relative[2]);
  const prefixPath = path.resolve(directory, relativePath);
  if ((!game && !compute) || prefixPath === path.resolve(directory) || !inside(directory, prefixPath)) {
    throw new Error("Windows environment initialization requires an owned private environment.");
  }
  Writable.assertOwnDirectory(userDataDir, directory, { create: false });
  Writable.assertOwnDirectory(directory, prefixPath, { create: false });
  const record = Object.freeze({ kind: "private", prefixPath, directory: path.resolve(directory), userDataDir: path.resolve(userDataDir) });
  privateEnvironments.add(record);
  return record;
}

function assertPrivateEnvironment(record, directory) {
  if (!privateEnvironments.has(record) || record.directory !== path.resolve(directory)) {
    throw new Error("External Windows environments cannot be initialized, recreated or removed.");
  }
  Writable.assertOwnDirectory(record.userDataDir, record.prefixPath, { create: false });
  return record.prefixPath;
}

function environmentReference(value) {
  if (value == null || value === "" || value === "private") return null;
  if (typeof value === "string") { try { value = JSON.parse(value); } catch { throw new Error("Invalid Windows environment reference."); } }
  if (!value || !["crossover-bottle", "sikarugir-wrapper"].includes(value.kind) ||
      !path.isAbsolute(value.path || "") || /[\0\r\n]/.test(value.path)) throw new Error("Invalid Windows environment reference.");
  return { kind: value.kind, path: path.resolve(value.path),
    ...(typeof value.bottleId === "string" ? { bottleId: value.bottleId } : {}),
    ...(typeof value.name === "string" ? { name: value.name } : {}) };
}

const textFile = file => { try { return fs.readFileSync(file, "utf8"); } catch { return ""; } };
const fileExists = file => { try { return fs.statSync(file).isFile(); } catch { return false; } };
function readIni(text) {
  const result = Object.create(null); let section;
  for (const line of String(text).split(/\r?\n/)) {
    const header = line.match(/^\s*\[([^\]]+)\]/);
    if (header) { section = result[header[1]] ||= Object.create(null); continue; }
    const item = line.match(/^\s*"((?:\\.|[^"\\])*)"\s*=\s*"((?:\\.|[^"\\])*)"/);
    if (section && item) section[item[1].replace(/\\(["\\])/g, "$1")] = item[2].replace(/\\(["\\])/g, "$1");
  }
  return result;
}
function readRegistry(text) {
  const result = Object.create(null); let section;
  for (const line of String(text).split(/\r?\n/)) {
    const header = line.match(/^\[([^\]]+)\]/);
    if (header) { section = result[header[1].replace(/\\\\/g, "\\")] ||= Object.create(null); continue; }
    const item = line.match(/^"((?:\\.|[^"\\])*)"=(.*)$/);
    if (!section || !item) continue;
    const raw = item[2];
    section[item[1].replace(/\\(["\\])/g, "$1")] = /^dword:[\da-f]+$/i.test(raw)
      ? parseInt(raw.slice(6), 16) : raw.startsWith('"') && raw.endsWith('"')
        ? raw.slice(1, -1).replace(/\\(["\\])/g, "$1") : raw;
  }
  return result;
}
function registryValues(prefixPath) {
  return Object.fromEntries(["system.reg", "user.reg", "userdef.reg"].map(file => [file, readRegistry(textFile(path.join(prefixPath, file)))]));
}
function normalizeSettings(environment, metadata, registry, wrapper) {
  const user = registry["user.reg"] || {};
  const value = (section, name) => user["Software\\Wine\\" + section]?.[name];
  const settings = { graphicsBackend: environment.CX_GRAPHICS_BACKEND || (wrapper
    ? Number(metadata.D3DMETAL) ? "d3dmetal" : Number(metadata.DXVK) ? "dxvk" : "dxmt" : "auto"),
    vulkanBackend: /kosmickrisp/i.test(environment.VK_DRIVER_FILES || "") ? "kosmickrisp" : "auto",
    synchronization: environment.WINEMSYNC === "1" ? "msync" : environment.WINEMSYNC === "0" ? "off" : "auto",
    wineDebug: environment.WINEDEBUG || "", windowsVersion: metadata.WindowsVersion || metadata.Template || value("", "Version"),
    highResolution: value("Mac Driver", "RetinaMode"), dpi: user["Control Panel\\Desktop"]?.LogPixels,
    optionAsAlt: value("Mac Driver", "LeftOptionIsAlt"), commandAsControl: value("Mac Driver", "LeftCommandIsCtrl"),
    mouseCapture: value("DirectInput", "MouseWarpOverride"), fullscreenCapture: value("Mac Driver", "CaptureDisplaysForFullscreen"),
    verticalSync: value("Mac Driver", "AllowVerticalSync"), cncDdraw: wrapper ? Boolean(Number(metadata.CNC_DDRAW)) : undefined,
    d9vk: wrapper ? Boolean(Number(metadata.D9VK)) : undefined };
  return settings;
}
function readEnvironment(value, options = {}) {
  const reference = environmentReference(value);
  if (!reference) return null;
  let root;
  try { root = fs.realpathSync(reference.path); } catch { throw new Error("The selected Windows environment is unavailable. Choose an existing environment in Runtime Settings."); }
  const wrapper = reference.kind === "sikarugir-wrapper";
  const prefixPath = wrapper ? path.join(root, "Contents", "SharedSupport", "prefix") : root;
  if (!fileExists(path.join(prefixPath, "system.reg"))) throw new Error("The selected Windows environment is incomplete. It will not be recreated.");
  let metadata, environment, install;
  if (wrapper) {
    metadata = AppBundle.readInfoPlist(root);
    const wineRoot = path.join(root, "Contents", "SharedSupport", "wine"), templateRoot = path.join(root, "Contents");
    const executablePath = path.join(wineRoot, "bin", "wine"), serverPath = path.join(wineRoot, "bin", "wineserver");
    if (!metadata || !("Program Name and Path" in metadata) || !fileExists(executablePath) || !fileExists(serverPath) ||
        !fs.existsSync(path.join(templateRoot, "Frameworks"))) throw new Error("Select a Sikarugir wrapper with its own engine and prefix.");
    environment = Object.fromEntries(Object.entries({ WINEMSYNC: metadata.WINEMSYNC, WINEDEBUG: metadata.WINEDEBUG,
      MTL_HUD_ENABLED: metadata.METAL_HUD, MVK_CONFIG_FAST_MATH_ENABLED: metadata.FASTMATH,
      ROSETTA_ADVERTISE_AVX: metadata.ADVERTISE_AVX }).filter(([, value]) => value != null).map(([key, value]) => [key, String(Number.isInteger(value) || typeof value === "boolean" ? Number(value) : value)]));
    const { readMachOArchitectures } = require("./local-native");
    const architectures = readMachOArchitectures(executablePath);
    install = { ready: true, external: true, imported: true, appPath: root, installDir: root, wineRoot, engineRoot: wineRoot,
      templateRoot, supportRoot: templateRoot, executablePath, serverPath, architectures,
      engineVersion: textFile(path.join(wineRoot, "version")).trim(), templateVersion: metadata.CFBundleVersion,
      needsRosetta: require("./architecture").imageRequiresRosetta(architectures) };
  } else {
    const configPath = path.join(root, "cxbottle.conf");
    if (fs.lstatSync(configPath).isSymbolicLink()) throw new Error("Published and stub CrossOver bottles are excluded.");
    const config = readIni(textFile(configPath)); metadata = config.Bottle || {}; environment = config.EnvironmentVariables || {};
    if (Object.hasOwn(metadata, "Updater")) throw new Error("Published and stub CrossOver bottles are excluded.");
  }
  const registry = registryValues(prefixPath);
  const name = reference.name || metadata.Description || metadata.CFBundleDisplayName || path.basename(root, wrapper ? ".app" : undefined);
  return { reference: { ...reference, path: root, name, ...(metadata.BottleID ? { bottleId: metadata.BottleID } : {}) },
    kind: reference.kind, path: root, prefixPath, name, metadata, environment, registry,
    settings: normalizeSettings(environment, metadata, registry, wrapper), ...(install ? { install } : {}) };
}
function discoverEnvironments(runtimeId, options = {}) {
  const home = options.home || os.homedir();
  const environment = { ...(options.environment || process.env), HOME: home };
  const expand = value => String(value).replace(/^~(?=\/|$)/, home)
    .replace(/\$\{([^}]+)\}|\$([A-Za-z_][\w]*)/g, (_all, braced, bare) => environment[braced || bare] || "");
  let candidates;
  if (runtimeId === "sikarugir") {
    const directory = path.join(home, "Applications", "Sikarugir");
    let entries = []; try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch {}
    candidates = [...entries.filter(item => item.isDirectory() && /\.app$/i.test(item.name)).map(item => path.join(directory, item.name)), ...(options.wrapperPaths || [])];
  } else if (runtimeId === "crossover") {
    const configPaths = [...(options.crossoverRoot ? [path.join(options.crossoverRoot, "etc", "CrossOver.conf")] : []),
      path.join(home, "Library", "Application Support", "CrossOver", "CrossOver.conf")];
    const configs = configPaths.map(file => readIni(textFile(file)));
    const config = Object.assign({}, ...configs.map(value => value.CrossOver));
    const configEnv = Object.assign({}, ...configs.map(value => value.EnvironmentVariables));
    const preference = AppBundle.readPlistFile(path.join(home, "Library", "Preferences", "com.codeweavers.CrossOver.plist"));
    const configured = environment.CX_BOTTLE_PATH || configEnv.CX_BOTTLE_PATH || config.BottlePath || preference?.BottleDir ||
      path.join(home, "Library", "Application Support", "CrossOver", "Bottles");
    const managed = [environment.CX_MANAGED_BOTTLE_PATH, config.ManagedBottleDirs].filter(Boolean).flatMap(value => expand(value).split(path.delimiter));
    candidates = [];
    for (const folder of expand(configured).split(path.delimiter)) {
      if (!path.isAbsolute(folder) || managed.some(root => inside(root, folder))) continue;
      let entries = []; try { entries = fs.readdirSync(folder, { withFileTypes: true }); } catch {}
      for (const item of entries) if (item.isDirectory() && item.name !== "default") candidates.push(path.join(folder, item.name));
    }
  } else return [];
  const result = [], seen = new Set();
  for (const candidate of candidates) try {
    const record = readEnvironment({ kind: runtimeId === "crossover" ? "crossover-bottle" : "sikarugir-wrapper", path: candidate });
    if (seen.has(record.path) || options.userDataDir && inside(fs.realpathSync(options.userDataDir), record.path)) continue;
    seen.add(record.path); result.push(record);
  } catch {}
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = { INHERIT, inside, privateEnvironment, assertPrivateEnvironment, environmentReference,
  readIni, readRegistry, readEnvironment, discoverEnvironments };
