const fs = require("node:fs");
const path = require("node:path");
const Native = require("../../shared/runtime/local-native");
const Steam = require("../../shared/runtime/steamworks");
const Profiles = require("../../shared/runtime/steamworks/profiles");
const Catalog = require("../../shared/runtime/steamworks/versions.json");
const Exports = require("../export");

// Observed from the exact native runner and corresponding Windows Steam API.
// It is a legacy ABI profile, not a promise about every Steam service or game.
const LEGACY_RUNNER = "1.4.9999";
const LEGACY_SHA256 = "dd8395d9dcdb5eb6e58641a730b22640d1909e72a55a48c3450cf6d0231040fa";
const LEGACY_HELPER_VERSION = "maclauncher-offline-abi-0.5.0-universal";
const LEGACY_HELPER_PROFILE = "gamemaker-legacy-1.4.9999-offline-abi0.5.0";
const LEGACY_INTERFACES = Object.freeze([
  "SteamClient017", "STEAMAPPLIST_INTERFACE_VERSION001", "STEAMAPPS_INTERFACE_VERSION007",
  "STEAMHTMLSURFACE_INTERFACE_VERSION_003", "STEAMHTTP_INTERFACE_VERSION002", "STEAMINVENTORY_INTERFACE_V001",
  "STEAMMUSICREMOTE_INTERFACE_VERSION001", "STEAMMUSIC_INTERFACE_VERSION001", "STEAMREMOTESTORAGE_INTERFACE_VERSION013",
  "STEAMSCREENSHOTS_INTERFACE_VERSION002", "STEAMUGC_INTERFACE_VERSION007", "STEAMUNIFIEDMESSAGES_INTERFACE_VERSION001",
  "STEAMUSERSTATS_INTERFACE_VERSION011", "STEAMVIDEO_INTERFACE_V001", "SteamController003", "SteamFriends015",
  "SteamMatchMaking009", "SteamMatchMakingServers002",
  "SteamNetworking005", "SteamUser018", "SteamUtils007"
]);

function required(inspection) {
  return inspection?.steamRequired === true || inspection?.steamEnabled === true || inspection?.steamFunctions === true;
}

function resolveDependency(inspection, dataPath, install, { runnerVersion = install?.version, resourcesRoot, offline = true } = {}) {
  if (!required(inspection)) return null;
  const legacy = runnerVersion === LEGACY_RUNNER && (!install || install.binarySha256 === LEGACY_SHA256);
  const architecture = legacy ? "x86_64" : install?.architectures?.includes(process.arch === "x64" ? "x86_64" : process.arch)
    ? (process.arch === "x64" ? "x86_64" : process.arch) : install?.architectures?.[0];
  const locations = [path.join(path.dirname(dataPath), "libsteam_api.dylib"),
    install?.runnerAppPath && path.join(install.runnerAppPath, "Contents/MacOS/libsteam_api.dylib")].filter(Boolean);
  const appId = Number.isInteger(inspection.steamAppId) ? Math.abs(inspection.steamAppId) : null;
  for (const file of locations) {
    try {
      const architectures = Native.readMachOArchitectures(file, { allowLibrary: true });
      if (!architecture || architectures.includes(architecture)) return { ready: true, mode: "native", libraryPath: file,
        architectures, architecture: architecture || architectures.find(arch => arch === process.arch) || architectures[0],
        appId, sha256: Native.hashFile(file), version: "game-library", sourceRevision: null,
        consumerPath: install?.runnerAppPath && path.join(install.runnerAppPath, "Contents/MacOS/Mac_Runner"),
        ...(legacy ? { interfaces: [...LEGACY_INTERFACES] } : {}) };
    } catch {}
  }
  if (offline && legacy) {
    const pin = Catalog.find(item => item.version === LEGACY_HELPER_VERSION);
    const profile = Profiles.resolveProfile({ id: LEGACY_HELPER_PROFILE, pin, architecture, requiredInterfaces: LEGACY_INTERFACES });
    if (profile.consumerVersion !== LEGACY_RUNNER || profile.consumerSha256 !== LEGACY_SHA256)
      throw Object.assign(new Error("The selected GameMaker Steam API profile does not match this runner."), { code: "STEAM_API_PROFILE_CHANGED" });
    const library = Steam.resolveBundledLibrary({ resourcesRoot, architecture, interfaces: pin.qualifiedInterfaces, catalog: [pin] });
    if (library.ready) {
      // GEN8 stores a signed ID; preserve that raw detection value. Only this
      // offline application's identity uses its positive numeric magnitude.
      if (!appId) throw Object.assign(new Error("The Steam application ID is missing. Choose Butterscotch for this VM export."),
        { code: "GAMEMAKER_STEAM_APP_ID_REQUIRED", fallbackRuntimeId: "butterscotch" });
      return { ...library, appId, architecture, interfaces: [...profile.interfaces], symbols: [...profile.symbols], abiProfile: profile.id,
        consumerPath: install?.runnerAppPath && path.join(install.runnerAppPath, "Contents/MacOS/Mac_Runner") };
    }
    if (library.present) throw new Error(library.reason);
  }
  throw Object.assign(new Error("This game requires a native Steam API. Choose Butterscotch or a runtime with a compatible Steam API."), {
    code: "GAMEMAKER_STEAM_DEPENDENCY_REQUIRED", fallbackRuntimeId: "butterscotch", steamAppId: inspection.steamAppId,
    missingDependency: "libsteam_api.dylib"
  });
}

async function prepareDependency(dependency, entry, context, baseEnvironment) {
  if (!dependency) return null;
  let symbols = [...(dependency.symbols || [])];
  if (dependency.abiProfile === LEGACY_HELPER_PROFILE &&
      (!dependency.consumerPath || Native.hashFile(dependency.consumerPath) !== LEGACY_SHA256))
    throw Object.assign(new Error("The GameMaker runner checksum does not match its Steam API profile."), { code: "STEAM_API_CONSUMER_CHANGED" });
  if (dependency.consumerPath) {
    const consumer = await require("../../shared/runtime/steamworks/native-consumer-probe")
      .inspectNativeSteamConsumer(dependency.consumerPath, { architecture: dependency.architecture });
    symbols = [...new Set([...symbols, ...consumer.symbols.map(symbol => symbol.replace(/^_/, ""))])];
  }
  const request = { required: true, appId: dependency.appId, arch: dependency.architecture,
    symbols, interfaces: dependency.interfaces || [],
    ...(dependency.abiProfile ? { abiProfile: dependency.abiProfile } : {}),
    nativeLibraryPaths: dependency.mode === "native" ? [dependency.libraryPath] : [],
    ...(dependency.mode === "offline" ? { version: dependency.version, preferOffline: true } : {}),
    ownedDirectory: path.join(Exports.resolveOutputRoot(entry, context), "official-steam") };
  const prepared = context.prepareSteamApi
    ? await context.prepareSteamApi(request, { baseEnvironment: baseEnvironment || process.env })
    : await require("../../shared/runtime/steamworks/automatic").prepareAutomaticLaunch(request,
      { userDataDir: context.userDataDir, baseEnvironment: baseEnvironment || process.env });
  return prepared;
}

module.exports = { LEGACY_RUNNER, LEGACY_SHA256, LEGACY_HELPER_VERSION, LEGACY_HELPER_PROFILE,
  LEGACY_INTERFACES, required, resolveDependency, prepareDependency };
