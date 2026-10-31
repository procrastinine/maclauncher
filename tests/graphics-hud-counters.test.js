// Compiles the plain C++ performance-overlay counters and frame-cap slots and
// runs their checks. These headers have no Metal dependency.
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const {spawnSync} = require("node:child_process");
const compiler = process.platform === "darwin" ? spawnSync("xcrun", ["--find", "clang++"], {encoding: "utf8"}) : null;
const unavailable = !compiler || compiler.status !== 0 ? "clang++ is unavailable" : false;

test("overlay counters assemble rates, pacing and the presented invariant", {skip: unavailable}, t => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-hud-"));t.after(() => fs.rmSync(work, {recursive: true, force: true}));
  const source = path.join(__dirname, "../src/modules/shared/reshade/native/test/hud-counters.cpp"), binary = path.join(work, "hud-counters");
  const build = spawnSync("xcrun", ["clang++", "-std=c++20", "-Wall", "-Werror", source, "-o", binary], {encoding: "utf8"});
  assert.equal(build.status, 0, build.stderr);
  const run = spawnSync(binary, [], {encoding: "utf8"});
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /hud-counters: pass/);
});
