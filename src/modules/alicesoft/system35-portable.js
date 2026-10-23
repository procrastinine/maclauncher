const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const Source = require("../shared/runtime/pinned-native-build");
const Native = require("../shared/runtime/local-native");
const Fonts = require("../shared/runtime/portable-sdl2-fonts");
const Audio = require("../shared/runtime/portable-sndfile");
const Overlay = require("./system35-overlay");
const { throwIfAborted } = require("../shared/runtime/download-utils");
const PIN = Object.freeze(require("./system35-portable.json"));

const VERSION = "2.20.0-macos-v2";
const REVISION = "82c8b76a58a19ff1f87b4bdadbaef169c4b37f46";
const SOURCE_SHA256 = "0f9ed54898badb68428e0dcafc1b69044b5ecb5e2f86ff6cc261a8a2ca558c1d";
const sourcePath = path.resolve(__dirname, "../../external/xsystem35-sdl2");
const recipeFiles = [__filename, require.resolve("./system35-overlay"), require.resolve("./system35-portable.json"),
  require.resolve("../shared/runtime/portable-sdl2-fonts"), require.resolve("../shared/runtime/portable-sdl2-fonts.json"),
  require.resolve("../shared/runtime/portable-sndfile"), require.resolve("../shared/runtime/portable-sndfile.json")];

function overlayIdentity() {
  const hash = crypto.createHash("sha256");
  for (const file of recipeFiles) hash.update(fs.readFileSync(file));
  return hash.digest("hex");
}

function dependencyRecipe(helper, catalog) {
  return crypto.createHash("sha256").update(fs.readFileSync(require.resolve(helper))).update(fs.readFileSync(require.resolve(catalog))).digest("hex");
}

function snapshotPrefix(prefix) {
  if (!path.isAbsolute(prefix || "") || !fs.lstatSync(prefix).isDirectory()) throw new Error("Portable dependency prefixes must be real absolute directories.");
  const root = fs.realpathSync(prefix), files = [], tree = crypto.createHash("sha256");
  let bytes = 0;
  function visit(directory, relative = "") {
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name), item = path.posix.join(relative, name), stat = fs.lstatSync(file);
      if (stat.isDirectory()) { visit(file, item); continue; }
      if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error("Portable dependency prefix contains an unsupported file.");
      const resolved = fs.realpathSync(file);
      if (!resolved.startsWith(root + path.sep) || !fs.statSync(resolved).isFile()) throw new Error("Portable dependency links must stay inside their prefix.");
      const size = fs.statSync(resolved).size;
      bytes += size;
      if (files.length >= 8000 || bytes > 256 * 1024 * 1024) throw new Error("Portable dependency inventory exceeds its bounds.");
      const row = { path: item, sha256: Native.hashFile(resolved), size, mode: stat.mode & 0o777,
        ...(stat.isSymbolicLink() ? { link: fs.readlinkSync(file) } : {}) };
      files.push(row); tree.update(JSON.stringify(row) + "\n");
    }
  }
  visit(root);
  return { prefix: root, sha256: tree.digest("hex"), files, bytes };
}

function validateStack(stack, catalog, recipeSha256) {
  if (!stack || stack.version !== catalog.version || stack.architecture !== "arm64" || stack.minimumMacOS !== "13.0" ||
      stack.recipeSha256 !== recipeSha256 || !/^[a-f0-9]{64}$/.test(stack.prefixSha256 || "") ||
      !Array.isArray(stack.sources) || stack.sources.length !== catalog.dependencies.length) throw new Error("Portable dependency reuse requires the exact source recipe and prefix checksum.");
  for (const pin of catalog.dependencies) {
    const source = stack.sources.find(row => row.id === pin.id);
    if (!source || Object.keys(pin).some(key => !isDeepStrictEqual(source[key], pin[key]))) throw new Error("Portable dependency source identity differs from the selected profile.");
  }
  const inventory = snapshotPrefix(stack.prefix);
  if (inventory.sha256 !== stack.prefixSha256) throw new Error("Portable dependency prefix checksum changed.");
  return inventory;
}

function linkPrefix(inputPrefix, outputPrefix) {
  const original = fs.realpathSync(inputPrefix), output = fs.realpathSync(outputPrefix);
  if (output === original || output.startsWith(original + path.sep) || original.startsWith(output + path.sep)) throw new Error("Portable dependency links require a separate build prefix.");
  function visit(directory, relative) {
    const destination = path.join(output, relative);
    fs.mkdirSync(destination, { recursive: true });
    for (const name of fs.readdirSync(directory).sort()) {
      const source = path.join(directory, name), target = path.join(destination, name), stat = fs.lstatSync(source);
      if (stat.isDirectory()) { visit(source, path.join(relative, name)); continue; }
      const resolved = fs.realpathSync(source);
      if ((!stat.isFile() && !stat.isSymbolicLink()) || !resolved.startsWith(original + path.sep) || !fs.statSync(resolved).isFile()) throw new Error("Portable dependency links must reference contained regular files.");
      if (fs.existsSync(target)) {
        if (Native.hashFile(target) !== Native.hashFile(resolved)) throw new Error("Portable dependency prefixes contain conflicting files.");
      } else fs.symlinkSync(resolved, target);
    }
  }
  // Executables, game fonts and other runtime resources are not inherited.
  for (const relative of ["include", "lib"]) if (fs.existsSync(path.join(original, relative))) visit(path.join(original, relative), relative);
}

