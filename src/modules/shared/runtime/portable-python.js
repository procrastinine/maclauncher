const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const Source = require("./pinned-native-build");
const Native = require("./local-native");
const Portable = require("./portable-sdl2-fonts");
const { throwIfAborted } = require("./download-utils");
const PIN = Object.freeze(require("./portable-python.json"));
const MAKEFILE_SOURCE_SHA256 = "ca788d7fd9f3cf1c6aaa16011a07fe8ab07bf889cf0e6c33b42dbcbb9032742f";
const recipeIdentity = () => crypto.createHash("sha256").update(fs.readFileSync(__filename)).update(fs.readFileSync(require.resolve("./portable-python.json"))).digest("hex");

function validateArchive(archive) {
  if (!path.isAbsolute(archive || "") || !fs.lstatSync(archive).isFile() || fs.statSync(archive).size !== PIN.source.archiveBytes || Native.hashFile(archive) !== PIN.source.archiveSha256) {
    throw new Error("The CPython source archive differs from the selected version.");
  }
}

function applySourceAdapter(sourceRoot) {
  const file = path.join(sourceRoot, "Makefile.pre.in");
  if (!path.isAbsolute(sourceRoot || "") || !fs.lstatSync(file).isFile() || !fs.realpathSync(file).startsWith(fs.realpathSync(sourceRoot) + path.sep)) throw new Error("Python adapters require a contained source file.");
  const original=fs.readFileSync(file), hash=bytes=>crypto.createHash("sha256").update(bytes).digest("hex");
  const before="-DVPATH='\"$(VPATH)\"'", after="-DVPATH='\"../source\"'";
  const text=original.toString("utf8");
  if(hash(original)!==MAKEFILE_SOURCE_SHA256||!text.includes(before)||text.indexOf(before)!==text.lastIndexOf(before))throw new Error("Python source differs from the selected path adapter.");
  // Keep make's source search unchanged. Only the runtime's build-location
  // fallback becomes relative to this profile's out-of-tree build directory.
  const adapted=Buffer.from(text.replace(before,after));fs.writeFileSync(file,adapted);
  return {path:"Makefile.pre.in",sourceSha256:MAKEFILE_SOURCE_SHA256,adaptedSourceSha256:hash(adapted)};
}

