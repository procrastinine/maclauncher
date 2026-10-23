const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const Native = require("../../shared/runtime/local-native");
const Source = require("../../shared/runtime/pinned-native-build");
const BuildTools = require("../../shared/runtime/native-build-tools");
const { downloadToFile, throwIfAborted } = require("../../shared/runtime/download-utils");

const PACKAGES = Object.freeze({
  source: { filename: "onscripter-en-2025-06-08.tar.gz", url: "https://github.com/Galladite27/ONScripter-EN/archive/0a725088e01919e0c206533c793a84f69f06b833.tar.gz", sha256: "105db585786917e698ab8db967dc1aa7cf5af4501bf267907bb98b5002550189", folder: "ONScripter-EN-0a725088e01919e0c206533c793a84f69f06b833" },
  sdl12: { filename: "sdl12-compat-1.2.76.tar.gz", url: "https://github.com/libsdl-org/sdl12-compat/archive/refs/tags/release-1.2.76.tar.gz", sha256: "e889ac9c7e8a6bdfc31972bf1f1254b84882cb52931608bada62e8febbf0270b", folder: "sdl12-compat-release-1.2.76" },
  sdl2: { filename: "SDL2-2.32.10.tar.gz", url: "https://github.com/libsdl-org/SDL/releases/download/release-2.32.10/SDL2-2.32.10.tar.gz", sha256: "5f5993c530f084535c65a6879e9b26ad441169b3e25d789d83287040a9ca5165", folder: "SDL2-2.32.10" },
  ...BuildTools.PACKAGES
});
const CODECS = [
  ["SDL_image", "1.2.12", "SDL_image-1.2.12/COPYING", "Zlib"],
  ["SDL_mixer", "1.2.12", "SDL_mixer-1.2.12/COPYING", "Zlib"],
  ["SDL_ttf", "2.0.11", "SDL_ttf-2.0.11/COPYING", "Zlib"],
  ["FreeType", "2.13.0", "freetype-2.13.0/LICENSE.TXT", "FTL"],
  ["libogg", "1.3.5", "libogg-1.3.5/COPYING", "BSD-3-Clause"],
  ["libvorbis", "1.3.7", "libvorbis-1.3.7/COPYING", "BSD-3-Clause"],
  ["libpng", "1.6.39", "libpng-1.6.39/LICENSE", "libpng-2.0"],
  ["IJG JPEG", "9f", "jpeg-9f/README", "IJG"],
  ["bzip2", "1.0.8", "bzip2-1.0.8/LICENSE", "bzip2-1.0.6"],
  ["SMPEG", "0.4.5", "smpeg/COPYING", "LGPL-2.0-or-later"],
  ["SMPEG audio", "0.4.5", "smpeg/audio/COPYING.LIB", "LGPL-2.0-or-later"],
  ["SMPEG video", "0.4.5", "smpeg/video/COPYRIGHT", "See included copyright notice"]
];
const building = new Set();

function compilerPrefixMaps({ work, source, overlay, packageRoots = {}, profile, home = os.homedir(),
  workspace = path.resolve(__dirname, "../../../.."), temporary = os.tmpdir(), caches = [] } = {}) {
  const maps = new Map();
  function add(directory, logical) {
    if (typeof directory !== "string" || !path.isAbsolute(directory) || directory.includes("\0") || directory === path.parse(directory).root) return;
    maps.set(path.resolve(directory), logical);
    try { maps.set(fs.realpathSync(directory), logical); } catch {}
  }
  add(home, "maclauncher-home");
  add(workspace, "maclauncher-workspace");
  for (const cache of [path.join(home, "Library/Caches"), process.env.XDG_CACHE_HOME, ...caches]) add(cache, "maclauncher-cache");
  for (const root of [temporary, process.env.TMPDIR, process.env.TMP, process.env.TEMP]) add(root, "maclauncher-temporary");
  const buildRoot = `maclauncher-build/onscripter-en/${profile}`;
  add(work, buildRoot);
  add(source, "src/external/onscripter-en");
  add(overlay, "src/modules/nscripter/overlays/onscripter-en");
  add(packageRoots.sdl2, "third_party/SDL2/2.32.10");
  add(packageRoots.sdl12, "third_party/sdl12-compat/1.2.76");
  // Clang gives later prefix maps precedence. Broad origins precede owned
  // source/generator roots, including /var and /private/var aliases.
  return [...maps].sort(([a], [b]) => a.length - b.length).map(([from, to]) => ({ from, to }));
}

