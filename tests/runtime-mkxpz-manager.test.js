const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const Manager = require("../src/modules/rgss/runtime/mkxpz-manager");
const Bundles = require("../src/modules/shared/runtime/bundled-native");
const Binary = require("../src/modules/rgss/runtime/bundled-binary.json");

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createInstall(userDataDir, version) {
  const installDir = path.join(userDataDir, "runtimes", "mkxpz", version);
  const appDir = path.join(installDir, "Z-universal.app");
  fs.mkdirSync(appDir, { recursive: true });
  return { installDir, appDir };
}

function createBundledFixture(t) {
  const resourceRoot = makeTempDir("maclauncher-mkxpz-resources-");
  t.after(() => fs.rmSync(resourceRoot, { recursive: true, force: true }));
  const directory = path.join(resourceRoot, "mkxpz", Binary.version, "arm64");
  const payload = path.join(directory, "files"), executableRelative = "Z-universal.app/Contents/MacOS/Z-universal";
  fs.mkdirSync(path.dirname(path.join(payload, executableRelative)), { recursive: true });
  fs.mkdirSync(path.join(payload, "licenses"));
  const executable = Buffer.alloc(32);
  executable.writeUInt32LE(0xfeedfacf); executable.writeUInt32LE(0x0100000c, 4); executable.writeUInt32LE(2, 12);
  fs.writeFileSync(path.join(payload, executableRelative), executable, { mode: 0o755 });
  fs.writeFileSync(path.join(payload, "licenses", "LICENSE"), "License", { mode: 0o644 });
  const manifest = { schemaVersion: 1, managerId: "mkxpz", version: Binary.version, upstreamRevision: Binary.upstreamRevision,
    platform: "darwin", arch: "arm64", minimumMacOS: "11.0", executableRelative,
    provenance: { sourceRevision: Binary.upstreamRevision, sourceKind: "reviewed-binary", verifiedBuild: false },
    notices: [{ name: "MKXP-Z", license: "GPL-2.0", sourceUrl: Binary.sourceUrl, path: "licenses/LICENSE" }], dependencies: [],
    files: [{ path: executableRelative, size: executable.length, sha256: Bundles.digest(executable), mode: 0o755, architectures: ["arm64"] },
      { path: "licenses/LICENSE", size: 7, sha256: Bundles.digest(Buffer.from("License")), mode: 0o644 }] };
  fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify(manifest));
  return { resourceRoot, payload, directory };
}

test("normalizeSettings applies defaults and trims input", () => {
  const normalized = Manager.normalizeSettings({
    defaultVersion: " 2026-01-12T18-22-32Z_794d1897abe529a23f3f2f9c4f72d711a3b18391 "
  });
  assert.equal(
    normalized.defaultVersion,
    "2026-01-12T18-22-32Z_794d1897abe529a23f3f2f9c4f72d711a3b18391"
  );

  const fallback = Manager.normalizeSettings({});
  assert.equal(fallback.defaultVersion, Manager.core.BUNDLED_VERSION);
});

test("applySettingsUpdate handles setDefault", () => {
  const settings = { defaultVersion: "old" };
  const next = Manager.applySettingsUpdate("setDefault", { version: "new" }, settings);
  assert.equal(next.defaultVersion, "new");

  const unchanged = Manager.applySettingsUpdate("noop", {}, settings);
  assert.deepEqual(unchanged, settings);
});

