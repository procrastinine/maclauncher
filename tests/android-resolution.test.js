const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { spawnSync } = require("node:child_process");
test("Android render-resolution allocation and input use the same bounded source/output contract", { skip: process.platform !== "darwin" }, t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "android-resolution-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const executable = path.join(temporary, "probe");
  const compiled = spawnSync("clang", ["-std=c11", "-Wall", "-Wextra", "-Werror",
    "-I" + path.join(__dirname, "../src/modules/android/native"),
    path.join(__dirname, "fixtures/android-window-session/resolution-test.c"), "-o", executable], { encoding: "utf8", timeout: 15000 });
  assert.equal(compiled.status, 0, compiled.stderr);
  const run = spawnSync(executable, [], { encoding: "utf8", timeout: 5000 });
  assert.equal(run.status, 0, run.stderr);assert.match(run.stdout, /coordinates passed/);
});
