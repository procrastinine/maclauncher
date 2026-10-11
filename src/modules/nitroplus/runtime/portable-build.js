const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const Source = require("../../shared/runtime/pinned-native-build");
const Native = require("../../shared/runtime/local-native");
const Portable = require("../../shared/runtime/portable-sdl2-fonts");
const Media = require("./portable-media");
const Previous = require("./build");
const { throwIfAborted } = require("../../shared/runtime/download-utils");

const VERSION = "0.5.3-macos-v8";
const PROFILE_REVISION = "macos-npa-nss-private-v8";
const REVISION = Previous.REVISION;
const NPA_REVISION = Previous.NPA_REVISION;
const ENGINE_TREE_SHA256 = "bea6a70135300539c8036d52888546712ce1c99a33f9812cc037dc9ec53a2833";
const NPA_TREE_SHA256 = "1db16289f3c1061207f69dc09cd20657963348d957061d48146c7eaafe8514df";
const COMBINED_TREE_SHA256 = "ec50f32f364301818ff1cf986049a3d84dde52ab162ac4162e16b2319275845b";
const OWNED_FILES = [__filename, require.resolve("./portable-media"), require.resolve("./portable-media.json"), require.resolve("./build"),
  ...["CMakeLists.txt", "main.cpp", "private-files.cpp", "text-markup.cpp", "text-markup.hpp", "fontconfig.conf", "choice-state.hpp"].map(file => path.join(__dirname, "native", file)),
  require.resolve("./choice-overlay"), require.resolve("../../shared/runtime/portable-sdl2-fonts"), require.resolve("../../shared/runtime/portable-sdl2-fonts.json")];

function overlayIdentity() {
  const hash = crypto.createHash("sha256");
  for (const file of OWNED_FILES) hash.update(path.relative(path.resolve(__dirname, "../../../.."), file) + "\0").update(fs.readFileSync(file));
  return hash.digest("hex");
}

function inventory(root) {
  const files = new Map(), pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    for (const name of fs.readdirSync(directory)) {
      const file = path.join(directory, name), stat = fs.lstatSync(file);
      if (stat.isSymbolicLink() || name === ".git") throw new Error("Nitroplus source export must contain ordinary source files.");
      if (stat.isDirectory()) pending.push(file);
      else if (stat.isFile()) files.set(path.relative(root, file).split(path.sep).join("/"), Native.hashFile(file));
      else throw new Error("Nitroplus source export contains a special file.");
      if (files.size + pending.length > 4096) throw new Error("Nitroplus source export exceeds its file limit.");
    }
  }
  return files;
}

function replace(root, relative, before, after) {
  const file = path.join(root, relative), text = fs.readFileSync(file, "utf8");
  if (!text.includes(before) || text.indexOf(before) !== text.lastIndexOf(before)) throw new Error(`Nitroplus source adapter differs in ${relative}.`);
  fs.writeFileSync(file, text.replace(before, () => after));
}

function adaptSource(root) {
  if (!path.isAbsolute(root || "") || !fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink() ||
      fs.realpathSync(root).split(path.sep).includes("external")) throw new Error("Nitroplus source adapters require a separate source export.");
  const before = inventory(root);
  for (const output of ["CMakeLists.txt", "main.cpp", "private-files.cpp", "text-markup.cpp", "text-markup.hpp", "libnpengine/include/choice-state.hpp"]) {
    if (before.has(output)) throw new Error("Nitroplus source export already contains its Mac adapter.");
  }
  Previous.adaptSource(root);
  replace(root, "main.cpp", "Encrypted NPA payload has no reviewed native profile", "Encrypted NPA payloads are unsupported by this runtime");
  replace(root, "main.cpp", "NSS scripts with libnpengine 0.5.3 Mac v7", "NSS scripts with libnpengine 0.5.3 Mac v8");
  replace(root, "main.cpp", "libnpengine 0.5.3 Mac v7 / da1a175e6b497c37f9714b77510cb47c0930cd42", "libnpengine 0.5.3 Mac v8 / da1a175e6b497c37f9714b77510cb47c0930cd42");
  replace(root, "CMakeLists.txt", 'set(CMAKE_INSTALL_RPATH "@loader_path/../lib")', 'set(CMAKE_INSTALL_RPATH "${MACLAUNCHER_NATIVE_RPATHS}")');
  replace(root, "CMakeLists.txt", "find_path(BOOST_INCLUDE_DIR boost/locale.hpp HINTS /opt/homebrew/include /usr/local/include REQUIRED)", 'if(NOT IS_DIRECTORY "${BOOST_INCLUDE_DIR}" OR NOT EXISTS "${BOOST_INCLUDE_DIR}/boost/locale.hpp")\n  message(FATAL_ERROR "Pass the pinned Boost include directory")\nendif()');
  replace(root, "CMakeLists.txt", "find_library(BOOST_LOCALE_LIBRARY boost_locale HINTS /opt/homebrew/lib /usr/local/lib REQUIRED)", 'if(NOT EXISTS "${BOOST_LOCALE_LIBRARY}")\n  message(FATAL_ERROR "Pass the pinned Boost locale library")\nendif()');
  const after = inventory(root);
  const files = [...after].filter(([file, sha256]) => before.get(file) !== sha256)
    .map(([file, sha256]) => ({ file, originalSha256: before.get(file) || null, sha256 }));
  return { profileRevision: PROFILE_REVISION, files };
}

