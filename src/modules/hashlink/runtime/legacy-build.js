const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const Native = require("../../shared/runtime/local-native");
const { validatePinnedSource, stagePinnedFiles, runBuildCommand, findBuildTool } = require("../../shared/runtime/pinned-native-build");
const CompilerPaths = require("./compiler-paths");

const UPSTREAM_VERSION = "1.9";
const VERSION = "1.9-MCLv1";
const REVISION = "4a4cfe91f3388a0b05bf2e45e7c4e38bae686dc6";
const SDL_REVISION = "53dea9830964eee8b5c2a7ee0a65d6e268dc78a1";
const OPENAL_REVISION = "dc7d7054a5b4f3bec1dc23a42fd616a0847af948";
const SDK_SOURCE = path.resolve(__dirname, "../../../external/krkrsdl2/external/SDL");
const OPENAL_SOURCE = path.resolve(__dirname, "../../../external/openal-soft");

function adaptSource(source, sdlSource) {
  const jpeg = path.join(source, "include/turbojpeg/jconfig.h"), png = path.join(source, "include/png/pngpriv.h");
  const jpegText = fs.readFileSync(jpeg, "utf8"), pngText = fs.readFileSync(png, "utf8");
  if (!jpegText.includes("#\tdefine WITH_SIMD") || !pngText.includes("|| defined(TARGET_OS_MAC)")) throw new Error("HashLink 1.9 source files do not match the Mac build adapter.");
  fs.writeFileSync(jpeg, jpegText.replace("#\tdefine WITH_SIMD", "/* Portable Mac build uses the bundled non-SIMD JPEG implementation. */"));
  // TARGET_OS_MAC denotes classic Mac in this old bundled PNG source. Modern
  // Apple's SDK also defines it; its C math interface is math.h, not fp.h.
  fs.writeFileSync(png, pngText.replace(" || defined(TARGET_OS_MAC)", ""));
  fs.copyFileSync(path.resolve(__dirname, "../overlays/native-1.9.cmake"), path.join(source, "CMakeLists.txt"));
  const headers = path.join(source, "include/SDL2"); fs.mkdirSync(headers, { recursive: true });
  for (const name of fs.readdirSync(path.join(sdlSource, "include"))) {
    if (name.endsWith(".h")) fs.copyFileSync(path.join(sdlSource, "include", name), path.join(headers, name));
  }
  return crypto.createHash("sha256").update(Native.hashFile(jpeg)).update(Native.hashFile(png))
    .update(Native.hashFile(path.join(source, "CMakeLists.txt"))).digest("hex");
}

