const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const AppBundle = require("../src/modules/shared/runtime/app-bundle");

function fixture(t, name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-hardening-bundle-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = path.join(root, "Player.app");
  fs.mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
  fs.writeFileSync(path.join(app, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>CFBundleExecutable</key><string>${name}</string></dict></plist>`);
  return app;
}

test("bundle metadata cannot resolve executables outside Contents/MacOS", t => {
  const app = fixture(t, "../outside");
  fs.writeFileSync(path.join(app, "Contents", "outside"), "not the bundle executable");
  assert.equal(AppBundle.readAppBundleExecutableName(app), null);
  assert.equal(AppBundle.resolveAppBundleExecutablePath(app), null);
  assert.equal(AppBundle.resolveAppBundleExecutablePath(app, "../outside"), null);
});

test("invalid bundle metadata still permits a real executable fallback", t => {
  const app = fixture(t, "../outside");
  const executable = path.join(app, "Contents", "MacOS", "Player");
  fs.writeFileSync(executable, "player");
  assert.equal(AppBundle.resolveAppBundleExecutablePath(app), executable);
});

test("bundle filenames with spaces and Unicode still resolve normally", t => {
  const app = fixture(t, "Player 日本語");
  const executable = path.join(app, "Contents", "MacOS", "Player 日本語");
  fs.writeFileSync(executable, "player");
  assert.equal(AppBundle.readAppBundleExecutableName(app), "Player 日本語");
  assert.equal(AppBundle.resolveAppBundleExecutablePath(app), executable);
});

function temporary(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function completeBundle(t) {
  const app = fixture(t, "Player");
  const executable = path.join(app, "Contents", "MacOS", "Player");
  fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const framework = path.join(app, "Contents", "Frameworks", "Demo.framework");
  const version = path.join(framework, "Versions", "A");
  fs.mkdirSync(path.join(version, "Resources"), { recursive: true });
  fs.writeFileSync(path.join(version, "Demo"), "framework payload", { mode: 0o755 });
  fs.writeFileSync(path.join(version, "Resources", "Info.plist"), "framework resources");
  fs.symlinkSync("A", path.join(framework, "Versions", "Current"));
  fs.symlinkSync("Versions/Current/Demo", path.join(framework, "Demo"));
  fs.symlinkSync("Versions/Current/Resources", path.join(framework, "Resources"));
  for (const bundleRoot of [path.join(app, "Contents"), version]) {
    fs.mkdirSync(path.join(bundleRoot, "_CodeSignature"), { recursive: true });
    fs.writeFileSync(path.join(bundleRoot, "_CodeSignature", "CodeResources"), Buffer.from("record\0bytes"));
  }
  return app;
}

function snapshot(root) {
  const records = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(directory, entry.name);
      const relative = path.relative(root, full);
      if (entry.isSymbolicLink()) records.push([relative, "link", fs.readlinkSync(full)]);
      else if (entry.isDirectory()) visit(full);
      else records.push([relative, fs.statSync(full).mode, fs.readFileSync(full).toString("hex")]);
    }
  }
  visit(root);
  return records;
}

test("a complete app copy preserves framework aliases and signature bytes after extraction is deleted", t => {
  const source = completeBundle(t);
  const destination = path.join(temporary(t, "maclauncher-installed-bundle-"), "Player.app");
  const original = snapshot(source);
  AppBundle.copyAppBundle(source, destination);
  assert.deepEqual(snapshot(source), original, "source bundle stays unchanged");
  assert.deepEqual(snapshot(destination), original, "copied file bytes, modes and relative aliases stay intact");
  fs.rmSync(path.dirname(source), { recursive: true, force: true });

  const inspected = AppBundle.validateAppBundle(destination);
  assert.equal(inspected.symlinks.length, 3);
  for (const link of inspected.symlinks) {
    const installedLink = path.join(destination, link.relativePath);
    assert.equal(path.isAbsolute(fs.readlinkSync(installedLink)), false);
    assert.ok(fs.realpathSync(installedLink).startsWith(`${fs.realpathSync(destination)}${path.sep}`));
  }
  const framework = path.join(destination, "Contents", "Frameworks", "Demo.framework");
  assert.equal(fs.readFileSync(path.join(framework, "Demo"), "utf8"), "framework payload");
  assert.equal(fs.readFileSync(path.join(framework, "Resources", "Info.plist"), "utf8"), "framework resources");
  assert.deepEqual(fs.readFileSync(path.join(destination, "Contents", "_CodeSignature", "CodeResources")), Buffer.from("record\0bytes"));
});

test("contained absolute framework aliases are made relative only in the copied app", t => {
  const source = completeBundle(t);
  const current = path.join(source, "Contents", "Frameworks", "Demo.framework", "Versions", "Current");
  fs.unlinkSync(current);
  fs.symlinkSync(path.join(path.dirname(current), "A"), current);
  const original = snapshot(source);
  const destination = path.join(temporary(t, "maclauncher-installed-bundle-"), "Player.app");
  assert.equal(AppBundle.appBundleStatus(source).ready, false);
  AppBundle.copyAppBundle(source, destination);
  assert.deepEqual(snapshot(source), original);
  fs.rmSync(path.dirname(source), { recursive: true, force: true });
  const copiedCurrent = path.join(destination, path.relative(source, current));
  assert.equal(fs.readlinkSync(copiedCurrent), "A");
  assert.equal(AppBundle.appBundleStatus(destination).ready, true);
});

test("escaping framework aliases reject copying while preserving source and previous installation", t => {
  const source = completeBundle(t);
  const destination = path.join(temporary(t, "maclauncher-installed-bundle-"), "Player.app");
  AppBundle.copyAppBundle(source, destination);
  const installed = snapshot(destination);
  const outsider = `${source}-outsider`;
  fs.mkdirSync(outsider);
  fs.writeFileSync(path.join(outsider, "private"), "outside payload");
  const escape = path.join(source, "Contents", "Frameworks", "Escape");
  for (const target of [path.join(outsider, "private"), path.relative(path.dirname(escape), path.join(outsider, "private"))]) {
    fs.symlinkSync(target, escape);
    const original = snapshot(source);
    assert.throws(() => AppBundle.copyAppBundle(source, destination), /symlink escapes the bundle/);
    assert.deepEqual(snapshot(source), original);
    assert.deepEqual(snapshot(destination), installed);
    assert.equal(fs.readFileSync(path.join(outsider, "private"), "utf8"), "outside payload");
    fs.unlinkSync(escape);
  }
  assert.throws(() => AppBundle.copyAppBundle(source, path.join(source, "nested.app")), /overlap/);
});

test("broken aliases and incomplete signature directories fail; an unsigned complete bundle remains valid", t => {
  const source = completeBundle(t);
  const signature = path.join(source, "Contents", "_CodeSignature");
  fs.unlinkSync(path.join(signature, "CodeResources"));
  assert.match(AppBundle.appBundleStatus(source).reason, /signature resources are missing/);
  fs.rmSync(signature, { recursive: true });
  assert.equal(AppBundle.appBundleStatus(source).ready, true);
  const broken = path.join(source, "Contents", "Frameworks", "Broken");
  fs.symlinkSync("missing", broken);
  assert.match(AppBundle.appBundleStatus(source).reason, /broken or cyclic/);
  fs.unlinkSync(broken);
  fs.symlinkSync("Broken", broken);
  assert.match(AppBundle.appBundleStatus(source).reason, /broken or cyclic/);
});
