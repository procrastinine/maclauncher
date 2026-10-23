const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const Observations = require("../../../../core/file-observations");
const Nwjs = require("./nwjs-manager");
const Greenworks = require("./greenworks-runtime");
const Sdk = require("./greenworks-sdk");
const GameData = require("../../game-data");
const AppId = require("../../runtime/steamworks/app-id");
const Steam = require("../../runtime/steamworks");
const SteamProfiles = require("../../runtime/steamworks/profiles");
const Ticket = require("../../runtime/steamworks/ticket");
const SteamCatalog = require("../../runtime/steamworks/versions.json");
const ProfileCatalog = require("../../runtime/steamworks/profiles.json");
const Native = require("../../runtime/local-native");
const { versionAtLeast } = require("../../runtime/bundled-native");
const Contracts = require("./greenworks-contracts.json");

const targetCache = new Map();
const SKIP_DIRECTORIES = new Set(["audio", "img", "images", "movies", "movie", "video", "videos", "fonts"]);
const LIMITS = { directories: 512, entries: 32768, depth: 8 };
const run = promisify(execFile);
let hostVersionPromise;

function failure(message, code) { return Object.assign(new Error(message), { code }); }
function contained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
}

function resolveRuntimeConfig(options = {}) {
  return Nwjs.resolveRuntimeConfig(options);
}

// Bound package inspection and exclude conventional image/audio asset trees
// before directory traversal. Greenworks is identified by package markers.
// Cached results retain every inspected directory identity, including misses.
function findGreenworksTargets(rootDir) {
  if (!path.isAbsolute(rootDir || "")) return [];
  let realRoot;
  try { realRoot = fs.realpathSync(rootDir); if (!fs.statSync(realRoot).isDirectory()) return []; }
  catch { return []; }
  const cacheKey = path.resolve(rootDir), cached = targetCache.get(cacheKey);
  if (cached && Observations.unchanged(cached.files)) {
    for (const [directory] of cached.files) fs.statSync(directory);
    return [...cached.targets];
  }
  const files = [], targets = [], seen = new Set(), queue = [{ directory: cacheKey, depth: 0 }];
  let count = 0;
  for (let index = 0; index < queue.length; index++) {
    const { directory, depth } = queue[index];
    let physical;
    try { physical = fs.realpathSync(directory); } catch { continue; }
    if (seen.has(physical)) continue;
    if (seen.size >= LIMITS.directories) throw failure("Greenworks package inspection exceeds its directory limit.", "GREENWORKS_PROBE_LIMIT");
    seen.add(physical);
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT" || error.code === "ENOTDIR") continue; throw error; }
    files.push([directory, Observations.identity(directory)]);
    count += entries.length;
    if (count > LIMITS.entries) throw failure("Greenworks package inspection exceeds its entry limit.", "GREENWORKS_PROBE_LIMIT");
    if (entries.some(entry => entry.isFile() && /^(?:greenworks\.js|greenworks\.node)$/i.test(entry.name))) {
      targets.push(directory);
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || SKIP_DIRECTORIES.has(entry.name.toLowerCase())) continue;
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        try { if (!contained(realRoot, fs.realpathSync(candidate)) || !fs.statSync(candidate).isDirectory()) continue; }
        catch { continue; }
      } else if (!entry.isDirectory()) continue;
      if (depth >= LIMITS.depth) continue;
      queue.push({ directory: candidate, depth: depth + 1 });
    }
  }
  const result = { files, targets };
  if (files.length && Observations.unchanged(files)) {
    targetCache.set(cacheKey, result);
    if (targetCache.size > 64) targetCache.delete(targetCache.keys().next().value);
  }
  return [...targets];
}

function resolveGreenworksRequirement({ managerSettings, runtimeData, sourceRoot, userDataDir } = {}) {
  const targets = findGreenworksTargets(sourceRoot);
  if (!targets.length) return { needsGreenworks: false, greenworksVersion: null, targets: [] };
  const { version } = resolveRuntimeConfig({ managerSettings, runtimeData, userDataDir, needsGreenworks: true });
  return { needsGreenworks: true, greenworksVersion: version, targets };
}

function selectedContract(version, install) {
  const contract = Contracts.find(item => item.nwVersion === version);
  if (!contract) throw failure(`No Greenworks ABI is available for NW.js ${version}.`, "GREENWORKS_ABI_UNVERIFIED");
  if (install?.ready && (!install.files?.some(file => file.path === "greenworks.js" && file.sha256 === contract.javascriptSha256) ||
      !install.files?.some(file => file.path === "lib/greenworks-osx.node" && file.sha256 === contract.nativeSha256))) {
    throw failure("The installed Greenworks bridge does not match the listed native API contract.", "GREENWORKS_ABI_UNVERIFIED");
  }
  return contract;
}

