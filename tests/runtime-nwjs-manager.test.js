const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const Manager = require("../src/modules/shared/web/runtime/nwjs-manager");
const { stableIdForPath } = require("../src/modules/shared/web/runtime/nwjs-cleanup");

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createInstall(userDataDir, { version, platformKey = "osx-x64", variant = "sdk" }) {
  const installDir = path.join(
    userDataDir,
    "runtimes",
    "nwjs",
    version,
    platformKey,
    variant
  );
  const exePath = path.join(installDir, "nwjs.app", "Contents", "MacOS", "nwjs");
  fs.mkdirSync(path.dirname(exePath), { recursive: true });
  fs.writeFileSync(exePath, "");
  return { installDir, exePath, version, platformKey, variant };
}

test("normalizeSettings applies defaults and trims input", () => {
  const normalized = Manager.normalizeSettings({
    defaultVersion: " v1.2.3 ",
    defaultVariant: "NORMAL"
  });
  assert.deepEqual(normalized, {
    defaultVersion: "1.2.3",
    defaultVariant: "sdk",
    greenworksDefaultVersion: null
  });

  const fallback = Manager.normalizeSettings({});
  assert.equal(fallback.defaultVersion, "0.107.0");
  assert.equal(fallback.defaultVariant, "sdk");
  assert.equal(fallback.greenworksDefaultVersion, null);
});

test("applySettingsUpdate handles setDefault", () => {
  const settings = { defaultVersion: "0.1.0", defaultVariant: "sdk" };
  const next = Manager.applySettingsUpdate(
    "setDefault",
    { version: "v0.2.0", variant: "normal" },
    settings
  );
  assert.equal(next.defaultVersion, "0.2.0");
  assert.equal(next.defaultVariant, "sdk");

  const greenworks = Manager.applySettingsUpdate(
    "setDefault",
    { sectionId: "greenworks", version: "0.103.1" },
    settings
  );
  assert.equal(greenworks.greenworksDefaultVersion, "0.103.1");

  const unchanged = Manager.applySettingsUpdate("noop", {}, settings);
  assert.deepEqual(unchanged, settings);
});

test("installRootDir uses the nwjs runtime root", () => {
  const userDataDir = makeTempDir("maclauncher-runtime-");
  try {
    const root = Manager.core.installRootDir(userDataDir);
    assert.equal(root, path.join(userDataDir, "runtimes", "nwjs"));
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("listInstalled and resolveBestInstalled find installs", () => {
  const userDataDir = makeTempDir("maclauncher-runtime-");
  try {
    const install = createInstall(userDataDir, { version: "0.80.0", variant: "sdk" });
    const installed = Manager.core.listInstalled(userDataDir);
    assert.equal(installed.length, 1);
    assert.equal(installed[0].version, "0.80.0");
    assert.equal(installed[0].variant, "sdk");

    const resolved = Manager.core.resolveBestInstalled({
      userDataDir,
      version: "0.80.0",
      variant: "sdk",
      platform: "darwin",
      arch: "x64"
    });
    assert.equal(resolved.executablePath, install.exePath);
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});


test("normalizeVersion and normalizeVariant validate input", () => {
  assert.throws(() => Manager.core.normalizeVersion("bad"));
  assert.throws(() => Manager.core.normalizeVariant("beta"));
  assert.equal(Manager.core.normalizeVariant("normal"), "sdk");
});

test("updateSettingsAfterInstall bumps default version", () => {
  const settings = { defaultVersion: "0.79.0", defaultVariant: "sdk" };
  const next = Manager.updateSettingsAfterInstall(settings, {
    version: "0.80.0",
    variant: "normal"
  });
  assert.equal(next.defaultVersion, "0.80.0");
  assert.equal(next.defaultVariant, "sdk");
});

test("updateSettingsAfterUninstall falls back to newest install", () => {
  const userDataDir = makeTempDir("maclauncher-runtime-");
  try {
    createInstall(userDataDir, { version: "0.79.0", variant: "sdk" });
    createInstall(userDataDir, { version: "0.80.0", variant: "sdk" });

    const settings = { defaultVersion: "0.81.0", defaultVariant: "sdk" };
    const next = Manager.updateSettingsAfterUninstall(settings, {}, { userDataDir });
    assert.equal(next.defaultVersion, "0.80.0");
    assert.equal(next.defaultVariant, "sdk");
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("updateSettingsAfterUninstall respects greenworks section defaults", () => {
  const userDataDir = makeTempDir("maclauncher-runtime-");
  try {
    const installDir = path.join(userDataDir, "runtimes", "greenworks", "0.103.1");
    fs.mkdirSync(installDir, { recursive: true });
    fs.writeFileSync(path.join(installDir, "greenworks.js"), "");

    const settings = { greenworksDefaultVersion: "0.80.0" };
    const next = Manager.updateSettingsAfterUninstall(
      settings,
      { sectionId: "greenworks" },
      { userDataDir }
    );
    assert.equal(next.greenworksDefaultVersion, "0.103.1");
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("cleanupGameData removes runtime data for a game", () => {
  const userDataDir = makeTempDir("maclauncher-runtime-");
  try {
    const moduleId = "mv";
    const gamePath = "/Games/TestGame";
    const id = stableIdForPath(gamePath);
    const wrapperRoot = path.join(userDataDir, "modules", moduleId, "nwjs", "wrappers");
    const profileRoot = path.join(userDataDir, "modules", moduleId, "nwjs", "profiles");
    const patchedWrapperRoot = path.join(userDataDir, "modules", moduleId, "nwjs-patched", "wrappers");
    const patchedProfileRoot = path.join(userDataDir, "modules", moduleId, "nwjs-patched", "profiles");
    fs.mkdirSync(path.join(wrapperRoot, id), { recursive: true });
    fs.mkdirSync(path.join(profileRoot, id), { recursive: true });
    fs.mkdirSync(path.join(patchedWrapperRoot, id), { recursive: true });
    fs.mkdirSync(path.join(patchedProfileRoot, id), { recursive: true });

    const removed = Manager.cleanupGameData({ userDataDir, moduleId, gamePath });
    assert.equal(removed, true);
    assert.ok(!fs.existsSync(path.join(wrapperRoot, id)));
    assert.ok(!fs.existsSync(path.join(profileRoot, id)));
    assert.ok(!fs.existsSync(path.join(patchedWrapperRoot, id)));
    assert.ok(!fs.existsSync(path.join(patchedProfileRoot, id)));
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("getState exposes sections and variants", () => {
  const userDataDir = makeTempDir("maclauncher-runtime-");
  try {
    const state = Manager.getState({ settings: {}, userDataDir });
    assert.ok(Array.isArray(state.sections));
    assert.equal(state.sections[0].id, "default");
    assert.equal(state.sections[1].id, "greenworks");
    assert.ok(Array.isArray(state.variants));
    assert.equal(state.variants.length, 0);
    assert.equal(state.catalog.status, "idle");
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
