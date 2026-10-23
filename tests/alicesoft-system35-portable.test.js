const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const Portable = require("../src/modules/alicesoft/system35-portable");
const Overlay = require("../src/modules/alicesoft/system35-overlay");
const { buildManagedRuntime } = require("../src/modules/alicesoft/build");

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-system35-portable-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}

function copyInputs(t) {
  if (!fs.existsSync(path.join(Portable.sourcePath, "src/font.c"))) { t.skip("xsystem35 source submodule is not initialized"); return null; }
  const root = temporary(t), source = path.join(root, "source"); fs.mkdirSync(path.join(source, "src"), { recursive: true });
  for (const relative of Object.keys(Overlay.SOURCE_HASHES)) fs.copyFileSync(path.join(Portable.sourcePath, relative), path.join(source, relative));
  return { root, source };
}

test("portable xsystem35 adapters keep upstream files unchanged and make dependency choices explicit", t => {
  const fixture = copyInputs(t); if (!fixture) return;
  const originals = Object.keys(Overlay.SOURCE_HASHES).map(relative => fs.readFileSync(path.join(Portable.sourcePath, relative)));
  const result = Overlay.apply(fixture.source);
  assert.equal(result.files.length, 2);
  const cmake = fs.readFileSync(path.join(fixture.source, "CMakeLists.txt"), "utf8");
  assert.match(cmake, /elseif \(ENABLE_PORTMIDI\)\n    find_library/);
  assert.match(cmake, /if \(ENABLE_GETTEXT AND/);
  assert.match(cmake, /if \(APPLE\)\n      set\(DEFAULT_FONT_PATH ""\)/);
  assert.match(fs.readFileSync(path.join(fixture.source, "src/font.c"), "utf8"), /_NSGetExecutablePath/);
  Object.keys(Overlay.SOURCE_HASHES).forEach((relative, i) => assert.deepEqual(fs.readFileSync(path.join(Portable.sourcePath, relative)), originals[i]));
  assert.throws(() => Overlay.apply(Portable.sourcePath), /separate writable/);
  assert.throws(() => Overlay.adapt("src/font.c", Buffer.from("another version")), /checksum/);
});

test("adapter source validation finishes before writing either file and rejects escaped links", t => {
  const fixture = copyInputs(t); if (!fixture) return;
  const cmake = fs.readFileSync(path.join(fixture.source, "CMakeLists.txt"));
  fs.writeFileSync(path.join(fixture.source, "src/font.c"), "changed input");
  assert.throws(() => Overlay.apply(fixture.source), /checksum/);
  assert.deepEqual(fs.readFileSync(path.join(fixture.source, "CMakeLists.txt")), cmake);
  fs.unlinkSync(path.join(fixture.source, "src/font.c")); fs.symlinkSync(path.join(Portable.sourcePath, "src/font.c"), path.join(fixture.source, "src/font.c"));
  assert.throws(() => Overlay.apply(fixture.source), /contained regular/);
});

test("native default fonts resolve beside a relocated executable and preserve custom paths", { skip: process.platform !== "darwin" || process.arch !== "arm64" }, t => {
  const fixture = copyInputs(t); if (!fixture) return;
  const source = Overlay.adapt("src/font.c", fs.readFileSync(path.join(Portable.sourcePath, "src/font.c"))).toString("utf8");
  const start = source.indexOf("static FT_Face open_default_font("), end = source.indexOf("\n#endif\n\nstatic FT_Face open_face", start);
  assert.ok(start > 0 && end > start);
  const runtime = path.join(fixture.root, "Runtime With Spaces.app/Contents/Resources/engines/files"), executable = path.join(runtime, "bin/probe");
  fs.mkdirSync(path.dirname(executable), { recursive: true }); fs.mkdirSync(path.join(runtime, "share/xsystem35/fonts"), { recursive: true });
  for (const name of ["MTLc3m.ttf", "mincho.ttf"]) fs.writeFileSync(path.join(runtime, "share/xsystem35/fonts", name), "font fixture");
  const header = '#include <stdio.h>\n#include <stdlib.h>\n#include <string.h>\n#include <stdint.h>\n#include <limits.h>\n#include <mach-o/dyld.h>\n#define DEFAULT_GOTHIC_TTF "MTLc3m.ttf"\n#define DEFAULT_MINCHO_TTF "mincho.ttf"\ntypedef void* FT_Face; static void* ft_library; static int FT_New_Face(void* lib,const char* file,int index,FT_Face* face) { (void)lib;(void)index;FILE* f=fopen(file,"rb");if(!f)return 1;fclose(f);*face=(void*)1;return 0; }\n';
  const main = '\nint main(void) { if(!open_default_font(DEFAULT_GOTHIC_TTF,0)||!open_default_font(DEFAULT_MINCHO_TTF,0))return 1; if(open_default_font("custom.ttf",0))return 2;return 0; }\n';
  const file = path.join(fixture.root, "probe.c"); fs.writeFileSync(file, header + source.slice(start, end) + main);
  execFileSync("/usr/bin/clang", ["-arch", "arm64", "-mmacosx-version-min=13.0", file, "-o", executable], { timeout: 30000, stdio: "pipe" });
  execFileSync(executable, [], { cwd: os.tmpdir(), timeout: 10000, stdio: "pipe" });
  const alias = path.join(fixture.root, "runtime-alias"); fs.symlinkSync(executable, alias);
  execFileSync(alias, [], { cwd: os.tmpdir(), timeout: 10000, stdio: "pipe" });
});

test("dependency prefix checksums reject external links, content mutations and recipe mismatches", t => {
  const root = temporary(t), prefix = path.join(root, "prefix"); fs.mkdirSync(path.join(prefix, "lib"), { recursive: true });
  fs.writeFileSync(path.join(prefix, "lib/library"), "dependency content"); fs.symlinkSync("library", path.join(prefix, "lib/alias"));
  const inventory = Portable.snapshotPrefix(prefix), pin = { id: "fixture", version: "1", archiveSha256: "a".repeat(64), options: [] };
  const catalog = { version: "fixture-v1", dependencies: [pin] }, stack = { version: catalog.version, architecture: "arm64", minimumMacOS: "13.0",
    recipeSha256: "b".repeat(64), prefix, prefixSha256: inventory.sha256, sources: [pin] };
  assert.equal(Portable.validateStack(stack, catalog, stack.recipeSha256).sha256, inventory.sha256);
  assert.throws(() => Portable.validateStack({ ...stack, recipeSha256: "c".repeat(64) }, catalog, stack.recipeSha256), /exact source recipe/);
  assert.throws(() => Portable.validateStack({ ...stack, sources: [{ ...pin, version: "2" }] }, catalog, stack.recipeSha256), /source identity/);
  fs.writeFileSync(path.join(prefix, "lib/library"), "changed dependency");
  assert.throws(() => Portable.validateStack(stack, catalog, stack.recipeSha256), /prefix checksum/);
  const outside = path.join(root, "outside"); fs.writeFileSync(outside, "outside"); fs.symlinkSync(outside, path.join(prefix, "lib/escaped"));
  assert.throws(() => Portable.snapshotPrefix(prefix), /inside their prefix/);
});

test("read-only dependency views link only build inputs and refuse conflicting files", t => {
  const root = temporary(t), input = path.join(root, "input"), output = path.join(root, "output");
  fs.mkdirSync(path.join(input, "lib/pkgconfig"), { recursive: true }); fs.mkdirSync(path.join(input, "bin")); fs.mkdirSync(output);
  fs.writeFileSync(path.join(input, "lib/dependency"), "content"); fs.writeFileSync(path.join(input, "lib/pkgconfig/example.pc"), "pkg"); fs.writeFileSync(path.join(input, "bin/other-runtime"), "unrelated");
  const before = Portable.snapshotPrefix(input);
  Portable.linkPrefix(input, output);
  assert.equal(fs.lstatSync(path.join(output, "lib/dependency")).isSymbolicLink(), true);
  assert.equal(fs.existsSync(path.join(output, "bin/other-runtime")), false);
  assert.equal(Portable.snapshotPrefix(input).sha256, before.sha256);
  assert.throws(() => Portable.linkPrefix(input, input), /separate build prefix/);
  fs.unlinkSync(path.join(output, "lib/dependency")); fs.writeFileSync(path.join(output, "lib/dependency"), "collision");
  assert.throws(() => Portable.linkPrefix(input, output), /conflicting files/);
});

test("portable xsystem35 cannot use the ambient-dependency Source Build route", async t => {
  const root = temporary(t); let calls = 0;
  const dependencies = { findBuildTool: () => { calls++; throw Error("Unexpected build tool"); }, runBuildCommand: () => { calls++; throw Error("Unexpected compiler"); } };
  for (const version of [Portable.VERSION, "v" + Portable.VERSION, " " + Portable.VERSION + " "]) {
    await assert.rejects(buildManagedRuntime({ manager: { id: "xsystem35" }, version, userDataDir: path.join(root, "userData"), dependencies }), /portable dependency recipe/);
  }
  assert.equal(calls, 0); assert.equal(fs.existsSync(path.join(root, "userData")), false);
});

test("Opus metadata uses the explicit source pin without changing a reused dependency", t => {
  const root = temporary(t), prefix = path.join(root, "prefix"), original = path.join(root, "opus-original.pc");
  fs.mkdirSync(path.join(prefix, "lib/pkgconfig"), { recursive: true });
  fs.writeFileSync(original, "Name: opus\nVersion: 0\nLibs: -lopus\n");
  const file = path.join(prefix, "lib/pkgconfig/opus.pc"); fs.symlinkSync(original, file);
  const before = fs.readFileSync(original), result = Portable.adaptDependencyMetadata(prefix);
  assert.equal(result.version, "1.6.1"); assert.equal(fs.lstatSync(file).isFile(), true);
  assert.match(fs.readFileSync(file, "utf8"), /^Version: 1\.6\.1$/m); assert.deepEqual(fs.readFileSync(original), before);
  fs.writeFileSync(file, "Version: 1.0\n"); assert.throws(() => Portable.adaptDependencyMetadata(prefix), /selected source version/);
});

test("feature checks refuse silently missing codecs and dynamic-library loading", t => {
  const root = temporary(t); fs.mkdirSync(path.join(root, "xsystem35")); fs.mkdirSync(path.join(root, "sdl2_mixer"));
  const config = "#define ENABLE_DEBUGGER 1\n#define ENABLE_MIDI_SDLMIXER 1\n#define HAVE_WEBP 1\n";
  fs.writeFileSync(path.join(root, "xsystem35/config.h"), config);
  const commands = "MUSIC_MID_NATIVE MUSIC_FLAC_LIBFLAC MUSIC_MP3_MPG123 MUSIC_OPUS MUSIC_OGG";
  const file = path.join(root, "sdl2_mixer/compile_commands.json"); fs.writeFileSync(file, commands);
  assert.equal(Portable.validateFeatures(root).dynamicCodecLoading, false);
  fs.writeFileSync(file, commands.replace("MUSIC_OPUS", "")); assert.throws(() => Portable.validateFeatures(root), /MUSIC_OPUS/);
  fs.writeFileSync(file, commands + " OPUS_DYNAMIC"); assert.throws(() => Portable.validateFeatures(root), /unselected dynamic/);
  fs.writeFileSync(file, commands); fs.writeFileSync(path.join(root, "xsystem35/config.h"), config + "#define ENABLE_MIDI_PORTMIDI 1\n");
  assert.throws(() => Portable.validateFeatures(root), /unselected external/);
});

test("cancelled portable builds make no output or source changes", async t => {
  const root = temporary(t), controller = new AbortController(); controller.abort();
  const workRoot = path.join(root, "output");
  await assert.rejects(Portable.buildPortableSystem35({ workRoot, signal: controller.signal }), { name: "AbortError" });
  assert.equal(fs.existsSync(workRoot), false);
  assert.match(Portable.overlayIdentity(), /^[a-f0-9]{64}$/);
  assert.equal(crypto.createHash("sha256").update(fs.readFileSync(require.resolve("../src/modules/alicesoft/system35-overlay"))).digest("hex").length, 64);
});
