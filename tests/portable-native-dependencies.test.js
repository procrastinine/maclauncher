const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const Fonts = require("../src/modules/shared/runtime/portable-sdl2-fonts");
const Resources = require("../src/modules/alicesoft/system3-resource-overlay");
const System3 = require("../src/modules/alicesoft/system3-portable");

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-portable-native-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}

test("portable dependency archives bind exact sizes and hashes and reject aliases or missing inputs", t => {
  const root = temporary(t), file = path.join(root, "source.tar.gz"), bytes = Buffer.from("source archive fixture");
  fs.writeFileSync(file, bytes);
  const pin = { id: "fixture", version: "1.0", revision: "a".repeat(40), archiveSha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    archiveBytes: bytes.length, archiveUrl: "https://example.invalid/source.tar.gz", notices: ["LICENSE"], options: ["-DFEATURE=ON"] };
  const catalog = { schemaVersion: 1, version: "fixture-v1", architecture: "arm64", minimumMacOS: "13.0", dependencies: [pin] };
  assert.deepEqual(Fonts.validateArchives({ fixture: file }, { catalog }), [pin]);
  const alias = path.join(root, "alias.tar.gz"); fs.symlinkSync(file, alias);
  assert.throws(() => Fonts.validateArchives({ fixture: alias }, { catalog }), /checksum or size/);
  assert.throws(() => Fonts.validateArchives({}, { catalog }), /checksum or size/);
  fs.writeFileSync(file, "changed archive bytes");
  assert.throws(() => Fonts.validateArchives({ fixture: file }, { catalog }), /checksum or size/);
  for (const change of [p => { p.revision = "short"; }, p => { p.archiveSha256 = "short"; }, p => { p.notices = ["../LICENSE"]; },
    p => { p.options = ["--untrusted"]; }, p => { p.id = "../escape"; }]) {
    const changed = structuredClone(catalog); change(changed.dependencies[0]);
    assert.throws(() => Fonts.validateArchives({ fixture: file }, { catalog: changed }), /exact source pins/);
  }
});

test("portable CMake plans isolate native dependencies and protect the architecture and macOS floor", () => {
  const input = { prefix: "/build/prefix", sdk: "/SDK", ninja: "/tools/ninja", pathMappings: [{ from: "/build/folder with spaces", to: "source" }], options: ["-DFEATURE=ON"] };
  const options = Fonts.cmakeOptions(input);
  assert.ok(options.includes("-DCMAKE_OSX_ARCHITECTURES=arm64")); assert.ok(options.includes("-DCMAKE_OSX_DEPLOYMENT_TARGET=13.0"));
  assert.ok(options.includes("-DCMAKE_IGNORE_PREFIX_PATH=/opt/homebrew;/usr/local"));
  assert.ok(options.includes("-DFETCHCONTENT_FULLY_DISCONNECTED=ON"));
  assert.match(options.find(value => value.startsWith("-DCMAKE_C_FLAGS=")), /'-ffile-prefix-map=\/build\/folder with spaces=source'/);
  for (const option of ["-DCMAKE_OSX_DEPLOYMENT_TARGET=27.0", "-DCMAKE_OSX_ARCHITECTURES=x86_64", "-DCMAKE_C_FLAGS=-I/opt/homebrew/include",
    "-DCMAKE_SHARED_LINKER_FLAGS=-L/opt/homebrew/lib", "-DFETCHCONTENT_FULLY_DISCONNECTED=OFF"]) {
    assert.throws(() => Fonts.cmakeOptions({ ...input, options: [option] }), /cannot replace/);
  }
  const environment = Fonts.buildEnvironment("/build/prefix", "/SDK");
  assert.equal(environment.PKG_CONFIG_PATH, ""); assert.equal(environment.PKG_CONFIG_LIBDIR, "/build/prefix/lib/pkgconfig");
  assert.equal(environment.MACOSX_DEPLOYMENT_TARGET, "13.0"); assert.equal(environment.DYLD_INSERT_LIBRARIES, undefined);
});

test("portable build output guards reject existing and aliased source trees before any write", t => {
  const root = temporary(t), source = path.join(root, "source"); fs.mkdirSync(source);
  const alias = path.join(root, "source-alias"); fs.symlinkSync(source, alias);
  assert.throws(() => Fonts.assertFreshBuildRoot(source), /new absolute/);
  assert.throws(() => Fonts.assertFreshBuildRoot(path.join(source, "build"), { readOnlyRoots: [source] }), /read-only/);
  assert.throws(() => Fonts.assertFreshBuildRoot(path.join(alias, "build"), { readOnlyRoots: [source] }), /read-only/);
  assert.equal(fs.existsSync(path.join(source, "build")), false);
  assert.equal(Fonts.assertFreshBuildRoot(path.join(root, "build"), { readOnlyRoots: [source] }), path.join(fs.realpathSync(root), "build"));
});