function adaptDependencyMetadata(prefix) {
  // Opus's Git-source CMake version probe returns 0 without .git metadata.
  // Replace only this build descriptor; the linked library stays unchanged.
  const pin = Audio.PIN.dependencies.find(row => row.id === "opus");
  const file = path.join(prefix, "lib/pkgconfig/opus.pc"), bytes = fs.readFileSync(file), text = bytes.toString("utf8");
  const version = /^Version:\s*([^\r\n]+)$/m.exec(text)?.[1];
  if (!["0", pin.version].includes(version)) throw new Error("Opus build metadata differs from the selected source version.");
  const adapted = Buffer.from(text.replace(/^Version:[^\r\n]+/m, `Version: ${pin.version}`));
  const temporary = file + ".maclauncher-new";
  fs.writeFileSync(temporary, adapted, { flag: "wx", mode: 0o644 });
  try { fs.renameSync(temporary, file); } finally { fs.rmSync(temporary, { force: true }); }
  return { path: "lib/pkgconfig/opus.pc", sourceRevision: pin.revision, version: pin.version,
    sourceSha256: crypto.createHash("sha256").update(bytes).digest("hex"), adaptedSha256: Native.hashFile(file) };
}

function validateFeatures(workRoot) {
  const config = fs.readFileSync(path.join(workRoot, "xsystem35/config.h"), "utf8");
  for (const name of ["ENABLE_DEBUGGER", "ENABLE_MIDI_SDLMIXER", "HAVE_WEBP"]) if (!new RegExp(`^#define ${name} (?:1|ON)$`, "m").test(config)) throw new Error(`xsystem35 did not enable ${name}.`);
  for (const name of ["HAVE_LIBINTL", "ENABLE_MIDI_PORTMIDI"]) if (new RegExp(`^#define ${name} `, "m").test(config)) throw new Error("xsystem35 enabled an unselected external dependency.");
  const commands = fs.readFileSync(path.join(workRoot, "sdl2_mixer/compile_commands.json"), "utf8");
  for (const name of ["MUSIC_MID_NATIVE", "MUSIC_FLAC_LIBFLAC", "MUSIC_MP3_MPG123", "MUSIC_OPUS", "MUSIC_OGG"]) {
    if (!commands.includes(name)) throw new Error(`SDL2_mixer did not enable ${name}.`);
  }
  if (/(?:FLAC|MPG123|OPUS|OGG)_DYNAMIC|MUSIC_MID_FLUIDSYNTH|MUSIC_MID_TIMIDITY/.test(commands)) throw new Error("SDL2_mixer enabled an unselected dynamic codec or MIDI backend.");
  return { debugger: true, webp: true, midi: "macOS AudioToolbox", portMidi: false, rtMidi: false,
    dynamicCodecLoading: false, audioFormats: ["WAV", "AIFF", "FLAC", "Ogg Vorbis", "Ogg Opus", "MP3", "MIDI"] };
}

