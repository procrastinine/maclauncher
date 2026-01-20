const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const Manager = require("../src/modules/rgss/runtime/mkxpz-manager");

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createInstall(userDataDir, version) {
  const installDir = path.join(userDataDir, "runtimes", "mkxpz", version);
  const appDir = path.join(installDir, "Z-universal.app");
  fs.mkdirSync(appDir, { recursive: true });
  return { installDir, appDir };
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

test("resolveBundledRuntime points at the bundled MKXP-Z app", () => {
  const bundled = Manager.core.resolveBundledRuntime();
  assert.ok(bundled);
  assert.equal(bundled.version, Manager.core.BUNDLED_VERSION);
  assert.ok(bundled.appPath.endsWith("Z-universal.app"));
});

test("listInstalled includes the bundled runtime when userData is empty", () => {
  const userDataDir = makeTempDir("maclauncher-mkxpz-runtime-");
  try {
    const bundled = Manager.core.resolveBundledRuntime();
    assert.ok(bundled);
    const installed = Manager.core.listInstalled(userDataDir);
    const match = installed.find(entry => entry.version === bundled.version);
    assert.ok(match);
    assert.equal(match.installDir, bundled.installDir);
    assert.equal(match.source, "Bundled");
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

test("installRuntime falls back to bundled layout when gh is unavailable", async () => {
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
  Manager.core.canUseGh = async () => false;

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
