const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const Manager = require("../src/modules/flash/runtime/ruffle-runtime-manager");

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createInstall(userDataDir, version) {
  const installDir = path.join(userDataDir, "runtimes", "ruffle", version);
  const appPath = path.join(installDir, "Ruffle.app");
  fs.mkdirSync(appPath, { recursive: true });
  return { installDir, appPath };
}

test("ruffle runtime manager normalizes settings defaults", () => {
  const normalized = Manager.normalizeSettings({
    defaultVersion: " nightly-2026-03-06 "
  });
  assert.equal(normalized.defaultVersion, null);

  const fallback = Manager.normalizeSettings({ defaultVersion: "bad/version" });
  assert.equal(fallback.defaultVersion, null);
});

test("ruffle runtime manager exposes default section shape", () => {
  const userDataDir = makeTempDir("maclauncher-ruffle-runtime-");
  try {
    const state = Manager.getState({ settings: {}, userDataDir });
    assert.ok(Array.isArray(state.sections));
    assert.equal(state.sections[0].id, "default");
    assert.equal(state.sections[0].supportsDefault, false);
    assert.equal(state.sections[0].label, "Ruffle versions");
    assert.equal(state.sections[0].catalog.status, "idle");
    assert.equal(state.sections[0].catalog.supportsLatestOnly, false);
    assert.ok(Array.isArray(state.sections[0].variants));
    assert.equal(state.sections[0].variants.length, 0);
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("ruffle runtime manager handles catalog latest/all modes", async () => {
  const originalFetch = Manager.core.fetchAvailableVersions;
  const calls = [];
  const userDataDir = makeTempDir("maclauncher-ruffle-runtime-");

  Manager.core.fetchAvailableVersions = async ({ latestOnly } = {}) => {
    calls.push(latestOnly !== false);
    if (latestOnly === false) {
      return {
        versions: ["nightly-2026-03-06", "nightly-2026-03-05"],
        releasesByVersion: {
          "nightly-2026-03-06": {
            version: "nightly-2026-03-06",
            downloadUrl: "https://example.invalid/ruffle-2026-03-06.tar.gz"
          },
          "nightly-2026-03-05": {
            version: "nightly-2026-03-05",
            downloadUrl: "https://example.invalid/ruffle-2026-03-05.tar.gz"
          }
        },
        source: "stub"
      };
    }

    return {
      versions: ["nightly-2026-03-06"],
      releasesByVersion: {
        "nightly-2026-03-06": {
          version: "nightly-2026-03-06",
          downloadUrl: "https://example.invalid/ruffle-2026-03-06.tar.gz"
        }
      },
      source: "stub"
    };
  };

  try {
    await Manager.refreshCatalog({ force: true, latestOnly: true });
    const latest = Manager.getState({ settings: {}, userDataDir });
    assert.equal(latest.catalog.mode, "latest");
    assert.deepEqual(latest.catalog.versions, ["nightly-2026-03-06"]);

    await Manager.refreshCatalog({ force: true, latestOnly: false });
    const all = Manager.getState({ settings: {}, userDataDir });
    assert.equal(all.catalog.mode, "all");
    assert.deepEqual(all.catalog.versions, ["nightly-2026-03-06", "nightly-2026-03-05"]);

    assert.deepEqual(calls, [true, false]);
  } finally {
    Manager.core.fetchAvailableVersions = originalFetch;
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("legacy default actions do not create game-runtime pins", () => {
  const set = Manager.applySettingsUpdate(
    "setDefault",
    { version: "nightly-2026-03-06" },
    {}
  );
  assert.deepEqual(set, {});

  const cleared = Manager.applySettingsUpdate("setDefault", { version: "" }, set);
  assert.deepEqual(cleared, {});
});

test("ordinary Ruffle refresh defaults to all versions and upgrades a pending reduced request", async t => {
  const calls = [];
  let releaseLatest;
  t.mock.method(Manager.core, "fetchAvailableVersions", async ({ latestOnly, maxPages }) => {
    calls.push({ latestOnly, maxPages });
    if (latestOnly) await new Promise(resolve => { releaseLatest = resolve; });
    return { versions: latestOnly ? ["new"] : ["new", "older"], releasesByVersion: {}, source: "fixture" };
  });
  const reduced = Manager.refreshCatalog({ force: true, latestOnly: true });
  const full = Manager.refreshCatalog({ force: true });
  releaseLatest();
  await reduced;
  assert.deepEqual((await full).versions, ["new", "older"]);
  assert.deepEqual(calls, [{ latestOnly: true, maxPages: 1 }, { latestOnly: false, maxPages: 5 }]);
});

test("failed ordinary Ruffle catalogs can be retried immediately", async t => {
  let attempts = 0;
  t.mock.method(Manager.core, "fetchAvailableVersions", async () => {
    if (++attempts === 1) throw new Error("temporary network failure");
    return { versions: ["recovered"], releasesByVersion: {}, source: "fixture" };
  });
  await assert.rejects(Manager.refreshCatalog({ force: true }), /temporary network/);
  assert.deepEqual((await Manager.refreshCatalog()).versions, ["recovered"]);
  assert.equal(attempts, 2);
});

test("the first explicit Ruffle install retains the ordinary release history", async t => {
  const managerPath = require.resolve("../src/modules/flash/runtime/ruffle-runtime-manager");
  const cached = require.cache[managerPath];
  delete require.cache[managerPath];
  const freshManager = require(managerPath);
  t.after(() => { require.cache[managerPath] = cached; });
  const userDataDir = makeTempDir("maclauncher-ruffle-runtime-");
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  const versions = ["nightly-2026-03-06", "nightly-2026-03-05"];
  const calls = [];
  t.mock.method(freshManager.core, "fetchAvailableVersions", async options => {
    calls.push(options);
    return { versions, releasesByVersion: {}, source: "fixture" };
  });
  t.mock.method(freshManager.core, "installVersion", async options => ({ version: options.version }));

  assert.equal(freshManager.getState({ settings: {}, userDataDir }).catalog.status, "idle");
  assert.equal(calls.length, 0);
  assert.deepEqual(await freshManager.installRuntime({ userDataDir }), { version: versions[0] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].latestOnly, false);
  assert.equal(calls[0].maxPages, 5);
  assert.deepEqual(freshManager.getState({ settings: {}, userDataDir }).catalog.versions, versions);
});

test("install and uninstall do not write a global game-runtime version", () => {
  const userDataDir = makeTempDir("maclauncher-ruffle-runtime-");
  try {
    createInstall(userDataDir, "nightly-2026-03-04");
    createInstall(userDataDir, "nightly-2026-03-06");

    const afterInstall = Manager.updateSettingsAfterInstall(
      { defaultVersion: "nightly-2026-03-03" },
      { version: "nightly-2026-03-06" }
    );
    assert.equal(afterInstall, undefined);

    const afterUninstall = Manager.updateSettingsAfterUninstall(
      { defaultVersion: "nightly-2026-03-07" },
      {},
      { userDataDir }
    );
    assert.equal(afterUninstall, undefined);
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
