const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const Source = require("../../shared/runtime/pinned-native-build");
const Native = require("../../shared/runtime/local-native");
const Fonts = require("../../shared/runtime/portable-sdl2-fonts");
const Audio = require("../../shared/runtime/portable-sndfile");
const Mixer = require("../../shared/runtime/portable-sdl2-mixer");
const Python = require("../../shared/runtime/portable-python-v2");
const Prefix = require("../../shared/runtime/portable-dependency-prefix");
const { throwIfAborted } = require("../../shared/runtime/download-utils");
const Overlay = require("./portable-overlay-v5");
const PayloadContent = require("./payload-content");
const VERSION = "0.9.5-git-bcb5cfaa9-cli-v5";
const REVISION = "bcb5cfaa9f19ffbe8a51f25a3c014fa344173351";
const SOURCE_SHA256 = "47eb4e2cc2d234bc37d9c69b7edc8222f6cc59d3a8cbb62dcb3d511aefa8c0cd";
const sourcePath = path.resolve(__dirname, "../../../external/gemrb");
const recipeFiles = [__filename, require.resolve("./portable-overlay-v5"), require.resolve("./payload-content"), require.resolve("../../shared/runtime/portable-dependency-prefix"),
  ...["portable-sdl2-fonts", "portable-sndfile", "portable-sdl2-mixer", "portable-python", "portable-python-v2"].flatMap(name => [require.resolve("../../shared/runtime/" + name), require.resolve("../../shared/runtime/" + name + ".json")])];
const overlayIdentity = () => { const h = crypto.createHash("sha256"); for (const file of recipeFiles) h.update(fs.readFileSync(file)); return h.digest("hex"); };

