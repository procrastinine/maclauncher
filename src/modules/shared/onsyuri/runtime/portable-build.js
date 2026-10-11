const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const Source = require("../../runtime/pinned-native-build");
const Native = require("../../runtime/local-native");
const Fonts = require("../../runtime/portable-sdl2-fonts");
const Audio = require("../../runtime/portable-sndfile");
const Mixer = require("../../runtime/portable-sdl2-mixer");
const Prefix = require("../../runtime/portable-dependency-prefix");
const { throwIfAborted } = require("../../runtime/download-utils");
const PIN = Object.freeze(require("./portable-build.json"));
const VERSION = PIN.engine.version;
const REVISION = PIN.engine.revision;
const SOURCE_SHA256 = PIN.engine.sourceTreeSha256;
const OWNED_FILES = [__filename, require.resolve("./portable-build.json"),
  path.join(__dirname, "portable-native/CMakeLists.txt"), path.join(__dirname, "portable-native/lua.CMakeLists.txt"),
  require.resolve("../../runtime/pinned-native-build"), require.resolve("../../runtime/portable-sdl2-fonts"), require.resolve("../../runtime/portable-sdl2-fonts.json"),
  require.resolve("../../runtime/portable-sndfile"), require.resolve("../../runtime/portable-sndfile.json"),
  require.resolve("../../runtime/portable-sdl2-mixer"), require.resolve("../../runtime/portable-sdl2-mixer.json"), require.resolve("../../runtime/portable-dependency-prefix")];
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const overlayIdentity = () => hash(Buffer.concat(OWNED_FILES.map(file => fs.readFileSync(file))));
const dependencyRecipe = (helper, catalog) => hash(Buffer.concat([fs.readFileSync(require.resolve(helper)), fs.readFileSync(require.resolve(catalog))]));

function validateEngineArchive(archives) {
  const file = archives?.onsyuri;
  if (!path.isAbsolute(file || "") || !fs.lstatSync(file).isFile() || fs.statSync(file).size !== PIN.engine.archiveBytes ||
      Native.hashFile(file) !== PIN.engine.archiveSha256) throw new Error("Yuri primary source archive checksum or size differs from its pinned version.");
}

function validateMixerStack(stack) {
  if (!stack || stack.version !== Mixer.PIN.version || stack.architecture !== "arm64" || stack.minimumMacOS !== "13.0" ||
      stack.recipeSha256 !== Mixer.recipeIdentity() || !/^[a-f0-9]{64}$/.test(stack.prefixSha256 || "") ||
      !Array.isArray(stack.sources) || stack.sources.length !== Mixer.PIN.dependencies.length ||
      !isDeepStrictEqual(stack.readRoots, [stack.fonts?.prefix, stack.audio?.prefix])) throw new Error("Yuri mixer reuse requires the exact source recipe, dependency roots and prefix checksum.");
  for (const pin of Mixer.PIN.dependencies) {
    const source = stack.sources.find(row => row.id === pin.id);
    if (!source || Object.keys(pin).some(key => !isDeepStrictEqual(pin[key], source[key]))) throw new Error("Yuri mixer source identity differs from its pinned version.");
  }
  Prefix.validateStack(stack.fonts, Fonts.PIN, dependencyRecipe("../../runtime/portable-sdl2-fonts", "../../runtime/portable-sdl2-fonts.json"));
  Prefix.validateStack(stack.audio, Audio.PIN, dependencyRecipe("../../runtime/portable-sndfile", "../../runtime/portable-sndfile.json"));
  const inventory = Prefix.snapshotPrefix(stack.prefix, { readRoots: stack.readRoots });
  if (inventory.sha256 !== stack.prefixSha256) throw new Error("Yuri reused mixer prefix checksum changed.");
  return inventory;
}

function requireOwnedSource(sourceRoot, sourceDir) {
  if (!path.isAbsolute(sourceRoot || "") || !fs.lstatSync(sourceRoot).isDirectory() || fs.existsSync(path.join(sourceRoot, ".git"))) {
    throw new Error("Yuri adapters require a separate disposable source directory.");
  }
  const root = fs.realpathSync(sourceRoot), external = path.resolve(__dirname, "../../../../external");
  for (const input of [external, ...(sourceDir ? [fs.realpathSync(sourceDir)] : [])]) {
    if (root === input || root.startsWith(input + path.sep) || input.startsWith(root + path.sep)) throw new Error("Yuri adapters cannot change source checkouts.");
  }
}

