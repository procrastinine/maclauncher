const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const Dependency = require("../src/modules/mages/native/portable-dependencies");
const Prefix = require("../src/modules/mages/native/portable-prefix");
const Build = require("../src/modules/mages/native/portable-build");
const Overlay = require("../src/modules/mages/native/portable-overlay");
const { image } = require("./fixtures/macho-image");

function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mages-portable-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function fixtureCatalog(file) {
  const bytes = fs.readFileSync(file);
  return { schemaVersion: 1, version: "dependency-v1", architecture: "arm64", minimumMacOS: "13.0", dependencies: [{
    id: "decoder", name: "Decoder", version: "1.0", sourceRelease: "1.0", archiveUrl: "https://example.org/source.tar.gz",
    archiveSha256: crypto.createHash("sha256").update(bytes).digest("hex"), archiveBytes: bytes.length,
    license: "MIT", notices: ["LICENSE"], buildSystem: "cmake", options: ["-DENABLE_TESTS=OFF"]
  }] };
}

test("portable Impacto archives require exact release identities, checksums and CPU", t => {
  const root = directory(t), file = path.join(root, "archive"); fs.writeFileSync(file, "source");
  const catalog = fixtureCatalog(file), archives = { decoder: file };
  assert.equal(Dependency.validateArchives(archives, { catalog })[0].sourceRelease, "1.0");
  fs.appendFileSync(file, "changed");
  assert.throws(() => Dependency.validateArchives(archives, { catalog }), /checksum or size/);
  fs.writeFileSync(file, "source");
  assert.throws(() => Dependency.validateArchives(archives, { catalog: { ...catalog, architecture: "x64" } }), /catalog/);
  assert.throws(() => Dependency.validateArchives(archives, { catalog: { ...catalog, dependencies: [catalog.dependencies[0], catalog.dependencies[0]] } }), /exact source archives/);
  assert.throws(() => Dependency.validateArchives(archives, { catalog: { ...catalog, dependencies: [{ ...catalog.dependencies[0], sourceRelease: null }] } }), /exact source archives/);
});

test("portable dependency catalogs reject escaping licenses and target overrides", t => {
  const root = directory(t), file = path.join(root, "archive"); fs.writeFileSync(file, "source");
  const catalog = fixtureCatalog(file);
  for (const mutation of [{ notices: ["../LICENSE"] }, { notices: ["/tmp/LICENSE"] }, { options: ["-DCMAKE_OSX_DEPLOYMENT_TARGET=27.0"] },
    { options: ["-DFETCHCONTENT_SOURCE_DIR_TEST=/tmp/source"] }, { options: ["-DOPTION=ON;OTHER=ON"] }, { archiveSha256: "a".repeat(40) }]) {
    assert.throws(() => Dependency.validateArchives({ decoder: file }, { catalog: { ...catalog, dependencies: [{ ...catalog.dependencies[0], ...mutation }] } }), /exact source archives/);
  }
});

test("dependency reuse checks source options and all original bytes", t => {
  const prefix = directory(t); fs.writeFileSync(path.join(prefix, "header.h"), "original");
  const inventory = Prefix.snapshotPrefix(prefix), pin = { id: "headers", version: "1.0", options: ["-DTEST=OFF"] };
  const catalog = { version: "stack-v1", dependencies: [pin] }, recipeSha256 = "a".repeat(64);
  const stack = { version: catalog.version, architecture: "arm64", minimumMacOS: "13.0", recipeSha256,
    prefix, prefixSha256: inventory.sha256, sources: [pin] };
  assert.equal(Prefix.validateStack(stack, catalog, recipeSha256).sha256, inventory.sha256);
  assert.throws(() => Prefix.validateStack({ ...stack, sources: [{ ...pin, options: ["-DTEST=ON"] }] }, catalog, recipeSha256), /source identity/);
  fs.writeFileSync(path.join(prefix, "header.h"), "changed");
  assert.throws(() => Prefix.validateStack(stack, catalog, recipeSha256), /checksum changed/);
});