function selectedHost(context, version) {
  const host = Nwjs.core.resolveBestInstalled({ userDataDir: context.userDataDir, version, variant: "sdk", platform: process.platform, arch: process.arch });
  return { host, architecture: host ? host.platformKey === "osx-x64" ? "x86_64" : "arm64" : process.arch === "x64" ? "x86_64" : process.arch };
}

async function assertHostFloor(contract, { platform = process.platform, systemVersion } = {}) {
  if (platform !== "darwin") return;
  if (systemVersion === undefined) {
    if (!hostVersionPromise) hostVersionPromise = run("/usr/bin/sw_vers", ["-productVersion"], { timeout: 10000, maxBuffer: 1024 })
      .then(result => result.stdout.trim()).catch(error => { hostVersionPromise = null; throw error; });
    systemVersion = await hostVersionPromise;
  }
  if (!/^\d+\.\d+(?:\.\d+)?$/.test(systemVersion || "")) throw failure("The macOS version could not be checked.", "GREENWORKS_OS_UNKNOWN");
  if (!versionAtLeast(systemVersion, contract.minimumMacOS)) throw failure(`Greenworks ${contract.greenworksVersion} requires macOS ${contract.minimumMacOS} or newer.`, "GREENWORKS_OS_UNSUPPORTED");
}

function resolveApiRoute({ contract, sdk, getNativeSdk, context, architecture, host }) {
  const mode = context.runtimeSettings?.steamApiMode || "auto";
  if (!["auto", "native"].includes(mode)) throw failure("Choose Automatic or Native Steam for this bridge.", "GREENWORKS_API_MODE_INVALID");
  const profileId = contract.helperAbiProfile || contract.offlineAbiProfile;
  const listedProfile = ProfileCatalog.find(profile => profile.id === profileId);
  if (mode === "auto" && profileId && (!listedProfile || listedProfile.architectures.includes(architecture))) {
    const pin = contract.helperVersion ? SteamCatalog.find(item => item.version === contract.helperVersion) : SteamCatalog[0];
    if (!pin) throw failure("The selected Greenworks Steam API helper version is unavailable.", "GREENWORKS_API_UNAVAILABLE");
    const profile = SteamProfiles.resolveProfile({ id: profileId, pin, architecture, requiredInterfaces: contract.interfaces });
    if (profile.bridgeLibrarySha256 !== contract.nativeSha256 || profile.bridgeJavascriptSha256 !== contract.javascriptSha256 ||
        profile.hostVersion !== contract.nwVersion || profile.sdkVersion !== contract.sdkVersion)
      throw failure("The selected Greenworks offline profile changed.", "GREENWORKS_ABI_UNVERIFIED");
    if (host && Native.hashFile(host.executablePath) !== profile.hostExecutableSha256)
      throw failure("The NW.js executable checksum does not match the selected Greenworks ABI.", "GREENWORKS_HOST_CHANGED");
    const helper = Steam.resolveBundledLibrary({ resourcesRoot: context.resourcesRoot, architecture, interfaces: pin.qualifiedInterfaces, catalog: [pin] });
    if (!helper.ready) throw failure(helper.reason || "The Greenworks Steam API library is unavailable.", "GREENWORKS_API_UNAVAILABLE");
    const ticket = Ticket.resolveBundledTicket({ resourcesRoot: context.resourcesRoot, architecture, version: contract.ticketVersion });
    if (!ticket.ready) throw failure(ticket.reason || "The Greenworks encrypted-ticket loader is unavailable.", "GREENWORKS_TICKET_UNAVAILABLE");
    if (profile.encryptedTicketSourceKind !== "owned" || profile.encryptedTicketVersion !== ticket.version ||
        profile.encryptedTicketSourceSha256 !== ticket.sourceSha256 || profile.encryptedTicketLibrarySha256 !== ticket.sha256 ||
        profile.encryptedTicketPolicy !== "unavailable" || ticket.policy !== "unavailable")
      throw failure("The selected Greenworks encrypted-ticket loader changed.", "GREENWORKS_ABI_UNVERIFIED");
    return { mode: "offline", profile, helper, ticket, architecture };
  }
  const nativeSdk = sdk || getNativeSdk?.();
  if (!nativeSdk?.apiLibraryPath) throw failure(`${nativeSdk?.nativeApiReason ? "The imported native Steam API changed." : "This native Steam route requires SDK 1.63 libsteam_api.dylib."} Use Runtimes → NW.js → Greenworks → Import Steamworks SDK 1.63…`, "GREENWORKS_NATIVE_API_UNAVAILABLE");
  return { mode: "native", sdk: nativeSdk, architecture };
}