function adaptEngine(sourceRoot, sourceDir) {
  requireOwnedSource(sourceRoot, sourceDir);
  const file = path.join(sourceRoot, "CMakeLists.txt"), original = fs.readFileSync(file);
  if (hash(original) !== PIN.engine.cmakeSha256) throw new Error("Yuri CMake source differs from its pinned version.");
  fs.copyFileSync(path.join(__dirname, "portable-native/CMakeLists.txt"), file);
  return { files: [{ path: "CMakeLists.txt", sourceSha256: hash(original), adaptedSourceSha256: Native.hashFile(file) }] };
}

function adaptLua(sourceRoot) {
  requireOwnedSource(sourceRoot);
  const file = path.join(sourceRoot, "CMakeLists.txt"), header = fs.readFileSync(path.join(sourceRoot, "src/lua.h"), "utf8");
  if (fs.existsSync(file) || !header.includes('#define LUA_VERSION_RELEASE\t"9"') || !header.includes('#define LUA_VERSION_MINOR\t"4"')) {
    throw new Error("Lua source differs from the selected 5.4.9 profile.");
  }
  fs.copyFileSync(path.join(__dirname, "portable-native/lua.CMakeLists.txt"), file);
  return { files: [{ path: "CMakeLists.txt", sourceSha256: null, adaptedSourceSha256: Native.hashFile(file) }] };
}

function validateFeatures(outputRoot) {
  const commands = fs.readFileSync(path.join(outputRoot, "sdl2_image/compile_commands.json"), "utf8");
  for (const name of ["LOAD_PNG", "LOAD_JPG", "LOAD_WEBP"]) if (!commands.includes(name)) throw new Error(`Yuri image library did not enable ${name}.`);
  if (/LOAD_(?:PNG|JPG|WEBP|AVIF|JXL|TIF)_DYNAMIC/.test(commands)) throw new Error("Yuri image library enabled an unselected dynamic codec.");
  const engine = fs.readFileSync(path.join(outputRoot, "onsyuri/compile_commands.json"), "utf8");
  for (const name of ["USE_LUA", "USE_BUILTIN_LAYER_EFFECTS", "ENABLE_1BYTE_CHAR", "USE_PARALLEL"]) if (!engine.includes(name)) throw new Error(`Yuri native host did not enable ${name}.`);
  if (engine.includes("USE_GLES") || engine.includes("renderer/gles_renderer.cpp")) throw new Error("Yuri macOS build enabled the excluded GLES sharpness path.");
  return { imageFormats: ["BMP", "GIF", "JPEG", "LBM", "PCX", "PNG", "PNM", "QOI", "SVG", "TGA", "WebP", "XCF", "XPM", "XV"],
    imageFormatsExcluded: ["AVIF", "JPEG XL", "TIFF"], lua: "5.4.9", renderer: "SDL automatic", dynamicCodecLoading: false,
    moviePlayback: false, externalWindowsPlugins: false, glesSharpness: false };
}

