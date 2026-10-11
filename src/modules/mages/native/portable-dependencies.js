const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const Source = require("../../shared/runtime/pinned-native-build");
const Native = require("../../shared/runtime/local-native");
const Fonts = require("../../shared/runtime/portable-sdl2-fonts");
const Audio = require("../../shared/runtime/portable-sndfile");
const Prefix = require("./portable-prefix");
const { throwIfAborted } = require("../../shared/runtime/download-utils");
const PIN = Object.freeze(require("./portable-dependencies.json"));
const RECIPE_FILES = [__filename, require.resolve("./portable-dependencies.json"), require.resolve("./portable-prefix"),
  require.resolve("../../shared/runtime/portable-sdl2-fonts"), require.resolve("../../shared/runtime/portable-sdl2-fonts.json"),
  require.resolve("../../shared/runtime/portable-sndfile"), require.resolve("../../shared/runtime/portable-sndfile.json")];

function recipeHash(files = RECIPE_FILES) {
  const hash = crypto.createHash("sha256");
  for (const file of files) hash.update(fs.readFileSync(file));
  return hash.digest("hex");
}

function relative(value) {
  return typeof value === "string" && value.length > 0 && !path.isAbsolute(value) &&
    !value.split(/[\\/]/).some(part => ["", ".", ".."].includes(part)) && !/[\r\n\0]/.test(value);
}

function validateArchives(archives, { catalog = PIN } = {}) {
  if (catalog?.schemaVersion !== 1 || catalog.architecture !== "arm64" || catalog.minimumMacOS !== "13.0" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(catalog.version || "") || !Array.isArray(catalog.dependencies) ||
      !catalog.dependencies.length || catalog.dependencies.length > 32) throw new Error("Invalid Impacto dependency source catalog.");
  const seen = new Set();
  for (const pin of catalog.dependencies) {
    if (!/^[a-z0-9_]+$/.test(pin.id || "") || seen.has(pin.id) ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(pin.version || "") || typeof pin.name !== "string" || !pin.name ||
        typeof pin.license !== "string" || !pin.license ||
        !(pin.revision ? /^[a-f0-9]{40}$/.test(pin.revision) : /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(pin.sourceRelease || "")) ||
        !/^[a-f0-9]{64}$/.test(pin.archiveSha256 || "") || !/^https:\/\//.test(pin.archiveUrl || "") ||
        !Number.isSafeInteger(pin.archiveBytes) || pin.archiveBytes <= 0 || pin.archiveBytes > 256 * 1024 * 1024 ||
        !Array.isArray(pin.notices) || !pin.notices.length || pin.notices.some(value => !relative(value)) ||
        !["cmake", "meson", "headers"].includes(pin.buildSystem) || !Array.isArray(pin.options) ||
        pin.options.some(option => typeof option !== "string" || /[\r\n\0;]/.test(option) ||
          !/^-D[A-Za-z0-9_]+=/.test(option) || /^-D(?:CMAKE_|FETCHCONTENT_)/.test(option))) {
      throw new Error("Impacto dependencies require exact source archives, build options and license notices.");
    }
    seen.add(pin.id);
    const file = archives?.[pin.id];
    if (!path.isAbsolute(file || "") || !fs.lstatSync(file).isFile() || fs.statSync(file).size !== pin.archiveBytes ||
        Native.hashFile(file) !== pin.archiveSha256) throw new Error(`Source archive checksum or size differs for ${pin.name} ${pin.version}.`);
  }
  return catalog.dependencies;
}

function dependencyStacks({ fonts, audio }) {
  const inputs = [[fonts, Fonts.PIN, [require.resolve("../../shared/runtime/portable-sdl2-fonts"), require.resolve("../../shared/runtime/portable-sdl2-fonts.json")]],
    [audio, Audio.PIN, [require.resolve("../../shared/runtime/portable-sndfile"), require.resolve("../../shared/runtime/portable-sndfile.json")]]];
  const inventories = inputs.map(([stack, catalog, files]) => Prefix.validateStack(stack, catalog, recipeHash(files)));
  if (fonts.sdk !== audio.sdk || !path.isAbsolute(fonts.sdk || "")) throw new Error("Impacto dependencies require the same macOS SDK.");
  return inventories;
}

function environment(prefix, sdk, prefixes = [prefix]) {
  const env = Fonts.buildEnvironment(prefix, sdk);
  env.PKG_CONFIG_LIBDIR = prefixes.flatMap(value => [path.join(value, "lib/pkgconfig"), path.join(value, "share/pkgconfig")]).join(path.delimiter);
  env.PKG_CONFIG_PATH = "";
  for (const key of Object.keys(env)) if (/^(?:DYLD_|CMAKE_|CMAKE_PREFIX_PATH$|PKG_CONFIG_SYSROOT_DIR$|PKG_CONFIG_ALLOW_SYSTEM_)/.test(key)) delete env[key];
  return env;
}

