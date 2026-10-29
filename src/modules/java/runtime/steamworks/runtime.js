const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Bundle = require("../../../shared/runtime/bundled-native");
const Included = require("../../../shared/runtime/included-helpers");
const declarations = require("./distribution-supplementals.json");
const Native = require("../../../shared/runtime/local-native");
const GameData = require("../../../shared/game-data");
const Consumer = require("./consumer");
const Catalog = require("./versions.json");

const failure = (code, message) => Object.assign(new Error(message), { code });
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

// JNI is loaded by absolute path after its exact API provider is selected.
// The publisher's LC_ID_DYLIB identifies the library; it is not an input path.
function nativeHostDependencies() {
  return Catalog.map(pin => ({ id: "java-steamworks", version: pin.bridgeVersion,
    file: "libsteamworks4j.dylib", sha256: pin.jniSha256, dependency: "@loader_path/libsteam_api.dylib",
    provider: { id: "steam-api-helper", version: pin.helperVersion, file: "libsteam_api.dylib" },
    installNames: pin.version === "1.9.0" ? ["/usr/local/lib/libsteamworks4j.dylib"]
      : pin.architectures.map(architecture => `/usr/local/lib/libsteamworks4j-${architecture}.dylib`) }));
}

/** The wrapper selects its matching JNI; a newer JNI is never substituted. */
function requiredVariant(entry, { hostArch = process.arch, explicitVariant, preferredVariant } = {}) {
  const required = Consumer.requirement(entry);
  if (!required) return null;
  const available = required.pin.architectures.map(arch => arch === "x86_64" ? "x64" : arch);
  if (explicitVariant && !available.includes(explicitVariant))
    throw failure("JAVA_STEAM_CPU_MISMATCH", "This game's exact Java Steam bridge requires a different JVM CPU.");
  if (explicitVariant) {
    if (hostArch !== "arm64" && explicitVariant === "arm64")
      throw failure("JAVA_STEAM_CPU_UNAVAILABLE", "An ARM JVM cannot run on this Intel Mac.");
    return explicitVariant;
  }
  if (preferredVariant && available.includes(preferredVariant) && (hostArch === "arm64" || preferredVariant === "x64")) return preferredVariant;
  if (hostArch === "arm64" && available.includes("arm64")) return "arm64";
  if (available.includes("x64")) return "x64";
  throw failure("JAVA_STEAM_CPU_UNAVAILABLE", "This game's exact Java Steam bridge has no compatible JVM CPU.");
}

function resolveBundle(pin, { resourcesRoot, verification = "full", native = Native, declarations: includedDeclarations = declarations } = {}) {
  const included = Included.resolveIncluded(includedDeclarations, { id: "java-steamworks", version: pin.bridgeVersion, resourcesRoot });
  if (included) {
    const { directory, manifest, item } = included;
    const record = JSON.parse(manifest.bytes);
    if (record.id !== "java-steamworks" || record.version !== pin.bridgeVersion || record.wrapperVersion !== pin.version ||
        record.sourceRevision !== pin.sourceRevision || record.librarySha256 !== pin.jniSha256 || record.abiProfile !== pin.abiProfile ||
        record.agentSha256 !== pin.agentSha256 || record.agentClassMajor !== 52)
      throw failure("JAVA_STEAM_BUNDLE_CHANGED", "The included Java Steam bridge source or ABI changed.");
    const libraryPath = path.join(directory, "libsteamworks4j.dylib"), agentPath = path.join(directory, "steam-agent.jar");
    if (verification === "full") {
      Bundle.verifyPayload(directory, { ...record, files: [...record.files,
        { path: item.manifestRelative, size: manifest.size, sha256: item.manifestSha256, mode: 0o644 }] });
      const library = Bundle.readRegular(libraryPath, 2 * 1024 * 1024), agent = Bundle.readRegular(agentPath, 128 * 1024);
      if (library.sha256 !== pin.jniSha256 || library.size !== pin.jniSize || agent.sha256 !== pin.agentSha256 ||
          JSON.stringify(native.readMachOArchitectures(libraryPath, { allowLibrary: true }).sort()) !== JSON.stringify(pin.architectures.slice().sort()))
        throw failure("JAVA_STEAM_BUNDLE_CHANGED", "The included Java Steam JNI or loader agent changed.");
    } else if (![libraryPath, agentPath].every(file => fs.lstatSync(file).isFile() && !fs.lstatSync(file).isSymbolicLink()))
      throw failure("JAVA_STEAM_BUNDLE_CHANGED", "The included Java Steam bridge files are invalid.");
    return { ...pin, ready: true, directory, libraryPath, agentPath, source: "bundled", bundledExecution: "direct" };
  }
  throw failure("JAVA_STEAM_BRIDGE_UNAVAILABLE", "This app build does not include this game's exact Java Steam bridge.");
}

