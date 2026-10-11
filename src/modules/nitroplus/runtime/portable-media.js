const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const Source = require("../../shared/runtime/pinned-native-build");
const Native = require("../../shared/runtime/local-native");
const Portable = require("../../shared/runtime/portable-sdl2-fonts");
const { throwIfAborted } = require("../../shared/runtime/download-utils");
const PIN = Object.freeze(require("./portable-media.json"));

function safeRelative(value) {
  return typeof value === "string" && value.length > 0 && !path.isAbsolute(value) &&
    !/[\\\r\n\0]/.test(value) && !value.split("/").some(part => ["", ".", ".."].includes(part));
}

function validateSDKPrefix(prefix, { catalog = PIN } = {}) {
  if (!path.isAbsolute(prefix || "") || !fs.lstatSync(prefix).isDirectory() || fs.lstatSync(prefix).isSymbolicLink() ||
      catalog?.schemaVersion !== 1 || catalog.version !== PIN.version || !Array.isArray(catalog.requiredFiles) ||
      !catalog.requiredFiles.length || catalog.requiredFiles.length > 4096 || !Array.isArray(catalog.aliases) || catalog.aliases.length > 256) {
    throw new Error("The Nitroplus media SDK needs its exact versioned file catalog.");
  }
  const expected = new Map();
  for (const row of [...catalog.requiredFiles, ...catalog.aliases]) {
    if (!safeRelative(row.file) || expected.has(row.file) || (row.target ? !safeRelative(row.target) :
      !/^[a-f0-9]{64}$/.test(row.sha256 || "") || !Number.isSafeInteger(row.bytes) || row.bytes < 0 || row.bytes > 256 * 1024 * 1024)) {
      throw new Error("Nitroplus media SDK file metadata is invalid.");
    }
    expected.set(row.file, row);
  }
  const pending = [prefix], observed = new Set();
  while (pending.length) {
    const directory = pending.pop();
    for (const name of fs.readdirSync(directory)) {
      const file = path.join(directory, name), stat = fs.lstatSync(file), relative = path.relative(prefix, file).split(path.sep).join("/");
      if (stat.isDirectory() && !stat.isSymbolicLink()) { pending.push(file); continue; }
      const pin = expected.get(relative);
      if (!pin || observed.has(relative)) throw new Error("Nitroplus media SDK contains an unlisted file.");
      observed.add(relative);
      if (pin.target) {
        if (!stat.isSymbolicLink() || fs.readlinkSync(file) !== pin.target) throw new Error("Nitroplus media SDK library alias changed.");
        const target = fs.realpathSync(file), base = fs.realpathSync(prefix);
        if (!target.startsWith(base + path.sep) || !fs.statSync(target).isFile()) throw new Error("Nitroplus media SDK alias escapes its prefix.");
      } else if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== pin.bytes || Native.hashFile(file) !== pin.sha256) {
        throw new Error(`Nitroplus media SDK checksum changed: ${relative}.`);
      }
    }
  }
  if (observed.size !== expected.size) throw new Error("Nitroplus media SDK files are missing.");
  return { version: PIN.version, prefix, recipeSha256: recipeIdentity(), architecture: PIN.architecture, minimumMacOS: PIN.minimumMacOS };
}

function recipeIdentity() {
  return crypto.createHash("sha256").update(fs.readFileSync(__filename)).update(fs.readFileSync(require.resolve("./portable-media.json"))).digest("hex");
}

function buildEnvironment(prefix, sdk) {
  const env = Portable.buildEnvironment(prefix, sdk);
  for (const key of Object.keys(env)) if (key.startsWith("DYLD_") || key.startsWith("GST_")) delete env[key];
  return env;
}

async function unpackSDK({ archive, workRoot, signal, dependencies = {} }) {
  throwIfAborted(signal);
  if (!path.isAbsolute(archive || "") || !fs.lstatSync(archive).isFile() || fs.lstatSync(archive).isSymbolicLink() ||
      fs.statSync(archive).size !== PIN.sdkArchive.bytes || Native.hashFile(archive) !== PIN.sdkArchive.sha256) {
    throw new Error("Nitroplus media SDK archive checksum changed.");
  }
  workRoot = Portable.assertFreshBuildRoot(workRoot, { readOnlyRoots: [path.dirname(archive)] });
  fs.mkdirSync(workRoot, { recursive: true });
  const sdk = execFileSync("/usr/bin/xcrun", ["--show-sdk-path"], { encoding: "utf8" }).trim();
  await (dependencies.runBuildCommand || Source.runBuildCommand)("/usr/bin/tar", ["-xf", archive, "-C", workRoot],
    { cwd: workRoot, env: buildEnvironment(workRoot, sdk), logPath: path.join(path.dirname(workRoot), "media-sdk-extraction.log"), signal });
  return validateSDKPrefix(workRoot);
}

