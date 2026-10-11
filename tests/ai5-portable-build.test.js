const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const Audio = require("../src/modules/shared/runtime/portable-sndfile");
const Portable = require("../src/modules/ai5/runtime/portable-build");
const Previous = require("../src/modules/ai5/runtime/build");

function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ai5-portable-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function fixture(root) {
  for (const file of Object.keys(Portable.ORIGINALS)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.copyFileSync(path.join(Previous.sourcePath, file), path.join(root, file));
  }
}

test("AI5 portable version preserves original-data and save adapters with a separate native identity", t => {
  const root = temporary(t); fixture(root);
  const original = fs.readFileSync(path.join(Previous.sourcePath, "src/asset.c"));
  const overlay = Portable.adaptSource(root);
  assert.equal(Previous.VERSION, "1.5.0-macos-v2");
  assert.equal(Portable.VERSION, "1.5.0-macos-v3");
  assert.equal(overlay.upstreamRevision, Previous.REVISION);
  assert.equal(Object.keys(overlay.files).length, 12);
  assert.deepEqual(fs.readFileSync(path.join(Previous.sourcePath, "src/asset.c")), original);
  const assets = fs.readFileSync(path.join(root, "src/asset.c"), "utf8");
  assert.match(assets, /MACLAUNCHER_AI5_BG_BASE/);
  assert.match(assets, /MACLAUNCHER_AI5_AUX_ROOT/);
  assert.match(assets, /Failed to open base archive %s/);
  assert.doesNotMatch(assets, /reviewed/i);
  assert.match(fs.readFileSync(path.join(root, "src/savedata.c"), "utf8"), /MACLAUNCHER_AI5_SAVE_DIR/);
  assert.match(fs.readFileSync(path.join(root, "subprojects/libai5/src/arc/open.c"), "utf8"), /maclauncher_ai5_archive_open/);
  const meson = fs.readFileSync(path.join(root, "meson.build"), "utf8");
  assert.match(meson, /fallback : '1\.5\.0-macos-v3'/);
  assert.equal((meson.match(/method : 'pkg-config'/g) || []).length, 7);
  assert.match(fs.readFileSync(path.join(root, "subprojects/libai5/meson.build"), "utf8"), /method : 'pkg-config'/);
});

test("AI5 portable source guards reject changed or linked inputs before applying an adapter", t => {
  const root = temporary(t); fixture(root);
  fs.appendFileSync(path.join(root, "src/text.c"), "\n/* changed */\n");
  const original = fs.readFileSync(path.join(root, "src/main.c"));
  assert.throws(() => Portable.adaptSource(root), /checksum differs/);
  assert.deepEqual(fs.readFileSync(path.join(root, "src/main.c")), original);
  assert.equal(fs.existsSync(path.join(root, "maclauncher-disc.h")), false);
  const linked = path.join(temporary(t), "linked"); fs.symlinkSync(root, linked, "dir");
  assert.throws(() => Portable.adaptSource(linked), /separate source export/);
  assert.throws(() => Portable.adaptSource(Previous.sourcePath), /separate source export/);
});

test("portable audio catalog retains external codecs with explicit archive identities and no output modules", () => {
  assert.deepEqual(Audio.PIN.dependencies.map(pin => pin.id), ["ogg", "flac", "vorbis", "opus", "mpg123", "lame", "sndfile"]);
  const mpg = Audio.PIN.dependencies.find(pin => pin.id === "mpg123");
  assert.equal(mpg.revision, undefined);
  assert.equal(mpg.sourceRelease, "mpg123-1.33.7");
  assert.ok(mpg.options.includes("-DBUILD_LIBOUT123=OFF"));
  assert.ok(mpg.options.includes("-DNETWORK=OFF"));
  assert.ok(mpg.options.includes("-DUSE_MODULES=OFF"));
  const sndfile = Audio.PIN.dependencies.at(-1);
  assert.ok(sndfile.options.includes("-DENABLE_EXTERNAL_LIBS=ON"));
  assert.ok(sndfile.options.includes("-DENABLE_MPEG=ON"));
  assert.equal(new Set(Audio.PIN.dependencies.map(pin => pin.archiveSha256)).size, 7);
});

test("portable audio sources reject changed archives and unsafe build metadata", t => {
  const root = temporary(t), file = path.join(root, "source.tar.gz"), bytes = Buffer.from("test source"); fs.writeFileSync(file, bytes);
  const pin = { id: "fixture", name: "Fixture", version: "1.0", sourceRelease: "fixture-1.0", archiveBytes: bytes.length,
    archiveSha256: crypto.createHash("sha256").update(bytes).digest("hex"), archiveUrl: "https://example.invalid/source.tar.gz",
    notices: ["COPYING"], buildSystem: "cmake", options: [] };
  const catalog = { schemaVersion: 1, version: "audio-v1", architecture: "arm64", minimumMacOS: "13.0", dependencies: [pin] };
  assert.equal(Audio.validateArchives({ fixture: file }, { catalog }).length, 1);
  fs.writeFileSync(file, Buffer.from("bad! source"));
  assert.throws(() => Audio.validateArchives({ fixture: file }, { catalog }), /checksum or size differs/);
  for (const change of [{ notices: ["../COPYING"] }, { sourceSubdirectory: "/etc" }, { revision: "main" },
    { options: ["-DCMAKE_PREFIX_PATH=/opt/homebrew"] }, { options: ["-DFETCHCONTENT_FULLY_DISCONNECTED=OFF"] }]) {
    assert.throws(() => Audio.validateArchives({ fixture: file }, { catalog: { ...catalog, dependencies: [{ ...pin, ...change }] } }), /exact archive pins/);
  }
});

test("portable compiler configuration binds ARM64, macOS13 and compiler paths without literal shell quoting", () => {
  const sdk = "/SDK/MacOSX.sdk", mapping = [{ from: "/tmp/build", to: "maclauncher-build" }];
  const flags = Audio.compilerFlags(sdk, mapping);
  assert.match(flags, /-arch arm64 -mmacosx-version-min=13\.0/);
  assert.match(flags, /-fmacro-prefix-map=\/tmp\/build=maclauncher-build/);
  assert.doesNotMatch(flags, /['"`]/);
  assert.throws(() => Audio.compilerFlags("/SDK/with space", mapping), /without spaces/);
  assert.throws(() => Audio.compilerFlags(sdk, [{ from: "/tmp/build", to: "bad\nname" }]), /logical names/);
  const ini = Portable.nativeFile({ pkgConfig: "/tools/pkg-config", sdk, pathMappings: mapping, libraryDirectories: ["/build/fonts/lib", "/build/audio/lib"] });
  assert.match(ini, /c = '\/usr\/bin\/clang'/);
  assert.match(ini, /'-arch', 'arm64', '-mmacosx-version-min=13\.0'/);
  assert.match(ini, /pkg-config = '\/tools\/pkg-config'/);
  assert.match(ini, /'-Wl,-rpath,\/build\/fonts\/lib', '-Wl,-rpath,\/build\/audio\/lib'/);
  assert.doesNotMatch(ini, /homebrew/);
  assert.throws(() => Portable.nativeFile({ pkgConfig: "pkg-config", sdk }), /absolute pkg-config/);
  assert.throws(() => Portable.nativeFile({ pkgConfig: "/tools/pkg-config", sdk, libraryDirectories: ["/build/lib,evil"] }), /absolute library directories/);
});

test("AI5 portable build rejects unpinned or incompatible dependency profiles", () => {
  assert.throws(() => Portable.dependencyPrefixes({ fontStack: { version: "current" }, audioStack: {}, movieStack: {} }), /selected source profiles/);
});