test("dependency overlays permit only declared read-only roots and never replace originals", t => {
  const root = directory(t), original = path.join(root, "original"), output = path.join(root, "output"), outside = path.join(root, "outside");
  fs.mkdirSync(path.join(original, "include"), { recursive: true }); fs.mkdirSync(output); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(original, "include/header.h"), "original"); fs.writeFileSync(path.join(outside, "private"), "outside");
  const before = Prefix.snapshotPrefix(original).sha256;
  Prefix.linkPrefix(original, output);
  assert.throws(() => Prefix.snapshotPrefix(output), /declared inputs/);
  assert.equal(Prefix.snapshotPrefix(output, { readRoots: [original] }).files.length, 1);
  assert.equal(Prefix.snapshotPrefix(original).sha256, before);
  fs.symlinkSync(path.join(outside, "private"), path.join(output, "escaped"));
  assert.throws(() => Prefix.snapshotPrefix(output, { readRoots: [original] }), /declared inputs/);
  assert.throws(() => Prefix.linkPrefix(original, original), /separate/);
});

test("build environment isolates library and compiler discovery", () => {
  const envKeys = ["CMAKE_PREFIX_PATH", "DYLD_FALLBACK_LIBRARY_PATH", "CPATH", "PKG_CONFIG_SYSROOT_DIR"];
  const previous = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  try {
    for (const key of envKeys) process.env[key] = "/unselected";
    const env = Dependency.environment("/build/prefix", "/sdk", ["/build/ffmpeg", "/build/dependencies"]);
    for (const key of envKeys) assert.equal(env[key], undefined);
    assert.equal(env.MACOSX_DEPLOYMENT_TARGET, "13.0");
    assert.equal(env.PKG_CONFIG_PATH, "");
    assert.equal(env.PKG_CONFIG_LIBDIR, "/build/ffmpeg/lib/pkgconfig:/build/ffmpeg/share/pkgconfig:/build/dependencies/lib/pkgconfig:/build/dependencies/share/pkgconfig");
  } finally {
    for (const key of envKeys) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
  }
});

test("portable FFmpeg retains the exact Windows Bink2 format and codec options", () => {
  const options = Build.ffmpegOptions({ prefix: "/build/ffmpeg", sdk: "/sdk", pathMappings: [{ from: "/build", to: "BUILD" }] });
  assert.ok(options.includes("--enable-decoder=bink,bink2,binkaudio_dct,binkaudio_rdft,vorbis,pcm_s16le"));
  assert.ok(options.includes("--enable-demuxer=bink,ogg,wav"));
  assert.ok(options.includes("--disable-autodetect"));
  assert.ok(options.includes("--disable-network"));
  const flags = options.filter(option => option.startsWith("--extra-cflags="));
  assert.equal(flags.length, 1);
  assert.match(flags[0], /-mmacosx-version-min=13\.0/);
  assert.match(flags[0], /-isysroot \/sdk/);
  assert.match(flags[0], /-ffile-prefix-map=\/build=BUILD/);
  assert.throws(() => Build.ffmpegOptions({ prefix: "/bad;prefix", sdk: "/sdk" }), /prefix/);
});

test("the Boost header descriptor verifies its actual encoded source version", t => {
  const root = directory(t), source = path.join(root, "source"), prefix = path.join(root, "prefix");
  fs.mkdirSync(path.join(source, "boost"), { recursive: true }); fs.mkdirSync(prefix);
  fs.writeFileSync(path.join(source, "boost/version.hpp"), "#define BOOST_VERSION 109200\n");
  const result = Dependency.boostHeaders(source, prefix, "1.92.0");
  assert.equal(result.headerVersion, "1.92.0");
  assert.match(fs.readFileSync(path.join(prefix, "lib/cmake/Boost/BoostConfig.cmake"), "utf8"), /Boost::headers/);
  assert.throws(() => Dependency.boostHeaders(source, prefix, "1.91.0"), /version differs/);
});

test("HarfBuzz build metadata selects the same exact library through pkg-config", t => {
  const root = directory(t), output = path.join(root, "metadata");
  const record = Build.writeHarfBuzzDescriptor(output, "14.6.0");
  const text = fs.readFileSync(path.join(output, "harfbuzzConfig.cmake"), "utf8");
  assert.match(text, /IMPORTED_TARGET GLOBAL harfbuzz=14\.6\.0/);
  assert.match(text, /add_library\(harfbuzz::harfbuzz ALIAS PkgConfig::MACLAUNCHER_HARFBUZZ\)/);
  assert.equal(record.descriptor, "pkg-config");
  assert.throws(() => Build.writeHarfBuzzDescriptor(path.join(root, "invalid"), "current"), /exact version/);
});

