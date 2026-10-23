const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const Source = require("../../shared/runtime/pinned-native-build");
const Native = require("../../shared/runtime/local-native");
const Fonts = require("../../shared/runtime/portable-sdl2-fonts");
const MachO = require("../../shared/runtime/macho-load-commands");
const Dependency = require("./portable-dependencies");
const Prefix = require("./portable-prefix");
const Adapter = require("./adapter");
const Patches = require("./source-patches");
const Existing = require("./build");
const PortableOverlay = require("./portable-overlay");
const DependencyOverlays = require("./dependency-overlays.json");
const { throwIfAborted } = require("../../shared/runtime/download-utils");

const VERSION = "0.10.8.810-windows-v4";
const PROFILE = "windows-mpk2-sc3-macos13-v4";
const SOURCE_TREES = Object.freeze({
  impacto: "2a00bf7f39026b503c912771b24577c6564b74baf555c6b830c462ec332f1e34",
  avcpp: "93e6901d79049e16a2358b06487a9ca5bd8cce00a24922e25083ce4c0c08b652",
  atrac9: "7695aefd9eee95dd69a426d049f485edb47d9465bef688aaa1817fb6695cd671",
  magicEnum: "01c4fd3e307c10d8aa6ff44a392a262383468efbc9a413d0562a73b0e47a454a"
});
const PROFILE_SHA256 = "2c53ac4a44ad388dfce6ac75e14838de324a285b1c5115a5e3c5f878002e9f7c";
const FFMPEG_ARCHIVE_BYTES = 11030368;
const RECIPE_FILES = [__filename, require.resolve("./portable-overlay"), ...Dependency.RECIPE_FILES, require.resolve("./adapter"), require.resolve("./build"),
  require.resolve("./source-patches"), require.resolve("./dependency-overlays.json"), require.resolve("./impacto-overlay.json"),
  path.join(__dirname, "impacto.patch"), path.join(__dirname, "bink2.patch"), path.join(__dirname, "ffmpeg-probe.c"),
  path.join(__dirname, "windows-game.lua")];

function overlayIdentity() {
  const hash = crypto.createHash("sha256");
  for (const file of [...new Set(RECIPE_FILES)]) hash.update(fs.readFileSync(file));
  return hash.digest("hex");
}

function validateDependencyStack(stack) {
  if (!stack || stack.version !== Dependency.PIN.version || stack.architecture !== "arm64" || stack.minimumMacOS !== "13.0" ||
      stack.recipeSha256 !== Dependency.recipeHash() || !/^[a-f0-9]{64}$/.test(stack.prefixSha256 || "") ||
      !Array.isArray(stack.sources) || stack.sources.length !== Dependency.PIN.dependencies.length) {
    throw new Error("Impacto requires its exact macOS 13 dependency version and checksum.");
  }
  for (const pin of Dependency.PIN.dependencies) {
    const source = stack.sources.find(row => row.id === pin.id);
    if (!source || Object.keys(pin).some(key => !isDeepStrictEqual(source[key], pin[key]))) throw new Error("Impacto dependency source identity changed.");
  }
  const retained = Dependency.dependencyStacks(stack.reusedStacks);
  if (!Array.isArray(stack.reusedPrefixes) || stack.reusedPrefixes.length !== retained.length ||
      retained.some((row, index) => row.sha256 !== stack.reusedPrefixes[index].sha256 || row.prefix !== stack.reusedPrefixes[index].prefix)) {
    throw new Error("Impacto dependency inputs changed.");
  }
  const inventory = Prefix.snapshotPrefix(stack.prefix, { readRoots: retained.map(row => row.prefix) });
  if (inventory.sha256 !== stack.prefixSha256) throw new Error("Impacto dependency prefix checksum changed.");
  return { inventory, retained };
}

function assertMinimumMacOS(file, maximum = "13.0") {
  const info = MachO.readMachOLoadCommands(file, { architecture: "arm64" });
  if (info.slices.length !== 1 || info.slices[0].platform !== 1 || !info.slices[0].minimumMacOS) throw new Error("Impacto build requires an ARM macOS executable or library.");
  const compare = (a, b) => {
    const left = a.split(".").map(Number), right = b.split(".").map(Number);
    for (let index = 0; index < 3; index++) if ((left[index] || 0) !== (right[index] || 0)) return (left[index] || 0) - (right[index] || 0);
    return 0;
  };
  if (compare(info.slices[0].minimumMacOS, maximum) > 0) throw new Error(`Impacto library requires macOS ${info.slices[0].minimumMacOS}, above ${maximum}.`);
  return { file, sha256: Native.hashFile(file), ...info.slices[0] };
}

