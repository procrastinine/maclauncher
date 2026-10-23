const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Source = require("../../shared/runtime/pinned-native-build");
const Native = require("../../shared/runtime/local-native");
const Fonts = require("../../shared/runtime/portable-sdl2-fonts");
const Audio = require("../../shared/runtime/portable-sndfile");
const Movie = require("../../shared/runtime/portable-ffmpeg");
const Previous = require("./build");
const { throwIfAborted } = require("../../shared/runtime/download-utils");

const VERSION = "1.5.0-ad7a703f-macos-v4";
const REVISION = "ad7a703f1c9f56e127d23c10d54fec0dcd4eaef3";
const SOURCE_SHA256 = "f09b2d16b42d3a29f10b5299a9b8731279786c3f693eb6f84268134b7c2dfbf0";
const PROFILE = "macos13-original-disc-v4";
const ORIGINALS = Object.freeze({
  "meson.build": "51578b194daac0d893e6209e0b1f480c10c459608d1b95673d102a96a74b436a",
  "meson_options.txt": "079163e60a1391bb10876a1eaf1724aa31c3a140c67e12c367407063a65253e8",
  "src/asset.c": "d3f362732fc1f2eda7aa142bd74e4f10bf1b0b20cc026c24fd255b0078615915",
  "src/debug.c": "785d0365e4fb0c1d3041d4c09dbf05fa56c09406c3b3e444b96645daa8651134",
  "src/gfx.c": "29792107a7d4f7ff210362b84395c747d5f75cac35d2972334664e270f8b13a3",
  "src/main.c": "6df07ac276bac8afd5937f5722409a0eecee7892d89bfb649713f3f4bbb9965e",
  "src/savedata.c": "ef1df79a13fc3225c06d8d539d0285d8d0304153d2e657c1f4fb9de82ed838aa",
  "src/text.c": "4ed7756651735add903804412a8196431e3a0db487f7814dd84bc63c817dbc2c",
  "subprojects/libai5/meson.build": "4ec196b85c3e19ea40d07c5de4ad5be4b1258ebed4c810d3748a0ea4d06b37f9",
  "subprojects/libai5/src/arc/open.c": "bd6be4fe5eae3a8df3a74e45bc42c4db90db4158ddf16e2ba326a106a2291151"
});
const OUTPUTS = ["maclauncher-disc.h", "maclauncher-paths.h"];
const OWNED_FILES = [__filename, require.resolve("./build"), path.join(__dirname, "macos-disc.h"), path.join(__dirname, "macos-paths.h"),
  require.resolve("../../shared/runtime/portable-sdl2-fonts"), require.resolve("../../shared/runtime/portable-sdl2-fonts.json"),
  require.resolve("../../shared/runtime/portable-sndfile"), require.resolve("../../shared/runtime/portable-sndfile.json"),
  require.resolve("../../shared/runtime/portable-ffmpeg"), require.resolve("../../shared/runtime/portable-ffmpeg.json")];

function overlayIdentity() {
  const hash = crypto.createHash("sha256");
  for (const file of OWNED_FILES) hash.update(path.relative(path.resolve(__dirname, "../../../.."), file) + "\0").update(fs.readFileSync(file));
  return hash.digest("hex");
}

function replace(root, file, before, after) {
  const target = path.join(root, file), text = fs.readFileSync(target, "utf8");
  if (!text.includes(before) || text.indexOf(before) !== text.lastIndexOf(before)) throw new Error(`AI5 source adapter differs in ${file}.`);
  fs.writeFileSync(target, text.replace(before, () => after));
}

