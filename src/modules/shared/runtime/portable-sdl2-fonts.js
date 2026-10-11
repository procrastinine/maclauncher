const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const Source = require("./pinned-native-build");
const Native = require("./local-native");
const { throwIfAborted } = require("./download-utils");
const PIN = Object.freeze(require("./portable-sdl2-fonts.json"));

function validateArchives(archives, { catalog = PIN } = {}) {
  if (!catalog || catalog.schemaVersion !== 1 || catalog.architecture !== "arm64" || catalog.minimumMacOS !== "13.0" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(catalog.version || "") || !Array.isArray(catalog.dependencies) ||
      !catalog.dependencies.length || catalog.dependencies.length > 32) throw new Error("Invalid portable dependency catalog.");
  const seen = new Set();
  for (const pin of catalog.dependencies) {
    if (!/^[a-z0-9_]+$/.test(pin.id || "") || seen.has(pin.id) || !/^[a-f0-9]{40}$/.test(pin.revision || "") ||
        !/^[a-f0-9]{64}$/.test(pin.archiveSha256 || "") || !/^https:\/\//.test(pin.archiveUrl || "") ||
        !Number.isSafeInteger(pin.archiveBytes) || pin.archiveBytes <= 0 || pin.archiveBytes > 256 * 1024 * 1024 ||
        !Array.isArray(pin.notices) || !pin.notices.length || pin.notices.some(value => typeof value !== "string" ||
          path.isAbsolute(value) || value.split(/[\\/]/).some(part => ["", ".", ".."].includes(part))) ||
        !Array.isArray(pin.options) || pin.options.some(option => typeof option !== "string" || !/^-D[A-Za-z0-9_]+=/.test(option))) {
      throw new Error("Portable dependencies require unique names, exact source pins and license notices.");
    }
    seen.add(pin.id);
    const file = archives?.[pin.id];
    if (!path.isAbsolute(file || "") || !fs.lstatSync(file).isFile() || fs.statSync(file).size !== pin.archiveBytes ||
        Native.hashFile(file) !== pin.archiveSha256) throw new Error(`Source archive checksum or size differs for ${pin.id} ${pin.version}.`);
  }
  return catalog.dependencies;
}

function buildEnvironment(prefix, sdk) {
  const env = { ...process.env, PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin",
    PKG_CONFIG_PATH: "", PKG_CONFIG_LIBDIR: path.join(prefix, "lib/pkgconfig"), MACOSX_DEPLOYMENT_TARGET: "13.0", SDKROOT: sdk };
  for (const key of ["CPATH", "C_INCLUDE_PATH", "CPLUS_INCLUDE_PATH", "OBJC_INCLUDE_PATH", "LIBRARY_PATH", "CFLAGS", "CXXFLAGS", "LDFLAGS",
    "DYLD_LIBRARY_PATH", "DYLD_FRAMEWORK_PATH", "DYLD_INSERT_LIBRARIES"]) delete env[key];
  return env;
}

