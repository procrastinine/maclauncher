const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const Source = require("./pinned-native-build");
const Native = require("./local-native");
const Portable = require("./portable-sdl2-fonts");
const { throwIfAborted } = require("./download-utils");
const PIN = Object.freeze(require("./portable-sndfile.json"));

function relative(value) {
  return typeof value === "string" && value.length > 0 && !path.isAbsolute(value) &&
    !value.split(/[\\/]/).some(part => ["", ".", ".."].includes(part)) && !/[\r\n\0]/.test(value);
}

function validateArchives(archives, { catalog = PIN } = {}) {
  if (catalog?.schemaVersion !== 1 || catalog.architecture !== "arm64" || catalog.minimumMacOS !== "13.0" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(catalog.version || "") || !Array.isArray(catalog.dependencies) ||
      !catalog.dependencies.length || catalog.dependencies.length > 32) throw new Error("Invalid portable audio source catalog.");
  const seen = new Set();
  for (const pin of catalog.dependencies) {
    if (!/^[a-z0-9_]+$/.test(pin.id || "") || seen.has(pin.id) ||
        !(pin.revision ? /^[a-f0-9]{40}$/.test(pin.revision) : /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(pin.sourceRelease || "")) ||
        !/^[a-f0-9]{64}$/.test(pin.archiveSha256 || "") || !/^https:\/\//.test(pin.archiveUrl || "") ||
        !Number.isSafeInteger(pin.archiveBytes) || pin.archiveBytes <= 0 || pin.archiveBytes > 64 * 1024 * 1024 ||
        !Array.isArray(pin.notices) || !pin.notices.length || pin.notices.some(value => !relative(value)) ||
        (pin.sourceSubdirectory && !relative(pin.sourceSubdirectory)) || !["cmake", "autotools"].includes(pin.buildSystem) ||
        !Array.isArray(pin.options) || pin.options.some(option => typeof option !== "string" || /[\r\n\0]/.test(option) ||
          (pin.buildSystem === "cmake" ? !/^-D[A-Za-z0-9_]+=/.test(option) || /^-D(?:CMAKE_|FETCHCONTENT_)/.test(option) :
            !/^--(?:enable|disable|with|without)-[a-z0-9-]+(?:=[A-Za-z0-9._-]+)?$/.test(option)))) {
      throw new Error("Portable audio sources require exact archive pins, build options and license notices.");
    }
    seen.add(pin.id);
    const file = archives?.[pin.id];
    if (!path.isAbsolute(file || "") || !fs.lstatSync(file).isFile() || fs.statSync(file).size !== pin.archiveBytes ||
        Native.hashFile(file) !== pin.archiveSha256) throw new Error(`Source archive checksum or size differs for ${pin.name} ${pin.version}.`);
  }
  return catalog.dependencies;
}