function nativePrerequisites(entry, context, requirement, install, sourceRoot, selectedArchitecture) {
  const contract = selectedContract(requirement.greenworksVersion, install);
  const selected = selectedHost(context, contract.nwVersion);
  if (selectedArchitecture) selected.architecture = selectedArchitecture;
  const apiRoute = resolveApiRoute({ contract, context, ...selected, getNativeSdk: () => {
    const sdk = Sdk.resolveQualifiedTicket({ userDataDir: context.userDataDir,
      gameRoots: [entry.gamePath, sourceRoot || entry.contentRootDir, ...requirement.targets], bridgeDir: install?.installDir });
    if (!sdk) throw failure("Native Steam requires libsdkencryptedappticket.dylib from SDK 1.63. Use Runtimes → NW.js → Greenworks → Import Steamworks SDK 1.63…", "GREENWORKS_TICKET_UNAVAILABLE");
    return sdk;
  } });
  const sdk = apiRoute.ticket || apiRoute.sdk;
  const appId = AppId.readGameAppId({ gameRoot: sourceRoot || entry.contentRootDir || entry.gamePath, extraRoots: requirement.targets });
  if (appId.status === "invalid" || appId.status === "conflict") throw failure("The game's Steam application ID metadata is invalid or conflicting.", "GREENWORKS_APP_ID_INVALID");
  if (apiRoute.mode === "offline" && !appId.value) throw failure("The game's Steam application ID could not be found.", "GREENWORKS_APP_ID_REQUIRED");
  return { contract, sdk, apiRoute, appId };
}

async function getRuntimeRequirements(entry, context, { sourceRoot } = {}) {
  if (context.runtimeId !== "nwjs" && context.runtimeId !== "nwjs-patched") return [];
  const requirement = resolveGreenworksRequirement({
    userDataDir: context.userDataDir,
    managerSettings: context.settings?.runtimes?.nwjs,
    runtimeData: entry.runtimeData?.[context.runtimeId],
    sourceRoot: sourceRoot || entry.contentRootDir || entry.gamePath
  });
  if (!requirement.needsGreenworks) return [];
  const installed = Greenworks.listInstalled(context.userDataDir).find(item => item.version === requirement.greenworksVersion);
  await assertHostFloor(selectedContract(requirement.greenworksVersion, installed));
  // Loader/ABI prerequisites are checked before any host/bridge consent.
  // Package installation is separate from a complete native Steam dependency.
  const { sdk } = nativePrerequisites(entry, context, requirement, installed, sourceRoot);
  if (sdk.installDir) context.recordRuntimeUse?.({ managerId: "nwjs", version: sdk.version,
    sectionId: "greenworks", sourcePath: sdk.installDir });
  if (installed?.ready !== false && installed) {
    context.recordRuntimeUse?.({ managerId: "nwjs", version: installed.version,
      sectionId: "greenworks", sourcePath: installed.installDir });
    return [];
  }
  return [{ managerId: "nwjs", version: requirement.greenworksVersion, installOptions: { sectionId: "greenworks" } }];
}

async function prepareLaunchEnvironment({ entry, context, install, sourceRoot, runtimeVersion, architecture, baseEnvironment = process.env }) {
  const requirement = resolveGreenworksRequirement({ sourceRoot,
    managerSettings: context.settings?.runtimes?.nwjs, runtimeData: { version: runtimeVersion } });
  if (!requirement.needsGreenworks) return null;
  await assertHostFloor(selectedContract(requirement.greenworksVersion, install));
  const { contract, sdk, apiRoute, appId } = nativePrerequisites(entry, context, requirement, install, sourceRoot, architecture);
  if (typeof context.prepareSteamApi !== "function") throw failure("The native Steam API launch service is unavailable.", "GREENWORKS_NATIVE_API_UNAVAILABLE");
  const request = { required: true, appId: appId.value, arch: architecture, symbols: contract.symbols, interfaces: contract.interfaces,
    nativeLibraryPaths: apiRoute.mode === "native" ? [sdk.apiLibraryPath] : [],
    ...(apiRoute.mode === "offline" ? { abiProfile: apiRoute.profile.id, version: apiRoute.profile.helperVersion, preferOffline: true } : {}),
    ownedDirectory: path.join(GameData.resolveGameRuntimeDir(context.userDataDir, entry.gameId, context.runtimeId), "steam-api") };
  const steam = await context.prepareSteamApi(request, { baseEnvironment });
  if (!steam?.libraryPath || !steam.environment || steam.mode !== apiRoute.mode ||
      steam.mode === "offline" && steam.abiProfile !== apiRoute.profile.id)
    throw failure("The native Steam API result differs from the selected Greenworks route.", "GREENWORKS_ABI_UNVERIFIED");
  return { ...steam, sdk, requirement };
}