function cmakeOptions({ prefix, sdk, ninja, prefixes = [prefix], pathMappings = [], options = [] }) {
  if (!Array.isArray(prefixes) || !prefixes.length || prefixes.some(value => !path.isAbsolute(value || "") || /[\r\n\0;]/.test(value))) {
    throw new Error("Impacto dependency prefixes must be explicit absolute paths.");
  }
  return Fonts.cmakeOptions({ prefix, sdk, ninja, pathMappings, options }).map(option =>
    option.startsWith("-DCMAKE_PREFIX_PATH=") ? "-DCMAKE_PREFIX_PATH=" + prefixes.join(";") : option);
}

function compilerFlags(sdk, pathMappings) {
  Fonts.cmakeOptions({ prefix: sdk, sdk, ninja: "/usr/bin/true", pathMappings });
  if ([sdk, ...pathMappings.map(mapping => mapping.from)].some(value => /[\s'"$`\\]/.test(value))) {
    throw new Error("Impacto compiler paths need a temporary directory without spaces or shell metacharacters.");
  }
  return ["-arch", "arm64", "-mmacosx-version-min=13.0", "-isysroot", sdk,
    ...pathMappings.flatMap(mapping => ["file", "debug", "macro"].map(kind => `-f${kind}-prefix-map=${mapping.from}=${mapping.to}`)),
    "-Werror=unguarded-availability-new"].join(" ");
}

function boostHeaders(sourceRoot, prefix, version) {
  const header = fs.readFileSync(path.join(sourceRoot, "boost/version.hpp"), "utf8");
  const [major, minor, patch] = version.split(".").map(Number), encoded = major * 100000 + minor * 100 + patch;
  if (!new RegExp(`^#define BOOST_VERSION ${encoded}$`, "m").test(header)) {
    throw new Error("Boost header version differs from its source archive.");
  }
  const include = path.join(sourceRoot, "boost");
  if (!fs.lstatSync(include).isDirectory() || fs.lstatSync(include).isSymbolicLink()) throw new Error("Boost source archive is missing its headers.");
  const directory = path.join(prefix, "lib/cmake/Boost"); fs.mkdirSync(directory, { recursive: true });
  // Only the header interface used by Impacto is installed. No Boost library is compiled.
  const text = `set(Boost_FOUND TRUE)\nset(Boost_VERSION_STRING "${version}")\nif(NOT TARGET Boost::headers)\n  add_library(Boost::headers INTERFACE IMPORTED)\n  set_target_properties(Boost::headers PROPERTIES INTERFACE_INCLUDE_DIRECTORIES "${sourceRoot}")\nendif()\n`;
  fs.writeFileSync(path.join(directory, "BoostConfig.cmake"), text);
  return { sourceRoot, outputRoot: directory, configureOptions: [], headerVersion: version, headerSha256: Native.hashFile(path.join(sourceRoot, "boost/version.hpp")) };
}

async function buildCmake({ sourceRoot, outputRoot, prefix, sdk, tools, pathMappings, prefixes = [prefix], options, signal, dependencies = {} }) {
  const configureOptions = ["-S", sourceRoot, "-B", outputRoot, ...cmakeOptions({ prefix, sdk, ninja: tools.ninja, prefixes, pathMappings, options })];
  const run = dependencies.runBuildCommand || Source.runBuildCommand, env = environment(prefix, sdk, prefixes), logPath = outputRoot + ".log";
  const startedAt = new Date().toISOString();
  for (const args of [configureOptions, ["--build", outputRoot, "--parallel", "2"], ["--install", outputRoot]]) {
    throwIfAborted(signal);
    await run(tools.cmake, args, { cwd: path.dirname(outputRoot), env, logPath, signal, timeout: 20 * 60 * 1000 });
  }
  return { sourceRoot, outputRoot, configureOptions, startedAt, completedAt: new Date().toISOString(), logPath };
}

async function buildMeson({ sourceRoot, outputRoot, prefix, sdk, tools, pathMappings, options, signal, dependencies = {} }) {
  const env = environment(prefix, sdk), flags = compilerFlags(sdk, pathMappings), logPath = outputRoot + ".log";
  Object.assign(env, { CC: "/usr/bin/clang", CXX: "/usr/bin/clang++", CFLAGS: flags, CXXFLAGS: flags,
    LDFLAGS: `-arch arm64 -mmacosx-version-min=13.0 -isysroot ${sdk} -Wl,-headerpad_max_install_names -Wl,-rpath,${prefix}/lib` });
  const configureOptions = ["setup", outputRoot, sourceRoot, "--prefix=" + prefix, "--libdir=lib", "--buildtype=release",
    "--wrap-mode=nodownload", "--default-library=shared", ...options];
  const run = dependencies.runBuildCommand || Source.runBuildCommand, startedAt = new Date().toISOString();
  await run(tools.meson, configureOptions, { cwd: path.dirname(outputRoot), env, logPath, signal });
  await run(tools.ninja, ["-C", outputRoot, "-j2"], { cwd: path.dirname(outputRoot), env, logPath, signal });
  await run(tools.meson, ["install", "-C", outputRoot, "--no-rebuild"], { cwd: path.dirname(outputRoot), env, logPath, signal });
  return { sourceRoot, outputRoot, configureOptions, compilerOptions: flags, startedAt, completedAt: new Date().toISOString(), logPath };
}

async function buildDependencies({ archives, workRoot, reusedStacks, pathMappings = [], signal, onProgress, dependencies = {} }) {
  throwIfAborted(signal);
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("This Impacto dependency build requires an Apple Silicon Mac.");
  const pins = validateArchives(archives), retained = dependencyStacks(reusedStacks);
  workRoot = Fonts.assertFreshBuildRoot(workRoot, { readOnlyRoots: retained.map(row => row.prefix) });
  const sdk = reusedStacks.fonts.sdk;
  compilerFlags(sdk, pathMappings);
  const tools = Object.fromEntries(["cmake", "ninja", "meson"].map(name => [name, (dependencies.findBuildTool || Source.findBuildTool)(name)]));
  const overlaySha256 = recipeHash(), prefix = path.join(workRoot, "prefix"), sourceDirectory = path.join(workRoot, "source");
  fs.mkdirSync(prefix, { recursive: true }); fs.mkdirSync(sourceDirectory);
  for (const inventory of retained) Prefix.linkPrefix(inventory.prefix, prefix);
  const sources = [], sourceRoots = {}, run = dependencies.runBuildCommand || Source.runBuildCommand;
  for (const pin of pins) {
    throwIfAborted(signal); const sourceRoot = path.join(sourceDirectory, pin.id); fs.mkdirSync(sourceRoot);
    await run("/usr/bin/tar", ["-xf", archives[pin.id], "--strip-components", "1", "-C", sourceRoot],
      { cwd: workRoot, logPath: path.join(workRoot, "extraction.log"), env: environment(prefix, sdk), signal });
    for (const notice of pin.notices) if (!fs.lstatSync(path.join(sourceRoot, notice)).isFile()) throw new Error(`Missing source license for ${pin.name}.`);
    onProgress?.({ phase: "build", project: pin.id });
    const outputRoot = path.join(workRoot, pin.id);
    const build = pin.buildSystem === "headers" ? boostHeaders(sourceRoot, prefix, pin.version)
      : pin.buildSystem === "meson" ? await buildMeson({ sourceRoot, outputRoot, prefix, sdk, tools, pathMappings, options: pin.options, signal, dependencies })
        : await buildCmake({ sourceRoot, outputRoot, prefix, sdk, tools, pathMappings, options: pin.options, signal, dependencies });
    sourceRoots[pin.id] = sourceRoot; sources.push({ ...pin, ...build, sourceRoot });
    fs.writeFileSync(path.join(workRoot, "dependency-progress.json"), JSON.stringify({ sources, sourceRoots }, null, 2));
  }
  for (const inventory of retained) if (Prefix.snapshotPrefix(inventory.prefix).sha256 !== inventory.sha256) throw new Error("A dependency input changed during compilation.");
  if (recipeHash() !== overlaySha256) throw new Error("Impacto dependency recipe changed during compilation.");
  const inventory = Prefix.snapshotPrefix(prefix, { readRoots: retained.map(row => row.prefix) });
  return { version: PIN.version, architecture: "arm64", minimumMacOS: "13.0", recipeSha256: overlaySha256,
    prefix, prefixSha256: inventory.sha256, sdk, tools, sources, sourceRoots, reusedStacks, reusedPrefixes: retained };
}

module.exports = { PIN, RECIPE_FILES, recipeHash, relative, validateArchives, dependencyStacks, environment, cmakeOptions,
  compilerFlags, boostHeaders, buildCmake, buildMeson, buildDependencies };
