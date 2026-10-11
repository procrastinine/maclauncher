const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const Source = require("../../shared/runtime/pinned-native-build");
const Native = require("../../shared/runtime/local-native");
const Steam = require("../../shared/runtime/steamworks");
const SteamPins = require("../../shared/runtime/steamworks/versions.json");
const Overlay = require("./luasteam-source-overlay");
const { throwIfAborted } = require("../../shared/runtime/download-utils");

const execFileAsync = promisify(execFile);
const SOURCE_ROOT = path.resolve(__dirname, "../../..");

/** Optional maintainer build; packaged Play never invokes a compiler. */
async function buildFromSource({ version = Overlay.VERSION, destination, sourceDir = path.join(SOURCE_ROOT, "external/luasteam"),
  sdkDir = path.join(SOURCE_ROOT, "external/SteamworksSDK"), steamLibraryPath, signal, logger } = {}) {
  if (version !== Overlay.VERSION || process.platform !== "darwin" || !path.isAbsolute(destination || ""))
    throw new Error("Choose the exact listed LuaSteam profile and an absolute new Mac build directory.");
  const target = path.resolve(destination);
  if (fs.existsSync(target)) throw new Error("This LuaSteam build directory already exists; its files were preserved.");
  throwIfAborted(signal);
  await Source.validatePinnedSource(sourceDir, Overlay.SOURCE_REVISION, { signal });
  await Source.validatePinnedSource(sdkDir, Overlay.SDK_HEADERS_REVISION, { signal });
  const luaHeadersDir = path.join(sourceDir, "luajit");
  await Source.validatePinnedSource(luaHeadersDir, Overlay.LUA_HEADERS_REVISION, { signal });
  const pin = SteamPins[0];
  const libraryPath = steamLibraryPath || path.resolve(SOURCE_ROOT, "resources/native-runtimes/steam-api-helper", pin.version, "universal/libsteam_api.dylib");
  Steam.verifiedLibrary(libraryPath, { sha256: pin.librarySha256, architecture: "arm64" });
  Steam.verifiedLibrary(libraryPath, { sha256: pin.librarySha256, architecture: "x86_64" });
  try { await execFileAsync("/usr/bin/xcrun", ["--find", "clang++"], { encoding: "utf8", timeout: 10000 }); }
  catch { throw new Error("Source builds need Apple's Command Line Tools. Install them with xcode-select --install; clang++ is supplied through /usr/bin/xcrun. Packaged LuaSteam does not need these tools."); }
  fs.mkdirSync(target, { recursive: true });
  const sourceRoot = path.join(target, "source");
  const source = Overlay.stageSource({ roots: { luasteam: sourceDir, luajit: luaHeadersDir, steamSdk: sdkDir }, destination: sourceRoot });
  const logPath = path.join(target, "build.log");
  fs.writeFileSync(logPath, `${version}\n${source.sourceTreeSha256}\n`);
  const options = { cwd: target, logPath, signal, env: { ...process.env }, timeout: 120000 };
  for (const architecture of ["arm64", "x86_64"]) {
    throwIfAborted(signal);
    const outputPath = path.join(target, `luasteam-${architecture}.so`);
    logger?.info?.(`[luasteam] build ${version}/${architecture}`);
    await Source.runBuildCommand("/usr/bin/xcrun", ["clang++", ...Overlay.compilerArguments({ sourceRoot, architecture, steamLibraryPath: libraryPath, outputPath })], options);
    await Source.runBuildCommand("/usr/bin/install_name_tool", ["-change", "@rpath/libsteam_api.dylib", "@loader_path/libsteam_api.dylib", outputPath], options);
  }
  const library = path.join(target, "luasteam.so");
  await Source.runBuildCommand("/usr/bin/lipo", ["-create", path.join(target, "luasteam-arm64.so"), path.join(target, "luasteam-x86_64.so"), "-output", library], options);
  await Source.runBuildCommand("/usr/bin/codesign", ["--force", "--sign", "-", library], options);
  if (JSON.stringify(Native.readMachOArchitectures(library, { allowLibrary: true }).sort()) !== JSON.stringify(["arm64", "x86_64"]))
    throw new Error("The LuaSteam build did not produce both reviewed CPU slices.");
  await Source.validatePinnedSource(sourceDir, Overlay.SOURCE_REVISION, { signal });
  await Source.validatePinnedSource(sdkDir, Overlay.SDK_HEADERS_REVISION, { signal });
  const receipt = { schemaVersion: 1, id: "love-luasteam", version, source,
    librarySha256: Native.hashFile(library), architectures: ["arm64", "x86_64"], hostLuaAbi: Overlay.HOST_LUA_ABI,
    steamLibraryVersion: pin.version, steamLibrarySha256: pin.librarySha256, logPath,
    compilerArguments: ["arm64", "x86_64"].map(architecture => Overlay.compilerArguments({ sourceRoot, architecture,
      steamLibraryPath: libraryPath, outputPath: path.join(target, `luasteam-${architecture}.so`) })) };
  fs.writeFileSync(path.join(target, "build-receipt.json"), JSON.stringify(receipt, null, 2));
  return { ...receipt, libraryPath: library, sourceRoot };
}

module.exports = { buildFromSource };
