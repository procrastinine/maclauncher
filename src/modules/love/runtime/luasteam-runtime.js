const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Bundle = require("../../shared/runtime/bundled-native");
const Included = require("../../shared/runtime/included-helpers");
const declarations = require("./distribution-supplementals.json");
const Native = require("../../shared/runtime/local-native");
const GameData = require("../../shared/game-data");
const Consumer = require("./luasteam-consumer");
const Catalog = require("./luasteam-versions.json");
const Custom = require("../../shared/runtime/custom-runtime");

const SECTION_ID = "luasteam";
function nativeHostDependencies() {
  return Catalog.map(pin => ({ id: "love-luasteam", version: pin.version,
    file: "luasteam.so", sha256: pin.librarySha256, dependency: "@loader_path/libsteam_api.dylib",
    provider: { id: "steam-api-helper", version: pin.helperVersion, file: "libsteam_api.dylib" },
    installNames: ["@loader_path/luasteam.so"] }));
}
function selectedPin(version = Catalog[0]?.version) {
  const pin = Catalog.find(item => item.version === version);
  if (!pin) throw new Error("Choose an explicitly listed LuaSteam bridge version.");
  return pin;
}
function resolveBundle({ version, resourcesRoot, verification = "full", userDataDir, declarations: includedDeclarations = declarations } = {}) {
  const pin = selectedPin(version);
  try {
    const included = Included.resolveIncluded(includedDeclarations, { id: "love-luasteam", version: pin.version, resourcesRoot });
    if (included) {
      const { directory, manifest, item } = included;
      const record = JSON.parse(manifest.bytes);
      if (record.id !== "love-luasteam" || record.version !== pin.version || record.sourceRevision !== pin.sourceRevision ||
          record.librarySha256 !== pin.librarySha256 || record.abiProfile !== pin.abiProfile || record.hostLuaAbi !== "Lua 5.1 C API")
        throw new Error("The included LuaSteam source or API profile changed.");
      const libraryPath = path.join(directory, "luasteam.so");
      if (verification === "full") {
        Bundle.verifyPayload(directory, { ...record, files: [...record.files,
          { path: item.manifestRelative, size: manifest.size, sha256: item.manifestSha256, mode: 0o644 }] });
        const library = Bundle.readRegular(libraryPath, 4 * 1024 * 1024);
        if (library.sha256 !== pin.librarySha256 || !["arm64", "x86_64"].every(arch => Native.readMachOArchitectures(libraryPath, { allowLibrary: true }).includes(arch)))
          throw new Error("The included LuaSteam library changed or has an incompatible CPU.");
        // Release staging verifies the code signature. The exact sealed bytes
        // are verified again here without spawning a signature tool on Play.
      } else {
        const stat = fs.lstatSync(libraryPath);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("The included LuaSteam library is not a regular file.");
      }
      return { ...pin, ready: true, directory, installDir: directory, libraryPath, source: "bundled", bundledExecution: "direct",
        readOnly: true, removable: false, architectures: ["arm64", "x86_64"], reason: null };
    }
  } catch (error) { return { ...pin, ready: false, present: true, reason: error.message }; }
  return { ...pin, ready: false, present: false, reason: "This app build does not include the compatible LuaSteam bridge." };
}

function getSection({ settings, resourcesRoot } = {}) {
  const version = settings?.defaultVersion || Catalog[0]?.version;
  const installed = Catalog.map(pin => resolveBundle({ version: pin.version, resourcesRoot, verification: "status" })).filter(item => item.ready);
  return { id: SECTION_ID, label: "Steam bridge", defaultVersion: version, installed, variants: [], installing: null,
    versionLabels: Object.fromEntries(Catalog.map(pin => [pin.version, `LuaSteam ${pin.upstreamVersion} · host Lua`])),
    catalog: { status: "success", versions: [], source: "Included with MacLauncher", mode: "all",
      supportsLatestOnly: false, installableVersions: [], includedVersions: installed.map(item => item.version),
      versionRequirements: Object.fromEntries(Catalog.map(pin => [pin.version, { included: installed.some(item => item.version === pin.version),
        requiresDownload: false, installable: false, installLabel: "Included", available: installed.some(item => item.version === pin.version) }])) } };
}