function requirePrefix(prefix) {
  if (!path.isAbsolute(prefix || "") || !fs.lstatSync(prefix).isDirectory() || fs.lstatSync(prefix).isSymbolicLink() ||
      /[\r\n\0;]/.test(prefix)) throw new Error("Nitroplus dependencies require ordinary absolute prefixes.");
  return prefix;
}

async function buildPortableNPengine({ sourceDir = Previous.sourcePath, npaSourceDir = Previous.npaSourcePath,
  workRoot, mediaStack, utilityStack, sdlStack, signal, onProgress, dependencies = {} }) {
  throwIfAborted(signal);
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("This Nitroplus source profile builds on Apple Silicon Macs.");
  const media = Media.validateSDKPrefix(requirePrefix(mediaStack?.prefix));
  if (utilityStack?.version !== "boost-glew-macos13-v1" || utilityStack.architecture !== "arm64" || utilityStack.minimumMacOS !== "13.0" ||
      utilityStack.recipeSha256 !== Media.recipeIdentity()) throw new Error("Nitroplus needs the matching portable Boost and GLEW build.");
  const utilityPrefix = requirePrefix(utilityStack.prefix), sdlPrefix = requirePrefix(sdlStack?.prefix);
  if (sdlStack?.version !== Portable.PIN.version) throw new Error("Nitroplus needs the pinned classic SDL2 source build.");
  workRoot = Portable.assertFreshBuildRoot(workRoot, { readOnlyRoots: [sourceDir, npaSourceDir, media.prefix, utilityPrefix, sdlPrefix] });
  const [engine, npa] = await Promise.all([Source.validatePinnedSource(sourceDir, REVISION, { signal }), Source.validatePinnedSource(npaSourceDir, NPA_REVISION, { signal })]);
  if (Source.hashPinnedFiles(sourceDir, engine.files) !== ENGINE_TREE_SHA256 || Source.hashPinnedFiles(npaSourceDir, npa.files) !== NPA_TREE_SHA256) {
    throw new Error("Nitroplus engine or archive-library source checksum changed.");
  }
  const overlaySha256 = overlayIdentity(); fs.mkdirSync(workRoot, { recursive: true });
  const sourceRoot = path.join(workRoot, "source"), outputRoot = path.join(workRoot, "build"), prefix = path.join(workRoot, "prefix");
  Source.stagePinnedFiles(sourceDir, engine.files, path.join(sourceRoot, "libnpengine"));
  Source.stagePinnedFiles(npaSourceDir, npa.files, path.join(sourceRoot, "libnpa"));
  const sourceOverlay = adaptSource(sourceRoot), sdk = utilityStack.sdk;
  const tool = dependencies.findBuildTool || Source.findBuildTool, tools = { cmake: tool("cmake"), ninja: tool("ninja"), pkg: tool("pkg-config"),
    flex: ["/opt/homebrew/opt/flex/bin/flex", "/usr/local/opt/flex/bin/flex"].find(file => fs.existsSync(file)) || tool("flex"),
    bison: ["/opt/homebrew/opt/bison/bin/bison", "/usr/local/opt/bison/bin/bison"].find(file => fs.existsSync(file)) || tool("bison") };
  const env = Media.buildEnvironment(prefix, sdk);
  env.PKG_CONFIG_LIBDIR = [media.prefix, utilityPrefix, sdlPrefix].map(value => path.join(value, "lib/pkgconfig")).join(path.delimiter);
  const packageVersion = (name) => execFileSync(tools.pkg, ["--modversion", name], { env, encoding: "utf8", timeout: 10000 }).trim();
  const versions = Object.fromEntries(["sdl2", "glew", "pangocairo", "glib-2.0", "gstreamer-1.0"].map(name => [name, packageVersion(name)]));
  if (versions.sdl2 !== "2.32.10" || versions.glew !== "2.3.1" || versions.pangocairo !== "1.56.2" || versions["glib-2.0"] !== "2.82.4" || versions["gstreamer-1.0"] !== "1.28.7") {
    throw new Error("Nitroplus portable dependency versions changed.");
  }
  const prefixes = [prefix, media.prefix, utilityPrefix, sdlPrefix];
  const maps = [{ from: workRoot, to: "NPENGINE_BUILD_ROOT" }, { from: media.prefix, to: "NPENGINE_MEDIA_SDK_ROOT" },
    { from: utilityPrefix, to: "NPENGINE_UTILITY_PREFIX" }, { from: sdlPrefix, to: "NPENGINE_SDL_PREFIX" }];
  const options = Portable.cmakeOptions({ prefix, sdk, ninja: tools.ninja, pathMappings: maps });
  options.push(`-DCMAKE_PREFIX_PATH=${prefixes.join(";")}`, "-DCMAKE_FIND_USE_CMAKE_ENVIRONMENT_PATH=OFF",
    `-DPKG_CONFIG_EXECUTABLE=${tools.pkg}`, `-DFLEX_EXECUTABLE=${tools.flex}`, `-DBISON_EXECUTABLE=${tools.bison}`,
    `-DBOOST_INCLUDE_DIR=${utilityPrefix}/include`, `-DBOOST_LOCALE_LIBRARY=${utilityPrefix}/lib/libboost_locale.dylib`,
    `-DZLIB_INCLUDE_DIR=${sdk}/usr/include`, `-DZLIB_LIBRARY=${sdk}/usr/lib/libz.tbd`,
    `-DJPEG_INCLUDE_DIR=${media.prefix}/include`, `-DJPEG_LIBRARY=${media.prefix}/lib/libjpeg.8.3.2.dylib`,
    `-DPNG_PNG_INCLUDE_DIR=${media.prefix}/include/libpng16`, `-DPNG_LIBRARY=${media.prefix}/lib/libpng16.16.56.0.dylib`,
    `-DMACLAUNCHER_NATIVE_RPATHS=${prefixes.map(value => value + "/lib").join(";")}`);
  const logPath = path.join(workRoot, "build.log"), run = dependencies.runBuildCommand || Source.runBuildCommand;
  fs.writeFileSync(logPath, `libnpengine ${VERSION}\nEngine ${REVISION}\nlibnpa ${NPA_REVISION}\nOverlay ${overlaySha256}\n`);
  onProgress?.({ phase: "build", project: "npengine" });
  for (const args of [["-S", sourceRoot, "-B", outputRoot, ...options], ["--build", outputRoot, "--parallel", "2"], ["--install", outputRoot]]) {
    throwIfAborted(signal); await run(tools.cmake, args, { cwd: workRoot, env, logPath, signal, timeout: 20 * 60 * 1000 });
  }
  const plugins = path.join(prefix, "lib/gstreamer-1.0"); fs.mkdirSync(plugins, { recursive: true });
  for (const plugin of Previous.PLUGINS) fs.copyFileSync(path.join(media.prefix, "lib/gstreamer-1.0", `libgst${plugin}.dylib`), path.join(plugins, `libgst${plugin}.dylib`));
  const additionalSources = [{ id: "libnpa", upstreamRevision: NPA_REVISION, sourceTreeSha256: NPA_TREE_SHA256 }];
  const profile = { schemaVersion: 1, version: VERSION, profileRevision: PROFILE_REVISION, upstreamRevision: REVISION, npaRevision: NPA_REVISION,
    sourceTreeSha256: ENGINE_TREE_SHA256, additionalSources, combinedSourceTreeSha256: COMBINED_TREE_SHA256, overlaySha256,
    architecture: "arm64", minimumMacOS: "13.0", supportLevel: "beta", mediaVersion: Media.PIN.version,
    dependencyVersions: versions, plugins: Previous.PLUGINS, formats: ["NPA v1 unencrypted", "NSS source"] };
  fs.writeFileSync(path.join(prefix, "profile.json"), JSON.stringify(profile, null, 2) + "\n");
  fs.copyFileSync(path.join(__dirname, "native/fontconfig.conf"), path.join(prefix, "fontconfig.conf"));
  Media.validateSDKPrefix(media.prefix);
  await Promise.all([Source.validatePinnedSource(sourceDir, REVISION, { signal }), Source.validatePinnedSource(npaSourceDir, NPA_REVISION, { signal })]);
  if (overlayIdentity() !== overlaySha256 || Source.hashPinnedFiles(sourceDir, engine.files) !== ENGINE_TREE_SHA256 || Source.hashPinnedFiles(npaSourceDir, npa.files) !== NPA_TREE_SHA256) {
    throw new Error("Nitroplus sources or build adapters changed during compilation.");
  }
  const executable = path.join(prefix, "bin/npengine-runner");
  return { managerId: "npengine", version: VERSION, architecture: "arm64", minimumMacOS: "13.0", sourceRevision: REVISION,
    sourceTreeSha256: ENGINE_TREE_SHA256, additionalSources, combinedSourceTreeSha256: COMBINED_TREE_SHA256,
    overlaySha256, sourceOverlay, sourceRoot, prefix, executable, executableSha256: Native.hashFile(executable),
    profile, configureOptions: options, dependencyClosure: { media, utilities: utilityStack, sdl: sdlStack }, logPath };
}

module.exports = { VERSION, PROFILE_REVISION, REVISION, NPA_REVISION, ENGINE_TREE_SHA256, NPA_TREE_SHA256, COMBINED_TREE_SHA256,
  OWNED_FILES, overlayIdentity, inventory, adaptSource, requirePrefix, buildPortableNPengine };