async function buildRuntime({ userDataDir, sourcePath, sdlSourcePath, openalSourcePath, logger, signal, onProgress } = {}) {
  if (process.platform !== "darwin") throw new Error("HashLink native builds require macOS.");
  const manager = require("./manager"), installed = manager.core.resolveRegistered({ userDataDir, version: VERSION });
  if (installed) return installed;
  const source = sourcePath || path.resolve(__dirname, "../../../external/hashlink");
  const checkoutRevision = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 10000 }).trim();
  if (!manager.core.catalog.some(pin => pin.upstreamRevision === checkoutRevision)) throw new Error("HashLink source checkout must use one of the explicitly listed source pins.");
  await validatePinnedSource(source, checkoutRevision, { signal });
  const sdl = sdlSourcePath || SDK_SOURCE;
  const checkedSDL = await validatePinnedSource(sdl, SDL_REVISION, { signal });
  const openal = openalSourcePath || OPENAL_SOURCE;
  const checkedOpenAL = await validatePinnedSource(openal, OPENAL_REVISION, { signal });
  const cmake = findBuildTool("cmake"), make = findBuildTool("make"), ninja = findBuildTool("ninja");
  const directory = manager.core.getInstallDir({ userDataDir, version: VERSION });
  if (fs.existsSync(directory)) throw new Error("Remove the incomplete HashLink 1.9 installation in Runtimes before rebuilding.");
  fs.mkdirSync(directory, { recursive: true });
  const logPath = path.join(directory, "build.log"); fs.writeFileSync(logPath, `HashLink ${VERSION}\nSource ${REVISION}\nSDL2 ${SDL_REVISION}\nOpenAL-soft ${OPENAL_REVISION}\n`);
  // Some filesystems acknowledge compiler output before a separate
  // linker sees it. Compile on the native temporary filesystem, then publish
  // verified copies into managed data; retained inputs/logs remain with runtime.
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-hashlink-1.9-"));
  try {
  const command = { cwd: temporary, logPath, env: { ...process.env, HOMEBREW_NO_AUTO_UPDATE: "1" }, signal };
  const ownedCheckout = path.join(directory, "upstream-git"), copiedSource = path.join(temporary, "source");
  // Clone local objects into our owned directory, then check out the immutable
  // older tag there. Never change the vendored checkout or fetch a moving branch.
  await runBuildCommand("git", ["clone", "--shared", "--no-checkout", "--", source, ownedCheckout], command);
  await runBuildCommand("git", ["-C", ownedCheckout, "checkout", "--detach", REVISION], command);
  const checked = await validatePinnedSource(ownedCheckout, REVISION, { signal });
  const sourceTreeSha256 = stagePinnedFiles(ownedCheckout, checked.files, copiedSource);
  const copiedSDL = path.join(temporary, "sdl-source"), sdlBuild = path.join(temporary, "sdl-build");
  const sdlSourceTreeSha256 = stagePinnedFiles(sdl, checkedSDL.files, copiedSDL);
  const copiedOpenAL = path.join(temporary, "openal-source"), openalBuild = path.join(temporary, "openal-build");
  const openalSourceTreeSha256 = stagePinnedFiles(openal, checkedOpenAL.files, copiedOpenAL);
  const overlaySha256 = adaptSource(copiedSource, copiedSDL);
  const compilerPathMappings = CompilerPaths.compilerPathMappings({ source: copiedSource, sdlSource: copiedSDL,
    openalSource: copiedOpenAL, build: temporary, runtime: directory });
  const compilerFlags = CompilerPaths.compilerFlags(compilerPathMappings);
  const mappedFlags = CompilerPaths.flagsString(compilerFlags);
  const compilerOverlay = path.join(temporary, "compiler-paths.cmake");
  fs.writeFileSync(compilerOverlay, CompilerPaths.cmakeOverlay(compilerFlags));
  const compilerOptions = [`-DCMAKE_PROJECT_INCLUDE=${compilerOverlay}`];
  const configureOptions = ["-G", "Ninja", `-DCMAKE_MAKE_PROGRAM=${ninja}`, "-DCMAKE_OSX_ARCHITECTURES=x86_64", "-DCMAKE_OSX_DEPLOYMENT_TARGET=13.0",
    "-DSDL_SHARED=OFF", "-DSDL_STATIC=ON", "-DSDL_TEST=OFF", "-DSDL_X11=OFF", "-DCMAKE_POLICY_VERSION_MINIMUM=3.5",
    "-DHAVE_GCC_WERROR_DECLARATION_AFTER_STATEMENT=OFF", "-DFETCHCONTENT_FULLY_DISCONNECTED=ON", "-DFETCHCONTENT_UPDATES_DISCONNECTED=ON", ...compilerOptions];
  onProgress?.({ phase: "source", percent: 5 });
  await runBuildCommand(cmake, ["-S", copiedSDL, "-B", sdlBuild, ...configureOptions], command);
  await runBuildCommand(cmake, ["--build", sdlBuild, "--parallel", "2"], command);
  const openalConfigureOptions = ["-G", "Ninja", `-DCMAKE_MAKE_PROGRAM=${ninja}`, "-DCMAKE_BUILD_TYPE=Release",
    "-DCMAKE_OSX_ARCHITECTURES=x86_64", "-DCMAKE_OSX_DEPLOYMENT_TARGET=13.0", "-DLIBTYPE=SHARED",
    "-DALSOFT_UTILS=OFF", "-DALSOFT_EXAMPLES=OFF", "-DALSOFT_TESTS=OFF", "-DALSOFT_INSTALL=OFF",
    "-DALSOFT_UPDATE_BUILD_VERSION=OFF", "-DALSOFT_BACKEND_COREAUDIO=ON", "-DALSOFT_REQUIRE_COREAUDIO=ON",
    "-DALSOFT_BACKEND_PIPEWIRE=OFF", "-DALSOFT_BACKEND_PULSEAUDIO=OFF", "-DALSOFT_BACKEND_JACK=OFF",
    "-DALSOFT_BACKEND_PORTAUDIO=OFF", "-DALSOFT_BACKEND_SDL2=OFF", "-DALSOFT_BACKEND_SDL3=OFF",
    "-DFETCHCONTENT_FULLY_DISCONNECTED=ON", "-DFETCHCONTENT_UPDATES_DISCONNECTED=ON", ...compilerOptions];
  await runBuildCommand(cmake, ["-S", copiedOpenAL, "-B", openalBuild, ...openalConfigureOptions], command);
  await runBuildCommand(cmake, ["--build", openalBuild, "--parallel", "2"], command);
  onProgress?.({ phase: "native", percent: 40 });
  const makeCompilerArguments = ["/usr/bin/clang", "-arch", "x86_64", "-mmacosx-version-min=13.0", ...compilerFlags];
  await runBuildCommand(make, ["-j2", "hl", "ui", `CC=/usr/bin/clang -arch x86_64 -mmacosx-version-min=13.0 ${mappedFlags}`], { ...command, cwd: copiedSource });
  const build = path.join(temporary, "native-build");
  const nativeConfigureOptions = ["-G", "Ninja", `-DCMAKE_MAKE_PROGRAM=${ninja}`, "-DCMAKE_SKIP_BUILD_RPATH=ON",
    `-DHASHLINK_SDL_LIBRARY=${path.join(sdlBuild, "libSDL2.a")}`,
    `-DHASHLINK_OPENAL_LIBRARY=${path.join(openalBuild, "libopenal.1.24.3.dylib")}`,
    `-DHASHLINK_OPENAL_INCLUDE=${path.join(copiedOpenAL, "include")}`, ...compilerOptions];
  await runBuildCommand(cmake, ["-S", copiedSource, "-B", build, ...nativeConfigureOptions], command);
  await runBuildCommand(cmake, ["--build", build, "--parallel", "2"], command);
  onProgress?.({ phase: "publish", percent: 85 });
  const output = path.join(directory, "build-output/bin"); fs.mkdirSync(output, { recursive: true });
  for (const name of ["hl", "libhl.dylib", "fmt.hdll", "ui.hdll", "sdl.hdll", "openal.hdll"]) {
    const target = path.join(output, name); fs.copyFileSync(path.join(copiedSource, name), target);
    if (name === "hl") fs.chmodSync(target, 0o755);
    if (name !== "libhl.dylib") await runBuildCommand("/usr/bin/install_name_tool", ["-change", "libhl.dylib", "@loader_path/libhl.dylib", target], command);
    if (name === "openal.hdll") await runBuildCommand("/usr/bin/install_name_tool", ["-change", "@rpath/libopenal.1.dylib", "@loader_path/libopenal.1.dylib", target], command);
    await runBuildCommand("/usr/bin/codesign", ["--force", "--sign", "-", target], command);
  }
  const openalLibrary = path.join(output, "libopenal.1.dylib");
  fs.copyFileSync(path.join(openalBuild, "libopenal.1.24.3.dylib"), openalLibrary);
  await runBuildCommand("/usr/bin/codesign", ["--force", "--sign", "-", openalLibrary], command);
  await validatePinnedSource(source, checkoutRevision, { signal }); await validatePinnedSource(sdl, SDL_REVISION, { signal });
  await validatePinnedSource(openal, OPENAL_REVISION, { signal });
  signal?.throwIfAborted();
  fs.cpSync(copiedSource, path.join(directory, "source"), { recursive: true });
  fs.cpSync(copiedSDL, path.join(directory, "sdl-source"), { recursive: true });
  fs.cpSync(copiedOpenAL, path.join(directory, "openal-source"), { recursive: true });
  const verifiedBuild = { sourceRevision: REVISION, upstreamVersion: UPSTREAM_VERSION, macPackageVersion: VERSION,
    checkoutRevision, sourceTreeSha256, overlaySha256, configureOptions, compilerPathMapProfile: CompilerPaths.PROFILE,
    nativeConfigureOptions, makeCompilerArguments, compilerPathSourceSha256: Native.hashFile(require.resolve("./compiler-paths")),
    compilerPathOverlaySha256: Native.hashFile(compilerOverlay),
    compilerPlatform: { platform: process.platform, hostArch: process.arch, targetArch: "x86_64", minimumMacOS: "13.0" },
    nativeProfile: "1.9-sdl2.0.22-openal-soft1.24.3-macos-v2", dependencies: [
      { name: "SDL2", sourceRevision: SDL_REVISION, sourceTreeSha256: sdlSourceTreeSha256 },
      { name: "OpenAL-soft", version: "1.24.3", sourceRevision: OPENAL_REVISION, sourceTreeSha256: openalSourceTreeSha256, configureOptions: openalConfigureOptions }], logPath };
  fs.writeFileSync(path.join(directory, "build-evidence.json"), JSON.stringify({ version: VERSION, verifiedBuild, compilerPathMappings }, null, 2));
  const result = manager.core.registerLocal({ userDataDir, version: VERSION, runtimePath: path.join(output, "hl"), verifiedBuild });
  onProgress?.({ phase: "ready", percent: 100 });
  logger?.info?.(`[runtime] built matching HashLink ${VERSION} native modules; ${logPath}`);
  return result;
  } finally { fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}

module.exports = { buildRuntime, adaptSource, VERSION, UPSTREAM_VERSION, REVISION, SDL_REVISION, OPENAL_REVISION };