async function buildPortableYuri({ sourceDir, archives, workRoot, dependencyStacks, pathMappings = [], signal, onProgress, dependencies = {} }) {
  throwIfAborted(signal);
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("This portable Yuri build requires an Apple Silicon Mac.");
  if (!path.isAbsolute(sourceDir || "")) throw new Error("Choose an absolute clean checkout of the pinned Yuri source.");
  const original = await Source.validatePinnedSource(sourceDir, REVISION, { signal, sourceScope: PIN.engine.sourceScope });
  if (Source.hashPinnedFiles(sourceDir, original.files) !== SOURCE_SHA256 || !isDeepStrictEqual(original.omittedSubmodules, PIN.engine.omittedSubmodules)) throw new Error("Yuri primary source checksum or omitted-submodule revisions changed.");
  validateEngineArchive(archives); Fonts.validateArchives(archives); Audio.validateArchives(archives); Audio.validateArchives(archives, { catalog: Mixer.PIN }); Fonts.validateArchives(archives, { catalog: PIN });
  if (dependencyStacks && (Object.keys(dependencyStacks).length !== 1 || !dependencyStacks.mixer)) throw new Error("Yuri dependency reuse accepts one exact complete mixer profile.");
  let mixer = dependencyStacks?.mixer, retained;
  if (mixer) retained = validateMixerStack(mixer);
  workRoot = Fonts.assertFreshBuildRoot(workRoot, { readOnlyRoots: [sourceDir, ...(mixer ? [mixer.prefix, ...mixer.readRoots] : [])] });
  const overlaySha256 = overlayIdentity(); fs.mkdirSync(workRoot, { recursive: true });
  if (!mixer) mixer = await Mixer.buildMixer({ archives, workRoot: path.join(workRoot, "mixer-dependencies"), pathMappings, signal, onProgress, dependencies });
  const prefix = path.join(workRoot, "prefix"); fs.mkdirSync(prefix); Prefix.linkPrefix(mixer.prefix, prefix, { readRoots: mixer.readRoots });
  const sources = [], sourceRoots = {}, run = dependencies.runBuildCommand || Source.runBuildCommand;
  for (const pin of PIN.dependencies) {
    throwIfAborted(signal);
    const sourceRoot = path.join(workRoot, "source", pin.id); fs.mkdirSync(sourceRoot, { recursive: true });
    await run("/usr/bin/tar", ["-xf", archives[pin.id], "--strip-components", "1", "-C", sourceRoot],
      { cwd: workRoot, logPath: path.join(workRoot, "extraction.log"), env: Fonts.buildEnvironment(prefix, mixer.sdk), signal });
    for (const notice of pin.notices) if (!fs.lstatSync(path.join(sourceRoot, notice)).isFile()) throw new Error(`Missing source license for ${pin.name}.`);
    const sourceOverlay = pin.id === "lua" ? adaptLua(sourceRoot) : undefined;
    const build = await Fonts.buildProject({ sourceRoot, outputRoot: path.join(workRoot, pin.id), prefix, sdk: mixer.sdk, tools: mixer.tools,
      pathMappings, options: pin.options, signal, onProgress, dependencies });
    sources.push({ ...pin, ...build, ...(sourceOverlay ? { sourceOverlay } : {}) }); sourceRoots[pin.id] = sourceRoot;
  }
  const sourceRoot = path.join(workRoot, "onsyuri-source"), sourceTreeSha256 = Source.stagePinnedFiles(sourceDir, original.files, sourceRoot);
  const sourceOverlay = adaptEngine(sourceRoot, sourceDir);
  const build = await Fonts.buildProject({ sourceRoot, outputRoot: path.join(workRoot, "onsyuri"), prefix, sdk: mixer.sdk, tools: mixer.tools,
    pathMappings, options: [], signal, onProgress, dependencies });
  const features = { ...mixer.features, ...validateFeatures(workRoot) };
  const profile = { schemaVersion: 1, version: VERSION, upstreamVersion: PIN.engine.upstreamVersion, upstreamRevision: REVISION, sourceTreeSha256,
    sourceScope: original.sourceScope, omittedSubmodules: original.omittedSubmodules, overlaySha256, architecture: "arm64", minimumMacOS: "13.0", features };
  fs.writeFileSync(path.join(prefix, "profile.json"), JSON.stringify(profile, null, 2) + "\n", { flag: "wx" });
  const current = await Source.validatePinnedSource(sourceDir, REVISION, { signal, sourceScope: PIN.engine.sourceScope });
  if (Source.hashPinnedFiles(sourceDir, current.files) !== sourceTreeSha256 || overlayIdentity() !== overlaySha256) throw new Error("Yuri source or build adapter changed during compilation.");
  if (retained && Prefix.snapshotPrefix(mixer.prefix, { readRoots: mixer.readRoots }).sha256 !== retained.sha256) throw new Error("A reused Yuri dependency prefix changed during compilation.");
  throwIfAborted(signal);
  const executable = path.join(prefix, "bin/onsyuri");
  return { managerId: "onsyuri", version: VERSION, sourceRevision: REVISION, sourceTreeSha256, sourceScope: original.sourceScope,
    omittedSubmodules: original.omittedSubmodules, sourceOverlay, overlaySha256, architecture: "arm64", minimumMacOS: "13.0", executable,
    executableSha256: Native.hashFile(executable), profile, features, ...build,
    dependencyClosure: { version: PIN.version, prefix, sdk: mixer.sdk, tools: mixer.tools, mixer, sources, sourceRoots,
      ...(retained ? { reusedPrefixes: [{ prefix: retained.prefix, sha256: retained.sha256, readRoots: mixer.readRoots }] } : {}) } };
}

module.exports = { PIN, VERSION, REVISION, SOURCE_SHA256, OWNED_FILES, overlayIdentity, validateEngineArchive, validateMixerStack,
  requireOwnedSource, adaptEngine, adaptLua, validateFeatures, buildPortableYuri };
