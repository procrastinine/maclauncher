const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Build = require("../../shared/runtime/pinned-native-build");
const Native = require("../../shared/runtime/local-native");
const Overlay = require("./overlay");
const Movies = require("./movie-build");
const { downloadToFile, throwIfAborted } = require("../../shared/runtime/download-utils");
const sourcePath = path.resolve(__dirname, "../../../external/ReMinori");
const building = new Set();
function closeMovieDependencies(prefix, directory) {
  const { execFileSync } = require("node:child_process");
  const lib = path.join(directory, "lib"); fs.mkdirSync(lib, { recursive: true });
  const files = fs.readdirSync(path.join(prefix, "lib"), { withFileTypes: true })
    .filter(entry => entry.isFile() && /^lib(?:avcodec|avformat|avutil|swscale|swresample)\.\d+\.\d+\.\d+\.dylib$/.test(entry.name));
  if (files.length !== 5) throw new Error("Minori movie dependencies do not contain the complete five-library FFmpeg profile.");
  const names = new Map();
  for (const file of files) {
    const name = file.name.replace(/(\.\d+)\.\d+\.\d+\.dylib$/, "$1.dylib");
    names.set(file.name, name); fs.copyFileSync(path.join(prefix, "lib", file.name), path.join(lib, name));
  }
  const binary = path.join(directory, "bin/maclauncher-minori-movie");
  const payload = [binary, ...names.values()].map(value => path.isAbsolute(value) ? value : path.join(lib, value));
  for (const file of payload) {
    const links = execFileSync("/usr/bin/otool", ["-L", file], { encoding: "utf8" }).split("\n").slice(1).map(line => line.trim().split(" (compatibility")[0]).filter(Boolean);
    const options = [];
    if (file !== binary) options.push("-id", "@loader_path/" + path.basename(file));
    for (const link of links) {
      if (link.startsWith("/System/Library/") || link.startsWith("/usr/lib/")) continue;
      const basename = path.basename(link), name = names.get(basename) || [...names.values()].find(name => name === basename);
      if (!name) throw new Error("Minori FFmpeg has an unsupported native dependency.");
      options.push("-change", link, (file === binary ? "@loader_path/../lib/" : "@loader_path/") + name);
    }
    const paths = execFileSync("/usr/bin/otool", ["-l", file], { encoding: "utf8" });
    for (const match of paths.matchAll(/cmd LC_RPATH\s+cmdsize \d+\s+path (.+?) \(offset \d+\)/g)) options.push("-delete_rpath", match[1]);
    if (options.length) execFileSync("/usr/bin/install_name_tool", [...options, file], { stdio: "pipe" });
    execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", file], { stdio: "pipe" });
  }
  return payload.map(file => ({ path: path.relative(directory, file), sha256: Native.hashFile(file) }));
}

