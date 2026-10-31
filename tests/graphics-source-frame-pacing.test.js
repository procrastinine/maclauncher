// CPU-only producer-clock and interrupted-wait regression; no GPU or app.
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { spawnSync } = require("node:child_process");
const compiler = process.platform === "darwin" ? spawnSync("xcrun", ["--find", "clang++"], { encoding: "utf8" }) : null;
test("source caps preserve the selected producer's 30/45 Hz clocks across helper traffic and interrupted waits", {
  skip: !compiler || compiler.status !== 0 ? "macOS clang++ is unavailable" : false
}, t => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-source-pacing-"));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const source = path.resolve(__dirname, "../src/modules/shared/reshade/native/test/source-frame-pacing.cpp");
  const binary = path.join(work, "source-frame-pacing");
  const build = spawnSync("xcrun", ["clang++", "-std=c++17", "-Wall", "-Wextra", "-Werror", source, "-o", binary], { encoding: "utf8" });
  assert.ifError(build.error);assert.equal(build.status, 0, build.stderr);
  const run = spawnSync(binary, [], { encoding: "utf8" });
  assert.ifError(run.error);assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /source-frame-pacing: pass/);
});