function cmakeOptions({ prefix, sdk, ninja, pathMappings = [], options = [] }) {
  for (const value of [prefix, sdk, ninja]) if (!path.isAbsolute(value || "") || value.includes("\0")) throw new Error("Portable build paths must be absolute.");
  if (!Array.isArray(pathMappings) || pathMappings.some(mapping => !path.isAbsolute(mapping?.from || "") ||
      !/^[A-Za-z0-9_.-]+$/.test(mapping?.to || "") || /[\r\n\0;]/.test(mapping.from))) throw new Error("Portable compiler mappings need absolute prefixes and logical names.");
  if (!Array.isArray(options) || options.some(option => typeof option !== "string" || !/^-D[A-Za-z0-9_]+=/.test(option) ||
      /^-D(?:CMAKE_|FETCHCONTENT_)/.test(option))) {
    throw new Error("Module options cannot replace portable compiler, dependency or target settings.");
  }
  const quote = value => /[\s'"$`\\]/.test(value) ? "'" + value.replaceAll("'", "'\\''") + "'" : value;
  const maps = pathMappings.flatMap(mapping => ["file", "debug", "macro"].map(kind => quote(`-f${kind}-prefix-map=${mapping.from}=${mapping.to}`)));
  const flags = [...maps, "-Werror=unguarded-availability-new"].join(" ");
  return ["-G", "Ninja", `-DCMAKE_MAKE_PROGRAM=${ninja}`, "-DCMAKE_BUILD_TYPE=Release", "-DCMAKE_POLICY_VERSION_MINIMUM=3.5",
    "-DCMAKE_OSX_ARCHITECTURES=arm64", "-DCMAKE_OSX_DEPLOYMENT_TARGET=13.0", `-DCMAKE_OSX_SYSROOT=${sdk}`,
    `-DCMAKE_INSTALL_PREFIX=${prefix}`, `-DCMAKE_PREFIX_PATH=${prefix}`, "-DCMAKE_IGNORE_PREFIX_PATH=/opt/homebrew;/usr/local",
    "-DCMAKE_FIND_USE_PACKAGE_REGISTRY=OFF", "-DCMAKE_FIND_USE_SYSTEM_PACKAGE_REGISTRY=OFF", "-DCMAKE_EXPORT_COMPILE_COMMANDS=ON",
    "-DFETCHCONTENT_FULLY_DISCONNECTED=ON", "-DFETCHCONTENT_UPDATES_DISCONNECTED=ON", "-DCMAKE_C_COMPILER=/usr/bin/clang", "-DCMAKE_CXX_COMPILER=/usr/bin/clang++",
    `-DCMAKE_C_FLAGS=${flags}`, `-DCMAKE_CXX_FLAGS=${flags}`, "-DCMAKE_SHARED_LINKER_FLAGS=-Wl,-headerpad_max_install_names", "-DCMAKE_EXE_LINKER_FLAGS=-Wl,-headerpad_max_install_names",
    `-DCMAKE_INSTALL_RPATH=${prefix}/lib`, "-DCMAKE_INSTALL_RPATH_USE_LINK_PATH=OFF", "-DCMAKE_MACOSX_RPATH=ON", "-DBUILD_SHARED_LIBS=ON", "-DBUILD_TESTING=OFF", ...options];
}

function sdkCompressionMetadata(sdk, prefix) {
  const zlibHeader = path.join(sdk, "usr/include/zlib.h"), bzipHeader = path.join(sdk, "usr/include/bzlib.h");
  const zlibVersion = /^#define\s+ZLIB_VERSION\s+"([\d.]+)"/m.exec(fs.readFileSync(zlibHeader, "utf8"))?.[1];
  if (!zlibVersion || !fs.statSync(path.join(sdk, "usr/lib/libz.tbd")).isFile() || !fs.statSync(path.join(sdk, "usr/lib/libbz2.tbd")).isFile()) {
    throw new Error("The macOS SDK is missing its compression headers or link stubs.");
  }
  const directory = path.join(prefix, "lib/pkgconfig"); fs.mkdirSync(directory, { recursive: true });
  // This build-only descriptor links macOS's zlib; no system library is copied.
  fs.writeFileSync(path.join(directory, "zlib.pc"), `Name: zlib\nDescription: macOS system zlib\nVersion: ${zlibVersion}\nLibs: -lz\nCflags:\n`);
  return { zlib: { headerVersion: zlibVersion, headerSha256: Native.hashFile(zlibHeader), library: "/usr/lib/libz.1.dylib" },
    bzip2: { headerSha256: Native.hashFile(bzipHeader), library: "/usr/lib/libbz2.1.0.dylib" } };
}

async function buildProject({ sourceRoot, outputRoot, prefix, sdk, tools, pathMappings, options, signal, onProgress, dependencies = {} }) {
  throwIfAborted(signal);
  const args = ["-S", sourceRoot, "-B", outputRoot, ...cmakeOptions({ prefix, sdk, ninja: tools.ninja, pathMappings, options })];
  const logPath = outputRoot + ".log", env = buildEnvironment(prefix, sdk);
  const run = dependencies.runBuildCommand || Source.runBuildCommand;
  const startedAt = new Date().toISOString(); onProgress?.({ phase: "configure", project: path.basename(outputRoot) });
  for (const commandArgs of [args, ["--build", outputRoot, "--parallel", "2"], ["--install", outputRoot]]) {
    throwIfAborted(signal);
    await run(tools.cmake, commandArgs, { cwd: path.dirname(outputRoot), logPath, env, signal, timeout: 20 * 60 * 1000 });
  }
  return { sourceRoot, outputRoot, configureOptions: args, startedAt, completedAt: new Date().toISOString(), logPath };
}

function assertFreshBuildRoot(workRoot, { readOnlyRoots = [] } = {}) {
  if (!path.isAbsolute(workRoot || "") || /[\r\n\0;]/.test(workRoot) || fs.existsSync(workRoot)) throw new Error("Portable dependencies require a new absolute build directory.");
  let ancestor = path.dirname(workRoot);
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const resolved = path.resolve(fs.realpathSync(ancestor), path.relative(ancestor, workRoot));
  const external = path.resolve(__dirname, "../../../external");
  for (const source of [external, ...readOnlyRoots]) {
    if (!fs.existsSync(source)) continue;
    const original = fs.realpathSync(source);
    if (resolved === original || resolved.startsWith(original + path.sep) || original.startsWith(resolved + path.sep)) {
      throw new Error("Portable build outputs must be separate from read-only source directories.");
    }
  }
  return resolved;
}

async function buildDependencies({ archives, workRoot, pathMappings = [], signal, onProgress, dependencies = {} }) {
  throwIfAborted(signal);
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("This portable dependency build requires an Apple Silicon Mac.");
  const pins = validateArchives(archives);
  workRoot = assertFreshBuildRoot(workRoot);
  const sdk = (dependencies.readSDK || (() => execFileSync("/usr/bin/xcrun", ["--show-sdk-path"], { encoding: "utf8" }).trim()))();
  const tools = { cmake: (dependencies.findBuildTool || Source.findBuildTool)("cmake"), ninja: (dependencies.findBuildTool || Source.findBuildTool)("ninja") };
  fs.mkdirSync(workRoot, { recursive: true });
  const prefix = path.join(workRoot, "prefix"), sourceDirectory = path.join(workRoot, "source");
  fs.mkdirSync(prefix); fs.mkdirSync(sourceDirectory);
  const sdkPackages = sdkCompressionMetadata(sdk, prefix), sources = [], sourceRoots = {};
  const zlib = [`-DZLIB_LIBRARY=${sdk}/usr/lib/libz.tbd`, `-DZLIB_INCLUDE_DIR=${sdk}/usr/include`];
  for (const pin of pins) {
    throwIfAborted(signal);
    const sourceRoot = path.join(sourceDirectory, pin.id); fs.mkdirSync(sourceRoot);
    // Extraction accepts only the exact finite source archives above. Build
    // outputs and CMake-generated files never touch an upstream Git checkout.
    await (dependencies.runBuildCommand || Source.runBuildCommand)("/usr/bin/tar", ["-xzf", archives[pin.id], "--strip-components", "1", "-C", sourceRoot],
      { cwd: workRoot, logPath: path.join(workRoot, "extraction.log"), env: buildEnvironment(prefix, sdk), signal });
    for (const notice of pin.notices) if (!fs.lstatSync(path.join(sourceRoot, notice)).isFile()) throw new Error(`Missing source license for ${pin.name}.`);
    const options = [...pin.options, ...(["libpng", "freetype"].includes(pin.id) ? zlib : []),
      ...(pin.id === "freetype" ? [`-DBZIP2_LIBRARY_RELEASE=${sdk}/usr/lib/libbz2.tbd`, `-DBZIP2_INCLUDE_DIR=${sdk}/usr/include`] : [])];
    const build = await buildProject({ sourceRoot, outputRoot: path.join(workRoot, pin.id), prefix, sdk, tools, pathMappings, options, signal, onProgress, dependencies });
    sourceRoots[pin.id] = sourceRoot; sources.push({ ...pin, ...build });
  }
  const recipeSha256 = crypto.createHash("sha256").update(fs.readFileSync(__filename)).update(fs.readFileSync(path.join(__dirname, "portable-sdl2-fonts.json"))).digest("hex");
  return { version: PIN.version, architecture: PIN.architecture, minimumMacOS: PIN.minimumMacOS, recipeSha256, prefix, sdk, tools, sdkPackages, sources, sourceRoots };
}

module.exports = { PIN, validateArchives, buildEnvironment, cmakeOptions, sdkCompressionMetadata, buildProject, assertFreshBuildRoot, buildDependencies };