function validateMixerStack(stack) {
  if (!stack || stack.version !== Mixer.PIN.version || stack.recipeSha256 !== Mixer.recipeIdentity() || stack.architecture !== "arm64" || stack.minimumMacOS !== "13.0") throw new Error("GemRB requires the exact portable SDL2_mixer profile.");
  const recipe = (helper, catalog) => crypto.createHash("sha256").update(fs.readFileSync(require.resolve(helper))).update(fs.readFileSync(require.resolve(catalog))).digest("hex");
  const fonts = Prefix.validateStack(stack.fonts, Fonts.PIN, recipe("../../shared/runtime/portable-sdl2-fonts", "../../shared/runtime/portable-sdl2-fonts.json"));
  const audio = Prefix.validateStack(stack.audio, Audio.PIN, recipe("../../shared/runtime/portable-sndfile", "../../shared/runtime/portable-sndfile.json"));
  if (!Array.isArray(stack.sources) || stack.sources.length !== Mixer.PIN.dependencies.length || Mixer.PIN.dependencies.some(pin => !stack.sources.some(source => source.id === pin.id && Object.keys(pin).every(key => isDeepStrictEqual(source[key],pin[key]))))) throw new Error("GemRB audio source identity changed.");
  const inventory = Prefix.snapshotPrefix(stack.prefix, { readRoots: [fonts.prefix, audio.prefix] });
  if (inventory.sha256 !== stack.prefixSha256) throw new Error("GemRB audio prefix checksum changed.");
  return { inventory, fonts, audio };
}
function validatePythonStack(stack) {
  if (!stack || stack.version !== Python.PIN.version || stack.recipeSha256 !== Python.recipeIdentity() || stack.architecture !== "arm64" || stack.minimumMacOS !== "13.0" || !isDeepStrictEqual(stack.source, Python.PIN.source) || !isDeepStrictEqual(stack.configureOptions, Python.PIN.options) || !isDeepStrictEqual(stack.disabledModules, Python.PIN.disabledModules) || stack.baseProfile !== Python.PIN.baseProfile || stack.objectSymbolPaths !== "relative" || !isDeepStrictEqual(stack.linkerOptions, Python.linkerOptions(path.dirname(stack.prefix))) || stack.library !== path.join(stack.prefix,"lib/libpython3.14.dylib") || stack.includeDir !== path.join(stack.prefix,"include/python3.14") || stack.stdlib !== path.join(stack.prefix,"lib/python3.14")) throw new Error("GemRB requires the exact embedded Python source profile.");
  const inventory = Prefix.snapshotPrefix(stack.prefix);
  if (inventory.sha256 !== stack.prefixSha256) throw new Error("GemRB Python prefix checksum changed.");
  return inventory;
}
function configureOptions({ prefix, sdk, tools, python, pathMappings = [] }) {
  const maps = [...pathMappings].flatMap(({ from, to }) => ["file", "macro", "debug"].map(kind => `-f${kind}-prefix-map=${from}=${to}`));
  const flags = [...maps, "-Werror=unguarded-availability-new"].join(" ");
  return [...Fonts.cmakeOptions({ prefix, sdk, ninja: tools.ninja, pathMappings, options: [] }),
    "-DCMAKE_OBJC_COMPILER=/usr/bin/clang", "-DCMAKE_OBJCXX_COMPILER=/usr/bin/clang++", `-DCMAKE_OBJC_FLAGS=${flags}`, `-DCMAKE_OBJCXX_FLAGS=${flags}`,
    "-DDISABLE_WERROR=ON", "-DUSE_TRACY=OFF", "-DSKIP_DEMO_DATA=ON", "-DSDL_BACKEND=SDL2", "-DOPENGL_BACKEND=None", "-DUSE_SDLMIXER=ON", "-DUSE_OPENAL=ON", "-DUSE_LIBVLC=OFF",
    "-DUSE_FREETYPE=ON", "-DUSE_PNG=ON", "-DUSE_VORBIS=ON", "-DPYTHON_VERSION=3.14", "-DPython_FIND_FRAMEWORK=NEVER", "-DPython_FIND_REGISTRY=NEVER",
    `-DPython_LIBRARY=${python.library}`, `-DPython_INCLUDE_DIR=${python.includeDir}`, `-DPython_ROOT_DIR=${python.prefix}`,
    `-DZLIB_LIBRARY=${sdk}/usr/lib/libz.tbd`, `-DZLIB_INCLUDE_DIR=${sdk}/usr/include`, `-DIconv_LIBRARY=${sdk}/usr/lib/libiconv.tbd`, `-DIconv_INCLUDE_DIR=${sdk}/usr/include`,
    `-DOPENAL_LIBRARY=${sdk}/System/Library/Frameworks/OpenAL.framework`, `-DOPENAL_INCLUDE_DIR=${sdk}/System/Library/Frameworks/OpenAL.framework/Headers`];
}
function validateFeatures(buildRoot) {
  const appRoot = path.join(buildRoot, "gemrb/gemrb.app"), plugins = path.join(appRoot, "Contents/PlugIns");
  for (const name of ["GUIScript", "SDLVideo", "SDLAudio", "OpenALAudio", "OGGReader", "TTFImporter", "PNGImporter", "ACMReader", "MVEPlayer", "BIKPlayer"]) if (!fs.lstatSync(path.join(plugins, name + ".so")).isFile()) throw new Error(`GemRB is missing the ${name} plugin.`);
  const commands = fs.readFileSync(path.join(buildRoot, "compile_commands.json"), "utf8");
  if (/\/opt\/homebrew\/(?:include|opt|Cellar)|\/usr\/local\/include/.test(commands) || commands.includes("VLCPlayer")) throw new Error("GemRB discovered an unselected external dependency.");
  if (fs.existsSync(path.join(appRoot, "Contents/Resources/demo"))) throw new Error("GemRB runtime must omit the optional demo game data.");
  return { python: "3.14.8", pythonObjectSymbolPaths: "relative", sdl: "2.32.10", sdlMixer: "2.8.2", openAL: "macOS system", trueType: true, png: true, vorbis: true, nativeMovieFormats: ["MVE", "BIK"],vlc: false, networkFetch: false,cliConfiguration: true,scriptingReferenceExports: true,bundledDemo: false };
}

