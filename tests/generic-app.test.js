const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");
const mod = require("../src/modules/generic-app/main");
const { resolveEntryApp, removeQuarantine } = require("../src/modules/shared/runtime/app-maintenance");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-app-tools-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appPath = path.join(root, "Test Space;$(command).app");
  fs.mkdirSync(path.join(appPath, "Contents/MacOS"), { recursive: true });
  fs.writeFileSync(path.join(appPath, "Contents/MacOS/runner"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(path.join(appPath, "Contents/Info.plist"), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>runner</string><key>CFBundleShortVersionString</key><string>1.2.3</string></dict></plist>');
  return appPath;
}

test("generic app recognizes a declared executable and records app version", t => {
  const appPath = fixture(t);
  const detected = mod.detectGame({ rootDir: appPath, isAppBundle: true });
  assert.equal(detected.moduleId, "generic-app");
  assert.equal(detected.nativeAppPath, appPath);
  assert.equal(detected.moduleData.bundleVersion, "1.2.3");
  assert.equal(mod.detectGame({ rootDir: appPath, isAppBundle: false }), null);
  fs.rmSync(path.join(appPath, "Contents/MacOS/runner"));
  assert.equal(mod.detectGame({ rootDir: appPath, isAppBundle: true }), null);
});

test("quarantine removal is an explicit exact-argv backend operation on the game's app", async t => {
  const appPath = fixture(t);
  const entry = { gamePath: "/game/data", nativeAppPath: appPath };
  assert.equal(resolveEntryApp(entry), appPath);
  let calls = 0;
  const result = await removeQuarantine(entry, { platform: "darwin", execute: (command, args, options, callback) => {
    calls++;
    assert.equal(command, "/usr/bin/xattr");
    assert.deepEqual(args, ["-dr", "com.apple.quarantine", appPath]);
    assert.equal(options.shell, false);
    callback(null, "", "");
  } });
  assert.equal(calls, 1);
  assert.equal(result.quarantineRemoved, true);
  await assert.rejects(removeQuarantine(entry, { platform: "linux" }), /macOS/);
  await assert.rejects(removeQuarantine({ gamePath: "/missing.app" }, { platform: "darwin" }), /not found/);
});

test("xattr failures are reported and removal leaves unrelated attributes intact", async t => {
  const appPath = fixture(t);
  await assert.rejects(removeQuarantine({ gamePath: appPath }, { platform: "darwin", execute: (_cmd, _args, _opts, cb) => cb(new Error("failed"), "", "Permission denied") }), /Permission denied/);
  if (process.platform !== "darwin") return;
  execFileSync("/usr/bin/xattr", ["-w", "com.apple.quarantine", "0081;00000000;MacLauncher;test", appPath]);
  execFileSync("/usr/bin/xattr", ["-w", "org.maclauncher.test", "keep", appPath]);
  await removeQuarantine({ gamePath: appPath });
  const attributes = execFileSync("/usr/bin/xattr", [appPath], { encoding: "utf8" });
  assert.equal(attributes.includes("com.apple.quarantine"), false);
  assert.match(attributes, /org.maclauncher.test/);
});