function ownedDirectory(userDataDir, directory) {
  if (!path.isAbsolute(userDataDir || "") || !path.isAbsolute(directory || ""))
    throw failure("JAVA_STEAM_STATE_INVALID", "Java Steam state needs absolute launcher game paths.");
  const root = path.resolve(userDataDir), target = path.resolve(directory), relative = path.relative(root, target);
  if (relative.split(path.sep)[0] !== "games" || relative.split(path.sep).length < 3 || relative.startsWith(".." + path.sep))
    throw failure("JAVA_STEAM_STATE_INVALID", "Java Steam state must belong to one game's launcher data.");
  Bundle.realDirectory(root, { create: true });
  let current = fs.realpathSync(root);
  for (const name of relative.split(path.sep)) {
    current = path.join(current, name);
    try { fs.mkdirSync(current, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
    if (!fs.lstatSync(current).isDirectory() || fs.lstatSync(current).isSymbolicLink())
      throw failure("JAVA_STEAM_STATE_INVALID", "Java Steam state directories cannot use symlinks.");
  }
  return current;
}

/** The JVM canonicalizes symlinks, so @loader_path needs a real JNI entry.
 * A hardlink shares the small native bridge. Across volumes/protected app
 * bundles, clone/copy only that bridge; originals, games and JREs stay shared. */
function prepareNativeLayout(directory, bridge, steam, operations = fs) {
  Bundle.realDirectory(directory, { create: true });
  const key = digest(JSON.stringify([bridge.bridgeVersion, bridge.jniSha256, steam.libraryPath, steam.sha256]));
  const target = path.join(directory, key), name = "libsteamworks4j.dylib", apiName = "libsteam_api.dylib";
  const verify = () => {
    if (!fs.lstatSync(target).isDirectory() || fs.lstatSync(target).isSymbolicLink() ||
        JSON.stringify(fs.readdirSync(target).sort()) !== JSON.stringify([apiName, name].sort()))
      throw failure("JAVA_STEAM_LAYOUT_CHANGED", "The game's Java Steam library layout changed.");
    const jni = path.join(target, name), api = path.join(target, apiName);
    const info = fs.lstatSync(jni);
    if (!info.isFile() || info.isSymbolicLink() || Bundle.readRegular(jni, 2 * 1024 * 1024).sha256 !== bridge.jniSha256 ||
        !fs.lstatSync(api).isSymbolicLink() || fs.readlinkSync(api) !== steam.libraryPath)
      throw failure("JAVA_STEAM_LAYOUT_CHANGED", "The game's Java Steam native files changed.");
  };
  if (fs.existsSync(target)) { verify(); return path.join(target, name); }
  const staging = fs.mkdtempSync(path.join(directory, ".prepare-"));
  try {
    try { operations.linkSync(bridge.libraryPath, path.join(staging, name)); }
    catch (error) {
      if (!["EXDEV", "EPERM", "EACCES", "ENOTSUP"].includes(error.code)) throw error;
      operations.copyFileSync(bridge.libraryPath, path.join(staging, name), fs.constants.COPYFILE_FICLONE);
    }
    fs.symlinkSync(steam.libraryPath, path.join(staging, apiName));
    try { fs.renameSync(staging, target); }
    catch (error) { if (!fs.existsSync(target)) throw error; }
    verify(); return path.join(target, name);
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}

function property(value) {
  return String(value).replace(/[\\\r\n\t\f=:#!]/g, character => ({ "\\": "\\\\", "\r": "\\r", "\n": "\\n", "\t": "\\t", "\f": "\\f" }[character] || "\\" + character))
    .replace(/^ /, "\\ ");
}
function writeConfiguration(directory, bridge, steam, jni, arch) {
  const content = ["version=" + property(bridge.version), "arch=" + arch,
    "helper=" + property(steam.libraryPath), "jni=" + property(jni)].join("\n") + "\n";
  const configuration = path.join(directory, "loader-" + digest(content) + ".properties");
  const bytes = Buffer.from(content);
  if (fs.existsSync(configuration)) {
    if (!fs.lstatSync(configuration).isFile() || fs.lstatSync(configuration).isSymbolicLink() ||
        !Bundle.readRegular(configuration, 64 * 1024).bytes.equals(bytes))
      throw failure("JAVA_STEAM_CONFIGURATION_CHANGED", "The game's Java Steam loader configuration changed.");
    return configuration;
  }
  const temporary = path.join(directory, ".loader-" + crypto.randomBytes(16).toString("hex"));
  try {
    fs.writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
    fs.linkSync(temporary, configuration);
  } catch (error) {
    if (error.code !== "EEXIST" || !Bundle.readRegular(configuration, 64 * 1024).bytes.equals(bytes)) throw error;
  } finally { fs.rmSync(temporary, { force: true }); }
  return configuration;
}

async function prepareLaunch(entry, context, install, baseEnvironment = process.env) {
  const required = Consumer.requirement(entry);
  if (!required) return null;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(entry.gameId || ""))
    throw failure("JAVA_STEAM_STATE_INVALID", "Java Steam setup requires this game's library identity.");
  const arch = install.variant === "x64" ? "x86_64" : install.variant;
  if (!required.pin.architectures.includes(arch)) throw failure("JAVA_STEAM_CPU_MISMATCH", "The selected JVM CPU does not match this game's Java Steam bridge.");
  const bridge = resolveBundle(required.pin, { resourcesRoot: context.resourcesRoot });
  if (typeof context.prepareSteamApi !== "function") throw failure("JAVA_STEAM_SERVICE_UNAVAILABLE", "The native Steam API launch service is unavailable.");
  const directory = ownedDirectory(context.userDataDir, GameData.resolveGameRuntimeDir(context.userDataDir, entry.gameId, "java"));
  const steam = await context.prepareSteamApi({ required: true, appId: required.evidence.appId.value, arch,
    abiProfile: bridge.helperAbiProfile || bridge.abiProfile,
    ...(bridge.helperVersion ? { version: bridge.helperVersion } : {}),
    symbols: bridge.symbols, interfaces: bridge.interfaces,
    nativeLibraryPaths: [path.join(required.evidence.gameRoot, "libsteam_api.dylib")], ownedDirectory: path.join(directory, "steam-api") }, { baseEnvironment });
  if (!steam?.libraryPath || !steam.environment) throw failure("JAVA_STEAM_SERVICE_UNAVAILABLE", "The native Steam API prerequisite could not be prepared.");
  const jni = prepareNativeLayout(path.join(directory, "native-libraries"), bridge, steam);
  const configuration = writeConfiguration(directory, bridge, steam, jni, install.variant);
  return { bridge, steam, jni, configuration, environment: steam.environment, vmArgs: ["-javaagent:" + bridge.agentPath + "=" + configuration] };
}

module.exports = { Catalog, nativeHostDependencies, requiredVariant, resolveBundle, ownedDirectory, prepareNativeLayout, writeConfiguration, prepareLaunch, property };