function adaptSource(root) {
  if (!path.isAbsolute(root || "") || !fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink() ||
      fs.realpathSync(root).split(path.sep).includes("external") || fs.existsSync(path.join(root, ".git"))) {
    throw new Error("AI5 source adapters require a separate source export.");
  }
  for (const file of [...Object.keys(ORIGINALS), ...OUTPUTS]) {
    const target = path.join(root, file);
    let current = path.dirname(target);
    while (current !== root) {
      if (fs.existsSync(current) && (!fs.lstatSync(current).isDirectory() || fs.lstatSync(current).isSymbolicLink())) throw new Error("AI5 source export contains a linked directory.");
      current = path.dirname(current);
    }
    if (fs.existsSync(target) && (!fs.lstatSync(target).isFile() || fs.lstatSync(target).isSymbolicLink())) throw new Error("AI5 source export contains a linked file.");
    if (ORIGINALS[file] && Native.hashFile(target) !== ORIGINALS[file]) throw new Error(`AI5 source checksum differs in ${file}.`);
    if (OUTPUTS.includes(file) && fs.existsSync(target)) throw new Error("AI5 source export already contains its Mac adapter.");
  }
  Previous.adaptSource(root);
  replace(root, "meson.build", `fallback : '${Previous.VERSION}'`, `fallback : '${VERSION}'`);
  replace(root, "src/asset.c", "Failed to open reviewed base archive %s", "Failed to open base archive %s");
  replace(root, "meson_options.txt", "Reviewed profile includes AVI/movie decoding", "Enable AVI and movie decoding");
  for (const name of ["sdl2", "SDL2_ttf", "sndfile"]) {
    replace(root, "meson.build", `dependency('${name}', static : static_libs)`, `dependency('${name}', static : static_libs, method : 'pkg-config')`);
  }
  for (const name of ["libavcodec", "libavformat", "libavutil", "libswscale"]) {
    replace(root, "meson.build", `dependency('${name}', required: get_option('ffmpeg'), static : static_libs)`,
      `dependency('${name}', required: get_option('ffmpeg'), static : static_libs, method : 'pkg-config')`);
  }
  replace(root, "subprojects/libai5/meson.build", "dependency('libpng', static : static_libs)",
    "dependency('libpng', static : static_libs, method : 'pkg-config')");
  return { version: VERSION, profile: PROFILE, upstreamRevision: REVISION,
    originals: ORIGINALS, files: Object.fromEntries([...Object.keys(ORIGINALS), ...OUTPUTS].sort().map(file => [file, Native.hashFile(path.join(root, file))])) };
}

function recipeHash(moduleFile, catalogFile) {
  return crypto.createHash("sha256").update(fs.readFileSync(moduleFile)).update(fs.readFileSync(catalogFile)).digest("hex");
}

function dependencyPrefixes({ fontStack, audioStack, movieStack }) {
  if (fontStack?.version !== Fonts.PIN.version || fontStack.architecture !== "arm64" || fontStack.minimumMacOS !== "13.0" ||
      fontStack.recipeSha256 !== recipeHash(require.resolve("../../shared/runtime/portable-sdl2-fonts"), require.resolve("../../shared/runtime/portable-sdl2-fonts.json")) ||
      audioStack?.version !== Audio.PIN.version || audioStack.architecture !== "arm64" || audioStack.minimumMacOS !== "13.0" ||
      audioStack.recipeSha256 !== recipeHash(require.resolve("../../shared/runtime/portable-sndfile"), require.resolve("../../shared/runtime/portable-sndfile.json")) ||
      movieStack?.version !== Movie.PIN.version || movieStack.recipeSha256 !== Movie.recipeIdentity() || movieStack.source.version !== Movie.PIN.source.version || movieStack.source.sha256 !== Movie.PIN.source.sha256 ||
      movieStack.architecture !== "arm64" || movieStack.minimumMacOS !== "13.0" || movieStack.network !== false ||
      movieStack.externalCodecs !== false || movieStack.gpl !== false || movieStack.nonfree !== false ||
      JSON.stringify(movieStack.decoders) !== JSON.stringify(Movie.PIN.decoders) || JSON.stringify(movieStack.demuxers) !== JSON.stringify(Movie.PIN.demuxers)) {
    throw new Error("AI5 portable dependencies differ from their selected source profiles.");
  }
  const moviePrefix = movieStack.options?.find(option => option.startsWith("--prefix="))?.slice(9);
  const prefixes = [fontStack.prefix, audioStack.prefix, moviePrefix];
  for (const prefix of prefixes) if (!path.isAbsolute(prefix || "") || !fs.statSync(path.join(prefix, "lib/pkgconfig")).isDirectory()) {
    throw new Error("AI5 portable dependencies need their original immutable build prefixes.");
  }
  return prefixes;
}

function nativeFile({ pkgConfig, sdk, pathMappings = [], libraryDirectories = [] }) {
  const literal = value => "'" + String(value).replaceAll("\\", "\\\\").replaceAll("'", "\\'") + "'";
  Fonts.cmakeOptions({ prefix: sdk, sdk, ninja: "/usr/bin/true", pathMappings });
  if (!path.isAbsolute(pkgConfig || "") || /[\r\n\0]/.test(pkgConfig)) throw new Error("AI5 requires an absolute pkg-config build tool.");
  if (!Array.isArray(libraryDirectories) || libraryDirectories.some(value => !path.isAbsolute(value || "") || /[\r\n\0,]/.test(value))) {
    throw new Error("AI5 dependency rpaths must be absolute library directories.");
  }
  const maps = pathMappings.flatMap(mapping => ["file", "debug", "macro"].map(kind => `-f${kind}-prefix-map=${mapping.from}=${mapping.to}`));
  const flags = ["-arch", "arm64", "-mmacosx-version-min=13.0", "-isysroot", sdk];
  return `[binaries]\nc = '/usr/bin/clang'\nar = '/usr/bin/ar'\nstrip = '/usr/bin/strip'\npkg-config = ${literal(pkgConfig)}\n\n[built-in options]\nc_args = [${[...flags, ...maps, "-Werror=unguarded-availability-new"].map(literal).join(", ")}]\nc_link_args = [${[...flags, "-Wl,-headerpad_max_install_names", ...libraryDirectories.map(value => "-Wl,-rpath," + value)].map(literal).join(", ")}]\n`;
}

