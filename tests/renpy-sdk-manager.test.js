const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const SdkManager = require("../src/modules/renpy/runtime/sdk-manager");
const SdkRuntimeManager = require("../src/modules/renpy/runtime/sdk-runtime-manager");

const { isVersionInMajorGroup } = SdkManager.__test;

test("sdk manager groups Ren'Py 6 and 7 under the python 2 major", () => {
  assert.equal(isVersionInMajorGroup("6.99.12", 7), true);
  assert.equal(isVersionInMajorGroup("7.4.11", 7), true);
  assert.equal(isVersionInMajorGroup("8.2.1", 7), false);
});

test("sdk manager keeps Ren'Py 8 in the python 3 major group", () => {
  assert.equal(isVersionInMajorGroup("8.2.1", 8), true);
  assert.equal(isVersionInMajorGroup("7.4.11", 8), false);
  assert.equal(isVersionInMajorGroup("6.99.12", 8), false);
});

test("sdk runtime manager exposes Ren'Py as the runtime panel label", async () => {
  const originalInstallVersion = SdkRuntimeManager.core.installVersion;
  const calls = [];
  const downloads = {
    runTask: async (meta, runner) => {
      calls.push(meta);
      return runner({ signal: null, onProgress: () => {} });
    }
  };

  try {
    SdkRuntimeManager.core.installVersion = async () => ({ version: "8.2.1" });

    const result = await SdkRuntimeManager.installRuntime({
      userDataDir: "/tmp",
      sectionId: "v8",
      version: "8.2.1",
      downloads
    });

    assert.equal(result.version, "8.2.1");
    assert.equal(SdkRuntimeManager.label, "Ren'Py");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].label, "Ren'Py");
    assert.equal(calls[0].managerId, "sdk");
    assert.equal(calls[0].sectionId, "v8");
    assert.equal(calls[0].version, "8.2.1");
  } finally {
    SdkRuntimeManager.core.installVersion = originalInstallVersion;
  }
});

test("sdk manager primes the launcher app on macOS after install", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-renpy-sdk-"));
  const launcherPath = path.join(tmpDir, "Ren'Py.app");
  fs.mkdirSync(launcherPath, { recursive: true });

  const calls = [];
  try {
    const primed = await SdkManager.__test.primeLauncherApp(launcherPath, {
      platform: "darwin",
      delayMs: 2500,
      runner: async (cmd, args, options) => {
        calls.push({ cmd, args, options });
        return { stdout: "", stderr: "" };
      }
    });

    assert.equal(primed, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, "/usr/bin/osascript");
    assert.equal(calls[0].args.at(-1), launcherPath);
    assert.ok(calls[0].args.includes("tell application appRef to launch"));
    assert.ok(calls[0].args.includes("tell application appRef to quit"));
    assert.ok(calls[0].args.includes("delay 2.5"));
    assert.equal(calls[0].options.signal, undefined);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("sdk manager skips app priming outside macOS or when the app is missing", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-renpy-sdk-"));
  const launcherPath = path.join(tmpDir, "Ren'Py.app");
  const runner = async () => {
    throw new Error("runner should not be called");
  };

  try {
    const skippedForPlatform = await SdkManager.__test.primeLauncherApp(launcherPath, {
      platform: "linux",
      runner
    });
    const skippedForMissingApp = await SdkManager.__test.primeLauncherApp(launcherPath, {
      platform: "darwin",
      runner
    });

    assert.equal(skippedForPlatform, false);
    assert.equal(skippedForMissingApp, false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Ren'Py catalog defaults to stable history and keeps Python generations separate", async () => {
  const index = '<a href="6.99.12/">old</a><a href="7.4.11/">7</a><a href="8.0.0/">8</a><a href="8.9.0/">future</a>';
  const fetcher = async url => ({
    status: 200, headers: {},
    body: Buffer.from(url.endsWith("/dl/") ? index : url.endsWith("latest-7.html") ? "Ren'Py 7.8.7" : "Ren'Py 8.6.1")
  });
  const v8 = await SdkManager.fetchAvailableVersions({ major: 8, fetcher });
  assert.deepEqual(v8.versions, ["8.6.1", "8.0.0"]);
  assert.equal(v8.latestStableVersion, "8.6.1");
  const v7 = await SdkManager.fetchAvailableVersions({ major: 7, fetcher });
  assert.deepEqual(v7.versions, ["7.8.7", "7.4.11", "6.99.12"]);
  const latest = await SdkManager.fetchAvailableVersions({ major: 8, latestOnly: true, fetcher });
  assert.deepEqual(latest.versions, ["8.6.1"]);
});

test("Ren'Py cancellation during stable metadata fetch is not treated as an optional failure", async () => {
  const controller = new AbortController();
  const fetcher = async url => {
    if (url.endsWith("/dl/")) return { status: 200, headers: {}, body: Buffer.from('<a href="8.0.0/">8</a>') };
    controller.abort();
    throw new Error("canceled metadata request");
  };
  await assert.rejects(SdkManager.fetchAvailableVersions({ major: 8, signal: controller.signal, fetcher }), { name: "AbortError" });
});

test("Ren'Py full refresh replaces reduced cache and preserves explicit global SDK choices", async () => {
  const original = SdkRuntimeManager.core.fetchAvailableVersions;
  const calls = [];
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-renpy-catalog-"));
  const settings = { v8: { defaultVersion: "8.0.0" } };
  try {
    SdkRuntimeManager.core.fetchAvailableVersions = async options => {
      calls.push(options.latestOnly);
      return { versions: options.latestOnly ? ["8.6.1"] : ["8.6.1", "8.0.0"], latestStableVersion: "8.6.1" };
    };
    await SdkRuntimeManager.refreshCatalog({ sectionId: "v8", force: true, latestOnly: true });
    const full = await SdkRuntimeManager.refreshCatalog({ sectionId: "v8" });
    assert.deepEqual(calls, [true, false]);
    assert.deepEqual(full.versions, ["8.6.1", "8.0.0"]);
    const state = SdkRuntimeManager.getState({ settings, userDataDir }).v8;
    assert.equal(state.defaultVersion, "8.0.0");
    assert.equal(state.supportsDefault, true);
    assert.equal(state.catalog.latestAvailableVersion, "8.6.1", "update metadata does not replace the saved SDK choice");
    assert.equal(state.catalog.supportsLatestOnly, false);
    assert.equal(state.catalog.mode, "all");
  } finally {
    SdkRuntimeManager.core.fetchAvailableVersions = original;
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("SDK choices survive installation and change only on an explicit setDefault action", () => {
  const settings = { v7: { defaultVersion: "7.4.11" }, v8: { defaultVersion: "8.0.0" } };
  assert.deepEqual(SdkRuntimeManager.normalizeSettings(settings), settings);
  assert.equal(SdkRuntimeManager.updateSettingsAfterInstall(settings, { version: "8.6.1" }, { major: 8 }), settings);
  assert.equal(SdkRuntimeManager.updateSettingsAfterUninstall(settings, { major: 8 }, { userDataDir: "/unused" }), settings);
  assert.deepEqual(SdkRuntimeManager.applySettingsUpdate("setDefault", { major: 8, version: "8.6.1" }, settings), { v7: settings.v7, v8: { defaultVersion: "8.6.1" } });
});
