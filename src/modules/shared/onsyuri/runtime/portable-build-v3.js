const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const Base = require("./portable-build");
const Page = require("./portable-page-reset");
const Source = require("../../runtime/pinned-native-build");
const Native = require("../../runtime/local-native");
const Fonts = require("../../runtime/portable-sdl2-fonts");
const Audio = require("../../runtime/portable-sndfile");
const Mixer = require("../../runtime/portable-sdl2-mixer");
const Prefix = require("../../runtime/portable-dependency-prefix");
const { throwIfAborted } = require("../../runtime/download-utils");
const VERSION_PIN = require("./portable-build-v3.json");
const PIN = Object.freeze({ ...Base.PIN, ...VERSION_PIN, engine: { ...Base.PIN.engine, ...VERSION_PIN.engine } });
const VERSION = PIN.engine.version, REVISION = PIN.engine.revision, SOURCE_SHA256 = PIN.engine.sourceTreeSha256;
const OWNED_FILES = [...Base.OWNED_FILES, __filename, require.resolve("./portable-build-v3.json"), require.resolve("./portable-page-reset")];
const overlayIdentity = () => crypto.createHash("sha256").update(Buffer.concat(OWNED_FILES.map(file => fs.readFileSync(file)))).digest("hex");

function validateBase() {
  if (Base.VERSION !== PIN.base.version || Base.REVISION !== REVISION || Base.SOURCE_SHA256 !== SOURCE_SHA256 ||
      Base.overlayIdentity() !== PIN.base.overlaySha256) throw new Error("Yuri dependency recipe differs from its pinned base version.");
}

function validateCompleteStack(stack) {
  validateBase();
  const receipt = stack?.receipt, closure = receipt?.dependencyClosure;
  if (!receipt || receipt.complete !== true || receipt.version !== PIN.base.version || receipt.sourceRevision !== REVISION ||
      receipt.sourceTreeSha256 !== SOURCE_SHA256 || receipt.overlaySha256 !== PIN.base.overlaySha256 ||
      receipt.architecture !== "arm64" || receipt.minimumMacOS !== "13.0" ||
      receipt.profile?.overlaySha256 !== PIN.base.overlaySha256 || !/^[a-f0-9]{64}$/.test(stack.prefixSha256 || "") ||
      !isDeepStrictEqual(stack.readRoots, [closure?.mixer?.prefix, ...(closure?.mixer?.readRoots || [])]) ||
      !Array.isArray(closure?.sources) || closure.sources.length !== Base.PIN.dependencies.length) {
    throw new Error("Yuri dependency reuse needs its complete pinned base recipe and prefix checksum.");
  }
  Base.validateMixerStack(closure.mixer);
  for (const pin of Base.PIN.dependencies) {
    const source = closure.sources.find(row => row.id === pin.id);
    if (!source || Object.keys(pin).some(key => !isDeepStrictEqual(pin[key], source[key]))) throw new Error("Yuri dependency source differs from its pinned base version.");
  }
  const profile = JSON.parse(fs.readFileSync(path.join(closure.prefix, "profile.json"), "utf8"));
  if (!isDeepStrictEqual(profile, receipt.profile)) throw new Error("Yuri dependency profile checksum changed.");
  const inventory = Prefix.snapshotPrefix(closure.prefix, { readRoots: stack.readRoots });
  if (inventory.sha256 !== stack.prefixSha256) throw new Error("Yuri dependency prefix checksum changed.");
  Base.validateFeatures(path.dirname(closure.prefix));
  return inventory;
}

function validateEngineFeatures(outputRoot) {
  const commands = fs.readFileSync(path.join(outputRoot, "compile_commands.json"), "utf8");
  for (const name of ["USE_LUA", "USE_BUILTIN_LAYER_EFFECTS", "ENABLE_1BYTE_CHAR", "USE_PARALLEL"]) if (!commands.includes(name)) throw new Error(`Yuri native host did not enable ${name}.`);
  if (commands.includes("USE_GLES") || commands.includes("renderer/gles_renderer.cpp")) throw new Error("Yuri macOS build enabled the excluded GLES sharpness path.");
}