async function buildPortableAI5({ sourceDir = Previous.sourcePath, workRoot, fontStack, audioStack, movieStack,
  pathMappings = [], signal, onProgress, dependencies = {} }) {
  throwIfAborted(signal);
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("This AI5 source profile requires an Apple Silicon Mac.");
  workRoot = Fonts.assertFreshBuildRoot(workRoot, { readOnlyRoots: [sourceDir, fontStack?.prefix, audioStack?.prefix].filter(Boolean) });
  const prefixes = dependencyPrefixes({ fontStack, audioStack, movieStack });
  const source = await Source.validatePinnedSource(sourceDir, REVISION, { signal });
  if (Source.hashPinnedFiles(sourceDir, source.files) !== SOURCE_SHA256) throw new Error("AI5 source tree checksum does not match the selected version.");
  const overlaySha256 = overlayIdentity(); fs.mkdirSync(workRoot, { recursive: true });
  const sourceRoot = path.join(workRoot, "source"), outputRoot = path.join(workRoot, "output"), prefix = path.join(workRoot, "prefix");
  const sourceTreeSha256 = Source.stagePinnedFiles(sourceDir, source.files, sourceRoot), sourceOverlay = adaptSource(sourceRoot);
  const tool = dependencies.findBuildTool || Source.findBuildTool;
  const tools = { meson: tool("meson"), ninja: tool("ninja"), pkgConfig: tool("pkg-config") };
  const sdk = fontStack.sdk, file = path.join(workRoot, "native.ini");
  fs.writeFileSync(file, nativeFile({ pkgConfig: tools.pkgConfig, sdk, pathMappings, libraryDirectories: prefixes.map(item => path.join(item, "lib")) }));
  const configureOptions = ["setup", outputRoot, sourceRoot, "--wrap-mode=nodownload", "--buildtype=release", "--native-file=" + file,
    "-Dffmpeg=enabled", "-Dsdl_mixer=disabled", "--prefix=" + prefix];
  const env = Fonts.buildEnvironment(prefix, sdk);
  env.PKG_CONFIG_LIBDIR = prefixes.map(item => path.join(item, "lib/pkgconfig")).join(path.delimiter);
  env.GIT_CEILING_DIRECTORIES = workRoot;
  for (const key of ["PKG_CONFIG_SYSROOT_DIR", "PKG_CONFIG_ALLOW_SYSTEM_CFLAGS", "PKG_CONFIG_ALLOW_SYSTEM_LIBS"]) delete env[key];
  const run = dependencies.runBuildCommand || Source.runBuildCommand, logPath = path.join(workRoot, "build.log"), startedAt = new Date().toISOString();
  fs.writeFileSync(logPath, `AI5 ${VERSION}\nSource ${REVISION}\nSource tree ${sourceTreeSha256}\nOverlay ${overlaySha256}\n`);
  onProgress?.({ phase: "configure", project: "ai5" });
  await run(tools.meson, configureOptions, { cwd: workRoot, env, logPath, signal });
  onProgress?.({ phase: "build", project: "ai5" });
  await run(tools.ninja, ["-C", outputRoot, "-j2"], { cwd: workRoot, env, logPath, signal });
  await run(tools.meson, ["install", "-C", outputRoot, "--no-rebuild"], { cwd: workRoot, env, logPath, signal });
  await Source.validatePinnedSource(sourceDir, REVISION, { signal });
  if (Source.hashPinnedFiles(sourceDir, source.files) !== sourceTreeSha256 || overlayIdentity() !== overlaySha256) throw new Error("AI5 source or build adapter changed during compilation.");
  const executable = path.join(prefix, "bin/ai5");
  return { managerId: "ai5", version: VERSION, profile: PROFILE, sourceRevision: REVISION, sourceTreeSha256, overlaySha256, sourceOverlay,
    architecture: "arm64", minimumMacOS: "13.0", executable, executableSha256: Native.hashFile(executable), resources: path.join(prefix, "share/ai5-sdl2"),
    sourceRoot, outputRoot, prefix, tools, configureOptions, nativeFileSha256: Native.hashFile(file), startedAt, completedAt: new Date().toISOString(), logPath,
    dependencyClosure: { fonts: fontStack, audio: audioStack, movie: movieStack } };
}

module.exports = { VERSION, REVISION, SOURCE_SHA256, PROFILE, ORIGINALS, OWNED_FILES, overlayIdentity, adaptSource, dependencyPrefixes, nativeFile, buildPortableAI5 };
