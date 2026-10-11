const fs = require("node:fs");
const path = require("node:path");
const Build = require("../../shared/runtime/pinned-native-build");
const Adapter = require("./adapter");
const Patches = require("./source-patches");
const DependencyOverlays = require("./dependency-overlays.json");

const FFMPEG_OPTIONS = Object.freeze(["--cc=clang", "--target-os=darwin", "--enable-shared", "--disable-static",
  "--enable-pic", "--disable-doc", "--disable-debug", "--disable-autodetect", "--disable-gpl", "--disable-nonfree",
  "--disable-version3", "--disable-everything", "--enable-decoder=bink,bink2,binkaudio_dct,binkaudio_rdft,vorbis,pcm_s16le",
  "--enable-demuxer=bink,ogg,wav", "--enable-parser=vorbis", "--enable-protocol=file", "--enable-encoder=rawvideo",
  "--enable-muxer=rawvideo,null", "--disable-avdevice", "--disable-avfilter", "--disable-network",
  "--extra-cflags=-mmacosx-version-min=13.0", "--extra-ldflags=-mmacosx-version-min=13.0"]);

function diagnosticPathMappings(workDir, dependencyPrefix) {
  const pairs = [[path.resolve(workDir), "IMPACTO_BUILD"], [fs.realpathSync(workDir), "IMPACTO_BUILD"],
    [path.resolve(dependencyPrefix), "DEPENDENCY_PREFIX"], [fs.realpathSync(dependencyPrefix), "DEPENDENCY_PREFIX"]];
  return [...new Map(pairs.map(([from, to]) => [from, { from, to }])).values()].sort((a, b) => b.from.length - a.from.length);
}

function compilerDiagnosticFlags(mappings) {
  return mappings.flatMap(({ from, to }) => [`-ffile-prefix-map=${from}=${to}`, `-fmacro-prefix-map=${from}=${to}`]);
}

function normalizeGeneratedFfmpegConfiguration(outputDir, mappings) {
  const file = path.join(outputDir, "config.h"), original = fs.readFileSync(file, "utf8");
  let found = false;
  const normalized = original.replace(/^#define FFMPEG_CONFIGURATION (.*)$/m, (_line, value) => {
    found = true;
    const projected = mappings.reduce((text, { from, to }) => text.split(from).join(to), value);
    if (/\/(?:Users|Volumes|home)\/|(?:^|[\\/])\.local[\\/]/.test(projected)) throw new Error("FFmpeg diagnostic configuration retains a private build path.");
    return "#define FFMPEG_CONFIGURATION " + projected;
  });
  if (!found) throw new Error("Generated FFmpeg configuration macro is unavailable.");
  const originalSha256 = Adapter.hash(file);
  fs.writeFileSync(file, normalized);
  return { generatedFile: "config.h", macro: "FFMPEG_CONFIGURATION", originalSha256, normalizedSha256: Adapter.hash(file),
    mappings: mappings.map(mapping => ({ ...mapping })) };
}