function bridgeVersion(entry, settings) {
  return entry?.runtimeData?.love?.steamBridgeVersion || Custom.defaultVersion(settings, "love", SECTION_ID) ||
    settings?.runtimes?.love?.luasteam?.defaultVersion || Catalog[0]?.version;
}
function preflight(entry, context) {
  const required = Consumer.requiredIdentity(entry);
  if (!required) return null;
  const bridge = resolveBundle({ version: bridgeVersion(entry, context.settings), resourcesRoot: context.resourcesRoot, userDataDir: context.userDataDir });
  if (!bridge.ready) throw new Error(bridge.reason);
  return { ...required, bridge };
}

function verifyHostLua(appPath) {
  const headers = path.join(appPath, "Contents/Frameworks/Lua.framework/Versions/A/Headers/lua.h");
  const text = Bundle.readRegular(headers, 128 * 1024).bytes.toString("utf8");
  if (!/^\s*#define\s+LUA_VERSION_NUM\s+501\b/m.test(text))
    throw new Error("This LuaSteam bridge requires a Lua 5.1 host.");
}
function prepareAliases(directory, bridge, steam) {
  Bundle.realDirectory(directory, { create: true });
  const key = crypto.createHash("sha256").update(JSON.stringify([bridge.version, bridge.librarySha256, steam.identity])).digest("hex");
  const target = path.join(directory, key);
  const links = { "luasteam.so": bridge.libraryPath, "libsteam_api.dylib": steam.libraryPath };
  const verify = () => {
    if (!fs.lstatSync(target).isDirectory() || fs.lstatSync(target).isSymbolicLink() ||
        JSON.stringify(fs.readdirSync(target).sort()) !== JSON.stringify(Object.keys(links).sort()))
      throw new Error("The game's LuaSteam aliases changed.");
    for (const [name, source] of Object.entries(links)) {
      const file = path.join(target, name);
      if (!fs.lstatSync(file).isSymbolicLink() || fs.readlinkSync(file) !== source) throw new Error("The game's LuaSteam aliases changed.");
    }
  };
  if (fs.existsSync(target)) { verify(); return target; }
  const staging = fs.mkdtempSync(path.join(directory, ".prepare-"));
  try {
    for (const [name, source] of Object.entries(links)) fs.symlinkSync(source, path.join(staging, name));
    try { fs.renameSync(staging, target); }
    catch (error) { if (!fs.existsSync(target)) throw error; }
    verify(); return target;
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}

/** Binding is child-only. Originals and shared native libraries remain read-only. */
async function prepareLaunchEnvironment(entry, context, selection, baseEnvironment = process.env) {
  const required = preflight(entry, context);
  if (!required) return null;
  verifyHostLua(selection.install.appPath);
  if (typeof context.prepareSteamApi !== "function") throw new Error("The native Steam API launch service is unavailable.");
  const architecture = selection.install.requiresRosetta ? "x86_64" : process.arch === "x64" ? "x86_64" : process.arch;
  const gameRuntime = GameData.resolveGameRuntimeDir(context.userDataDir, entry.gameId, "love");
  const request = { required: true, appId: required.appId.value, arch: architecture,
    abiProfile: required.bridge.helperAbiProfile || required.bridge.abiProfile,
    ...(required.bridge.helperVersion ? { version: required.bridge.helperVersion } : {}),
    interfaces: required.bridge.interfaces, symbols: required.bridge.symbols,
    nativeLibraryPaths: [path.join(required.evidence.gameRoot, "libsteam_api.dylib")],
    ownedDirectory: path.join(gameRuntime, "steam-api") };
  const steam = await context.prepareSteamApi(request, { baseEnvironment });
  if (!steam?.libraryPath || !steam.environment) throw new Error("The native Steam API library is unavailable.");
  const aliases = prepareAliases(path.join(gameRuntime, "native-modules"), required.bridge, steam);
  const existing = steam.environment.LUA_CPATH;
  return { ...steam, bridgeVersion: required.bridge.version, bridgeSha256: required.bridge.librarySha256,
    environment: { ...steam.environment, LUA_CPATH: path.join(aliases, "?.so") + ";" + (existing || ";") } };
}

function inspectCustomRuntime(runtimePath) {
  const native = Custom.inspectExecutable(runtimePath, { allowLibrary: true, candidates: ["luasteam.so"] });
  return { ...Catalog[0], ...native, sourceRevision: "custom", libraryPath: native.executablePath, directory: native.root,
    librarySha256: native.binarySha256, abiProfile: Catalog[0]?.abiProfile, hostLuaAbi: "Lua 5.1 C API" };
}

module.exports = { SECTION_ID, Catalog, nativeHostDependencies, selectedPin, resolveBundle, getSection, preflight, verifyHostLua, inspectCustomRuntime,
  prepareAliases, prepareLaunchEnvironment, bridgeVersion };
