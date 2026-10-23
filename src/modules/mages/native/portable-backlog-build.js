const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const Source = require("../../shared/runtime/pinned-native-build");
const Native = require("../../shared/runtime/local-native");
const Fonts = require("../../shared/runtime/portable-sdl2-fonts");
const Base = require("./portable-checkpoint-build");
const Portable = require("./portable-build");
const Dependency = require("./portable-dependencies");
const Prefix = require("./portable-prefix");
const Overlay = require("./windows-backlog-overlay");
const Session = require("./windows-checkpoint-session");
const PROFILE_SOURCE = path.join(__dirname, "windows-game-v8.lua");
const { throwIfAborted } = require("../../shared/runtime/download-utils");

const VERSION = "0.10.8.810-windows-v8";
const PROFILE = "windows-mpk2-sc3-backlog-macos13-v8";
const PROFILE_SHA256 = Session.PROFILE_SHA256;
const BASE_RECIPE_SHA256 = "ddbd510f118aa4a9bf1f4a5d6a4e9d3ac1a91482705321901e4652306786f15c";
const RECIPE_FILES = Object.freeze([...new Set([__filename, ...Base.RECIPE_FILES,
  require.resolve("./windows-backlog-overlay"), PROFILE_SOURCE])]);

function overlayIdentity() {
  const hash = crypto.createHash("sha256");
  for (const file of RECIPE_FILES) hash.update(fs.readFileSync(file));
  return hash.digest("hex");
}

function sourceInventory(directory) {
  if (!path.isAbsolute(directory || "") || fs.lstatSync(directory).isSymbolicLink() ||
      !fs.lstatSync(directory).isDirectory() || fs.existsSync(path.join(directory, ".git")))
    throw new Error("Impacto dependency reuse requires a separate source export.");
  const root = fs.realpathSync(directory), files = [];
  let bytes = 0;
  function visit(current, relative = "") {
    for (const name of fs.readdirSync(current).sort()) {
      if (name === ".git") throw new Error("Impacto source exports cannot contain Git metadata.");
      const file = path.join(current, name), item = path.posix.join(relative, name), stat = fs.lstatSync(file);
      if (stat.isDirectory()) { visit(file, item); continue; }
      if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error("Impacto source export contains a special file.");
      bytes += stat.size;
      if (files.length >= 10000 || bytes > 256 * 1024 * 1024) throw new Error("Impacto source export exceeds its bounds.");
      files.push(item);
    }
  }
  visit(root);
  return { directory: root, files, bytes, sha256: Source.hashPinnedFiles(root, files) };
}

function assertDigest(actual, expected, name) {
  if (!/^[a-f0-9]{64}$/.test(expected || "") || actual !== expected)
    throw new Error(`Impacto ${name} checksum changed.`);
}

