const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Source = require("../../shared/runtime/pinned-native-build");
const Native = require("../../shared/runtime/local-native");
const Fonts = require("../../shared/runtime/portable-sdl2-fonts");
const Dependency = require("./portable-dependencies");
const Portable = require("./portable-build");
const Prefix = require("./portable-prefix");
const Patches = require("./source-patches");
const SoundEffectSession = require("./windows-sfx-session");
const Adapter = require("./adapter");
const overlay = require("./current-windows-overlay.json");
const { throwIfAborted } = require("../../shared/runtime/download-utils");

const VERSION = "0.10.8.903-MCLv1";
const REVISION = "914fae7cbb9583f8aa231569a03aab27d8c042f8";
const SOURCE_SHA256 = "db00099b846a948287c3b77329834eb68e46307b1180fb3dfdedef4adb0ba2c1";
const PROFILE = "windows-mpk2-sc3-sfx-macos13-v9";
const PROFILE_SHA256 = SoundEffectSession.PROFILE_SHA256;
const PATCH = path.join(__dirname, "current-windows.patch");
const ABI_PROFILE = Object.freeze({ input: "windows-sc3-input-v1", audio: "windows-sc3-voice-v1",
  checkpoint: "windows-sc3-checkpoint-u16-v1", backlog: "backlog-zero-capacity-v1", soundEffect: "windows-sc3-sfx-v1" });
const recipeFiles = [...new Set([__filename, PATCH, require.resolve("./current-windows-overlay.json"),
  require.resolve("./windows-game-v9.lua"), path.join(__dirname, "ffmpeg-probe.c"), ...Dependency.RECIPE_FILES])];

function overlayIdentity() {
  const hash = crypto.createHash("sha256");
  for (const file of recipeFiles) hash.update(fs.readFileSync(file));
  return hash.digest("hex");
}

async function applyCurrentOverlay(directory, { logPath, signal } = {}) {
  return { upstreamRevision: REVISION, overlaySha256: overlayIdentity(),
    ...await Patches.applyPinnedPatch(directory, PATCH, overlay, { logPath, signal }) };
}

