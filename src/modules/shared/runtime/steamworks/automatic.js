const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Native = require("../local-native");
const Bundle = require("../bundled-native");
const Steam = require("./index");
const Environment = require("./environment");
const Catalog = require("./versions.json");
const Profiles = require("./profiles");
const Managed = require("./managed-consumer");

// Encrypted tickets use a separate native library and ABI. They cannot be
// satisfied by renaming the Steam API helper.
const ALIAS = /^(?:lib)?steam_api(?:64)?(?:\.(?:dll(?:\.dylib)?|dylib|so(?:\.dylib)?|bundle))?$/i;
const SYMBOL = /^(?:Steam[A-Za-z0-9_]{0,160}|GetHSteam(?:User|Pipe))$/;
const failure = (code, message, details = {}) => Object.assign(new Error(message), { code, ...details });
const inside = (root, file) => file === root || file.startsWith(root + path.sep);

function stringList(value, pattern, label, maximum = 4096) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > maximum || value.some(item => typeof item !== "string" || !pattern.test(item))) {
    throw failure("STEAM_API_REQUIREMENT_INVALID", `Invalid Steam API ${label}.`);
  }
  return [...new Set(value)].sort();
}

function architecture(value) {
  if (value === "x64" || value === "x86_64") return "x86_64";
  if (value === "arm64") return value;
  throw failure("STEAM_API_ARCHITECTURE_UNKNOWN", "The game's native Steam API architecture is unknown.");
}

