const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), {spawnSync} = require("node:child_process");

test("decoded video generation spans distinct PTS at playback speed and matches export phases", {skip: process.platform !== "darwin"}, t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "video-generation-timing-"));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const native = path.resolve(__dirname, "../src/modules/shared/reshade/native"), binary = path.join(directory, "timing");
  const compiled = spawnSync("/usr/bin/clang++", ["-std=c++17", "-Wall", "-Wextra", "-Werror", "-UNDEBUG", "-I", native,
    "-I", path.join(native, "base/src"), path.join(__dirname, "native/video-generation-timing.cpp"), path.join(native, "test/fixture-assert.cpp"), "-o", binary], {encoding: "utf8"});
  assert.equal(compiled.status, 0, compiled.stderr);
  const result = spawnSync(binary, [], {encoding: "utf8"});
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /video generation timing: pass/);
});