function compilerPathFlags(mappings) {
  const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";
  return mappings.flatMap(({ from, to }) => ["file", "debug", "macro"].map(kind => `-f${kind}-prefix-map=${quote(from + "=" + to)}`)).join(" ");
}

function sourceFiles(root, depth = 0, prefix = "", output = []) {
  if (depth > 32) throw new Error("Source archive is too deeply nested.");
  for (const entry of fs.readdirSync(path.join(root, prefix), { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) sourceFiles(root, depth + 1, relative, output);
    else if (entry.isFile()) output.push(relative);
    else throw new Error("Source archive contains unsupported symbolic or special files.");
    if (output.length > 100000) throw new Error("Source archive exceeds its file inventory limit.");
  }
  return output;
}

function stageNotices({ source, sdl12, sdl2, destination, revision }) {
  const notices = [
    ["ONScripter-EN", "2025-06-08", path.join(source, "COPYING"), "GPL-2.0-or-later", `https://github.com/Galladite27/ONScripter-EN/tree/${revision}`],
    ["SDL12-compat", "1.2.76", path.join(sdl12, "LICENSE.txt"), "Zlib", "https://github.com/libsdl-org/sdl12-compat/tree/release-1.2.76"],
    ["SDL2", "2.32.10", path.join(sdl2, "LICENSE.txt"), "Zlib", "https://github.com/libsdl-org/SDL/tree/release-2.32.10"],
    ["FreeType license", "2.13.0", path.resolve(__dirname, "../resources/onscripter-en/FreeType-2.13.0-FTL.txt"), "FTL",
      "https://github.com/freetype/freetype/blob/VER-2-13-0/docs/FTL.TXT"],
    ...CODECS.map(([name, version, file, license]) => [name, version, path.join(source, "extlib", "src", file), license,
      `https://github.com/Galladite27/ONScripter-EN/tree/${revision}/extlib/src`])
  ];
  return notices.map(([name, version, from, license, sourceUrl], index) => {
    const relative = `licenses/${index}-${name.replace(/[^A-Za-z0-9_-]/g, "_")}-${version}.txt`;
    fs.mkdirSync(path.dirname(path.join(destination, relative)), { recursive: true });
    fs.copyFileSync(from, path.join(destination, relative));
    return { name: `${name} ${version}`, license, sourceUrl, path: relative };
  });
}

async function buildRuntime({ manager: suppliedManager, userDataDir, version, sourceDir, logger, signal, onProgress, dependencies = {} } = {}) {
  const manager = suppliedManager || require("./onscripter-en-manager");
  const { PROFILE, REVISION } = require("./onscripter-en-manager");
  const selected = version || PROFILE;
  if (selected !== PROFILE || process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch)) {
    throw new Error("The reviewed ONScripter-EN source adapter supports 2025-06-08 Mac profile v2; existing v1 installations remain separate.");
  }
  const destination = manager.core.getInstallDir({ userDataDir, version: selected });
  if (building.has(destination)) throw new Error("This ONScripter-EN version is already building.");
  if (fs.existsSync(path.join(destination, "runtime.json"))) throw new Error("This runtime version is already installed.");
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-onscripter-en-build-"));
  const run = dependencies.runBuildCommand || Source.runBuildCommand;
  const download = dependencies.downloadToFile || downloadToFile;
  fs.mkdirSync(destination, { recursive: true });
  const logPath = path.join(destination, "build.log");
  const payload = path.join(destination, "files");
  fs.writeFileSync(logPath, `ONScripter-EN ${selected}\nSource ${REVISION}\n`);
  building.add(destination);
  try {
    const packageRoots = {};
    async function packageArchive(key, into) {
      const pin = PACKAGES[key], archive = path.join(work, pin.filename);
      await download(pin.url, archive, { signal });
      throwIfAborted(signal);
      if (Native.hashFile(archive) !== pin.sha256) throw new Error(`${pin.filename} failed its SHA-256 check.`);
      fs.mkdirSync(into, { recursive: true });
      await run(pin.filename.endsWith(".zip") ? "/usr/bin/ditto" : "/usr/bin/tar",
        pin.filename.endsWith(".zip") ? ["-x", "-k", archive, into] : ["-xzf", archive, "-C", into], { logPath, signal });
      packageRoots[key] = pin.folder ? path.join(into, pin.folder) : into;
    }
    // Probe Apple's compiler/SDK before acquiring auxiliary source or tools.
    await run("/usr/bin/xcrun", ["--find", "clang"], { logPath, signal });
    await run("/usr/bin/xcrun", ["--show-sdk-path"], { logPath, signal });
    const toolOptions = { temporary: work, packageArchive, findBuildTool: dependencies.findBuildTool || Source.findBuildTool };
    const cmake = await BuildTools.resolveBuildTool("cmake", toolOptions);
    const ninja = await BuildTools.resolveBuildTool("ninja", toolOptions);
    let source = sourceDir, sourceTreeSha256 = null, sourceArchiveSha256 = null;
    if (source && fs.existsSync(path.join(source, ".git"))) {
      const pin = await Source.validatePinnedSource(source, REVISION, { signal });
      const privateSource = path.join(work, "source");
      sourceTreeSha256 = Source.stagePinnedFiles(source, pin.files, privateSource);
      source = privateSource;
    } else {
      await packageArchive("source", path.join(work, "source-package"));
      sourceArchiveSha256 = PACKAGES.source.sha256;
      source = path.join(work, "source");
      sourceTreeSha256 = Source.stagePinnedFiles(packageRoots.source, sourceFiles(packageRoots.source), source);
    }
    await packageArchive("sdl12", path.join(work, "sdl12-package"));
    await packageArchive("sdl2", path.join(work, "sdl2-package"));
    onProgress?.({ downloaded: 1, total: 5 });
    const prefix = path.join(work, "deps"), arch = process.arch === "x64" ? "x86_64" : "arm64";
    const overlaySource = path.resolve(__dirname, "../overlays/onscripter-en"), overlay = path.join(work, "overlay");
    fs.cpSync(overlaySource, overlay, { recursive: true });
    const prefixMaps = compilerPrefixMaps({ work, source, overlay, packageRoots, profile: selected });
    const compilerFlags = compilerPathFlags(prefixMaps);
    async function build(sourceRoot, name, options = []) {
      const output = path.join(work, `${name}-build`);
      await run(cmake, ["-S", sourceRoot, "-B", output, "-G", "Ninja", `-DCMAKE_MAKE_PROGRAM=${ninja}`,
        "-DCMAKE_BUILD_TYPE=Release", "-DCMAKE_POLICY_VERSION_MINIMUM=3.5", "-DCMAKE_OSX_DEPLOYMENT_TARGET=13.0",
        ...["C", "CXX", "OBJC", "OBJCXX"].map(language => `-DCMAKE_${language}_FLAGS=${compilerFlags}`),
        `-DCMAKE_OSX_ARCHITECTURES=${arch}`, `-DCMAKE_INSTALL_PREFIX=${name === "engine" ? payload : prefix}`,
        "-DFETCHCONTENT_FULLY_DISCONNECTED=ON", "-DFETCHCONTENT_UPDATES_DISCONNECTED=ON", ...options], { logPath, signal });
      await run(cmake, ["--build", output, "--parallel", "4"], { logPath, signal });
      await run(cmake, ["--install", output], { logPath, signal });
      return output;
    }
    await build(packageRoots.sdl2, "sdl2", ["-DSDL_SHARED=ON", "-DSDL_STATIC=OFF", "-DSDL_TEST=OFF", "-DSDL_TESTS=OFF"]);
    onProgress?.({ downloaded: 2, total: 5 });
    await build(packageRoots.sdl12, "sdl12", ["-DSDL12TESTS=OFF", "-DSDL12DEVEL=ON", `-DSDL2_INCLUDE_DIR=${prefix}/include/SDL2`]);
    onProgress?.({ downloaded: 3, total: 5 });
    const overlayFiles = Object.fromEntries(fs.readdirSync(overlay).sort().filter(name => fs.statSync(path.join(overlay, name)).isFile())
      .map(name => [name, Native.hashFile(path.join(overlay, name))]));
    const overlaySha256 = crypto.createHash("sha256").update(fs.readFileSync(__filename)).update(JSON.stringify(overlayFiles)).digest("hex");
    await build(overlay, "engine", [`-DONS_SOURCE=${source}`, `-DSDL12_PREFIX=${prefix}`]);
    fs.mkdirSync(path.join(payload, "lib"), { recursive: true });
    for (const name of ["libSDL-1.2.0.dylib", "libSDL2-2.0.0.dylib"]) {
      const target = path.join(payload, "lib", name);
      fs.copyFileSync(path.join(prefix, "lib", name), target);
      await run("/usr/bin/codesign", ["--force", "--sign", "-", target], { logPath, signal });
    }
    const executable = path.join(payload, "bin", "onscripter-en");
    await run("/usr/bin/codesign", ["--force", "--sign", "-", executable], { logPath, signal });
    const notices = stageNotices({ source, sdl12: packageRoots.sdl12, sdl2: packageRoots.sdl2, destination: payload, revision: REVISION });
    const verifiedBuild = { sourceRevision: REVISION, sourceTreeSha256, sourceArchiveSha256,
      adapterProfile: "mac-sdl12-v2", overlaySha256, overlayFiles, architecture: process.arch, minimumMacOS: "13.0",
      compilerPrefixMaps: prefixMaps, compilerFlags, buildDirectory: work,
      nativeVersions: { sdl12Compat: "1.2.76", sdl2: "2.32.10" }, packages: Object.fromEntries(Object.entries(PACKAGES).map(([key, pin]) => [key, pin.sha256])), notices };
    // The shipped profile contains logical source identities only. Complete
    // machine-local compiler inputs remain in the private runtime receipt.
    const publicBuild = { ...verifiedBuild, compilerPrefixMaps: prefixMaps.map(({ to }) => ({ logicalRoot: to })) };
    delete publicBuild.compilerFlags; delete publicBuild.buildDirectory;
    fs.writeFileSync(path.join(payload, "onscripter-en-runtime.json"), JSON.stringify(publicBuild, null, 2));
    if (sourceDir && fs.existsSync(path.join(sourceDir, ".git"))) await Source.validatePinnedSource(sourceDir, REVISION, { signal });
    throwIfAborted(signal);
    onProgress?.({ downloaded: 4, total: 5 });
    const installed = manager.core.registerLocal({ userDataDir, version: selected, runtimePath: executable, verifiedBuild });
    logger?.info?.(`[onscripter-en] installed ${selected}; ${logPath}`);
    onProgress?.({ downloaded: 5, total: 5 });
    return { ...installed, logPath, verifiedBuild };
  } finally { fs.rmSync(work, { recursive: true, force: true }); building.delete(destination); }
}

module.exports = { PACKAGES, CODECS, buildRuntime, stageNotices, sourceFiles, compilerPrefixMaps, compilerPathFlags };