function compilerEnvironment({ sdk, sourceRoot, workRoot, pathMappings = [] }) {
  // Autoconf expands compiler variables as words; embedded shell quotes are
  // literal arguments. Build in an ordinary temporary directory instead.
  if (![sdk, sourceRoot, workRoot].every(value => path.isAbsolute(value || "") && !/[\s'"$`\\\0]/.test(value))) throw new Error("Python build paths must be absolute and contain no shell metacharacters or spaces.");
  if (!Array.isArray(pathMappings) || pathMappings.some(({ from, to } = {}) => !path.isAbsolute(from || "") || /[\s'"$`\\\0]/.test(from) || !/^[A-Za-z0-9_.-]+$/.test(to || ""))) throw new Error("Python compiler mappings need absolute paths and logical names.");
  const maps = [...pathMappings, { from: sourceRoot, to: "python-source" }, { from: workRoot, to: "python-build" }]
    .flatMap(({ from, to }) => ["file", "debug", "macro"].map(kind => `-f${kind}-prefix-map=${from}=${to}`));
  const flags = ["-arch arm64", "-mmacosx-version-min=13.0", `-isysroot ${sdk}`, ...maps, "-Werror=unguarded-availability-new"].join(" ");
  const env = Portable.buildEnvironment(workRoot, sdk);
  for (const key of Object.keys(env)) if (/^(?:PYTHON|DYLD_)/.test(key)) delete env[key];
  return { ...env, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", CC: "/usr/bin/clang", CXX: "/usr/bin/clang++", AR: "/usr/bin/ar", RANLIB: "/usr/bin/ranlib",
    CFLAGS: flags, CPPFLAGS: flags, LDFLAGS: "-arch arm64 -mmacosx-version-min=13.0 -Wl,-headerpad_max_install_names " + `-isysroot ${sdk}`, CONFIG_SITE: "/dev/null" };
}

function copyTree(source, destination, { exclude = [] } = {}) {
  fs.mkdirSync(destination, { recursive: true });
  for (const name of fs.readdirSync(source).sort()) {
    if (exclude.includes(name) || /\.pyc$/.test(name)) continue;
    const input = path.join(source, name), output = path.join(destination, name), stat = fs.lstatSync(input);
    if (stat.isDirectory()) copyTree(input, output, { exclude });
    else if (stat.isFile()) fs.copyFileSync(input, output);
    else throw new Error("Python runtime resources must be regular files and directories.");
  }
}

function stageRuntime({ sourceRoot, buildRoot, prefix, pathMappings = [] }) {
  const library = path.join(buildRoot, "libpython3.14.dylib");
  if (!fs.lstatSync(library).isFile()) throw new Error("Python shared library was not built.");
  const includeDir = path.join(prefix, "include/python3.14"), stdlib = path.join(prefix, "lib/python3.14"), libDir = path.join(prefix, "lib");
  copyTree(path.join(sourceRoot, "Include"), includeDir);
  fs.copyFileSync(path.join(buildRoot, "pyconfig.h"), path.join(includeDir, "pyconfig.h"));
  copyTree(path.join(sourceRoot, "Lib"), stdlib, { exclude: PIN.excludedStdlib });
  fs.copyFileSync(library, path.join(libDir, path.basename(library)));
  const buildDirectory = path.join(buildRoot, "build");
  const extensionRoots = fs.readdirSync(buildDirectory).filter(name => /^lib\./.test(name) && fs.lstatSync(path.join(buildDirectory, name)).isDirectory());
  if (extensionRoots.length !== 1) throw new Error("Python extension output must have one exact build directory.");
  const extensionRoot = path.join(buildDirectory, extensionRoots[0]), dynload = path.join(stdlib, "lib-dynload");
  fs.mkdirSync(dynload);
  const extensions = [];
  for (const name of fs.readdirSync(extensionRoot).sort()) {
    if (!name.endsWith(".so")) continue;
    const input = path.join(extensionRoot, name), resolved = fs.realpathSync(input), build = fs.realpathSync(buildRoot);
    // CPython's out-of-tree module directory uses links to its own Modules/.
    if (!resolved.startsWith(build + path.sep) || !fs.statSync(resolved).isFile() || PIN.disabledModules.some(module => name.startsWith(module + ".")) || /^_test|^xx/.test(name)) throw new Error("Python built an unselected or escaped native module.");
    fs.copyFileSync(resolved, path.join(dynload, name)); extensions.push(name);
  }
  if (!["_struct", "math", "zlib", "unicodedata", "_codecs_jp"].every(module => extensions.some(name => name.startsWith(module + ".")))) throw new Error("Python is missing required embedded-runtime modules.");
  const sysconfig = fs.readdirSync(extensionRoot).filter(name => /^_sysconfigdata.*\.py$/.test(name));
  if (sysconfig.length !== 1) throw new Error("Python build configuration metadata is missing.");
  let text = fs.readFileSync(path.join(extensionRoot, sysconfig[0]), "utf8");
  const mappings = [...pathMappings, { from: sourceRoot, to: "python-source" }, { from: buildRoot, to: "python-build" }, { from: prefix, to: "/maclauncher/python" }].sort((a,b) => b.from.length-a.from.length);
  for (const mapping of mappings) text = text.replaceAll(mapping.from, mapping.to);
  fs.writeFileSync(path.join(stdlib, sysconfig[0]), text);
  const notices = path.join(prefix, "licenses/python"); fs.mkdirSync(notices, { recursive: true });
  for (const notice of PIN.source.notices) fs.copyFileSync(path.join(sourceRoot, notice), path.join(notices, path.basename(notice)));
  return { prefix, library: path.join(libDir, path.basename(library)), includeDir, stdlib, extensions, notices };
}

async function buildPython({ archive, workRoot, sdk, pathMappings = [], signal, onProgress, dependencies = {} }) {
  throwIfAborted(signal);
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("This embedded Python build requires an Apple Silicon Mac.");
  validateArchive(archive);
  workRoot = Portable.assertFreshBuildRoot(workRoot, { readOnlyRoots: [archive] });
  sdk ||= (dependencies.readSDK || (() => execFileSync("/usr/bin/xcrun", ["--show-sdk-path"], { encoding: "utf8" }).trim()))();
  const recipeSha256 = recipeIdentity(), sourceRoot = path.join(workRoot, "source"), buildRoot = path.join(workRoot, "build"), prefix = path.join(workRoot, "prefix");
  fs.mkdirSync(sourceRoot, { recursive: true }); fs.mkdirSync(buildRoot); fs.mkdirSync(prefix);
  const env = compilerEnvironment({ sdk, sourceRoot, workRoot, pathMappings }), run = dependencies.runBuildCommand || Source.runBuildCommand, logPath = path.join(workRoot, "python.log");
  const options = { cwd: buildRoot, logPath, env, signal, timeout: 20 * 60 * 1000 };
  await run("/usr/bin/tar", ["-xf", archive, "--strip-components", "1", "-C", sourceRoot], options);
  const sourceOverlay=applySourceAdapter(sourceRoot);
  const setup = "*disabled*\n" + PIN.disabledModules.join("\n") + "\n";
  fs.mkdirSync(path.join(buildRoot, "Modules"));
  fs.writeFileSync(path.join(buildRoot, "Modules/Setup.local"), setup, { flag: "wx" });
  onProgress?.({ phase: "configure", project: "python" });
  await run(path.join(sourceRoot, "configure"), PIN.options, options);
  onProgress?.({ phase: "build", project: "python" });
  await run("/usr/bin/make", ["-j2"], options);
  throwIfAborted(signal);
  const staged = stageRuntime({ sourceRoot, buildRoot, prefix, pathMappings });
  if (recipeIdentity() !== recipeSha256) throw new Error("Python build recipe changed during compilation.");
  return { version: PIN.version, architecture: PIN.architecture, minimumMacOS: PIN.minimumMacOS, source: PIN.source,
    recipeSha256, sourceRoot, sourceOverlay, buildRoot, sdk, configureOptions: PIN.options, disabledModules: PIN.disabledModules, setupSha256: crypto.createHash("sha256").update(setup).digest("hex"), ...staged, logPath };
}

module.exports = { PIN, MAKEFILE_SOURCE_SHA256, recipeIdentity, validateArchive, applySourceAdapter, compilerEnvironment, stageRuntime, buildPython };