function dependencyFloors(stack) {
  const { inventory } = validateDependencyStack(stack), seen = new Set(), files = [];
  for (const row of inventory.files) {
    if (!row.path.endsWith(".dylib")) continue;
    const file = fs.realpathSync(path.join(inventory.prefix, row.path));
    if (seen.has(file)) continue;
    seen.add(file); files.push(assertMinimumMacOS(file));
  }
  return files;
}

function ffmpegOptions({ prefix, sdk, pathMappings = [] }) {
  if (!path.isAbsolute(prefix || "") || /[\s'"$`\\\r\n\0;]/.test(prefix)) throw new Error("FFmpeg build prefix must be an absolute path without shell metacharacters.");
  const flags = Dependency.compilerFlags(sdk, pathMappings);
  return [`--prefix=${prefix}`, "--arch=arm64", ...Existing.FFMPEG_OPTIONS.filter(option => !option.startsWith("--extra-cflags=") && !option.startsWith("--extra-ldflags=")),
    `--extra-cflags=${flags}`, `--extra-ldflags=-arch arm64 -mmacosx-version-min=13.0 -isysroot ${sdk} -Wl,-headerpad_max_install_names`];
}

function writeHarfBuzzDescriptor(directory, version) {
  if (!path.isAbsolute(directory || "") || /[\r\n\0;]/.test(directory) || !/^\d+\.\d+\.\d+$/.test(version || "")) {
    throw new Error("HarfBuzz build metadata requires an absolute output and exact version.");
  }
  fs.mkdirSync(directory, { recursive: true });
  // The source-build export omits its include prefix. Its verified pkg-config
  // descriptor contains the installed headers and the same shared library.
  const contents = `include(CMakeFindDependencyMacro)\nfind_dependency(PkgConfig REQUIRED)\npkg_check_modules(MACLAUNCHER_HARFBUZZ REQUIRED IMPORTED_TARGET GLOBAL harfbuzz=${version})\nif(NOT TARGET harfbuzz::harfbuzz)\n  add_library(harfbuzz::harfbuzz ALIAS PkgConfig::MACLAUNCHER_HARFBUZZ)\nendif()\n`;
  const file = path.join(directory, "harfbuzzConfig.cmake");
  fs.writeFileSync(file, contents, { flag: "wx" });
  return { version, directory, sha256: Native.hashFile(file), descriptor: "pkg-config" };
}

async function linkDependencyPaths(executable, prefixes, { logPath, env, signal, dependencies = {} } = {}) {
  if (!path.isAbsolute(executable || "") || fs.lstatSync(executable).isSymbolicLink() || !fs.lstatSync(executable).isFile() ||
      !Array.isArray(prefixes) || !prefixes.length || prefixes.some(prefix => !path.isAbsolute(prefix || "") || /[\r\n\0;]/.test(prefix))) {
    throw new Error("Impacto dependency linking requires its owned executable and explicit library prefixes.");
  }
  const existing = MachO.readMachOLoadCommands(executable, { architecture: "arm64" }).slices[0].runPaths;
  const paths = [...new Set(prefixes.map(prefix => path.join(prefix, "lib")))];
  for (const directory of paths) if (!fs.statSync(directory).isDirectory()) throw new Error("Impacto dependency library directory is unavailable.");
  const beforeSha256 = Native.hashFile(executable), commands = [];
  for (const directory of paths) {
    if (existing.includes(directory)) continue;
    const args = ["-add_rpath", directory, executable];
    await (dependencies.runBuildCommand || Source.runBuildCommand)("/usr/bin/install_name_tool", args,
      { cwd: path.dirname(executable), logPath, env, signal });
    commands.push(args);
  }
  return { beforeSha256, sha256: Native.hashFile(executable), paths, commands };
}

async function buildPortableImpacto({ workRoot, sourceDir = path.resolve(__dirname, "../../../external/impacto"),
  avcppSource, atrac9Source, magicEnumSource, ffmpegArchive, dependencyStack, pathMappings = [], signal, onProgress, dependencies = {} }) {
  throwIfAborted(signal);
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("This Impacto source profile requires an Apple Silicon Mac.");
  const dependencyProof = validateDependencyStack(dependencyStack), nativeFloors = dependencyFloors(dependencyStack);
  const checkouts = { impacto: sourceDir, avcpp: avcppSource, atrac9: atrac9Source, magicEnum: magicEnumSource }, validated = {};
  for (const [id, directory] of Object.entries(checkouts)) {
    validated[id] = await Source.validatePinnedSource(directory, Adapter.SOURCES[id].revision, { signal });
    if (Source.hashPinnedFiles(directory, validated[id].files) !== SOURCE_TREES[id]) throw new Error(`Impacto source tree checksum differs for ${id}.`);
  }
  if (!path.isAbsolute(ffmpegArchive || "") || !fs.lstatSync(ffmpegArchive).isFile() || fs.statSync(ffmpegArchive).size !== FFMPEG_ARCHIVE_BYTES ||
      Adapter.hash(ffmpegArchive) !== Adapter.SOURCES.ffmpeg.sha256 || Adapter.hash(path.join(__dirname, "bink2.patch")) !== Adapter.SOURCES.bink2.patchSha256 ||
      Adapter.hash(path.join(__dirname, "windows-game.lua")) !== PROFILE_SHA256) throw new Error("Impacto codec sources or Windows profile checksum changed.");
  workRoot = Fonts.assertFreshBuildRoot(workRoot, { readOnlyRoots: [...Object.values(checkouts), ffmpegArchive, dependencyStack.prefix,
    ...dependencyProof.retained.map(row => row.prefix)] });
  const overlaySha256 = overlayIdentity(), sdk = dependencyStack.sdk;
  Dependency.compilerFlags(sdk, pathMappings);
  fs.mkdirSync(workRoot, { recursive: true });
  const sourceRoot = path.join(workRoot, "source"), outputRoot = path.join(workRoot, "output"), runtimeRoot = path.join(workRoot, "native");
  const ffmpegPrefix = path.join(workRoot, "ffmpeg"), avcppPrefix = path.join(workRoot, "avcpp");
  fs.mkdirSync(sourceRoot); fs.mkdirSync(outputRoot);
  const prefixes = [avcppPrefix, ffmpegPrefix, dependencyStack.prefix], env = Dependency.environment(runtimeRoot, sdk, prefixes);
  env.GIT_CEILING_DIRECTORIES = workRoot;
  const findTool = dependencies.findBuildTool || Source.findBuildTool, tools = { cmake: findTool("cmake"), ninja: findTool("ninja") };
  const logPath = path.join(workRoot, "build.log"), runCommand = dependencies.runBuildCommand || Source.runBuildCommand;
  const run = (command, args, cwd = workRoot) => runCommand(command, args, { cwd, logPath, env, signal, timeout: 20 * 60 * 1000 });
  const sourceTrees = {}, startedAt = new Date().toISOString();
  for (const [id, directory] of Object.entries(checkouts)) sourceTrees[id] = Source.stagePinnedFiles(directory, validated[id].files, path.join(sourceRoot, id));
  const sourceOverlay = await Adapter.applyImpactoOverlay(path.join(sourceRoot, "impacto"), { logPath, signal });
  const portableOverlay = PortableOverlay.applyPortableOverlay(path.join(sourceRoot, "impacto"));
  const avcppOverlay = await Patches.applyPinnedPatch(path.join(sourceRoot, "avcpp"),
    path.join(sourceRoot, "impacto/portfiles/avcpp/0002-av_init_packet_deprecation.patch"), DependencyOverlays.avcppPacket, { logPath, signal, env });
  fs.copyFileSync(path.join(sourceRoot, "impacto/vendor/patches/LibAtrac9/CMakeLists.txt"), path.join(sourceRoot, "atrac9/CMakeLists.txt"));
  await run("/usr/bin/tar", ["-xf", ffmpegArchive, "-C", sourceRoot]);
  const ffmpegSource = path.join(sourceRoot, "ffmpeg-" + Adapter.SOURCES.ffmpeg.version), ffmpegOutput = path.join(outputRoot, "ffmpeg");
  const ffmpegOverlay = await Patches.applyPinnedPatch(ffmpegSource, path.join(__dirname, "bink2.patch"), DependencyOverlays.ffmpegBink2, { logPath, signal, env });
  fs.mkdirSync(ffmpegOutput);
  const ffmpegConfigure = ffmpegOptions({ prefix: ffmpegPrefix, sdk, pathMappings });
  onProgress?.({ phase: "build", project: "ffmpeg-bink2" });
  await run(path.join(ffmpegSource, "configure"), ffmpegConfigure, ffmpegOutput);
  const diagnosticConfiguration = Existing.normalizeGeneratedFfmpegConfiguration(ffmpegOutput, pathMappings);
  await run("/usr/bin/make", ["-j2"], ffmpegOutput);
  await run("/usr/bin/make", ["install"], ffmpegOutput);
  const codecProbe = path.join(workRoot, "ffmpeg-probe"), probeSource = path.join(__dirname, "ffmpeg-probe.c");
  const diagnosticFlags = pathMappings.flatMap(mapping => ["file", "debug", "macro"].map(kind => `-f${kind}-prefix-map=${mapping.from}=${mapping.to}`));
  await run("/usr/bin/clang", ["-std=c11", "-arch", "arm64", "-mmacosx-version-min=13.0", "-isysroot", sdk, ...diagnosticFlags,
    "-I" + path.join(ffmpegPrefix, "include"), probeSource, "-L" + path.join(ffmpegPrefix, "lib"), "-lavformat", "-lavcodec", "-lavutil",
    "-Wl,-rpath," + path.join(ffmpegPrefix, "lib"), "-o", codecProbe]);
  await run(codecProbe, []);
  onProgress?.({ phase: "build", project: "avcpp" });
  const avcppBuild = await Dependency.buildCmake({ sourceRoot: path.join(sourceRoot, "avcpp"), outputRoot: path.join(outputRoot, "avcpp"),
    prefix: avcppPrefix, sdk, tools, prefixes: [ffmpegPrefix, dependencyStack.prefix], pathMappings, signal, dependencies,
    options: ["-DAV_ENABLE_STATIC=ON", "-DAV_ENABLE_SHARED=OFF", "-DAV_BUILD_EXAMPLES=OFF", "-DAV_BUILD_TESTS=OFF", "-DAV_DISABLE_AVDEVICE=ON", "-DAV_DISABLE_AVFILTER=ON"] });
  const harfbuzzMetadata = writeHarfBuzzDescriptor(path.join(workRoot, "harfbuzz-metadata"),
    Fonts.PIN.dependencies.find(pin => pin.id === "harfbuzz").version);
  const impactoOutput = path.join(outputRoot, "impacto"), impactoConfigure = ["-S", path.join(sourceRoot, "impacto"), "-B", impactoOutput,
    ...Dependency.cmakeOptions({ prefix: runtimeRoot, sdk, ninja: tools.ninja, prefixes, pathMappings, options: ["-DIMPACTO_DISABLE_IMGUI=ON",
      "-DIMPACTO_DISABLE_VULKAN=ON", "-DIMPACTO_WARNINGS=OFF", "-DIMPACTO_DISABLE_LIBASS=ON"] }),
    `-DFETCHCONTENT_SOURCE_DIR_LIBATRAC9=${path.join(sourceRoot, "atrac9")}`, `-DFETCHCONTENT_SOURCE_DIR_MAGIC_ENUM=${path.join(sourceRoot, "magicEnum")}`,
    `-Dharfbuzz_DIR=${harfbuzzMetadata.directory}`,
    `-DZLIB_LIBRARY=${sdk}/usr/lib/libz.tbd`, `-DZLIB_INCLUDE_DIR=${sdk}/usr/include`];
  onProgress?.({ phase: "build", project: "impacto" });
  await run(tools.cmake, impactoConfigure);
  await run(tools.cmake, ["--build", impactoOutput, "--parallel", "2"]);
  await run(tools.cmake, ["--install", impactoOutput]);
  const executable = path.join(runtimeRoot, "Impacto.app/Contents/MacOS/Impacto");
  const dependencyLink = await linkDependencyPaths(executable, [dependencyStack.prefix, ffmpegPrefix], { logPath, env, signal, dependencies });
  for (const [id, directory] of Object.entries(checkouts)) {
    await Source.validatePinnedSource(directory, Adapter.SOURCES[id].revision, { signal });
    if (Source.hashPinnedFiles(directory, validated[id].files) !== sourceTrees[id]) throw new Error("An Impacto source input changed during compilation.");
  }
  validateDependencyStack(dependencyStack);
  if (overlayIdentity() !== overlaySha256) throw new Error("Impacto build recipe changed during compilation.");
  const executableFloor = assertMinimumMacOS(executable);
  const result = { managerId: "impacto", version: VERSION, profile: PROFILE, sourceRevision: Adapter.SOURCES.impacto.revision,
    sourceTrees, overlaySha256, sourceOverlay, portableOverlay, dependencyOverlays: { avcpp: avcppOverlay, ffmpeg: ffmpegOverlay },
    profileSha256: PROFILE_SHA256, architecture: "arm64", minimumMacOS: "13.0", executable, executableSha256: Native.hashFile(executable),
    runtimeRoot, sourceRoot, outputRoot, dependencyStack, nativeFloors, executableFloor, tools, sdk, harfbuzzMetadata, dependencyLink,
    codecProbe: { executable: codecProbe, executableSha256: Native.hashFile(codecProbe), sourceSha256: Native.hashFile(probeSource),
      bink2Descriptor: true, bink2Decoder: true, headerLibraryVersionsMatch: true }, diagnosticConfiguration,
    configureOptions: { ffmpeg: ffmpegConfigure, avcpp: avcppBuild.configureOptions, impacto: impactoConfigure },
    startedAt, completedAt: new Date().toISOString(), logPath };
  fs.writeFileSync(path.join(workRoot, "portable-build.json"), JSON.stringify(result, null, 2), { mode: 0o600 });
  return result;
}

module.exports = { VERSION, PROFILE, SOURCE_TREES, PROFILE_SHA256, FFMPEG_ARCHIVE_BYTES, RECIPE_FILES, overlayIdentity, validateDependencyStack,
  assertMinimumMacOS, dependencyFloors, ffmpegOptions, writeHarfBuzzDescriptor, linkDependencyPaths, buildPortableImpacto };
