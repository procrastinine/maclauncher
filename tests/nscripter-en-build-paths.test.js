const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const Build = require("../src/modules/nscripter/runtime/onscripter-en-build");
const { PROFILE } = require("../src/modules/nscripter/runtime/onscripter-en-manager");

test("ONScripter compiler paths map owned sources, generated files, home, workspace, temp and cache roots", { skip: process.platform !== "darwin" }, t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ons path's fixture-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home"), workspace = path.join(root, "workspace"), temporary = path.join(root, "temporary");
  const work = path.join(temporary, "maclauncher-onscripter-en-build-fixture"), source = path.join(work, "source"), overlay = path.join(work, "overlay");
  const packageRoots = { sdl2: path.join(work, "sdl2-package/SDL2-2.32.10"), sdl12: path.join(work, "sdl12-package/sdl12-compat-release-1.2.76") };
  for (const folder of [home, workspace, temporary, source, overlay, ...Object.values(packageRoots)]) fs.mkdirSync(folder, { recursive: true });
  const mappings = Build.compilerPrefixMaps({ work, source, overlay, packageRoots, profile: PROFILE, home, workspace, temporary });
  const flags = Build.compilerPathFlags(mappings), executable = path.join(root, "fixture");
  const cases = [
    [path.join(source, "fixture.cpp"), "src/external/onscripter-en/fixture.cpp"],
    [path.join(overlay, "fixture.mm"), "src/modules/nscripter/overlays/onscripter-en/fixture.mm"],
    [path.join(packageRoots.sdl2, "src/render/opengl/fixture.c"), "third_party/SDL2/2.32.10/src/render/opengl/fixture.c"],
    [path.join(packageRoots.sdl12, "fixture.m"), "third_party/sdl12-compat/1.2.76/fixture.m"],
    [path.join(work, "engine-build/generated/fixture.cpp"), `maclauncher-build/onscripter-en/${PROFILE}/engine-build/generated/fixture.cpp`],
    [path.join(home, "fixture.cpp"), "maclauncher-home/fixture.cpp"],
    [path.join(workspace, "fixture.cpp"), "maclauncher-workspace/fixture.cpp"],
    [path.join(temporary, "fixture.cpp"), "maclauncher-temporary/fixture.cpp"],
    [path.join(home, "Library/Caches/fixture.cpp"), "maclauncher-cache/fixture.cpp"]
  ];
  for (const [file, expected] of cases) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "#include <stdio.h>\nint main(void) { puts(__FILE__); puts(__builtin_FILE()); }\n");
    execFileSync("/bin/sh", ["-c", "exec /usr/bin/clang " + flags + ' "$1" -o "$2"', "ons-source-fixture", file, executable], { stdio: ["ignore", "pipe", "pipe"] });
    const output = execFileSync(executable, [], { encoding: "utf8" }).trim().split("\n");
    assert.deepEqual(output, [expected, expected]);
    assert.equal(fs.readFileSync(executable).includes(Buffer.from(root)), false);
  }
});