test("native linking adds only missing explicit dependency paths without a shell", async t => {
  const root = directory(t), executable = path.join(root, "Impacto"), selected = path.join(root, "selected"), codec = path.join(root, "codec");
  fs.mkdirSync(path.join(selected, "lib"), { recursive: true }); fs.mkdirSync(path.join(codec, "lib"), { recursive: true });
  fs.writeFileSync(executable, image({ fileType: 2, installName: null, runPaths: [path.join(selected, "lib")] }));
  const before = crypto.createHash("sha256").update(fs.readFileSync(executable)).digest("hex"), calls = [];
  const env = { MACOSX_DEPLOYMENT_TARGET: "13.0" }, controller = new AbortController();
  const result = await Build.linkDependencyPaths(executable, [selected, codec, codec], {
    env, signal: controller.signal, dependencies: { runBuildCommand: async (command, args, options) => {
      calls.push({ command, args }); assert.equal(options.env, env); assert.equal(options.signal, controller.signal);
      assert.equal(options.cwd, root);
    } }
  });
  assert.deepEqual(calls, [{ command: "/usr/bin/install_name_tool", args: ["-add_rpath", path.join(codec, "lib"), executable] }]);
  assert.deepEqual(result.paths, [path.join(selected, "lib"), path.join(codec, "lib")]);
  assert.equal(result.beforeSha256, before); assert.equal(result.sha256, before);
});

test("native linking rejects linked executables and incomplete library inputs before mutation", async t => {
  const root = directory(t), executable = path.join(root, "Impacto"), alias = path.join(root, "alias"), prefix = path.join(root, "prefix");
  fs.writeFileSync(executable, image({ fileType: 2, installName: null })); fs.symlinkSync(executable, alias);
  const calls = [], options = { dependencies: { runBuildCommand: async (...args) => calls.push(args) } };
  await assert.rejects(Build.linkDependencyPaths(alias, [prefix], options), /owned executable/);
  await assert.rejects(Build.linkDependencyPaths(executable, ["relative"], options), /explicit library prefixes/);
  await assert.rejects(Build.linkDependencyPaths(executable, [prefix + ";other"], options), /explicit library prefixes/);
  await assert.rejects(Build.linkDependencyPaths(executable, [], options), /explicit library prefixes/);
  fs.mkdirSync(prefix); fs.writeFileSync(path.join(prefix, "lib"), "file");
  await assert.rejects(Build.linkDependencyPaths(executable, [prefix], options), /library directory is unavailable/);
  assert.deepEqual(calls, []);
});

test("portable source changes require the complete Windows overlay and reject linked or Git inputs", t => {
  const root = directory(t), source = path.join(root, "source"); fs.mkdirSync(source);
  fs.mkdirSync(path.join(source, "src/subtitle"), { recursive: true });
  const target = path.join(source, Overlay.FILE); fs.writeFileSync(target, "#ifndef IMPACTO_DISABLE_ASS\n");
  assert.throws(() => Overlay.applyPortableOverlay(source), /checksum differs/);
  assert.equal(fs.readFileSync(target, "utf8"), "#ifndef IMPACTO_DISABLE_ASS\n");
  fs.mkdirSync(path.join(source, ".git"));
  assert.throws(() => Overlay.applyPortableOverlay(source), /separate source export/);
  fs.rmSync(path.join(source, ".git"), { recursive: true });
  const alias = path.join(root, "alias"); fs.symlinkSync(source, alias);
  assert.throws(() => Overlay.applyPortableOverlay(alias), /separate source export/);
});

test("Mach-O load-command floors reject macOS 27 despite a macOS 13 label", t => {
  const root = directory(t), file = path.join(root, "library.dylib"), bytes = Buffer.alloc(56);
  bytes.writeUInt32LE(0xfeedfacf, 0); bytes.writeUInt32LE(0x0100000c, 4); bytes.writeUInt32LE(6, 12);
  bytes.writeUInt32LE(1, 16); bytes.writeUInt32LE(24, 20); bytes.writeUInt32LE(0x32, 32); bytes.writeUInt32LE(24, 36);
  bytes.writeUInt32LE(1, 40); bytes.writeUInt32LE(13 << 16, 44); bytes.writeUInt32LE(27 << 16, 48);
  fs.writeFileSync(file, bytes);
  assert.equal(Build.assertMinimumMacOS(file).minimumMacOS, "13.0.0");
  bytes.writeUInt32LE(27 << 16, 44); fs.writeFileSync(file, bytes);
  assert.throws(() => Build.assertMinimumMacOS(file), /above 13\.0/);
});