test("cancellation between portable configure and compilation publishes no installed output", async t => {
  const root = temporary(t), controller = new AbortController(), calls = [];
  await assert.rejects(Fonts.buildProject({ sourceRoot: root, outputRoot: path.join(root, "output"), prefix: path.join(root, "prefix"), sdk: "/SDK",
    tools: { cmake: "/tools/cmake", ninja: "/tools/ninja" }, signal: controller.signal,
    dependencies: { runBuildCommand: async (...args) => { calls.push(args); controller.abort(); } } }), { name: "AbortError" });
  assert.equal(calls.length, 1); assert.equal(fs.existsSync(path.join(root, "prefix")), false);
});

test("System3 resource adaptation preserves the upstream input and rejects source aliases", t => {
  const originalFile = path.join(System3.sourcePath, "src/resource.cpp");
  if (!fs.existsSync(originalFile)) { t.skip("System3 source submodule is not initialized"); return; }
  const root = temporary(t), bytes = fs.readFileSync(originalFile), before = crypto.createHash("sha256").update(bytes).digest("hex");
  const source = path.join(root, "source"); fs.mkdirSync(path.join(source, "src"), { recursive: true }); fs.writeFileSync(path.join(source, "src/resource.cpp"), bytes);
  const overlay = Resources.apply(source);
  assert.equal(overlay.sourceSha256, before); assert.notEqual(overlay.adaptedSourceSha256, before);
  assert.deepEqual(fs.readFileSync(originalFile), bytes);
  assert.throws(() => Resources.apply(System3.sourcePath), /separate writable/);
  assert.throws(() => Resources.adaptedResource(Buffer.from("wrong version")), /checksum/);
  const escaped = path.join(root, "escaped"); fs.mkdirSync(escaped); fs.symlinkSync(path.join(System3.sourcePath, "src"), path.join(escaped, "src"));
  assert.throws(() => Resources.apply(escaped), /contained regular/);
  assert.deepEqual(fs.readFileSync(originalFile), bytes);
});

test("the native System3 resource adapter resolves nested app resources from its executable with bounded paths", { skip: process.platform !== "darwin" || process.arch !== "arm64" }, t => {
  const originalFile = path.join(System3.sourcePath, "src/resource.cpp");
  if (!fs.existsSync(originalFile)) { t.skip("System3 source submodule is not initialized"); return; }
  const root = temporary(t), source = path.join(root, "source"); fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, "resource.cpp"), Resources.adaptedResource(fs.readFileSync(originalFile)));
  fs.writeFileSync(path.join(source, "common.h"), "");
  fs.writeFileSync(path.join(source, "sdl_compat.h"), "namespace sdl { struct IOStream { FILE* file; }; inline IOStream* IOFromFile(const char* path, const char* mode) { FILE* f=fopen(path,mode); return f ? new IOStream{f} : NULL; } }\n");
  const host = path.join(root, "App With Spaces.app/Contents/Resources/native-runtimes/fixture/files"), executable = path.join(host, "bin/probe");
  fs.mkdirSync(path.dirname(executable), { recursive: true }); fs.mkdirSync(path.join(host, "share/system3/mda"), { recursive: true });
  fs.writeFileSync(path.join(host, "share/system3/mda/fixture.dat"), "runtime-resource");
  const main = '#include "resource.cpp"\nint main() { auto* stream = open_resource("fixture.dat", "mda"); if (!stream) return 1; char text[32]={}; fread(text,1,31,stream->file); fclose(stream->file); delete stream; if (strcmp(text,"runtime-resource")) return 2; char longName[PATH_MAX*2]; memset(longName,\'x\',sizeof(longName)-1); longName[sizeof(longName)-1]=0; if (open_resource(longName,"mda")) return 3; return 0; }\n';
  fs.writeFileSync(path.join(source, "main.cpp"), main);
  execFileSync("/usr/bin/clang++", ["-arch", "arm64", "-mmacosx-version-min=13.0", path.join(source, "main.cpp"), "-o", executable], { timeout: 30000, stdio: "pipe" });
  execFileSync(executable, [], { cwd: os.tmpdir(), timeout: 10000, stdio: "pipe" });
});