async function buildPortableGemRB({ sourceDir = sourcePath, archives, workRoot, dependencyStacks, pathMappings = [], signal, onProgress, dependencies = {} }) {
  throwIfAborted(signal);
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("This GemRB build requires an Apple Silicon Mac.");
  workRoot = Fonts.assertFreshBuildRoot(workRoot, { readOnlyRoots: [sourceDir, ...Object.values(dependencyStacks || {}).map(stack => stack.prefix)] });
  Fonts.validateArchives(archives); Audio.validateArchives(archives); Audio.validateArchives(archives, { catalog: Mixer.PIN }); Python.validateArchive(archives?.python);
  const source = await Source.validatePinnedSource(sourceDir, REVISION, { signal });
  if (Source.hashPinnedFiles(sourceDir, source.files) !== SOURCE_SHA256) throw new Error("GemRB source tree differs from the selected version.");
  const recipeSha256 = overlayIdentity(), retained = [];
  let mixer, python;
  if (dependencyStacks) {
    if (Object.keys(dependencyStacks).length !== 2 || !dependencyStacks.mixer || !dependencyStacks.python) throw new Error("GemRB dependency reuse needs exact mixer and Python profiles.");
    mixer = dependencyStacks.mixer; python = dependencyStacks.python;
    const checked = validateMixerStack(mixer); retained.push({ ...checked.inventory, readRoots: [checked.fonts.prefix, checked.audio.prefix] }, checked.fonts, checked.audio, validatePythonStack(python));
  }
  fs.mkdirSync(workRoot, { recursive: true });
  if (!mixer) { mixer = await Mixer.buildMixer({ archives, workRoot: path.join(workRoot, "mixer"), pathMappings, signal, onProgress, dependencies }); python = await Python.buildPython({ archive: archives.python, workRoot: path.join(workRoot, "python"), sdk: mixer.sdk, pathMappings, signal, onProgress, dependencies }); }
  if (mixer.sdk !== python.sdk) throw new Error("GemRB dependencies must use the same macOS SDK.");
  const prefix = path.join(workRoot, "prefix"), sourceRoot = path.join(workRoot, "gemrb-source"), outputRoot = path.join(workRoot, "gemrb");
  fs.mkdirSync(prefix); Prefix.linkPrefix(mixer.prefix, prefix, { readRoots: [mixer.fonts.prefix, mixer.audio.prefix] });
  const logPath = path.join(workRoot, "gemrb.log"), env = Fonts.buildEnvironment(prefix, mixer.sdk), run = dependencies.runBuildCommand || Source.runBuildCommand;
  delete env.GITHUB_SHA;
  // The shared Python input uses a neutral install name. Give only this new
  // build's library copy an absolute producer location for link collection;
  // runtime packaging replaces it with a contained loader-relative name.
  const pythonLibrary = path.join(prefix, "lib/libpython3.14.dylib");
  fs.copyFileSync(python.library, pythonLibrary, fs.constants.COPYFILE_EXCL);
  const pythonSourceSha256 = Native.hashFile(pythonLibrary);
  await run("/usr/bin/install_name_tool", ["-id", pythonLibrary, pythonLibrary], { cwd: workRoot, logPath, env, signal });
  const pythonLibraryAdapter = { originalSha256: pythonSourceSha256, adaptedSha256: Native.hashFile(pythonLibrary), library: pythonLibrary };
  const sourceTreeSha256 = Source.stagePinnedFiles(sourceDir, source.files, sourceRoot), sourceOverlay = Overlay.apply(sourceRoot, { sourceDir });
  const tools = mixer.tools || { cmake: Source.findBuildTool("cmake"), ninja: Source.findBuildTool("ninja") };
  const compilerMappings = [...pathMappings, { from: sourceRoot, to: "gemrb-source" }, { from: workRoot, to: "gemrb-build" }];
  const options = configureOptions({ prefix, sdk: mixer.sdk, tools, python: { ...python, library: pythonLibrary }, pathMappings: compilerMappings });
  onProgress?.({ phase: "configure", project: "gemrb" });
  await run(tools.cmake, ["-S", sourceRoot, "-B", outputRoot, ...options], { cwd: workRoot, logPath, env, signal });
  onProgress?.({ phase: "build", project: "gemrb" });
  // Apple plugins link against the CLI bundle loader; finish it first.
  for (const args of [["--build", outputRoot, "--target", "gemrb", "--parallel", "2"], ["--build", outputRoot, "--parallel", "2"]]) await run(tools.cmake, args, { cwd: workRoot, logPath, env, signal, timeout: 20 * 60 * 1000 });
  throwIfAborted(signal);
  const appRoot = path.join(outputRoot, "gemrb/gemrb.app"), executable = path.join(appRoot, "Contents/MacOS/gemrb"), features = validateFeatures(outputRoot);
  PayloadContent.omitOptionalTests(appRoot);
  await run("/usr/libexec/PlistBuddy", ["-c", "Add :LSMinimumSystemVersion string 13.0", path.join(appRoot, "Contents/Info.plist")], { cwd: workRoot, logPath, env, signal });
  await Source.validatePinnedSource(sourceDir, REVISION, { signal });
  if (Source.hashPinnedFiles(sourceDir, source.files) !== sourceTreeSha256 || overlayIdentity() !== recipeSha256) throw new Error("GemRB source or adapter changed during compilation.");
  for (const inventory of retained) if (Prefix.snapshotPrefix(inventory.prefix, { readRoots: inventory.readRoots }).sha256 !== inventory.sha256) throw new Error("A reused dependency prefix changed during compilation.");
  return { managerId: "gemrb", version: VERSION, sourceRevision: REVISION, sourceTreeSha256, overlaySha256: recipeSha256, sourceOverlay,
    architecture: "arm64", minimumMacOS: "13.0", appRoot, executable, executableSha256: Native.hashFile(executable), sourceRoot, outputRoot, configureOptions: options, features,
    logPath, dependencyClosure: { mixer, python, pythonLibraryAdapter, prefix }, resources: path.join(appRoot, "Contents/Resources"), plugins: path.join(appRoot, "Contents/PlugIns") };
}
module.exports = { VERSION, REVISION, SOURCE_SHA256, sourcePath, overlayIdentity, validateMixerStack, validatePythonStack, configureOptions, validateFeatures, buildPortableGemRB };