async function buildPortableSystem35({ sourceDir = sourcePath, archives, workRoot, dependencyStacks, pathMappings = [], signal, onProgress, dependencies = {} }) {
  throwIfAborted(signal);
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("This portable xsystem35 build requires an Apple Silicon Mac.");
  workRoot = Fonts.assertFreshBuildRoot(workRoot, { readOnlyRoots: [sourceDir, ...Object.values(dependencyStacks || {}).map(stack => stack.prefix)] });
  Fonts.validateArchives(archives); Audio.validateArchives(archives); Audio.validateArchives(archives, { catalog: PIN });
  const source = await Source.validatePinnedSource(sourceDir, REVISION, { signal });
  if (Source.hashPinnedFiles(sourceDir, source.files) !== SOURCE_SHA256) throw new Error("xsystem35 source tree checksum does not match the selected version.");
  const overlaySha256 = overlayIdentity(), retained = [];
  let fonts, audio;
  if (dependencyStacks) {
    if (Object.keys(dependencyStacks).length !== 2 || !dependencyStacks.fonts || !dependencyStacks.audio) throw new Error("Portable dependency reuse needs both font and audio profiles.");
    fonts = dependencyStacks.fonts; audio = dependencyStacks.audio;
    retained.push(validateStack(fonts, Fonts.PIN, dependencyRecipe("../shared/runtime/portable-sdl2-fonts", "../shared/runtime/portable-sdl2-fonts.json")),
      validateStack(audio, Audio.PIN, dependencyRecipe("../shared/runtime/portable-sndfile", "../shared/runtime/portable-sndfile.json")));
  }
  fs.mkdirSync(workRoot, { recursive: true });
  if (!fonts) {
    fonts = await Fonts.buildDependencies({ archives, workRoot: path.join(workRoot, "font-dependencies"), pathMappings, signal, onProgress, dependencies });
    audio = await Audio.buildDependencies({ archives, workRoot: path.join(workRoot, "audio-dependencies"), pathMappings, signal, onProgress, dependencies });
  }
  if (fonts.sdk !== audio.sdk) throw new Error("Portable dependency profiles must use the same macOS SDK.");
  const prefix = path.join(workRoot, "prefix"), sourceRoots = {}, sources = [];
  fs.mkdirSync(prefix); linkPrefix(fonts.prefix, prefix); linkPrefix(audio.prefix, prefix);
  const dependencyMetadata = adaptDependencyMetadata(prefix);
  const run = dependencies.runBuildCommand || Source.runBuildCommand;
  for (const pin of PIN.dependencies) {
    throwIfAborted(signal);
    const sourceRoot = path.join(workRoot, "source", pin.id); fs.mkdirSync(sourceRoot, { recursive: true });
    await run("/usr/bin/tar", ["-xf", archives[pin.id], "--strip-components", "1", "-C", sourceRoot],
      { cwd: workRoot, logPath: path.join(workRoot, "extraction.log"), env: Fonts.buildEnvironment(prefix, fonts.sdk), signal });
    for (const notice of pin.notices) if (!fs.lstatSync(path.join(sourceRoot, notice)).isFile()) throw new Error(`Missing source license for ${pin.name}.`);
    const sourceOverlay = pin.id === "sdl2_mixer" ? Overlay.applyMixer(sourceRoot) : undefined;
    onProgress?.({ phase: "build", project: pin.id });
    const common = { sourceRoot, outputRoot: path.join(workRoot, pin.id), prefix, sdk: fonts.sdk, pathMappings, options: pin.options, signal, dependencies };
    const build = await (pin.buildSystem === "autotools" ? Audio.buildAutotools(common) : Fonts.buildProject({ ...common, tools: fonts.tools, onProgress }));
    sourceRoots[pin.id] = sourceRoot; sources.push({ ...pin, ...build, ...(sourceOverlay ? { sourceOverlay } : {}) });
  }
  const sourceRoot = path.join(workRoot, "xsystem35-source"), sourceTreeSha256 = Source.stagePinnedFiles(sourceDir, source.files, sourceRoot);
  const sourceOverlay = Overlay.apply(sourceRoot, { sourceDir });
  const build = await Fonts.buildProject({ sourceRoot, outputRoot: path.join(workRoot, "xsystem35"), prefix, sdk: fonts.sdk, tools: fonts.tools,
    pathMappings, options: ["-DENABLE_DEBUGGER=ON", "-DENABLE_WEBP=ON", "-DENABLE_PORTMIDI=OFF", "-DENABLE_GETTEXT=OFF"], signal, onProgress, dependencies });
  throwIfAborted(signal);
  const features = validateFeatures(workRoot);
  await Source.validatePinnedSource(sourceDir, REVISION, { signal });
  if (Source.hashPinnedFiles(sourceDir, source.files) !== sourceTreeSha256 || overlayIdentity() !== overlaySha256) throw new Error("xsystem35 source or build adapter changed during compilation.");
  for (const inventory of retained) if (snapshotPrefix(inventory.prefix).sha256 !== inventory.sha256) throw new Error("A reused dependency prefix changed during compilation.");
  const executable = path.join(prefix, "bin/xsystem35");
  return { managerId: "xsystem35", version: VERSION, sourceRevision: REVISION, sourceTreeSha256, overlaySha256, sourceOverlay,
    architecture: "arm64", minimumMacOS: "13.0", executable, executableSha256: Native.hashFile(executable), resources: path.join(prefix, "share/xsystem35"), features,
    ...build, dependencyClosure: { version: PIN.version, prefix, fonts, audio, sources, sourceRoots, dependencyMetadata,
      reusedPrefixes: retained.map(({ prefix: directory, sha256 }) => ({ prefix: directory, sha256 })) } };
}

module.exports = { VERSION, REVISION, SOURCE_SHA256, PIN, sourcePath, overlayIdentity, snapshotPrefix, validateStack, linkPrefix, adaptDependencyMetadata, validateFeatures, buildPortableSystem35 };
