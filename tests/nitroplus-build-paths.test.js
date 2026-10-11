const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { sourcePathFlags, VERSION } = require("../src/modules/nitroplus/runtime/build");

test("Nitroplus compiler paths retain exact logical roots without leaking quoted private build paths", { skip: process.platform !== "darwin" }, t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "nitro path's fixture-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const relative of ["build-source/libnpengine/src", "build-source/libnpa/src", "build-source", "build-output"]) {
    const source = path.join(root, relative, "fixture.cpp"), executable = path.join(root, "fixture");
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, "#include <cstdio>\nint main() { puts(__FILE__); }\n");
    execFileSync("/bin/sh", ["-c", "exec /usr/bin/clang++ " + sourcePathFlags(root) + ' "$1" -o "$2"', "nitro-build-fixture", source, executable], { stdio: ["ignore", "pipe", "pipe"] });
    const identity = execFileSync(executable, [], { encoding: "utf8" }).trim();
    assert.equal(identity, relative.startsWith("build-source/libnpengine") ? "src/external/libnpengine/src/fixture.cpp"
      : relative.startsWith("build-source/libnpa") ? "src/external/libnpa/src/fixture.cpp"
        : relative === "build-source" ? "src/modules/nitroplus/native-stage/fixture.cpp" : `maclauncher-build/npengine/${VERSION}/build-output/fixture.cpp`);
    assert.equal(fs.readFileSync(executable).includes(Buffer.from(root)), false);
  }
});