function ownedRoot(directory, userDataDir) {
  if (!path.isAbsolute(directory || "") || !path.isAbsolute(userDataDir || "")) {
    throw failure("STEAM_API_STATE_INVALID", "Steam API state needs an absolute game data directory.");
  }
  // Resolve the nearest existing ancestor without following newly created game
  // subdirectories. The launcher root itself may have a macOS /var alias.
  const requested = path.resolve(directory), lexicalRoot = path.resolve(userDataDir);
  if (!inside(lexicalRoot, requested)) throw failure("STEAM_API_STATE_INVALID", "Steam API state must belong to this game's launcher data.");
  const relative = path.relative(lexicalRoot, requested);
  if (relative.split(path.sep)[0] !== "games" || relative.split(path.sep).length < 3) {
    throw failure("STEAM_API_STATE_INVALID", "Steam API state must be stored beneath an individual game.");
  }
  Bundle.realDirectory(userDataDir, { create: true });
  const root = fs.realpathSync(userDataDir);
  let current = root;
  for (const name of relative.split(path.sep)) {
    current = path.join(current, name);
    try { fs.mkdirSync(current, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure("STEAM_API_STATE_INVALID", "Steam API state directories cannot use symlinks.");
  }
  return current;
}

function aliasesForLibrary(directory, libraryPath, sha256, aliases, arch) {
  const identity = crypto.createHash("sha256").update(JSON.stringify([libraryPath, sha256, aliases, arch])).digest("hex");
  const root = path.join(directory, "libraries");
  try { fs.mkdirSync(root, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
  if (!fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink()) throw failure("STEAM_API_STATE_INVALID", "Steam API aliases cannot use a symlink directory.");
  const target = path.join(root, identity);
  const verify = () => {
    const stat = fs.lstatSync(target);
    if (!stat.isDirectory() || stat.isSymbolicLink() || JSON.stringify(fs.readdirSync(target).sort()) !== JSON.stringify(aliases)) {
      throw failure("STEAM_API_ALIASES_CHANGED", "The game's Steam API library aliases changed.");
    }
    for (const name of aliases) {
      const file = path.join(target, name);
      if (!fs.lstatSync(file).isSymbolicLink() || fs.readlinkSync(file) !== libraryPath) {
        throw failure("STEAM_API_ALIASES_CHANGED", "The game's Steam API library aliases changed.");
      }
    }
  };
  if (fs.existsSync(target)) { verify(); return target; }
  const staging = fs.mkdtempSync(path.join(root, ".prepare-"));
  try {
    for (const name of aliases) fs.symlinkSync(libraryPath, path.join(staging, name));
    try { fs.renameSync(staging, target); }
    catch (error) {
      if (!fs.existsSync(target)) throw error;
      // Concurrent preparation may have published the same immutable aliases.
      verify();
    }
    verify(); return target;
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}

function loaderEnvironment(base, directories) {
  const existing = String(base?.DYLD_LIBRARY_PATH || "").split(":").filter(Boolean);
  return { ...base, DYLD_LIBRARY_PATH: [...new Set([...directories, ...existing])].join(":") };
}

/** Shared native API setup. A module supplies actual consumer/ABI evidence. */
async function prepareAutomaticLaunch(request, context = {}, dependencies = {}) {
  if (request?.required !== true) return null;
  request = Profiles.normalizeProfileSelection(request);
  const arch = architecture(request.arch || request.architecture);
  let symbols = stringList(request.symbols, SYMBOL, "symbol names");
  const requiredInterfaces = stringList(request.interfaces, Environment.INTERFACE, "interface versions", 128);
  if (!symbols.length && !requiredInterfaces.length) {
    throw failure("STEAM_API_ABI_UNKNOWN", "This game needs Steam API, but its native API requirements could not be identified.");
  }
  const aliases = stringList(["libsteam_api.dylib", ...stringList(request.aliases, ALIAS, "library aliases", 31)], ALIAS, "library aliases", 32);
  const inspectExports = dependencies.inspectMachOExports || require("../macho-exports").inspectMachOExports;
  const native = dependencies.native || Native;
  const catalog = dependencies.catalog || Catalog;
  const selectedPin = request.version ? catalog.find(pin => pin.version === request.version) : catalog[0];
  if (request.version && !selectedPin) throw failure("STEAM_API_VERSION_UNKNOWN", "Choose an explicitly listed Steam API helper version.");
  const profile = Profiles.resolveProfile({ id: request.abiProfile, pin: selectedPin, architecture: arch,
    requiredInterfaces, ...(dependencies.profiles ? { profiles: dependencies.profiles } : {}) });
  const managed = await Managed.resolveManagedRequirement({ profile, sources: request.managedConsumers,
    symbols, signal: context.signal });
  symbols = managed.symbols;
  const originalPaths = request.nativeLibraryPaths || [];
  if (!Array.isArray(originalPaths) || originalPaths.length > 32 || originalPaths.some(file => !path.isAbsolute(file || ""))) {
    throw failure("STEAM_API_REQUIREMENT_INVALID", "Steam API library locations must be absolute paths.");
  }
  let library;
  if (request.preferOffline !== true) {
    for (const file of originalPaths) {
      try {
        const real = fs.realpathSync(file);
        if (!fs.lstatSync(real).isFile() || !native.readMachOArchitectures(real, { allowLibrary: true }).includes(arch)) continue;
        const exports = new Set(await inspectExports(real, { arch }));
        if (symbols.some(symbol => !exports.has(symbol))) continue;
        library = { ready: true, mode: "native", libraryPath: real, sha256: native.hashFile(real),
          architectures: [arch], version: "game-library", sourceRevision: null };
        break;
      } catch { /* A Windows or wrong-CPU library is not a native candidate. */ }
    }
  }
  let interfaces = requiredInterfaces;
  if (!library) {
    const pin = selectedPin;
    if (!pin) throw failure("STEAM_API_VERSION_UNKNOWN", "Choose an explicitly listed Steam API helper version.");
    // Flat C exports use this helper's own pinned client configuration. Explicit
    // virtual-interface consumers must instead supply their exact versions.
    if (profile) interfaces = profile.interfaces;
    else if (!interfaces.length) {
      interfaces = stringList(pin.defaultInterfaces ?? pin.qualifiedInterfaces, Environment.INTERFACE, "default interface versions", 128);
      if (interfaces.filter(value => /^SteamClient\d{3}$/.test(value)).length !== 1 ||
          interfaces.some(value => !pin.qualifiedInterfaces?.includes(value))) {
        throw failure("STEAM_API_INTERFACES_AMBIGUOUS", "An exact Steam API client profile is required.");
      }
    }
    const resolve = dependencies.resolveBundledLibrary || Steam.resolveBundledLibrary;
    // Payload validation always uses its original sealed interface inventory.
    // Additional consumer ABIs have separate profiles and retain the exact
    // native bytes and manifest identity.
    library = resolve({ resourcesRoot: context.resourcesRoot, architecture: arch,
      interfaces: profile ? pin.qualifiedInterfaces : interfaces, catalog: [pin] });
    if (!library?.ready) throw failure("STEAM_API_UNAVAILABLE", library?.reason || "A compatible native Steam API helper is unavailable.");
    const exports = new Set(await inspectExports(library.libraryPath, { arch }));
    const missing = symbols.filter(symbol => !exports.has(symbol));
    if (missing.length) throw failure("STEAM_API_SYMBOLS_UNAVAILABLE", "The included Steam API helper cannot provide this game's native API version.", { missingSymbols: missing });
  }
  const appId = request.appId?.value ?? request.appId;
  if (library.mode === "offline" && (!Number.isInteger(appId) || appId < 1 || appId > 0xffffffff)) {
    throw failure("STEAM_API_APP_ID_REQUIRED", "The game's Steam application ID could not be found.");
  }
  const directory = ownedRoot(request.ownedDirectory, context.userDataDir);
  if (inside(directory, library.libraryPath) || inside(library.libraryPath, directory)) {
    throw failure("STEAM_API_STATE_INVALID", "Steam API state cannot overlap its native library.");
  }
  const aliasDirectory = aliasesForLibrary(directory, library.libraryPath, library.sha256, aliases, arch);
  const base = context.baseEnvironment || request.baseEnvironment || process.env;
  let result;
  if (library.mode === "offline") {
    result = Steam.prepareOfflineLaunch({ library, ownedDirectory: directory, appId, interfaces,
      language: request.language, baseEnvironment: base });
  } else {
    result = { environment: { ...base }, settingsPath: null, savePath: null };
    if (Number.isInteger(appId) && appId > 0) {
      result.environment.SteamAppId = String(appId); result.environment.SteamGameId = String(appId);
    }
  }
  const environment = loaderEnvironment({ ...base, ...result.environment, DYLD_LIBRARY_PATH: base.DYLD_LIBRARY_PATH },
    [aliasDirectory, path.dirname(library.libraryPath)]);
  return { ...library, ...result, environment, aliasDirectory, aliases, interfaces, appId,
    ...(managed.consumers.length ? { managedConsumers: managed.consumers } : {}),
    abiProfile: library.mode === "offline" ? profile?.id || null : null,
    identity: { version: library.version, sha256: library.sha256, sourceRevision: library.sourceRevision, architecture: arch,
      ...(library.sourceKind === "owned" ? { sourceKind: library.sourceKind, sourceSha256: library.sourceSha256 } : {}),
      ...(library.packageVersion ? { packageVersion: library.packageVersion } : {}),
      ...(library.mode === "offline" && profile ? { abiProfile: profile.id } : {}) } };
}

module.exports = { prepareAutomaticLaunch, architecture, loaderEnvironment };
