const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const Build = require("../src/modules/hashlink/runtime/dynamic-legacy-build");

function sourceFixture(t, { jpeg = "#\tdefine WITH_SIMD", png = "#if defined(THINK_C) || defined(TARGET_OS_MAC)" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hashlink-dynamic-source-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source"), sdl = path.join(root, "sdl");
  for (const name of ["include/turbojpeg", "include/png", "libs/sdl", "libs/fmt"]) fs.mkdirSync(path.join(source, name), { recursive: true });
  fs.mkdirSync(path.join(sdl, "include"), { recursive: true });
  fs.writeFileSync(path.join(source, "include/turbojpeg/jconfig.h"), jpeg + "\n");
  fs.writeFileSync(path.join(source, "include/png/pngpriv.h"), png + "\n#include <fp.h>\n#endif\n");
  fs.writeFileSync(path.join(source, "libs/sdl/sdl.c"), "DEFINE_PRIM(_BOOL,event_loop,_DYN);\n");
  fs.writeFileSync(path.join(source, "libs/fmt/fmt.c"), "DEFINE_PRIM(_ABSTRACT(fmt_mp3),mp3_open,_BYTES _I32);\n");
  fs.writeFileSync(path.join(sdl, "include/SDL.h"), "pinned SDL2 header\n");
  fs.writeFileSync(path.join(sdl, "include/README.txt"), "not a header\n");
  return { source, sdl };
}

test("legacy dynamic build retains original primitive ABIs and limits adapters to build inputs", t => {
  const { source, sdl } = sourceFixture(t);
  const before = new Map(["libs/sdl/sdl.c", "libs/fmt/fmt.c"].map(file => [file, fs.readFileSync(path.join(source, file))]));
  const digest = Build.adaptSource(source, sdl);
  assert.match(digest, /^[a-f0-9]{64}$/);
  for (const [file, bytes] of before) assert.deepEqual(fs.readFileSync(path.join(source, file)), bytes);
  assert.equal(fs.readFileSync(path.join(sdl, "include/SDL.h"), "utf8"), "pinned SDL2 header\n");
  assert.equal(fs.readFileSync(path.join(source, "include/SDL2/SDL.h"), "utf8"), "pinned SDL2 header\n");
  assert.equal(fs.existsSync(path.join(source, "include/SDL2/README.txt")), false);
  assert.equal(fs.readFileSync(path.join(source, "include/png/pngpriv.h"), "utf8").includes("TARGET_OS_MAC"), false);
  assert.equal(fs.readFileSync(path.join(source, "include/turbojpeg/jconfig.h"), "utf8").includes("define WITH_SIMD"), false);
  const cmake = fs.readFileSync(path.join(source, "CMakeLists.txt"), "utf8");
  assert.match(cmake, /libs\/fmt\/dxt\.c/);
  assert.match(cmake, /target_include_directories\(sdl PRIVATE include include\/SDL2\)/);
  assert.throws(() => Build.adaptSource(source, sdl), /source files do not match/);
});

test("legacy dynamic source guards fail before writing a changed upstream header", t => {
  for (const options of [{ jpeg: "#define NEW_SIMD_BUILD" }, { png: "#if defined(NEW_PNG_PLATFORM)" }]) {
    const { source, sdl } = sourceFixture(t, options);
    const before = ["include/turbojpeg/jconfig.h", "include/png/pngpriv.h"].map(file => fs.readFileSync(path.join(source, file)));
    assert.throws(() => Build.adaptSource(source, sdl), /source files do not match/);
    for (const [index, file] of ["include/turbojpeg/jconfig.h", "include/png/pngpriv.h"].entries()) assert.deepEqual(fs.readFileSync(path.join(source, file)), before[index]);
    assert.equal(fs.existsSync(path.join(source, "CMakeLists.txt")), false);
    assert.equal(fs.existsSync(path.join(source, "include/SDL2")), false);
  }
});