async function buildAdapter({ workDir, sourceDir = path.resolve(__dirname, "../../../external/impacto"),
  avcppSource, atrac9Source, magicEnumSource, ffmpegArchive, dependencyPrefix = process.arch === "arm64" ? "/opt/homebrew" : "/usr/local", signal }) {
  if (process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch)) throw new Error("Native Impacto adapter builds require a supported macOS architecture.");
  const checkouts = { impacto: sourceDir, avcpp: avcppSource, atrac9: atrac9Source, magicEnum: magicEnumSource };
  const validated = {};
  for (const [id, directory] of Object.entries(checkouts)) validated[id] = await Build.validatePinnedSource(directory, Adapter.SOURCES[id].revision, { signal });
  if (Adapter.hash(ffmpegArchive) !== Adapter.SOURCES.ffmpeg.sha256 || Adapter.hash(path.join(__dirname, "bink2.patch")) !== Adapter.SOURCES.bink2.patchSha256) {
    throw new Error("FFmpeg source archive or Bink2 patch differs from its exact pinned SHA-256.");
  }
  const root = Adapter.separateStorage(workDir, [...Object.values(checkouts), ffmpegArchive]);
  if (fs.existsSync(root) && fs.readdirSync(root).length) throw new Error("Choose an empty owned directory for the native adapter build.");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const diagnosticMappings = diagnosticPathMappings(root, dependencyPrefix);
  const diagnosticFlags = compilerDiagnosticFlags(diagnosticMappings);
  const sourceRoot = path.join(root, "build-source"), outputRoot = path.join(root, "build-output");
  const ffmpegPrefix = path.join(root, "ffmpeg-install"), avcppPrefix = path.join(root, "avcpp-install"), runtimeRoot = path.join(root, "native");
  const logPath = path.join(root, "build.log");
  fs.mkdirSync(sourceRoot); fs.mkdirSync(outputRoot);
  const sourceTrees = {};
  for (const [id, directory] of Object.entries(checkouts)) sourceTrees[id] = Build.stagePinnedFiles(directory, validated[id].files, path.join(sourceRoot, id));
  const env = { ...process.env, HOMEBREW_NO_AUTO_UPDATE: "1", PATH: [path.join(dependencyPrefix, "bin"), process.env.PATH].filter(Boolean).join(path.delimiter),
    PKG_CONFIG_PATH: [path.join(ffmpegPrefix, "lib", "pkgconfig"), path.join(dependencyPrefix, "lib", "pkgconfig"), process.env.PKG_CONFIG_PATH].filter(Boolean).join(path.delimiter) };
  const run = (tool, args, cwd = root) => Build.runBuildCommand(tool.includes(path.sep) ? tool : Build.findBuildTool(tool), args, { cwd, logPath, env, signal });
  const sourceOverlay = await Adapter.applyImpactoOverlay(path.join(sourceRoot, "impacto"), { logPath, signal });
  const avcppOverlay = await Patches.applyPinnedPatch(path.join(sourceRoot, "avcpp"),
    path.join(sourceRoot, "impacto", "portfiles", "avcpp", "0002-av_init_packet_deprecation.patch"),
    DependencyOverlays.avcppPacket, { logPath, signal, env });
  fs.copyFileSync(path.join(sourceRoot, "impacto", "vendor", "patches", "LibAtrac9", "CMakeLists.txt"), path.join(sourceRoot, "atrac9", "CMakeLists.txt"));
  await run("tar", ["-xf", path.resolve(ffmpegArchive), "-C", sourceRoot]);
  const ffmpegSource = path.join(sourceRoot, "ffmpeg-" + Adapter.SOURCES.ffmpeg.version), ffmpegOutput = path.join(outputRoot, "ffmpeg");
  const ffmpegOverlay = await Patches.applyPinnedPatch(ffmpegSource, path.join(__dirname, "bink2.patch"),
    DependencyOverlays.ffmpegBink2, { logPath, signal, env });
  fs.mkdirSync(ffmpegOutput);
  const ffmpegOptions = [`--prefix=${ffmpegPrefix}`, `--arch=${process.arch === "arm64" ? "arm64" : "x86_64"}`, ...FFMPEG_OPTIONS,
    `--extra-cflags=${diagnosticFlags.join(" ")}`];
  await run(path.join(ffmpegSource, "configure"), ffmpegOptions, ffmpegOutput);
  // Only this generated diagnostic macro is projected. The actual configure
  // options/install paths remain in the private build receipt and build files.
  const diagnosticConfiguration = normalizeGeneratedFfmpegConfiguration(ffmpegOutput, diagnosticMappings);
  await run("make", ["-j6"], ffmpegOutput);
  await run("make", ["install"], ffmpegOutput);
  const codecProbe = path.join(root, "ffmpeg-probe");
  await run("clang", ["-std=c11", "-mmacosx-version-min=13.0", ...diagnosticFlags,
    "-I" + path.join(ffmpegPrefix, "include"), path.join(__dirname, "ffmpeg-probe.c"),
    "-L" + path.join(ffmpegPrefix, "lib"), "-lavformat", "-lavcodec", "-lavutil",
    "-Wl,-rpath," + path.join(ffmpegPrefix, "lib"), "-o", codecProbe]);
  // A successful build alone does not prove the optional custom decoder exists.
  // This executable binds the actual installed headers and libraries before any
  // C++ wrapper or runtime is compiled; a missing patch is a hard build failure.
  await run(codecProbe, []);
  const cmake = Build.findBuildTool("cmake"), ninja = Build.findBuildTool("ninja");
  const baseOptions = ["-G", "Ninja", `-DCMAKE_MAKE_PROGRAM=${ninja}`, "-DCMAKE_BUILD_TYPE=Release",
    `-DCMAKE_OSX_ARCHITECTURES=${process.arch === "arm64" ? "arm64" : "x86_64"}`, "-DCMAKE_OSX_DEPLOYMENT_TARGET=13.0",
    `-DCMAKE_C_FLAGS=${diagnosticFlags.join(" ")}`, `-DCMAKE_CXX_FLAGS=${diagnosticFlags.join(" ")}`];
  const avcppOutput = path.join(outputRoot, "avcpp");
  const avcppOptions = ["-S", path.join(sourceRoot, "avcpp"), "-B", avcppOutput, ...baseOptions,
    `-DCMAKE_INSTALL_PREFIX=${avcppPrefix}`, `-DCMAKE_PREFIX_PATH=${ffmpegPrefix};${dependencyPrefix}`,
    "-DAV_ENABLE_STATIC=ON", "-DAV_ENABLE_SHARED=OFF", "-DAV_BUILD_EXAMPLES=OFF", "-DAV_BUILD_TESTS=OFF",
    "-DAV_DISABLE_AVDEVICE=ON", "-DAV_DISABLE_AVFILTER=ON"];
  await run(cmake, avcppOptions);
  await run(cmake, ["--build", avcppOutput, "--parallel", "6"]);
  await run(cmake, ["--install", avcppOutput]);
  const impactoOutput = path.join(outputRoot, "impacto");
  const impactoOptions = ["-S", path.join(sourceRoot, "impacto"), "-B", impactoOutput, ...baseOptions,
    `-DCMAKE_INSTALL_PREFIX=${runtimeRoot}`, `-DCMAKE_PREFIX_PATH=${avcppPrefix};${ffmpegPrefix};${dependencyPrefix};${path.join(dependencyPrefix, "opt", "openal-soft")}`,
    `-DFETCHCONTENT_SOURCE_DIR_LIBATRAC9=${path.join(sourceRoot, "atrac9")}`, `-DFETCHCONTENT_SOURCE_DIR_MAGIC_ENUM=${path.join(sourceRoot, "magicEnum")}`,
    "-DFETCHCONTENT_FULLY_DISCONNECTED=ON", "-DFETCHCONTENT_UPDATES_DISCONNECTED=ON", "-DIMPACTO_DISABLE_IMGUI=ON",
    "-DIMPACTO_DISABLE_VULKAN=ON", "-DIMPACTO_WARNINGS=OFF", "-DIMPACTO_DISABLE_LIBASS=ON"];
  await run(cmake, impactoOptions);
  await run(cmake, ["--build", impactoOutput, "--parallel", "6"]);
  await run(cmake, ["--install", impactoOutput]);
  for (const [id, directory] of Object.entries(checkouts)) await Build.validatePinnedSource(directory, Adapter.SOURCES[id].revision, { signal });
  const executable = path.join(runtimeRoot, "Impacto.app", "Contents", "MacOS", "Impacto");
  const record = { executable, runtimeRoot, logPath, sources: Adapter.SOURCES, sourceTrees, sourceOverlay,
    dependencyOverlays: { avcpp: avcppOverlay, ffmpeg: ffmpegOverlay },
    codecProbe: { executable: codecProbe, sourceSha256: Adapter.hash(path.join(__dirname, "ffmpeg-probe.c")),
      bink2Descriptor: true, bink2Decoder: true, headerLibraryVersionsMatch: true },
    diagnosticConfiguration, compilerDiagnosticMappings: diagnosticMappings,
    configureOptions: { ffmpeg: ffmpegOptions, avcpp: avcppOptions, impacto: impactoOptions }, hostPlatform: process.platform, hostArch: process.arch,
    binarySha256: Adapter.hash(executable), qualification: "Developer adapter; gameplay, saves and portable distribution are not qualified" };
  fs.writeFileSync(path.join(root, "adapter-build.json"), JSON.stringify(record, null, 2), { mode: 0o600 });
  return record;
}

module.exports = { FFMPEG_OPTIONS, diagnosticPathMappings, compilerDiagnosticFlags, normalizeGeneratedFfmpegConfiguration, buildAdapter };
