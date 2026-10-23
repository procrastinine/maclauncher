const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const { profile, environment } = require("../src/modules/shared/runtime/macos-sandbox");

test("confined runtimes retain real native power assertion ownership with or without network access", {
  skip: process.platform !== "darwin", timeout: 15000,
}, t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "confined-power-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const executable = path.join(root, "probe");
  execFileSync("/usr/bin/clang", ["-Wall", "-Wextra", "-Werror", "-mmacosx-version-min=13.0",
    path.join(__dirname, "fixtures/network-isolation/power-assertion.c"),
    "-framework", "IOKit", "-framework", "CoreFoundation", "-o", executable], { stdio: "pipe" });
  for (const blockNetwork of [true, false]) {
    const policy = path.join(root, "application.sb");
    fs.writeFileSync(policy, profile({ readDirectories: [], readFiles: [], writeDirectories: [root],
      executables: [executable], blockNetwork }));
    const result = spawnSync("/usr/bin/sandbox-exec", ["-f", policy, executable], {
      cwd: root, env: { ...environment(), HOME: root, TMPDIR: root }, encoding: "utf8", timeout: 5000,
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.match(result.stdout, /Native power assertions acquired, observed and released/);
  }
});