function validateReuseInputs(reuse) {
  const base = reuse?.base;
  if (reuse?.schemaVersion !== 1 || base?.version !== Base.VERSION || base.profile !== Base.PROFILE ||
      base.architecture !== "arm64" || base.minimumMacOS !== "13.0" ||
      base.overlaySha256 !== BASE_RECIPE_SHA256 || Base.overlayIdentity() !== BASE_RECIPE_SHA256 ||
      base.profileSha256 !== Base.PROFILE_SHA256 || !isDeepStrictEqual(base.sourceTrees, Portable.SOURCE_TREES) ||
      base.windowsAudioOverlay?.abi !== "windows-sc3-voice-v1" ||
      base.windowsCheckpointOverlay?.abi !== "windows-sc3-checkpoint-u16-v1" || !base.engineReuse)
    throw new Error("Impacto engine reuse requires the exact Windows v7 source and dependency profile.");
  Portable.validateDependencyStack(base.dependencyStack);
  assertDigest(Native.hashFile(base.executable), base.executableSha256, "base executable");
  Portable.assertMinimumMacOS(base.executable);
  const source = sourceInventory(path.join(base.sourceRoot, "impacto"));
  assertDigest(source.sha256, reuse.sourceSha256, "source export");
  for (const [file, checksum] of Object.entries(Overlay.ORIGINALS))
    assertDigest(Native.hashFile(path.join(source.directory, file)), checksum, "backlog source");
  const prefixes = {};
  for (const id of ["ffmpeg", "avcpp"]) {
    const prefix = base.engineReuse.prefixes[id].prefix, inventory = Prefix.snapshotPrefix(prefix);
    assertDigest(inventory.sha256, base.engineReuse.prefixes[id].sha256, id + " inherited dependency prefix");
    assertDigest(inventory.sha256, reuse.prefixes?.[id], id + " dependency prefix");
    prefixes[id] = { prefix, sha256: inventory.sha256 };
    for (const row of inventory.files.filter(row => row.path.endsWith(".dylib")))
      Portable.assertMinimumMacOS(fs.realpathSync(path.join(prefix, row.path)));
  }
  const magicOptions = base.configureOptions.impacto.filter(option => option.startsWith("-DFETCHCONTENT_SOURCE_DIR_MAGIC_ENUM="));
  if (magicOptions.length !== 1) throw new Error("Impacto requires one exact magic_enum source path.");
  const magicEnum = sourceInventory(magicOptions[0].slice("-DFETCHCONTENT_SOURCE_DIR_MAGIC_ENUM=".length));
  assertDigest(magicEnum.sha256, reuse.magicEnumSha256, "magic_enum source");
  const library = base.engineReuse.atrac9.library;
  if (!fs.lstatSync(library).isFile() || fs.lstatSync(library).isSymbolicLink())
    throw new Error("Impacto Atrac9 reuse requires its original regular library.");
  assertDigest(Native.hashFile(library), reuse.atrac9LibrarySha256, "Atrac9 library");
  const include = base.engineReuse.atrac9.include, headers = Prefix.snapshotPrefix(include);
  assertDigest(headers.sha256, reuse.atrac9HeadersSha256, "Atrac9 headers");
  Portable.assertMinimumMacOS(library);
  return { source, prefixes, magicEnum, atrac9: { library, librarySha256: reuse.atrac9LibrarySha256,
    include, headersSha256: headers.sha256 }, dependencyPrefixSha256: base.dependencyStack.prefixSha256 };
}

