const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { execFileSync } = require("node:child_process");
const B = require("../../shared/runtime/bundled-native"), Native = require("../../shared/runtime/local-native");
const Supplemental = require("../../../../scripts/native-supplementals.cjs");
const VERSION = "1.0.0-ml1", MINIMUM_MACOS = "13.0", SDK_VERSION = "27.0", COMPILER_VERSION = "Apple clang version 21.0.0 (clang-2100.3.34.2)";
const REPO = path.resolve(__dirname, "../../../.."), SOURCE = path.join(__dirname, "native/ogg-decode.c");
const SOURCES = Object.freeze([
  { id: "libogg", version: "1.3.6", name: "libogg-1.3.6.tar.xz", url: "https://downloads.xiph.org/releases/ogg/libogg-1.3.6.tar.xz", sha256: "5c8253428e181840cd20d41f3ca16557a9cc04bad4a3d04cce84808677fa1061", license: "BSD-3-Clause" },
  { id: "libvorbis", version: "1.3.7", name: "libvorbis-1.3.7.tar.xz", url: "https://downloads.xiph.org/releases/vorbis/libvorbis-1.3.7.tar.xz", sha256: "b33cc4934322bcbf6efcbacf49e3ca01aadbea4114ec9589d1b1e9d20f72954b", license: "BSD-3-Clause" }
]);
const VORBIS_FILES = Object.freeze(["mdct", "smallft", "block", "envelope", "window", "lsp", "lpc", "analysis", "synthesis", "psy", "info", "floor1", "floor0", "res0", "mapping0", "registry", "codebook", "sharedbook", "lookup", "bitrate", "vorbisfile"]);
const command = (file, args) => execFileSync(file, args, { timeout: 60000, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** Offline developer recipe; the included decoder needs no end-user compiler. */
function stage({ resourcesRoot, sourceArchives } = {}) {
  if (process.platform !== "darwin" || !path.isAbsolute(resourcesRoot || "") || !sourceArchives) throw new Error("Absolute macOS resource and pinned audio-source paths are required.");
  const sdk = command("/usr/bin/xcrun", ["--sdk", "macosx", "--show-sdk-version"]), compiler = command("/usr/bin/xcrun", ["clang", "--version"]).split("\n")[0];
  if (sdk !== SDK_VERSION || compiler !== COMPILER_VERSION) throw new Error("The audio helper requires its pinned Apple clang 21 / SDK 27 toolchain.");
  for (const source of SOURCES) if (!path.isAbsolute(sourceArchives[source.id] || "") || B.readRegular(sourceArchives[source.id], 2 * 1024 * 1024).sha256 !== source.sha256) throw new Error(`The ${source.id} source archive differs from its pinned SHA-256.`);
  const directoryRelative = `catsystem2-ogg-decode/${VERSION}/universal`, destination = path.join(resourcesRoot, "native-runtimes", directoryRelative);
  if (fs.existsSync(destination)) throw new Error("The audio helper package is immutable; use an empty staging directory.");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-ogg-build-")), source = B.readRegular(SOURCE, 64 * 1024);
  try {
    fs.mkdirSync(destination, { recursive: true });
    for (const descriptor of SOURCES) command("/usr/bin/tar", ["-xf", sourceArchives[descriptor.id], "-C", temporary]);
    const ogg = path.join(temporary, "libogg-1.3.6"), vorbis = path.join(temporary, "libvorbis-1.3.7");
    const generatedTypes = "#ifndef ML_OGG_CONFIG_TYPES_H\n#define ML_OGG_CONFIG_TYPES_H\n#include <stdint.h>\ntypedef int16_t ogg_int16_t;\ntypedef uint16_t ogg_uint16_t;\ntypedef int32_t ogg_int32_t;\ntypedef uint32_t ogg_uint32_t;\ntypedef int64_t ogg_int64_t;\ntypedef uint64_t ogg_uint64_t;\n#endif\n";
    fs.writeFileSync(path.join(ogg, "include/ogg/config_types.h"), generatedTypes);
    const includes = [path.join(ogg, "include"), path.join(vorbis, "include"), path.join(vorbis, "lib")].flatMap(directory => ["-I", directory]);
    const sources = [path.join(ogg, "src/bitwise.c"), path.join(ogg, "src/framing.c"), ...VORBIS_FILES.map(name => path.join(vorbis, "lib", name + ".c"))];
    const maps = [`-ffile-prefix-map=${REPO}=maclauncher-source`, `-ffile-prefix-map=${temporary}=maclauncher-source/catsystem2/audio`, `-fmacro-prefix-map=${temporary}=maclauncher-source/catsystem2/audio`];
    for (const architecture of ["arm64", "x86_64"]) {
      const common = ["--sdk", "macosx", "clang", "-arch", architecture, `-mmacosx-version-min=${MINIMUM_MACOS}`, "-O2", "-std=gnu11", ...maps, ...includes];
      const objects = sources.map((file, index) => {
        const object = path.join(temporary, `${architecture}-${index}.o`); command("/usr/bin/xcrun", [...common, "-Wno-deprecated-declarations", "-c", file, "-o", object]); return object;
      });
      command("/usr/bin/xcrun", [...common, "-Wall", "-Wextra", "-Werror", SOURCE, ...objects, "-o", path.join(temporary, architecture)]);
    }
    const executable = path.join(destination, "ogg-decode");
    command("/usr/bin/lipo", ["-create", path.join(temporary, "arm64"), path.join(temporary, "x86_64"), "-output", executable]);
    command("/usr/bin/codesign", ["--force", "--sign", "-", "--identifier", "io.github.maclauncher.ogg-decode", executable]);
    command("/usr/bin/codesign", ["--verify", "--strict", executable]);
    const protocol = JSON.parse(command(executable, ["--version"]));
    if (protocol.version !== VERSION || protocol.protocolVersion !== 1 || protocol.libogg !== "1.3.6" || protocol.libvorbis !== "1.3.7") throw new Error("The audio helper codec or protocol differs.");
    if (JSON.stringify(Native.readMachOArchitectures(executable).sort()) !== JSON.stringify(["arm64", "x86_64"])) throw new Error("The audio helper CPU slices differ.");
    fs.copyFileSync(SOURCE, path.join(destination, "ogg-decode.c")); fs.copyFileSync(__filename, path.join(destination, "stage-audio.cjs"));
    fs.copyFileSync(path.join(REPO, "LICENSE"), path.join(destination, "MacLauncher-MIT.txt"));
    for (const descriptor of SOURCES) {
      fs.copyFileSync(path.join(temporary, `${descriptor.id}-${descriptor.version}/COPYING`), path.join(destination, descriptor.id + "-BSD.txt"));
      fs.copyFileSync(sourceArchives[descriptor.id], path.join(destination, descriptor.name));
    }
    fs.writeFileSync(path.join(destination, "DEPENDENCIES.txt"), "MacLauncher Ogg decoder: MIT; libogg 1.3.6 and libvorbis 1.3.7: BSD-3-Clause.\nOriginal compressed streams are received through stdin; MLPC v1 returns bounded signed 16-bit little-endian PCM.\nSingle logical Vorbis stream, one or two channels, 8–192 kHz, maximum 600 seconds / 256 MiB decoded.\nPlayback uses macOS /usr/bin/afplay.\n");
    const notices = [{ name: "MacLauncher Ogg decoder", license: "MIT", path: "MacLauncher-MIT.txt" }, ...SOURCES.map(descriptor => ({ name: `${descriptor.id} ${descriptor.version}`, license: descriptor.license, path: descriptor.id + "-BSD.txt" }))];
    const files = fs.readdirSync(destination).sort().map(name => {
      fs.chmodSync(path.join(destination, name), name === "ogg-decode" ? 0o755 : 0o644); const file = B.readRegular(path.join(destination, name), 4 * 1024 * 1024);
      return { path: name, size: file.size, sha256: file.sha256, mode: file.mode, ...(name === "ogg-decode" ? { architectures: ["arm64", "x86_64"] } : {}) };
    });
    const metadata = Buffer.from(JSON.stringify({ schemaVersion: 1, id: "catsystem2-ogg-decode", version: VERSION, protocolVersion: 1, minimumMacOS: MINIMUM_MACOS,
      sourceKind: "owned-source-with-bsd-codecs", sourceSha256: source.sha256, binarySha256: files.find(file => file.path === "ogg-decode").sha256,
      dependencySources: SOURCES, architectures: ["arm64", "x86_64"], notices, files,
      build: { compiler, sdk, signing: "ad-hoc", minimumMacOS: MINIMUM_MACOS, recipe: "src/modules/catsystem2/runtime/stage-audio.cjs", recipeSha256: files.find(file => file.path === "stage-audio.cjs").sha256,
        oggConfigTypesSha256: B.digest(Buffer.from(generatedTypes)), oggFiles: ["src/bitwise.c", "src/framing.c"], vorbisFiles: VORBIS_FILES.map(name => `lib/${name}.c`) } }, null, 2) + "\n");
    fs.writeFileSync(path.join(destination, "helper.json"), metadata, { mode: 0o644 });
    const declaration = { id: "catsystem2-ogg-decode", version: VERSION, arch: "universal", launcherArchitectures: ["arm64", "x64"], minimumMacOS: MINIMUM_MACOS,
      sourceRelative: "ogg-decode.c", sourceSha256: source.sha256, directoryRelative, manifestRelative: "helper.json", manifestSha256: B.digest(metadata),
      files: [...files, { path: "helper.json", size: metadata.length, sha256: B.digest(metadata), mode: 0o644 }], notices };
    Supplemental.validateDeclaration(declaration); Supplemental.verifySupplementals({ resourceRoot: path.join(resourcesRoot, "native-runtimes"), arch: process.arch, maximumMacOS: MINIMUM_MACOS, items: [declaration] }); return declaration;
  } catch (error) { fs.rmSync(destination, { recursive: true, force: true }); throw error; }
  finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
module.exports = { VERSION, MINIMUM_MACOS, SDK_VERSION, COMPILER_VERSION, SOURCES, VORBIS_FILES, stage };
if (require.main === module) {
  try {
    if (process.argv.length !== 5) throw new Error("Pass an absolute staging resource directory, libogg source archive and libvorbis source archive.");
    process.stdout.write(JSON.stringify(stage({ resourcesRoot: path.resolve(process.argv[2]), sourceArchives: { libogg: path.resolve(process.argv[3]), libvorbis: path.resolve(process.argv[4]) } }), null, 2) + "\n");
  } catch (error) { process.stderr.write(error.message + "\n"); process.exitCode = 1; }
}