async function buildPortableYuri({ sourceDir, archives, workRoot, dependencyStacks, pathMappings = [], signal, onProgress, dependencies = {} }) {
  throwIfAborted(signal);
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("This portable Yuri build requires an Apple Silicon Mac.");
  validateBase();
  if (!path.isAbsolute(sourceDir || "")) throw new Error("Choose an absolute clean checkout of the pinned Yuri source.");
  const scope = Base.PIN.engine.sourceScope;
  const original = await Source.validatePinnedSource(sourceDir, REVISION, { signal, sourceScope: scope });
  if (Source.hashPinnedFiles(sourceDir, original.files) !== SOURCE_SHA256 || !isDeepStrictEqual(original.omittedSubmodules, Base.PIN.engine.omittedSubmodules)) throw new Error("Yuri primary source checksum or omitted-submodule revisions changed.");
  Base.validateEngineArchive(archives); Fonts.validateArchives(archives); Audio.validateArchives(archives); Audio.validateArchives(archives, { catalog: Mixer.PIN }); Fonts.validateArchives(archives, { catalog: Base.PIN });
  if (dependencyStacks && (Object.keys(dependencyStacks).length !== 1 || !dependencyStacks.yuri)) throw new Error("Yuri dependency reuse accepts one exact complete base profile.");
  const retained = dependencyStacks ? validateCompleteStack(dependencyStacks.yuri) : null;
  let closure = dependencyStacks?.yuri.receipt.dependencyClosure, mixer = closure?.mixer;
  const readRoots = retained ? [closure.prefix, ...dependencyStacks.yuri.readRoots] : [];
  workRoot = Fonts.assertFreshBuildRoot(workRoot, { readOnlyRoots: [sourceDir, ...readRoots] });
  const overlaySha256 = overlayIdentity(); fs.mkdirSync(workRoot, { recursive: true });
  if (!mixer) mixer = await Mixer.buildMixer({ archives, workRoot: path.join(workRoot, "mixer-dependencies"), pathMappings, signal, onProgress, dependencies });
  const prefix = path.join(workRoot, "prefix"); fs.mkdirSync(prefix);
  Prefix.linkPrefix(closure?.prefix || mixer.prefix, prefix, { readRoots: retained ? dependencyStacks.yuri.readRoots : mixer.readRoots });
  const run = dependencies.runBuildCommand || Source.runBuildCommand;
  const sources = retained ? closure.sources : [], sourceRoots = retained ? closure.sourceRoots : {};
  if (!retained) {
    for (const pin of Base.PIN.dependencies) {
      throwIfAborted(signal);
      const sourceRoot = path.join(workRoot, "source", pin.id); fs.mkdirSync(sourceRoot, { recursive: true });
      await run("/usr/bin/tar", ["-xf", archives[pin.id], "--strip-components", "1", "-C", sourceRoot],
        { cwd: workRoot, logPath: path.join(workRoot, "extraction.log"), env: Fonts.buildEnvironment(prefix, mixer.sdk), signal });
      for (const notice of pin.notices) if (!fs.lstatSync(path.join(sourceRoot, notice)).isFile()) throw new Error(`Missing source license for ${pin.name}.`);
      const sourceOverlay = pin.id === "lua" ? Base.adaptLua(sourceRoot) : undefined;
      const build = await Fonts.buildProject({ sourceRoot, outputRoot: path.join(workRoot, pin.id), prefix, sdk: mixer.sdk, tools: mixer.tools,
        pathMappings, options: pin.options, signal, onProgress, dependencies });
      sources.push({ ...pin, ...build, ...(sourceOverlay ? { sourceOverlay } : {}) }); sourceRoots[pin.id] = sourceRoot;
    }
  }
  const sourceRoot = path.join(workRoot, "onsyuri-source"), sourceTreeSha256 = Source.stagePinnedFiles(sourceDir, original.files, sourceRoot);
  const cmake = Base.adaptEngine(sourceRoot, sourceDir), page = Page.apply(sourceRoot, sourceDir);
  const sourceOverlay = { files: [...cmake.files, ...page.files] };
  const outputRoot = path.join(workRoot, "onsyuri");
  const build = await Fonts.buildProject({ sourceRoot, outputRoot, prefix, sdk: mixer.sdk, tools: mixer.tools,
    pathMappings, options: [], signal, onProgress, dependencies });
  validateEngineFeatures(outputRoot);
  const features = { ...mixer.features, ...(retained ? dependencyStacks.yuri.receipt.features : Base.validateFeatures(workRoot)), emptyPageReset: true };
  const profile = { schemaVersion: 1, version: VERSION, upstreamVersion: PIN.engine.upstreamVersion, upstreamRevision: REVISION, sourceTreeSha256,
    sourceScope: original.sourceScope, omittedSubmodules: original.omittedSubmodules, overlaySha256, architecture: "arm64", minimumMacOS: "13.0", features };
  fs.writeFileSync(path.join(prefix, "profile.json"), JSON.stringify(profile, null, 2) + "\n", { flag: "wx" });
  const current = await Source.validatePinnedSource(sourceDir, REVISION, { signal, sourceScope: scope });
  if (Source.hashPinnedFiles(sourceDir, current.files) !== sourceTreeSha256 || overlayIdentity() !== overlaySha256) throw new Error("Yuri source or build adapter changed during compilation.");
  if (retained && Prefix.snapshotPrefix(closure.prefix, { readRoots: dependencyStacks.yuri.readRoots }).sha256 !== retained.sha256) throw new Error("A reused Yuri dependency prefix changed during compilation.");
  throwIfAborted(signal);
  const executable = path.join(prefix, "bin/onsyuri");
  return { managerId: "onsyuri", version: VERSION, sourceRevision: REVISION, sourceTreeSha256, sourceScope: original.sourceScope,
    omittedSubmodules: original.omittedSubmodules, sourceOverlay, overlaySha256, architecture: "arm64", minimumMacOS: "13.0", executable,
    executableSha256: Native.hashFile(executable), profile, features, ...build,
    dependencyClosure: { version: PIN.version, prefix, sdk: mixer.sdk, tools: mixer.tools, mixer, sources, sourceRoots,
      ...(retained ? { reusedPrefixes: [{ prefix: retained.prefix, sha256: retained.sha256, readRoots: dependencyStacks.yuri.readRoots, baseVersion: PIN.base.version }] } : {}) } };
}

module.exports = { PIN, VERSION, REVISION, SOURCE_SHA256, OWNED_FILES, overlayIdentity, validateBase, validateCompleteStack,
  validateEngineFeatures, buildPortableYuri };
