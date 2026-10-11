const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const GameData = require("../src/modules/shared/game-data");
const Manager = require("../src/modules/shared/web/runtime/nwjs-manager");

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
  fs.writeFileSync(exePath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(path.join(installDir, "nwjs.app", "Contents", "Info.plist"),
    '<plist version="1.0"><dict><key>CFBundleExecutable</key><string>nwjs</string></dict></plist>');
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
  assert.equal(greenworks.defaultVersion, "0.103.1");
  assert.equal(settings.defaultVersion, "0.1.0");

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

test("broken NW.js framework aliases remain visible as damaged and cannot be selected", t => {
  const userDataDir = makeTempDir("maclauncher-runtime-");
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  createInstall(userDataDir, { version: "0.116.0" });
  const broken = createInstall(userDataDir, { version: "0.117.0" });
  const versions = path.join(broken.installDir, "nwjs.app", "Contents", "Frameworks", "nwjs Framework.framework", "Versions");
  fs.mkdirSync(versions, { recursive: true });
  fs.symlinkSync(path.join(userDataDir, "deleted-extraction", "A"), path.join(versions, "Current"));
  const installed = Manager.core.listInstalled(userDataDir);
  const damaged = installed.find(entry => entry.version === "0.117.0");
  assert.equal(damaged.ready, false);
  assert.match(damaged.reason, /symlink is broken/);
  assert.equal(Manager.core.resolveBestInstalled({ userDataDir, version: "0.117.0", platform: "darwin", arch: "x64" }), null);
  const state = Manager.getState({ userDataDir, settings: {} });
  assert.equal(state.catalog.latestInstalledVersion, "0.116.0");
  assert.equal(Manager.updateSettingsAfterUninstall({ defaultVersion: "0.117.0" }, {}, { userDataDir }).defaultVersion, "0.116.0");
});


test("normalizeVersion and normalizeVariant validate input", () => {
  assert.throws(() => Manager.core.normalizeVersion("bad"));
  assert.throws(() => Manager.core.normalizeVariant("beta"));
  assert.equal(Manager.core.normalizeVariant("normal"), "sdk");
});

test("installing NW.js or Greenworks preserves the selected global defaults", () => {
  const settings = { defaultVersion: "0.79.0", defaultVariant: "sdk" };
  const next = Manager.updateSettingsAfterInstall(settings, {
    version: "0.80.0",
    variant: "normal"
  });
  assert.equal(next.defaultVersion, "0.79.0");
  assert.equal(next.defaultVariant, "sdk");
  const paired = { defaultVersion: "0.117.0", greenworksDefaultVersion: "0.80.0" };
  assert.equal(Manager.updateSettingsAfterInstall(paired, { version: "0.103.1" }, { sectionId: "greenworks" }), paired);
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
    fs.writeFileSync(path.join(installDir, "greenworks.js"), 'module.exports = require("./lib/greenworks-osx.node");');
    fs.mkdirSync(path.join(installDir, "lib"));
    const native = Buffer.alloc(32);
    native.writeUInt32LE(0xfeedfacf); native.writeUInt32LE(0x01000007, 4);
    native.writeUInt32LE(8, 12);
    fs.writeFileSync(path.join(installDir, "lib", "greenworks-osx.node"), native);

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
    const gameId = "game-nwjs";
    const runtimeRoot = GameData.resolveGameRuntimeDir(userDataDir, gameId, "nwjs");
    const patchedRuntimeRoot = GameData.resolveGameRuntimeDir(userDataDir, gameId, "nwjs-patched");
    fs.mkdirSync(path.join(runtimeRoot, "wrappers", "wrapper"), { recursive: true });
    fs.mkdirSync(path.join(runtimeRoot, "profiles", "profile"), { recursive: true });
    fs.mkdirSync(path.join(patchedRuntimeRoot, "wrappers", "wrapper"), { recursive: true });
    fs.mkdirSync(path.join(patchedRuntimeRoot, "profiles", "profile"), { recursive: true });

    const removed = Manager.cleanupGameData({ userDataDir, gameId });
    assert.equal(removed, true);
    assert.ok(!fs.existsSync(runtimeRoot));
    assert.ok(!fs.existsSync(patchedRuntimeRoot));
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

test("NW.js refresh enumerates stable history and reports host SDK availability", async () => {
  const payload = { versions: [
    { version: "v0.80.0", files: ["osx-x64"], flavors: ["sdk"] },
    { version: "v0.118.0-beta1", files: ["osx-arm64"], flavors: ["sdk"] },
    { version: "v0.117.0", files: ["osx-arm64", "osx-x64"], flavors: ["sdk"] },
    { version: "v0.12.3", files: ["osx-x64"], flavors: ["normal"] }
  ] };
  const fetcher = async url => {
    assert.equal(url, "https://nwjs.io/versions.json");
    return { status: 200, headers: {}, body: Buffer.from(JSON.stringify(payload)) };
  };
  const all = await Manager.core.fetchAvailableVersions({ arch: "arm64", fetcher });
  assert.deepEqual(all.versions, ["0.117.0", "0.80.0", "0.12.3"]);
  assert.deepEqual(all.installableVersions, ["0.117.0", "0.80.0"]);
  assert.equal(all.availabilityByVersion["0.117.0"].mode, "native");
  assert.equal(all.availabilityByVersion["0.80.0"].mode, "rosetta");
  assert.equal(all.availabilityByVersion["0.12.3"].mode, "unavailable");
  const latest = await Manager.core.fetchAvailableVersions({ latestOnly: true, fetcher });
  assert.deepEqual(latest.versions, ["0.117.0"]);
});

test("NW.js full refresh cannot reuse a reduced cache or alter the selected runtime", async () => {
  const original = Manager.core.fetchAvailableVersions;
  const calls = [];
  const userDataDir = makeTempDir("maclauncher-nwjs-catalog-");
  const settings = { defaultVersion: "0.80.0", defaultVariant: "sdk" };
  try {
    Manager.core.fetchAvailableVersions = async options => {
      calls.push(options.latestOnly);
      return { versions: options.latestOnly ? ["0.117.0"] : ["0.117.0", "0.80.0"] };
    };
    await Manager.refreshCatalog({ force: true, latestOnly: true });
    const full = await Manager.refreshCatalog();
    assert.deepEqual(calls, [true, false]);
    assert.deepEqual(full.versions, ["0.117.0", "0.80.0"]);
    await Manager.refreshCatalog();
    assert.equal(calls.length, 2);
    const state = Manager.getState({ settings, userDataDir });
    assert.equal(state.defaultVersion, "0.80.0");
    assert.equal(state.catalog.latestAvailableVersion, "0.117.0");
    assert.equal(state.catalog.mode, "all");
    assert.ok(state.sections.every(section => section.catalog.supportsLatestOnly === false));
    assert.deepEqual(settings, { defaultVersion: "0.80.0", defaultVariant: "sdk" });
  } finally {
    Manager.core.fetchAvailableVersions = original;
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("NW.js full refresh waits for a reduced request then fetches history", async () => {
  const original = Manager.core.fetchAvailableVersions;
  const calls = [];
  let releaseLatest;
  try {
    Manager.core.fetchAvailableVersions = options => {
      calls.push(options.latestOnly);
      if (options.latestOnly) return new Promise(resolve => { releaseLatest = resolve; });
      return Promise.resolve({ versions: ["0.117.0", "0.80.0"] });
    };
    const latest = Manager.refreshCatalog({ force: true, latestOnly: true });
    const full = Manager.refreshCatalog({ force: true });
    assert.deepEqual(calls, [true]);
    releaseLatest({ versions: ["0.117.0"] });
    await latest;
    assert.deepEqual((await full).versions, ["0.117.0", "0.80.0"]);
    assert.deepEqual(calls, [true, false]);
  } finally {
    Manager.core.fetchAvailableVersions = original;
  }
});

test("NW.js failed refresh can be retried immediately", async () => {
  const original = Manager.core.fetchAvailableVersions;
  let calls = 0;
  try {
    Manager.core.fetchAvailableVersions = async () => {
      calls += 1;
      if (calls === 1) throw new Error("metadata unavailable");
      return { versions: ["0.117.0", "0.80.0"] };
    };
    await assert.rejects(Manager.refreshCatalog({ force: true }), /metadata unavailable/);
    assert.deepEqual((await Manager.refreshCatalog()).versions, ["0.117.0", "0.80.0"]);
    assert.equal(calls, 2);
  } finally {
    Manager.core.fetchAvailableVersions = original;
  }
});