// SDK prefixes are ordinary outputs of the portable dependency, codec and
// avcpp recipes. The Windows Bink2 codec and all earlier ABI profiles remain
// independent of this engine source snapshot.
async function buildCurrentImpacto({ sourceDir, workRoot, dependencyStack, ffmpegPrefix, avcppPrefix,
  atrac9Source, magicEnumSource, pathMappings = [], dependencies = {}, signal }) {
  throwIfAborted(signal);
  Portable.validateDependencyStack(dependencyStack);
  const source = await Source.validatePinnedSource(sourceDir, REVISION, { signal });
  if (Source.hashPinnedFiles(sourceDir, source.files) !== SOURCE_SHA256)
    throw new Error("Impacto source differs from its selected snapshot.");
  const inputs = [ffmpegPrefix, avcppPrefix, atrac9Source, magicEnumSource];
  if (inputs.some(value => !path.isAbsolute(value || "") || !fs.statSync(value).isDirectory()))
    throw new Error("Impacto requires explicit codec, avcpp and native dependency source directories.");
  const snapshots = inputs.slice(0, 2).map(prefix => Prefix.snapshotPrefix(prefix));
  const nativeSources = [[atrac9Source, Adapter.SOURCES.atrac9], [magicEnumSource, Adapter.SOURCES.magicEnum]];
  const nativeSourceHashes = [];
  for (const [directory, pin] of nativeSources) {
    const validated = await Source.validatePinnedSource(directory, pin.revision, { signal });
    nativeSourceHashes.push(Source.hashPinnedFiles(directory, validated.files));
  }
  workRoot = Fonts.assertFreshBuildRoot(workRoot, { readOnlyRoots: [sourceDir, dependencyStack.prefix, ...inputs] });
  const identity = overlayIdentity(), sdk = dependencyStack.sdk;
  const findTool = dependencies.findBuildTool || Source.findBuildTool;
  const tools = { cmake: findTool("cmake"), ninja: findTool("ninja") };
  const projected = path.join(workRoot, "source"), output = path.join(workRoot, "build"), prefix = path.join(workRoot, "prefix");
  fs.mkdirSync(workRoot, { recursive: true });
  Source.stagePinnedFiles(sourceDir, source.files, projected);
  const logPath = path.join(workRoot, "build.log");
  const sourceOverlay = await applyCurrentOverlay(projected, { logPath, signal });
  const atrac9 = path.join(workRoot, "atrac9");
  fs.cpSync(atrac9Source, atrac9, { recursive: true, verbatimSymlinks: true,
    filter: file => path.basename(file) !== ".git" });
  fs.copyFileSync(path.join(projected, "vendor/patches/LibAtrac9/CMakeLists.txt"), path.join(atrac9, "CMakeLists.txt"));
  const harfbuzz = Portable.writeHarfBuzzDescriptor(path.join(workRoot, "harfbuzz"),
    require("../../shared/runtime/portable-sdl2-fonts.json").dependencies.find(pin => pin.id === "harfbuzz").version);
  const prefixes = [avcppPrefix, ffmpegPrefix, dependencyStack.prefix];
  const env = Dependency.environment(prefix, sdk, prefixes);
  const configureOptions = ["-S", projected, "-B", output,
    ...Dependency.cmakeOptions({ prefix, sdk, ninja: tools.ninja, prefixes, pathMappings,
      options: ["-DIMPACTO_DISABLE_IMGUI=ON", "-DIMPACTO_DISABLE_VULKAN=ON", "-DIMPACTO_WARNINGS=OFF", "-DIMPACTO_DISABLE_LIBASS=ON"] }),
    "-DFETCHCONTENT_SOURCE_DIR_LIBATRAC9=" + atrac9, "-DFETCHCONTENT_SOURCE_DIR_MAGIC_ENUM=" + magicEnumSource,
    "-Dharfbuzz_DIR=" + harfbuzz.directory, "-DZLIB_LIBRARY=" + sdk + "/usr/lib/libz.tbd", "-DZLIB_INCLUDE_DIR=" + sdk + "/usr/include"];
  const run = dependencies.runBuildCommand || Source.runBuildCommand;
  const codecSource = path.join(__dirname, "ffmpeg-probe.c"), codecProbe = path.join(workRoot, "codec-probe");
  await run("/usr/bin/clang", ["-std=c11", ...Dependency.compilerFlags(sdk, pathMappings).split(" "),
    "-I" + path.join(ffmpegPrefix, "include"), codecSource, "-L" + path.join(ffmpegPrefix, "lib"),
    "-lavformat", "-lavcodec", "-lavutil", "-Wl,-rpath," + path.join(ffmpegPrefix, "lib"), "-o", codecProbe],
  { cwd: workRoot, logPath, env, signal });
  await run(codecProbe, [], { cwd: workRoot, logPath, env, signal });
  for (const args of [configureOptions, ["--build", output, "--parallel", "4"], ["--install", output]])
    await run(tools.cmake, args, { cwd: workRoot, logPath, env, signal, timeout: 20 * 60 * 1000 });
  const executable = path.join(prefix, "Impacto.app/Contents/MacOS/Impacto");
  await Portable.linkDependencyPaths(executable, [dependencyStack.prefix, ffmpegPrefix], { logPath, env, signal, dependencies });
  Portable.assertMinimumMacOS(executable);
  Portable.validateDependencyStack(dependencyStack);
  inputs.slice(0, 2).forEach((input, index) => {
    if (Prefix.snapshotPrefix(input).sha256 !== snapshots[index].sha256)
      throw new Error("An Impacto dependency input changed during compilation.");
  });
  for (let index = 0; index < nativeSources.length; index++) {
    const [directory, pin] = nativeSources[index];
    const validated = await Source.validatePinnedSource(directory, pin.revision, { signal });
    if (Source.hashPinnedFiles(directory, validated.files) !== nativeSourceHashes[index])
      throw new Error("An Impacto native dependency source changed during compilation.");
  }
  if (overlayIdentity() !== identity) throw new Error("The Impacto adaptation changed during compilation.");
  return { version: VERSION, profile: PROFILE, sourceRevision: REVISION, sourceTreeSha256: SOURCE_SHA256,
    overlaySha256: identity, sourceOverlay, currentWindowsAbiProfile: ABI_PROFILE,
    profileSha256: PROFILE_SHA256, executable, runtimeRoot: prefix, executableSha256: Native.hashFile(executable),
    codecProbe: { sourceSha256: Native.hashFile(codecSource), bink2Decoder: true, headerLibraryVersionsMatch: true },
    dependencyStack, configureOptions, logPath };
}

module.exports = { VERSION, REVISION, SOURCE_SHA256, PROFILE, PROFILE_SHA256, ABI_PROFILE,
  overlayIdentity, applyCurrentOverlay, buildCurrentImpacto };
