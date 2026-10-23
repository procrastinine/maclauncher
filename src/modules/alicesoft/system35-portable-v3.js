const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const Source = require("../shared/runtime/pinned-native-build");
const Native = require("../shared/runtime/local-native");
const Fonts = require("../shared/runtime/portable-sdl2-fonts");
const Audio = require("../shared/runtime/portable-sndfile");
const Mixer = require("../shared/runtime/portable-sdl2-mixer");
const Prefix = require("../shared/runtime/portable-dependency-prefix");
const Overlay = require("./system35-overlay-v3");
const { throwIfAborted } = require("../shared/runtime/download-utils");
const PIN = Object.freeze(require("./system35-portable.json"));
const VERSION = "MCLv1-1019";
const REVISION = "fbb12f67950601d547f65ef37c4fba4a10cc3822";
const SOURCE_SHA256 = "73e633b7b9f3ecbbc760179347b542e4fe69fd18023981ff50224d099f2275a8";
const sourcePath = path.resolve(__dirname, "../../external/xsystem35-sdl2");
const recipeFiles = [__filename, require.resolve("./system35-overlay-v3"), require.resolve("./system35-portable.json"),
  ...["portable-sdl2-fonts", "portable-sndfile", "portable-sdl2-mixer"].flatMap(name =>
    [require.resolve("../shared/runtime/" + name), require.resolve("../shared/runtime/" + name + ".json")]),
  require.resolve("../shared/runtime/portable-dependency-prefix")];
const overlayIdentity = () => { const hash = crypto.createHash("sha256"); for (const file of recipeFiles) hash.update(fs.readFileSync(file)); return hash.digest("hex"); };
const dependencyRecipe = name => crypto.createHash("sha256").update(fs.readFileSync(require.resolve("../shared/runtime/" + name)))
  .update(fs.readFileSync(require.resolve("../shared/runtime/" + name + ".json"))).digest("hex");

function validateMixer(stack) {
  if (!stack || stack.version !== Mixer.PIN.version || stack.recipeSha256 !== Mixer.recipeIdentity() ||
      stack.architecture !== "arm64" || stack.minimumMacOS !== "13.0" || !Array.isArray(stack.sources) ||
      stack.sources.length !== Mixer.PIN.dependencies.length || Mixer.PIN.dependencies.some(pin =>
        !stack.sources.some(source => source.id === pin.id && Object.keys(pin).every(key => isDeepStrictEqual(source[key], pin[key]))))) {
    throw new Error("xsystem35 requires the exact portable SDL2_mixer dependency profile.");
  }
  const fonts = Prefix.validateStack(stack.fonts, Fonts.PIN, dependencyRecipe("portable-sdl2-fonts"));
  const audio = Prefix.validateStack(stack.audio, Audio.PIN, dependencyRecipe("portable-sndfile"));
  const inventory = Prefix.snapshotPrefix(stack.prefix, { readRoots: [fonts.prefix, audio.prefix] });
  if (inventory.sha256 !== stack.prefixSha256) throw new Error("xsystem35 mixer prefix checksum changed.");
  return [{ ...inventory, readRoots: [fonts.prefix, audio.prefix] }, fonts, audio];
}