async function buildMovieDecoder({ prefix, directory, signal, dependencies = {} } = {}) {
  if (!path.isAbsolute(prefix || "")) throw new Error("Provide a pinned FFmpeg 7.1.2 native build prefix.");
  const versionHeader = fs.readFileSync(path.join(prefix, "include/libavutil/ffversion.h"), "utf8");
  if (!/^#define FFMPEG_VERSION "7\.1\.2"$/m.test(versionHeader)) throw new Error("The Minori movie bridge requires FFmpeg 7.1.2.");
  fs.mkdirSync(directory, { recursive: true });
  const logPath = path.join(directory, "movie-build.log"), executable = path.join(directory, "maclauncher-minori-movie");
  fs.writeFileSync(logPath, "FFmpeg 7.1.2 Minori decoder bridge\n");
  const clang = (dependencies.findBuildTool || Build.findBuildTool)("clang");
  await (dependencies.runBuildCommand || Build.runBuildCommand)(clang,
    ["-O2", "-mmacosx-version-min=13.0", `-ffile-prefix-map=${__dirname}=src/modules/minori/runtime`,
      `-ffile-prefix-map=${directory}=maclauncher-build/minori/movie`,
      "-I" + path.join(prefix, "include"), path.join(__dirname, "native/movie-decoder.c"),
      "-L" + path.join(prefix, "lib"), "-lavformat", "-lavcodec", "-lavutil", "-lswscale", "-lswresample",
      "-Wl,-rpath," + path.join(prefix, "lib"), "-o", executable], { cwd: directory, logPath, signal });
  return { executable, version: "7.1.2", sha256: Native.hashFile(executable),
    sourceSha256: Native.hashFile(path.join(__dirname, "native/movie-decoder.c")), dependencyPrefix: prefix };
}

async function buildCandidate({ sourceDir = sourcePath, destination, decoderPrefix, signal, onProgress, dependencies = {} } = {}) {
  if (process.platform !== "darwin") throw new Error("The Minori native build requires macOS.");
  if (!path.isAbsolute(destination || "") || fs.existsSync(destination)) throw new Error("Choose a new absolute Minori candidate directory.");
  if (destination === sourceDir || destination.startsWith(sourceDir + path.sep) || sourceDir.startsWith(destination + path.sep)) throw new Error("Source and output directories must be separate.");
  throwIfAborted(signal);
  const pinned = await Build.validatePinnedSource(sourceDir, Overlay.REVISION, { signal });
  const cargo = (dependencies.findBuildTool || Build.findBuildTool)("cargo");
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-minori-build-"));
  const sourceRoot = path.join(workspace, "source"), target = path.join(workspace, "target");
  const logPath = path.join(workspace, "build.log");
  fs.writeFileSync(logPath, `ReMinori ${Overlay.REVISION}\n`);
  try {
    const sourceTreeSha256 = Build.stagePinnedFiles(sourceDir, pinned.files, sourceRoot);
    const sourceOverlay = Overlay.adaptSource(sourceRoot);
    const platformObject = path.join(workspace, "maclauncher-platform.o");
    const platformLibrary = path.join(workspace, "libmaclauncher-platform.a");
    const run = dependencies.runBuildCommand || Build.runBuildCommand;
    await run((dependencies.findBuildTool || Build.findBuildTool)("clang"), ["-fobjc-arc", "-O2", "-mmacosx-version-min=13.0",
      `-ffile-prefix-map=${workspace}=maclauncher-build/minori/${Overlay.VERSION}`,
      "-c", path.join(sourceRoot, "maclauncher-platform.m"), "-o", platformObject], { cwd: workspace, logPath, signal });
    await run("/usr/bin/ar", ["rcs", platformLibrary, platformObject], { cwd: workspace, logPath, signal });
    const rustFlags = [...new Set([workspace, fs.realpathSync(workspace)])].map(value => `--remap-path-prefix=${value}=maclauncher-build/minori/${Overlay.VERSION}`).concat([
      `--remap-path-prefix=${process.env.CARGO_HOME || path.join(os.homedir(), ".cargo")}=maclauncher-cargo`,
      "-C", "link-arg=-Wl,-dead_strip", "-C", `link-arg=${platformLibrary}`, "-C", "link-arg=-framework", "-C", "link-arg=AppKit"]).join("\x1f");
    const env = { ...process.env, CARGO_TARGET_DIR: target, CARGO_ENCODED_RUSTFLAGS: rustFlags, MACOSX_DEPLOYMENT_TARGET: "13.0" };
    onProgress?.({ downloaded: 1, total: 3 });
    await run(cargo, ["build", "--locked", "--offline", "--release", "-p", "eden", "-p", "eden-formats", "--bins"], { cwd: sourceRoot, logPath, env, signal });
    throwIfAborted(signal); onProgress?.({ downloaded: 2, total: 3 });
    await Build.validatePinnedSource(sourceDir, Overlay.REVISION, { signal });
    const candidate = path.join(workspace, "candidate"); fs.mkdirSync(path.join(candidate, "bin"), { recursive: true });
    for (const name of ["eden", "maclauncher-minori-probe"]) {
      const source = path.join(target, "release", name);
      fs.copyFileSync(source, path.join(candidate, "bin", name)); fs.chmodSync(path.join(candidate, "bin", name), 0o755);
    }
    fs.copyFileSync(path.join(sourceRoot, "LICENSE"), path.join(candidate, "ReMinori-LICENSE.txt"));
    let movieDecoder = null;
    if (decoderPrefix) {
      const built = await buildMovieDecoder({ prefix: decoderPrefix, directory: path.join(candidate, "bin"), signal, dependencies });
      const files = closeMovieDependencies(decoderPrefix, candidate);
      movieDecoder = { version: built.version, bridgeVersion: "maclauncher-minori-movie-v1",
        sha256: Native.hashFile(built.executable), sourceSha256: built.sourceSha256, files };
      fs.copyFileSync(path.join(decoderPrefix, "FFmpeg-LICENSE.txt"), path.join(candidate, "FFmpeg-LICENSE.txt"));
    }
    const profile = { schemaVersion: 1, version: Overlay.VERSION, upstreamRevision: Overlay.REVISION,
      profileRevision: Overlay.PROFILE, dataProfiles: ["paz-bf-slot0-rc4-v1", "paz-pe-keytables-rc4-v1"], minimumMacOS: "13.0",
      architecture: process.arch, sourceTreeSha256, sourceOverlay, cargoLockSha256: Native.hashFile(path.join(sourceRoot, "Cargo.lock")),
      nativeFeatures: ["wgpu-metal", "coretext-fonts", "appkit-game-menu", "appkit-save-comments", "cpal-audio", "private-saves", "private-movie-cache", "original-pe-profile",
        ...(movieDecoder ? ["ffmpeg-movie-bridge"] : [])], movieDecoder,
      supportLevel: "beta", executables: Object.fromEntries(["eden", "maclauncher-minori-probe"].map(name => [name, Native.hashFile(path.join(candidate, "bin", name))])) };
    fs.writeFileSync(path.join(candidate, "profile.json"), JSON.stringify(profile, null, 2) + "\n");
    fs.copyFileSync(logPath, path.join(candidate, "build.log"));
    fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.cpSync(candidate, destination, { recursive: true, errorOnExist: true, force: false });
    onProgress?.({ downloaded: 3, total: 3 });
    return { directory: destination, executablePath: path.join(destination, "bin/eden"), profile,
      workspace, sourceRoot, target, logPath };
  } catch (error) { error.buildLogPath = logPath; throw error; }
  // Retain the owned compiler workspace for developer tests and source review.
  // It is private build material; released apps only use sealed native files.
}

async function buildRuntime({ manager, version = Overlay.VERSION, sourceDir = sourcePath, userDataDir, signal, onProgress, context, dependencies } = {}) {
  if (version !== Overlay.VERSION) throw new Error("Only the pinned Minori Mac profile can be built by this overlay.");
  const installDir = manager.core.getInstallDir({ userDataDir, version });
  if (building.has(installDir)) throw new Error("This Minori version is already building.");
  building.add(installDir);
  try {
    // This callback runs only for an explicit developer source-build action.
    // Released native packages execute directly without this toolchain or fetch.
    await Build.validatePinnedSource(sourceDir, Overlay.REVISION, { signal });
    (dependencies?.findBuildTool || Build.findBuildTool)("cargo");
    fs.mkdirSync(installDir, { recursive: true });
    const archive = path.join(installDir, "ffmpeg-7.1.2.tar.xz");
    if (!fs.existsSync(archive)) await (dependencies?.downloadToFile || downloadToFile)(Movies.SOURCE.url, archive, { signal });
    if (Native.hashFile(archive) !== Movies.SOURCE.sha256) throw new Error("The Minori movie source archive differs from its pin.");
    const decoderPrefix = path.join(installDir, "movie-dependencies");
    await Movies.buildMovieDependencies({ archive, destination: decoderPrefix, signal, dependencies });
    const output = await buildCandidate({ sourceDir, destination: path.join(installDir, "native"), decoderPrefix, signal, onProgress, dependencies });
    const installed = manager.core.registerLocal({ userDataDir, version, runtimePath: output.executablePath,
      verifiedBuild: { sourceRevision: Overlay.REVISION, sourceTreeSha256: output.profile.sourceTreeSha256,
        sourceOverlay: output.profile.sourceOverlay, cargoLockSha256: output.profile.cargoLockSha256,
        hostPlatform: process.platform, hostArch: process.arch } });
    context?.onRuntimeStateChange?.(); return installed;
  } finally { building.delete(installDir); }
}
module.exports = { ...Overlay, sourcePath, closeMovieDependencies, buildMovieDecoder, buildCandidate, buildRuntime };