test("listInstalled finds MKXP-Z app bundles", () => {
  const userDataDir = makeTempDir("maclauncher-mkxpz-runtime-");
  try {
    const { installDir } = createInstall(userDataDir, "2026-01-11T18-22-32Z_deadbeef");
    fs.writeFileSync(
      path.join(installDir, ".maclauncher-mkxpz.json"),
      JSON.stringify({ source: "Bundled" }, null, 2)
    );
    const installed = Manager.core.listInstalled(userDataDir);
    const match = installed.find(entry => entry.version === "2026-01-11T18-22-32Z_deadbeef");
    assert.ok(match);
    assert.equal(match.source, "Bundled");
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("resolveBundledRuntime resolves sealed binary resources without a source checkout", t => {
  const fixture = createBundledFixture(t);
  const bundled = Manager.core.resolveBundledRuntime({ resourceRoot: fixture.resourceRoot, arch: "arm64" });
  assert.ok(bundled);
  assert.equal(bundled.version, Manager.core.BUNDLED_VERSION);
  assert.equal(bundled.appPath, path.join(fixture.payload, "Z-universal.app"));
  assert.equal(bundled.readOnly, true); assert.equal(bundled.removable, false);
  assert.equal(bundled.included, true); assert.equal(bundled.bundledExecution, "direct");
  assert.equal(bundled.bundle.manifest.provenance.verifiedBuild, false);
  assert.equal(Manager.core.resolveBundledRuntime({ resourceRoot: fixture.resourceRoot, arch: "x64" }), null);
  const file = path.join(fixture.directory, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(file)); manifest.upstreamRevision = "a".repeat(40);
  manifest.provenance.sourceRevision = manifest.upstreamRevision; fs.writeFileSync(file, JSON.stringify(manifest));
  assert.throws(() => Manager.core.resolveBundledRuntime({ resourceRoot: fixture.resourceRoot, arch: "arm64" }), /source pin/);
});

test("listInstalled includes the bundled runtime and preserves an existing exact writable copy", t => {
  const fixture = createBundledFixture(t), options = { resourceRoot: fixture.resourceRoot, arch: "arm64" };
  const userDataDir = makeTempDir("maclauncher-mkxpz-runtime-");
  try {
    const bundled = Manager.core.resolveBundledRuntime(options);
    assert.ok(bundled);
    const installed = Manager.core.listInstalled(userDataDir, options);
    const match = installed.find(entry => entry.version === bundled.version);
    assert.ok(match);
    assert.equal(match.installDir, bundled.installDir);
    assert.equal(match.source, "Bundled");
    const copy = createInstall(userDataDir, bundled.version);
    const copies = Manager.core.listInstalled(userDataDir, options).filter(entry => entry.version === bundled.version);
    assert.equal(copies.length, 1); assert.equal(copies[0].installDir, copy.installDir);
    assert.equal(Manager.core.uninstallVersion({ userDataDir, version: bundled.version, installDir: bundled.installDir }), false);
    assert.ok(fs.existsSync(bundled.appPath));
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("updateSettingsAfterInstall bumps default version", () => {
  const settings = { defaultVersion: "2026-01-10T18-22-32Z_old" };
  const next = Manager.updateSettingsAfterInstall(settings, {
    version: "2026-01-12T18-22-32Z_new"
  });
  assert.equal(next.defaultVersion, "2026-01-12T18-22-32Z_new");
});

test("updateSettingsAfterUninstall falls back to newest install", () => {
  const userDataDir = makeTempDir("maclauncher-mkxpz-runtime-");
  try {
    createInstall(userDataDir, "2027-01-11T18-22-32Z_deadbeef");
    createInstall(userDataDir, "2027-01-12T18-22-32Z_beadfeed");

    const settings = { defaultVersion: "2026-02-01T00-00-00Z_missing" };
    const next = Manager.updateSettingsAfterUninstall(settings, {}, { userDataDir });
    assert.equal(next.defaultVersion, "2027-01-12T18-22-32Z_beadfeed");
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("getState exposes sections and variants", () => {
  const userDataDir = makeTempDir("maclauncher-mkxpz-runtime-");
  try {
    const state = Manager.getState({ settings: {}, userDataDir });
    assert.ok(Array.isArray(state.sections));
    assert.equal(state.sections[0].id, "default");
    assert.ok(Array.isArray(state.variants));
    assert.equal(state.variants.length, 0);
    assert.equal(state.catalog.status, "idle");
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("canUseGh handles availability checks", async () => {
  const ok = await Manager.core.canUseGh({
    runCommand: () => Promise.resolve({ stdout: "", stderr: "" })
  });
  assert.equal(ok, true);

  const fail = await Manager.core.canUseGh({
    runCommand: () => Promise.reject(new Error("no gh"))
  });
  assert.equal(fail, false);
});

test("installRuntime copies the exact included version without checking gh", async () => {
  const userDataDir = makeTempDir("maclauncher-mkxpz-runtime-");
  const sourceDir = makeTempDir("maclauncher-mkxpz-bundled-");
  const appName = "Z-universal.app";
  fs.mkdirSync(path.join(sourceDir, appName), { recursive: true });

  const originalResolve = Manager.core.resolveBundledRuntime;
  const originalCanUseGh = Manager.core.canUseGh;

  Manager.core.resolveBundledRuntime = () => ({
    version: "fake-version",
    installDir: sourceDir,
    appPath: path.join(sourceDir, appName)
  });
  Manager.core.canUseGh = async () => { throw new Error("Included runtime must not require gh"); };

  try {
    const installed = await Manager.installRuntime({
      userDataDir,
      version: "fake-version"
    });
    assert.equal(installed.version, "fake-version");
    assert.equal(
      installed.installDir,
      path.join(userDataDir, "runtimes", "mkxpz", "fake-version")
    );
    assert.ok(fs.existsSync(path.join(installed.installDir, appName)));
  } finally {
    Manager.core.resolveBundledRuntime = originalResolve;
    Manager.core.canUseGh = originalCanUseGh;
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(sourceDir, { recursive: true, force: true });
  }
});

test("an unavailable explicit Actions version cannot silently switch to the included binary", async t => {
  const userDataDir = makeTempDir("maclauncher-mkxpz-runtime-");
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  const originalResolve = Manager.core.resolveBundledRuntime, originalCanUseGh = Manager.core.canUseGh;
  Manager.core.resolveBundledRuntime = () => ({ version: "included-version", installDir: "unused-source", appPath: "unused-app" });
  Manager.core.canUseGh = async () => false;
  t.after(() => { Manager.core.resolveBundledRuntime = originalResolve; Manager.core.canUseGh = originalCanUseGh; });
  await assert.rejects(Manager.installRuntime({ userDataDir, version: "chosen-actions-version" }), /GitHub CLI unavailable/);
  assert.equal(fs.existsSync(path.join(userDataDir, "runtimes")), false);
});

test("installed bundled MKXP-Z framework aliases survive removal of the source bundle", t => {
  const userDataDir = makeTempDir("maclauncher-mkxpz-runtime-");
  const sourceDir = makeTempDir("maclauncher-mkxpz-bundled-");
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  t.after(() => fs.rmSync(sourceDir, { recursive: true, force: true }));
  const appPath = path.join(sourceDir, "Z-universal.app");
  const framework = path.join(appPath, "Contents", "Frameworks", "Demo.framework");
  fs.mkdirSync(path.join(appPath, "Contents", "MacOS"), { recursive: true });
  fs.writeFileSync(path.join(appPath, "Contents", "MacOS", "Z-universal"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(path.join(appPath, "Contents", "Info.plist"),
    '<plist version="1.0"><dict><key>CFBundleExecutable</key><string>Z-universal</string></dict></plist>');
  fs.mkdirSync(path.join(framework, "Versions", "A", "Resources"), { recursive: true });
  fs.writeFileSync(path.join(framework, "Versions", "A", "Demo"), "framework bytes");
  fs.writeFileSync(path.join(framework, "Versions", "A", "Resources", "Info.plist"), "framework resources");
  fs.symlinkSync("A", path.join(framework, "Versions", "Current"));
  fs.symlinkSync("Versions/Current/Demo", path.join(framework, "Demo"));
  fs.symlinkSync("Versions/Current/Resources", path.join(framework, "Resources"));
  const installed = Manager.core.installBundledRuntime({ userDataDir,
    bundled: { version: "copy-fixture", installDir: sourceDir, appPath } });
  assert.equal(fs.readlinkSync(path.join(framework, "Versions", "Current")), "A");
  assert.equal(fs.readFileSync(path.join(framework, "Demo"), "utf8"), "framework bytes");
  fs.rmSync(sourceDir, { recursive: true, force: true });
  const copied = path.join(installed.appPath, "Contents", "Frameworks", "Demo.framework");
  assert.equal(fs.readlinkSync(path.join(copied, "Versions", "Current")), "A");
  assert.equal(fs.readFileSync(path.join(copied, "Demo"), "utf8"), "framework bytes");
  assert.equal(fs.readFileSync(path.join(copied, "Resources", "Info.plist"), "utf8"), "framework resources");
});