async function buildUtilities({ archives, workRoot, signal, onProgress, dependencies = {} }) {
  throwIfAborted(signal);
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("This Nitroplus dependency profile builds on Apple Silicon Macs.");
  for (const pin of PIN.utilitySources) {
    const file = archives?.[pin.id];
    if (!path.isAbsolute(file || "") || !fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink() ||
        fs.statSync(file).size !== pin.archiveBytes || Native.hashFile(file) !== pin.archiveSha256) throw new Error(`Nitroplus ${pin.id} source archive checksum changed.`);
  }
  workRoot = Portable.assertFreshBuildRoot(workRoot, { readOnlyRoots: Object.values(archives || {}).map(file => path.dirname(file)) });
  if (/[\s'"$`\\]/.test(workRoot)) throw new Error("Nitroplus dependency builds require a path without spaces or shell metacharacters.");
  fs.mkdirSync(workRoot, { recursive: true });
  const prefix = path.join(workRoot, "prefix"); fs.mkdirSync(prefix);
  const sdk = (dependencies.readSDK || (() => execFileSync("/usr/bin/xcrun", ["--show-sdk-path"], { encoding: "utf8" }).trim()))();
  const tool = dependencies.findBuildTool || Source.findBuildTool, tools = { cmake: tool("cmake"), ninja: tool("ninja") };
  const env = buildEnvironment(prefix, sdk), run = dependencies.runBuildCommand || Source.runBuildCommand;
  const builds = [], pathMappings = [{ from: workRoot, to: "NPENGINE_UTILITY_BUILD_ROOT" }];
  for (const pin of PIN.utilitySources) {
    throwIfAborted(signal);
    const sourceRoot = path.join(workRoot, "source-" + pin.id); fs.mkdirSync(sourceRoot);
    await run("/usr/bin/tar", ["-xf", archives[pin.id], "--strip-components", "1", "-C", sourceRoot], { cwd: workRoot, env, logPath: path.join(workRoot, "extract.log"), signal });
    if (!fs.lstatSync(path.join(sourceRoot, pin.notice)).isFile()) throw new Error(`Nitroplus ${pin.id} source license is missing.`);
    onProgress?.({ phase: "build", project: pin.id }); let build;
    if (pin.id === "boost") {
      const flags = `-O2 -arch arm64 -mmacosx-version-min=13.0 -isysroot ${sdk} -ffile-prefix-map=${workRoot}=NPENGINE_UTILITY_BUILD_ROOT -fdebug-prefix-map=${workRoot}=NPENGINE_UTILITY_BUILD_ROOT -fmacro-prefix-map=${workRoot}=NPENGINE_UTILITY_BUILD_ROOT -Werror=unguarded-availability-new`;
      const linkFlags = `-arch arm64 -mmacosx-version-min=13.0 -isysroot ${sdk} -Wl,-headerpad_max_install_names -Wl,-rpath,${prefix}/lib`;
      const config = path.join(workRoot, "boost-user-config.jam"), logPath = path.join(workRoot, "boost.log");
      fs.writeFileSync(config, `using clang : mac13 : /usr/bin/clang++ : <cxxflags>"${flags}" <linkflags>"${linkFlags}" ;\n`);
      const bootstrap = ["--with-toolset=clang", "--with-libraries=locale", "--without-icu", `--prefix=${prefix}`];
      await run(path.join(sourceRoot, "bootstrap.sh"), bootstrap, { cwd: sourceRoot, env, logPath, signal });
      const options = [`--user-config=${config}`, "toolset=clang-mac13", "target-os=darwin", "architecture=arm", "address-model=64", "variant=release", "link=shared", "threading=multi", "runtime-link=shared", "boost.locale.icu=off", "boost.locale.iconv=on", "boost.locale.posix=on", "boost.locale.std=on", `--prefix=${prefix}`, "--with-locale", "-j2", "install"];
      await run(path.join(sourceRoot, "b2"), options, { cwd: sourceRoot, env, logPath, signal, timeout: 20 * 60 * 1000 });
      build = { configureOptions: bootstrap, buildOptions: options, compilerOptions: flags, linkerOptions: linkFlags, logPath };
    } else {
      const options = ["-DBUILD_UTILS=OFF", "-DBUILD_FRAMEWORK=OFF", "-DGLEW_X11=OFF", "-DGLEW_EGL=OFF", "-DGLEW_OSMESA=OFF", "-DGLEW_REGAL=OFF"];
      build = await Portable.buildProject({ sourceRoot: path.join(sourceRoot, "build/cmake"), outputRoot: path.join(workRoot, pin.id), prefix, sdk, tools, pathMappings, options, signal,
        dependencies: { ...dependencies, runBuildCommand: (command, args, options) => run(command, args, { ...options, env }) } });
    }
    builds.push({ ...pin, sourceRoot, ...build });
  }
  return { version: "boost-glew-macos13-v1", architecture: "arm64", minimumMacOS: "13.0", recipeSha256: recipeIdentity(), prefix, sdk, tools, sources: builds };
}

module.exports = { PIN, safeRelative, recipeIdentity, validateSDKPrefix, buildEnvironment, unpackSDK, buildUtilities };