function compilerFlags(sdk, pathMappings = []) {
  // Use the shared validator, so both build systems reject ambiguous paths and
  // retain identical deployment and source-path mapping rules.
  Portable.cmakeOptions({ prefix: sdk, sdk, ninja: "/usr/bin/true", pathMappings });
  // Autoconf expands these environment variables as compiler words, so quotes
  // inside CFLAGS are literal bytes. Use an ordinary temporary build path.
  if ([sdk, ...pathMappings.map(mapping => mapping.from)].some(value => /[\s'"$`\\]/.test(value))) {
    throw new Error("Portable audio compiler paths require a temporary directory without spaces or shell metacharacters.");
  }
  return ["-O2", "-arch", "arm64", "-mmacosx-version-min=13.0", "-isysroot", sdk,
    ...pathMappings.flatMap(mapping => ["file", "debug", "macro"].map(kind => `-f${kind}-prefix-map=${mapping.from}=${mapping.to}`)),
    "-Werror=unguarded-availability-new"].join(" ");
}

async function buildAutotools({ sourceRoot, outputRoot, prefix, sdk, pathMappings, options, signal, dependencies = {} }) {
  if ([sourceRoot, outputRoot, prefix].some(value => !path.isAbsolute(value || "") || /[\s'"$`\\]/.test(value))) {
    throw new Error("Portable audio configure paths require a temporary directory without spaces or shell metacharacters.");
  }
  const flags = compilerFlags(sdk, pathMappings), env = Portable.buildEnvironment(prefix, sdk);
  Object.assign(env, { CC: "/usr/bin/clang", CXX: "/usr/bin/clang++", CFLAGS: flags, CXXFLAGS: flags,
    LDFLAGS: `-arch arm64 -mmacosx-version-min=13.0 -isysroot ${sdk} -Wl,-headerpad_max_install_names -Wl,-rpath,${prefix}/lib` });
  const configureOptions = [`--prefix=${prefix}`, ...options], logPath = outputRoot + ".log";
  fs.mkdirSync(outputRoot); const startedAt = new Date().toISOString();
  const run = dependencies.runBuildCommand || Source.runBuildCommand;
  await run(path.join(sourceRoot, "configure"), configureOptions, { cwd: outputRoot, env, logPath, signal });
  await run("/usr/bin/make", ["-j2"], { cwd: outputRoot, env, logPath, signal });
  await run("/usr/bin/make", ["install"], { cwd: outputRoot, env, logPath, signal });
  return { sourceRoot, outputRoot, configureOptions, compilerOptions: flags, linkerOptions: env.LDFLAGS,
    startedAt, completedAt: new Date().toISOString(), logPath };
}

async function buildDependencies({ archives, workRoot, pathMappings = [], signal, onProgress, dependencies = {} }) {
  throwIfAborted(signal);
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("This portable audio build requires an Apple Silicon Mac.");
  const pins = validateArchives(archives);
  workRoot = Portable.assertFreshBuildRoot(workRoot);
  const sdk = (dependencies.readSDK || (() => execFileSync("/usr/bin/xcrun", ["--show-sdk-path"], { encoding: "utf8" }).trim()))();
  compilerFlags(sdk, pathMappings);
  const tools = { cmake: (dependencies.findBuildTool || Source.findBuildTool)("cmake"), ninja: (dependencies.findBuildTool || Source.findBuildTool)("ninja") };
  fs.mkdirSync(workRoot, { recursive: true });
  const prefix = path.join(workRoot, "prefix"), sourceDirectory = path.join(workRoot, "source");
  fs.mkdirSync(prefix); fs.mkdirSync(sourceDirectory);
  const sources = [], sourceRoots = {}, run = dependencies.runBuildCommand || Source.runBuildCommand;
  for (const pin of pins) {
    throwIfAborted(signal); const sourceRoot = path.join(sourceDirectory, pin.id); fs.mkdirSync(sourceRoot);
    await run("/usr/bin/tar", ["-xf", archives[pin.id], "--strip-components", "1", "-C", sourceRoot],
      { cwd: workRoot, logPath: path.join(workRoot, "extraction.log"), env: Portable.buildEnvironment(prefix, sdk), signal });
    for (const notice of pin.notices) if (!fs.lstatSync(path.join(sourceRoot, notice)).isFile()) throw new Error(`Missing source license for ${pin.name}.`);
    onProgress?.({ phase: "build", project: pin.id });
    const build = await (pin.buildSystem === "autotools" ? buildAutotools({ sourceRoot, outputRoot: path.join(workRoot, pin.id),
      prefix, sdk, pathMappings, options: pin.options, signal, dependencies }) : Portable.buildProject({
      sourceRoot: path.join(sourceRoot, pin.sourceSubdirectory || ""), outputRoot: path.join(workRoot, pin.id), prefix, sdk, tools,
      pathMappings, options: pin.options, signal, onProgress, dependencies }));
    sourceRoots[pin.id] = sourceRoot; sources.push({ ...pin, ...build, sourceRoot });
  }
  // libsndfile can silently turn codecs off when a dependency is absent. The
  // selected profile requires all listed codecs rather than accepting that.
  const config = fs.readFileSync(path.join(workRoot, "sndfile/src/config.h"), "utf8");
  for (const symbol of ["HAVE_EXTERNAL_XIPH_LIBS", "HAVE_MPEG"]) if (!new RegExp(`^#define ${symbol} 1$`, "m").test(config)) {
    throw new Error(`Portable libsndfile did not enable ${symbol}.`);
  }
  return { version: PIN.version, architecture: PIN.architecture, minimumMacOS: PIN.minimumMacOS, audioFormats: PIN.audioFormats,
    recipeSha256: crypto.createHash("sha256").update(fs.readFileSync(__filename)).update(fs.readFileSync(require.resolve("./portable-sndfile.json"))).digest("hex"),
    prefix, sdk, tools, sources, sourceRoots };
}

module.exports = { PIN, validateArchives, compilerFlags, buildAutotools, buildDependencies };
