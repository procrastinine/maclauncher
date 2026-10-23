const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { runRuntimeManagerAction } = require("../src/core/runtime-manager-service");
const { createPinnedNativeManager } = require("../src/modules/shared/runtime/pinned-native-manager");
const { writeRuntimeCatalog } = require("../src/modules/shared/runtime/runtime-catalog");

test("fresh headless workers retain cached Play defaults and hydrate an explicit default selection offline", async t => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-default-cache-"));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  writeRuntimeCatalog({ userDataDir, managerId: "cached-default", entries: ["2.5.0", "2.6.0"].map(version =>
    ({ version, upstreamRevision: "a".repeat(40), localBuild: false })) });
  const make = () => createPinnedNativeManager({ id: "cached-default", label: "Cached tool", supportsDefault: true, catalog: [],
    discoverCatalog: () => assert.fail("Cached settings and Play selection must stay offline") });
  let settings = { defaultVersion: "2.5.0" };
  const beforeState = make();
  assert.equal(beforeState.normalizeSettings(settings).defaultVersion, "2.5.0");
  const selected = beforeState.resolveSelection({}, { runtimes: { "cached-default": settings } }, userDataDir);
  assert.equal(selected.version, "2.5.0"); assert.match(selected.reason, /not installed/);
  assert.throws(() => make().applySettingsUpdate("setDefault", { version: "2.6.0" }, settings), /Unsupported/);
  await runRuntimeManagerAction({ manager: make(), action: "setDefault", userDataDir,
    payload: { version: "v2.6.0" }, readSettings: () => settings, saveSettings: next => { settings = next; } });
  assert.equal(settings.defaultVersion, "2.6.0");
  assert.equal(make().resolveSelection({}, { runtimes: { "cached-default": settings } }, userDataDir).version, "2.6.0");
});

test("catalog refresh gets launcher-owned storage and broadcasts loading and completion", async () => {
  const states = [];
  let state = "idle";
  const manager = { async refreshCatalog(options) {
    assert.equal(options.userDataDir, "/owned/launcher");
    assert.equal(options.force, true);
    assert.equal(options.latestOnly, false);
    state = "loading";
    await Promise.resolve();
    state = "success";
    return { versions: ["1.16", "1.15", "1.14"] };
  } };
  const result = await runRuntimeManagerAction({ manager, action: "refreshCatalog",
    userDataDir: "/owned/launcher", payload: { userDataDir: "/untrusted", latestOnly: false },
    onStateChange: () => states.push(state) });
  assert.deepEqual(states, ["loading", "success"]);
  assert.deepEqual(result.versions, ["1.16", "1.15", "1.14"]);
});

test("runtime import uses a picked directory and persists the actual imported version", async () => {
  const calls = [];
  let settings = { defaultVersion: null };
  const manager = { id: "vendor",
    async importRuntime(options) { calls.push(options); return { version: "2026.1.2.3", ready: true }; },
    updateSettingsAfterInstall(current, record) { return { ...current, defaultVersion: current.defaultVersion || record.version }; }
  };
  await runRuntimeManagerAction({ manager, action: "import", userDataDir: "/owned/launcher",
    payload: { runtimeRoot: "/untrusted", version: "selected-version" }, chooseImportPath: () => "/picked/runtime",
    readSettings: () => settings, saveSettings: next => { settings = next; } });
  assert.equal(calls[0].runtimeRoot, "/picked/runtime");
  assert.equal(calls[0].runtimePath, "/picked/runtime");
  assert.equal(calls[0].version, "selected-version");
  assert.equal(settings.defaultVersion, "2026.1.2.3");
  calls.length = 0;
  const cancelled = await runRuntimeManagerAction({ manager, action: "import", chooseImportPath: () => null });
  assert.equal(cancelled, false);
  assert.equal(calls.length, 0);
});

test("independent installer setup does not change the selected runtime version", async () => {
  let setup;
  const manager = { async performSetupAction(options) { setup = options.setupActionId; return { version: "installer-build" }; },
    updateSettingsAfterInstall() { throw new Error("An installer is not a selected game runtime"); }
  };
  const result = await runRuntimeManagerAction({ manager, action: "setup", payload: { setupActionId: "installIgor" } });
  assert.equal(setup, "installIgor");
  assert.equal(result.version, "installer-build");
});