async function buildPortableSystem35({ sourceDir = sourcePath, archives, workRoot, dependencyStacks, pathMappings = [], signal, onProgress, dependencies = {} }) {
  throwIfAborted(signal);
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("This xsystem35 build requires an Apple Silicon Mac.");
  workRoot = Fonts.assertFreshBuildRoot(workRoot, { readOnlyRoots: [sourceDir, ...Object.values(dependencyStacks || {}).map(stack => stack.prefix)] });
  Fonts.validateArchives(archives); Audio.validateArchives(archives); Audio.validateArchives(archives, { catalog: PIN });
  const source = await Source.validatePinnedSource(sourceDir, REVISION, { signal });
  if (Source.hashPinnedFiles(sourceDir, source.files) !== SOURCE_SHA256) throw new Error("xsystem35 source tree differs from the selected snapshot.");
  const overlaySha256 = overlayIdentity();
  if (dependencyStacks && (Object.keys(dependencyStacks).length !== 1 || !dependencyStacks.mixer)) throw new Error("xsystem35 dependency reuse needs the exact mixer profile.");
  const mixer = dependencyStacks?.mixer || await Mixer.buildMixer({ archives, workRoot: path.join(workRoot, "mixer"), pathMappings, signal, onProgress, dependencies });
  const retained = validateMixer(mixer);
  fs.mkdirSync(workRoot, { recursive: true });
  const prefix = path.join(workRoot, "prefix"), sourceRoots = {}, sources = [];
  fs.mkdirSync(prefix); Prefix.linkPrefix(mixer.prefix, prefix, { readRoots: [mixer.fonts.prefix, mixer.audio.prefix] });
  const run = dependencies.runBuildCommand || Source.runBuildCommand;
  for (const pin of PIN.dependencies.filter(pin => ["cjson", "webp"].includes(pin.id))) {
    const sourceRoot = path.join(workRoot, "source", pin.id); fs.mkdirSync(sourceRoot, { recursive: true });
    await run("/usr/bin/tar", ["-xf", archives[pin.id], "--strip-components", "1", "-C", sourceRoot],
      { cwd: workRoot, logPath: path.join(workRoot, "extraction.log"), env: Fonts.buildEnvironment(prefix, mixer.sdk), signal });
    for (const notice of pin.notices) if (!fs.lstatSync(path.join(sourceRoot, notice)).isFile()) throw new Error(`Missing license for ${pin.name}.`);
    const build = await Fonts.buildProject({ sourceRoot, outputRoot: path.join(workRoot, pin.id), prefix, sdk: mixer.sdk,
      tools: mixer.tools, pathMappings, options: pin.options, signal, onProgress, dependencies });
    sourceRoots[pin.id] = sourceRoot; sources.push({ ...pin, ...build });
  }
  const sourceRoot = path.join(workRoot, "xsystem35-source"), sourceTreeSha256 = Source.stagePinnedFiles(sourceDir, source.files, sourceRoot);
  const sourceOverlay = Overlay.apply(sourceRoot, { sourceDir });
  const build = await Fonts.buildProject({ sourceRoot, outputRoot: path.join(workRoot, "xsystem35"), prefix, sdk: mixer.sdk,
    tools: mixer.tools, pathMappings, options: ["-DXSYSTEM35_SDL_VERSION=2", "-DXSYSTEM35_FETCH_SDL3_MIXER=OFF",
      "-DENABLE_DEBUGGER=ON", "-DENABLE_WEBP=ON", "-DENABLE_PORTMIDI=OFF", "-DENABLE_GETTEXT=OFF"], signal, onProgress, dependencies });
  const config = fs.readFileSync(path.join(workRoot, "xsystem35/config.h"), "utf8");
  for (const name of ["ENABLE_DEBUGGER", "ENABLE_MIDI_SDLMIXER", "HAVE_WEBP"]) if (!new RegExp(`^#define ${name} (?:1|ON)$`, "m").test(config)) throw new Error(`xsystem35 did not enable ${name}.`);
  for (const name of ["HAVE_LIBINTL", "ENABLE_MIDI_PORTMIDI"]) if (new RegExp(`^#define ${name} `, "m").test(config)) throw new Error("xsystem35 enabled an unselected dependency.");
  throwIfAborted(signal); await Source.validatePinnedSource(sourceDir, REVISION, { signal });
  if (Source.hashPinnedFiles(sourceDir, source.files) !== sourceTreeSha256 || overlayIdentity() !== overlaySha256) throw new Error("xsystem35 source or adapter changed during compilation.");
  for (const inventory of retained) if (Prefix.snapshotPrefix(inventory.prefix, { readRoots: inventory.readRoots }).sha256 !== inventory.sha256) throw new Error("A reused dependency prefix changed during compilation.");
  const executable = path.join(prefix, "bin/xsystem35");
  return { managerId: "xsystem35", version: VERSION, sourceRevision: REVISION, sourceTreeSha256, overlaySha256, sourceOverlay,
    architecture: "arm64", minimumMacOS: "13.0", executable, executableSha256: Native.hashFile(executable), resources: path.join(prefix, "share/xsystem35"),
    features: { debugger: true, webp: true, sdl: "2.32.10", midi: "macOS AudioToolbox", ...mixer.features },
    ...build, dependencyClosure: { mixer, prefix, sources, sourceRoots } };
}
module.exports = { VERSION, REVISION, SOURCE_SHA256, PIN, sourcePath, overlayIdentity, validateMixer, buildPortableSystem35 };
