const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), { spawnSync } = require("node:child_process");

test("generation suppresses images no refresh shows and keeps image changes clear of refresh latches", { skip: process.platform !== "darwin" }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "generation-schedule-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const binary = path.join(root, "generation-schedule"), native = path.resolve(__dirname, "../src/modules/shared/reshade/native");
  // The owned delivery plan replaces the base copy; the base supplies InterpolationPlan.
  const compiled = spawnSync("/usr/bin/clang++", ["-std=c++17", "-UNDEBUG", "-I", native, "-I", path.join(native, "base/src"),
    path.join(__dirname, "native/generation-schedule.cpp"), path.join(native, "test/fixture-assert.cpp"), "-o", binary], { encoding: "utf8" });
  assert.equal(compiled.status, 0, compiled.stderr);
  const result = spawnSync(binary, [], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /rules hold/);
});

test("display-limited generation retains ordinary real-frame admission and safe delivery transitions", { skip: process.platform !== "darwin" }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "display-limited-delivery-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const native = path.resolve(__dirname, "../src/modules/shared/reshade/native"), binary = path.join(root, "display-limited-delivery");
  const compiled = spawnSync("xcrun", ["clang++", "-std=c++17", "-Wall", "-Wextra", "-Werror", "-UNDEBUG", "-I", native,
    path.join(native, "test/display-limited-delivery.cpp"), path.join(native, "test/fixture-assert.cpp"), "-o", binary], { encoding: "utf8" });
  assert.equal(compiled.status, 0, compiled.stderr);
  const result = spawnSync(binary, [], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /display-limited-delivery: pass/);
});