test("failed refresh broadcasts its final state and preserves the error", async () => {
  const states = [];
  let state = "idle";
  const failure = new Error("Provider unavailable");
  const manager = { async refreshCatalog() { state = "loading"; await Promise.resolve(); state = "error"; throw failure; } };
  await assert.rejects(runRuntimeManagerAction({ manager, action: "refreshCatalog", onStateChange: () => states.push(state) }), error => error === failure);
  assert.deepEqual(states, ["loading", "error"]);
});

test("installed library actions target exactly one installed section/version and use injected file input", async () => {
  let settings = { defaultVersion: "8.4.1" }, input, performed;
  const manager = {
    getState: () => ({ sections: [{ id: "v8", installed: [{ version: "8.5.3", actions: [
      { id: "importLive2D", available: true, inputKind: "file", extensions: ["zip"] }
    ] }] }] }),
    performInstalledAction: async options => { performed = options; return { ready: true }; },
    updateSettingsAfterInstall: () => assert.fail("library installation cannot change the SDK default")
  };
  const base = { manager, action: "installedAction", userDataDir: "/owned", readSettings: () => settings,
    saveSettings: next => { settings = next; }, payload: { sectionId: "v8", version: "8.5.3", installedActionId: "importLive2D" } };
  await runRuntimeManagerAction({ ...base, chooseInstalledActionInput: action => {
    input = action; return { archivePath: "/selected/live2d.zip" };
  } });
  assert.equal(input.extensions[0], "zip"); assert.equal(performed.userDataDir, "/owned");
  assert.equal(performed.version, "8.5.3"); assert.equal(performed.archivePath, "/selected/live2d.zip");
  assert.equal(settings.defaultVersion, "8.4.1");
  performed = null;
  assert.equal(await runRuntimeManagerAction({ ...base, chooseInstalledActionInput: () => null }), false);
  assert.equal(performed, null);
  await assert.rejects(runRuntimeManagerAction({ ...base, payload: { ...base.payload, version: "8.5.2" } }), /unavailable/);
  await assert.rejects(runRuntimeManagerAction({ ...base, payload: { ...base.payload, sectionId: "v7" } }), /unavailable/);
  await runRuntimeManagerAction({ ...base, payload: { ...base.payload, filePaths: ["/headless/cubism.zip"] } });
  assert.deepEqual(performed.filePaths, ["/headless/cubism.zip"]);
});

test("headless runtime imports accept an explicit directory without requiring Electron", async () => {
  let imported;
  await runRuntimeManagerAction({ manager: { importRuntime: options => { imported = options; return { version: "1.0" }; } },
    action: "import", userDataDir: "/owned", payload: { runtimePath: "/chosen/runtime" } });
  assert.equal(imported.runtimePath, "/chosen/runtime"); assert.equal(imported.runtimeRoot, "/chosen/runtime");
});

test("manager setup receives trusted prerequisite consent without changing runtime defaults", async () => {
  const calls = [];
  const confirmRuntimeInstall = () => { calls.push("consent"); return { approved: true, licenseAccepted: true }; };
  const rosetta = { ensure: async context => {
    assert.equal(context.userDataDir, "/owned");
    assert.equal(context.confirmRuntimeInstall, confirmRuntimeInstall);
    assert.deepEqual(await context.confirmRuntimeInstall({ label: "Rosetta" }), { approved: true, licenseAccepted: true });
    calls.push("prerequisite");
  } };
  await runRuntimeManagerAction({ action: "setup", userDataDir: "/owned", rosetta,
    payload: { confirmRuntimeInstall: "untrusted", setupActionId: "installTool" },
    prerequisiteContext: { confirmRuntimeInstall }, manager: {
      performSetupAction: async context => { await context.ensureRosetta(); calls.push("setup"); return true; },
      updateSettingsAfterInstall: () => assert.fail("tool prerequisites cannot change runtime defaults")
    } });
  assert.deepEqual(calls, ["consent", "prerequisite", "setup"]);
});
