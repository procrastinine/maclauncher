const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Legacy = require("../src/modules/hashlink/runtime/legacy-build");
const CompilerPaths = require("../src/modules/hashlink/runtime/compiler-paths");
const { spawnSync } = require("node:child_process");
const { findBuildTool } = require("../src/modules/shared/runtime/pinned-native-build");

test("HashLink graphics compiler maps cover physical aliases and preserve paths with spaces", { skip: process.platform !== "darwin" }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hashlink-private-compiler-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source with space"), alias = path.join(root, "workspace-alias");
  fs.mkdirSync(source); fs.symlinkSync(source, alias, "dir");
  const file = path.join(source, "probe.c"), object = path.join(root, "probe.o");
  fs.writeFileSync(file, 'const char *source_identity = __FILE__;\n');
  const mappings = CompilerPaths.compilerPathMappings({ source: alias, build: root, workspace: alias,
    runtime: path.join(root, "runtime"), cache: path.join(root, "cache"), temporary: root, home: root });
  assert.ok(mappings.some(mapping => mapping.from === fs.realpathSync(source)));
  assert.ok(mappings.some(mapping => mapping.from === alias));
  const result = spawnSync("/usr/bin/clang", [...CompilerPaths.compilerFlags(mappings), "-g", "-c", file, "-o", object], { encoding: "utf8" });
  assert.equal(result.status, 0, "Mapped C compilation must succeed.");
  const bytes = fs.readFileSync(object);
  assert.equal(bytes.includes(Buffer.from(root)), false, "Actual temporary roots must not appear in object bytes.");
  assert.equal(bytes.includes(Buffer.from(fs.realpathSync(root))), false, "Physical temporary aliases must not appear in object bytes.");
  assert.equal(bytes.includes(Buffer.from("maclauncher-source/hashlink/probe.c")), true);
  const flags = CompilerPaths.flagsString(["-DVALUE=path with space", "-DQUOTE='literal'"]);
  assert.match(flags, /^'-DVALUE=path with space' /);
  assert.match(flags, /\\'/);
  assert.throws(() => CompilerPaths.compilerPathMappings({ source: "/" }), /non-root/);
});

test("HashLink CMake compiler overlay keeps separate mappings in C and Objective-C objects", { skip: process.platform !== "darwin" }, t => {
  let cmake; try { cmake = findBuildTool("cmake"); } catch { t.skip("Native compiler integration needs CMake."); return; }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hashlink-private-cmake-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source with space"), build = path.join(root, "build"), overlay = path.join(root, "compiler.cmake");
  fs.mkdirSync(source);
  for (const extension of ["c", "m"]) fs.writeFileSync(path.join(source, "probe." + extension), 'const char *file = __FILE__;\n');
  fs.writeFileSync(path.join(source, "CMakeLists.txt"), 'cmake_minimum_required(VERSION 3.20)\nproject(PrefixProbe C OBJC)\nadd_library(cprobe STATIC probe.c)\nadd_library(objcprobe STATIC probe.m)\n');
  fs.writeFileSync(overlay, CompilerPaths.cmakeOverlay(CompilerPaths.compilerFlags(CompilerPaths.compilerPathMappings({ source, build: root }))));
  const configure = spawnSync(cmake, ["-S", source, "-B", build, "-DCMAKE_PROJECT_INCLUDE=" + overlay], { encoding: "utf8" });
  assert.equal(configure.status, 0, "Owned compiler project include must configure.");
  const compile = spawnSync(cmake, ["--build", build], { encoding: "utf8" });
  assert.equal(compile.status, 0, "Mapped C and Objective-C compilation must succeed.");
  for (const [name, extension] of [["cprobe", "c"], ["objcprobe", "m"]]) {
    const bytes = fs.readFileSync(path.join(build, "lib" + name + ".a"));
    assert.equal(bytes.includes(Buffer.from(root)), false, "Actual build roots must be absent.");
    assert.equal(bytes.includes(Buffer.from(fs.realpathSync(root))), false, "Physical aliases must be absent.");
    assert.equal(bytes.includes(Buffer.from("maclauncher-source/hashlink/probe." + extension)), true);
  }
});

test("HashLink 1.9 source adaptation uses its pinned headers without changing SDL's primitive source", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hashlink-native-overlay-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source"), sdl = path.join(root, "sdl");
  for (const dir of ["include/turbojpeg", "include/png", "libs/sdl"]) fs.mkdirSync(path.join(source, dir), { recursive: true });
  fs.mkdirSync(path.join(sdl, "include"), { recursive: true });
  fs.writeFileSync(path.join(source, "include/turbojpeg/jconfig.h"), "#ifndef __ANDROID__\n#\tdefine WITH_SIMD\n#endif\n");
  fs.writeFileSync(path.join(source, "include/png/pngpriv.h"), "#if defined(THINK_C) || defined(TARGET_OS_MAC)\n#include <fp.h>\n#endif\n");
  fs.writeFileSync(path.join(source, "libs/sdl/sdl.c"), "DEFINE_PRIM(_BOOL, event_loop, _OBJ(_I32 _BOOL));\n");
  fs.writeFileSync(path.join(sdl, "include/SDL.h"), "pinned SDL2 header");
  const digest = Legacy.adaptSource(source, sdl);
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(fs.readFileSync(path.join(source, "libs/sdl/sdl.c"), "utf8"), "DEFINE_PRIM(_BOOL, event_loop, _OBJ(_I32 _BOOL));\n");
  assert.equal(fs.readFileSync(path.join(source, "include/SDL2/SDL.h"), "utf8"), "pinned SDL2 header");
  assert.match(fs.readFileSync(path.join(source, "CMakeLists.txt"), "utf8"), /HASHLINK_SDL_LIBRARY/);
  assert.equal(fs.readFileSync(path.join(sdl, "include/SDL.h"), "utf8"), "pinned SDL2 header");
  assert.throws(() => Legacy.adaptSource(source, sdl), /source files do not match/);
});

test("HashLink source builds reject unreviewed historical profiles without creating a runtime directory", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hashlink-unreviewed-build-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await assert.rejects(() => require("../src/modules/hashlink/runtime/build").buildRuntime({ userDataDir: root, version: "1.12" }), /supports HashLink 1\.16/);
  await assert.rejects(() => require("../src/modules/hashlink/runtime/build").buildRuntime({ userDataDir: root, version: "1.9" }), /1\.9.*Mac graphics v2/);
  assert.deepEqual(fs.readdirSync(root), []);
});