async function buildWindowsBacklogImpacto(options) {
  throwIfAborted(options.signal);
  if (Native.hashFile(PROFILE_SOURCE) !== PROFILE_SHA256)
    throw new Error("Impacto backlog profile checksum changed.");
  const identity = overlayIdentity();
  let base, reusedInputs, workRoot, sourceRoot, outputRoot, runtimeRoot, configureOptions, logPath, env, harfbuzzMetadata;
  if (options.reuse) {
    base = options.reuse.base;
    reusedInputs = validateReuseInputs(options.reuse);
    const readOnlyRoots = [base.sourceRoot, base.outputRoot, base.runtimeRoot, path.dirname(base.logPath),
      base.dependencyStack.prefix, ...Object.values(reusedInputs.prefixes).map(row => row.prefix)];
    workRoot = Fonts.assertFreshBuildRoot(options.workRoot, { readOnlyRoots });
    fs.mkdirSync(workRoot, { recursive: true });
    sourceRoot = path.join(workRoot, "source"); outputRoot = path.join(workRoot, "output"); runtimeRoot = path.join(workRoot, "native");
    fs.mkdirSync(sourceRoot); fs.mkdirSync(outputRoot);
    Source.stagePinnedFiles(reusedInputs.source.directory, reusedInputs.source.files, path.join(sourceRoot, "impacto"));
    const prefixes = [reusedInputs.prefixes.avcpp.prefix, reusedInputs.prefixes.ffmpeg.prefix, base.dependencyStack.prefix];
    env = Dependency.environment(runtimeRoot, base.sdk, prefixes);
    env.GIT_CEILING_DIRECTORIES = workRoot;
    harfbuzzMetadata = Portable.writeHarfBuzzDescriptor(path.join(workRoot, "harfbuzz-metadata"),
      Fonts.PIN.dependencies.find(pin => pin.id === "harfbuzz").version);
    const pathMappings = options.pathMappings || [];
    configureOptions = ["-S", path.join(sourceRoot, "impacto"), "-B", path.join(outputRoot, "impacto"),
      ...Dependency.cmakeOptions({ prefix: runtimeRoot, sdk: base.sdk, ninja: base.tools.ninja, prefixes, pathMappings,
        options: ["-DIMPACTO_DISABLE_IMGUI=ON", "-DIMPACTO_DISABLE_VULKAN=ON", "-DIMPACTO_WARNINGS=OFF", "-DIMPACTO_DISABLE_LIBASS=ON"] }),
      `-DFETCHCONTENT_SOURCE_DIR_MAGIC_ENUM=${reusedInputs.magicEnum.directory}`,
      `-DMACLAUNCHER_ATRAC9_LIBRARY=${reusedInputs.atrac9.library}`,
      `-DMACLAUNCHER_ATRAC9_INCLUDE=${reusedInputs.atrac9.include}`,
      `-Dharfbuzz_DIR=${harfbuzzMetadata.directory}`, `-DZLIB_LIBRARY=${base.sdk}/usr/lib/libz.tbd`, `-DZLIB_INCLUDE_DIR=${base.sdk}/usr/include`];
    logPath = path.join(workRoot, "build.log");
  } else {
    base = await Base.buildWindowsCheckpointImpacto(options);
    workRoot = path.dirname(base.logPath); sourceRoot = base.sourceRoot; outputRoot = base.outputRoot; runtimeRoot = base.runtimeRoot;
    configureOptions = base.configureOptions.impacto; logPath = base.logPath; harfbuzzMetadata = base.harfbuzzMetadata;
    env = Dependency.environment(runtimeRoot, base.sdk,
      [path.join(workRoot, "avcpp"), path.join(workRoot, "ffmpeg"), base.dependencyStack.prefix]);
    env.GIT_CEILING_DIRECTORIES = workRoot;
  }
  throwIfAborted(options.signal);
  const startedAt = new Date().toISOString(), windowsBacklogOverlay = Overlay.applyWindowsBacklogOverlay(path.join(sourceRoot, "impacto"));
  const run = options.dependencies?.runBuildCommand || Source.runBuildCommand;
  const runOptions = { cwd: workRoot, logPath, env, signal: options.signal, timeout: 20 * 60 * 1000 };
  options.onProgress?.({ phase: "build", project: "impacto-disabled-backlog" });
  await run(base.tools.cmake, configureOptions, runOptions);
  await run(base.tools.cmake, ["--build", path.join(outputRoot, "impacto"), "--target", "impacto", "--parallel", "2"], runOptions);
  await run(base.tools.cmake, ["--install", path.join(outputRoot, "impacto")], runOptions);
  const executable = path.join(runtimeRoot, "Impacto.app/Contents/MacOS/Impacto");
  const prefixInputs = reusedInputs ? [base.dependencyStack.prefix, reusedInputs.prefixes.ffmpeg.prefix]
    : [base.dependencyStack.prefix, path.join(workRoot, "ffmpeg")];
  const dependencyLink = await Portable.linkDependencyPaths(executable, prefixInputs,
    { logPath, env, signal: options.signal, dependencies: options.dependencies });
  Portable.validateDependencyStack(base.dependencyStack);
  if (options.reuse) validateReuseInputs(options.reuse);
  if (overlayIdentity() !== identity) throw new Error("Impacto backlog build recipe changed during compilation.");
  const result = { ...base, version: VERSION, profile: PROFILE, profileSha256: PROFILE_SHA256,
    overlaySha256: identity, baseRecipeSha256: base.overlaySha256, windowsBacklogOverlay,
    executable, executableSha256: Native.hashFile(executable), executableFloor: Portable.assertMinimumMacOS(executable),
    sourceRoot, outputRoot, runtimeRoot, configureOptions: { ...base.configureOptions, impacto: configureOptions },
    dependencyLink, harfbuzzMetadata, logPath, startedAt, completedAt: new Date().toISOString(),
    ...(reusedInputs ? { engineReuse: { baseVersion: base.version, baseRecipeSha256: BASE_RECIPE_SHA256,
      sourceSha256: reusedInputs.source.sha256, prefixes: reusedInputs.prefixes,
      magicEnumSha256: reusedInputs.magicEnum.sha256, atrac9: reusedInputs.atrac9,
      dependencyPrefixSha256: reusedInputs.dependencyPrefixSha256 } } : {}) };
  if (!options.reuse) fs.renameSync(path.join(workRoot, "portable-build.json"), path.join(workRoot, "portable-checkpoint-build.json"));
  fs.writeFileSync(path.join(workRoot, "portable-build.json"), JSON.stringify(result, null, 2), { mode: 0o600 });
  return result;
}

module.exports = { VERSION, PROFILE, PROFILE_SOURCE, PROFILE_SHA256, BASE_RECIPE_SHA256, RECIPE_FILES,
  overlayIdentity, sourceInventory, validateReuseInputs, buildWindowsBacklogImpacto };