function ensureGreenworksInstalled({ userDataDir, version }) {
  const exact = Greenworks.normalizeNwVersion(version);
  const install = Greenworks.listInstalled(userDataDir).find(item => item.version === exact);
  if (install?.ready !== false && install) return install;
  throw failure(install?.reason || `Greenworks for the selected NW.js ${exact} is not installed.`, "GREENWORKS_UNAVAILABLE");
}

function materializeDirectory(wrapperDir, sourceRoot, relative) {
  let destination = wrapperDir, source = sourceRoot;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    destination = path.join(destination, part); source = path.join(source, part);
    let stat;
    try { stat = fs.lstatSync(destination); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (stat?.isSymbolicLink()) { fs.unlinkSync(destination); stat = null; }
    if (stat && !stat.isDirectory()) throw failure("Greenworks overlay path is not a directory.", "GREENWORKS_OVERLAY_INVALID");
    if (!stat) {
      fs.mkdirSync(destination);
      for (const entry of fs.readdirSync(source, { withFileTypes: true })) fs.symlinkSync(path.join(source, entry.name), path.join(destination, entry.name));
    }
  }
  return destination;
}

function copyOwnedTree(source, destination) {
  const stat = fs.lstatSync(source);
  let existing;
  try { existing = fs.lstatSync(destination); } catch (error) { if (error.code !== "ENOENT") throw error; }
  // The wrapper initially links original files. Always detach the destination
  // before replacement; writing through one of those links edits the game.
  if (existing?.isSymbolicLink()) { fs.unlinkSync(destination); existing = null; }
  if (stat.isDirectory()) {
    if (existing && !existing.isDirectory()) throw failure("Greenworks overlay destination has an incompatible file.", "GREENWORKS_OVERLAY_INVALID");
    fs.mkdirSync(destination, { recursive: true });
    for (const name of fs.readdirSync(source)) copyOwnedTree(path.join(source, name), path.join(destination, name));
  } else if (stat.isFile()) {
    if (existing && !existing.isFile()) throw failure("Greenworks overlay destination has an incompatible directory.", "GREENWORKS_OVERLAY_INVALID");
    fs.copyFileSync(source, destination);
  } else if (stat.isSymbolicLink()) {
    if (existing) fs.unlinkSync(destination);
    fs.symlinkSync(fs.readlinkSync(source), destination);
  } else throw failure("Greenworks package contains an unsupported file type.", "GREENWORKS_OVERLAY_INVALID");
}

function overlayGreenworks({ wrapperDir, sourceRoot, greenworksDir, targets, steam }) {
  if (!greenworksDir) return;
  for (const target of targets?.length ? targets : findGreenworksTargets(sourceRoot)) {
    const relative = path.relative(sourceRoot, target);
    if (!contained(sourceRoot, target)) throw failure("Greenworks target is outside the original game.", "GREENWORKS_OVERLAY_INVALID");
    const destination = relative ? materializeDirectory(wrapperDir, sourceRoot, relative) : wrapperDir;
    copyOwnedTree(greenworksDir, destination);
    if (steam) {
      const libraryRoot = path.join(destination, "lib");
      fs.mkdirSync(libraryRoot, { recursive: true });
      const libraryStat = fs.lstatSync(libraryRoot);
      if (!libraryStat.isDirectory() || libraryStat.isSymbolicLink()) throw failure("Greenworks native aliases require an owned library directory.", "GREENWORKS_OVERLAY_INVALID");
      for (const [name, source] of [[Sdk.PIN.filename, steam.sdk.libraryPath], [Sdk.PIN.api.filename, steam.libraryPath]]) {
        const alias = path.join(libraryRoot, name);
        try { fs.unlinkSync(alias); } catch (error) { if (error.code !== "ENOENT") throw error; }
        fs.symlinkSync(source, alias);
      }
    }
  }
}

module.exports = { LIMITS, resolveRuntimeConfig, findGreenworksTargets, resolveGreenworksRequirement, selectedHost, assertHostFloor, resolveApiRoute,
  selectedContract, nativePrerequisites, prepareLaunchEnvironment,
  getRuntimeRequirements, ensureGreenworksInstalled, overlayGreenworks };
