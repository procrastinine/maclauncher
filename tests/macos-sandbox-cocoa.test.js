const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const { profile, environment } = require("../src/modules/shared/runtime/macos-sandbox");

test("confined Cocoa applications can register their ordinary Dock menu endpoint", {
  skip: process.platform !== "darwin", timeout: 15000,
}, t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "confined-cocoa-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const executable = path.join(root, "probe");
  execFileSync("/usr/bin/clang", ["-Wall", "-Wextra", "-Werror", "-mmacosx-version-min=13.0",
    path.join(__dirname, "fixtures/network-isolation/cocoa-dock.c"), "-o", executable], { stdio: "pipe" });
  const ordinary = spawnSync(executable, [], { encoding: "utf8", timeout: 5000 });
  if (ordinary.status !== 0) return t.skip("Requires a graphical macOS login with Dock running");
  for (const blockNetwork of [true, false]) {
    const policy = path.join(root, "application.sb");
    fs.writeFileSync(policy, profile({ readDirectories: [], readFiles: [], writeDirectories: [root],
      executables: [executable], blockNetwork }));
    const result = spawnSync("/usr/bin/sandbox-exec", ["-f", policy, executable], {
      cwd: root, env: { ...environment(), HOME: root, TMPDIR: root }, encoding: "utf8", timeout: 5000,
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.match(result.stdout, /Dock menu endpoint available/);
  }
});

test("confined Cocoa text UI can reach native completion and locale-specific spelling services", {
  skip: process.platform !== "darwin", timeout: 15000,
}, t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "confined-text-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const executable = path.join(root, "probe");
  execFileSync("/usr/bin/clang", ["-Wall", "-Wextra", "-Werror", "-mmacosx-version-min=13.0",
    path.join(__dirname, "fixtures/network-isolation/cocoa-text-policy.c"), "-lsandbox", "-o", executable], { stdio: "pipe" });
  for (const blockNetwork of [true, false]) {
    const policy = path.join(root, "application.sb");
    fs.writeFileSync(policy, profile({ readDirectories: [], readFiles: [], writeDirectories: [root],
      executables: [executable], blockNetwork }));
    const result = spawnSync("/usr/bin/sandbox-exec", ["-f", policy, executable], {
      cwd: root, env: { ...environment(), HOME: root, TMPDIR: root }, encoding: "utf8", timeout: 5000,
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.match(result.stdout, /Native text services available; unrelated services and files remain confined/);
  }
});

test("confined Cocoa accessibility validation preserves peer-process isolation", {
  skip: process.platform !== "darwin", timeout: 15000,
}, t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "confined-accessibility-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const executable = path.join(root, "probe");
  execFileSync("/usr/bin/clang", ["-Wall", "-Wextra", "-Werror", "-mmacosx-version-min=13.0",
    path.join(__dirname, "fixtures/network-isolation/cocoa-accessibility-policy.c"), "-lsandbox", "-o", executable], { stdio: "pipe" });
  for (const blockNetwork of [true, false]) {
    const policy = path.join(root, "application.sb");
    fs.writeFileSync(policy, profile({ readDirectories: [], readFiles: [], writeDirectories: [root],
      executables: [executable], blockNetwork }));
    const result = spawnSync("/usr/bin/sandbox-exec", ["-f", policy, executable], {
      cwd: root, env: environment(), encoding: "utf8", timeout: 5000,
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.match(result.stdout, /Accessibility validation available; peer servers and private files remain confined/);
  }
});
