const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const Module = require("../src/modules/android/main");
const Runtime = require("../src/modules/android/runtime");

test("Android is a discovered APK module with local settings and shared graphics", () => {
  const modules = require("../src/modules/registry");
  const module = modules.getModule("android");
  assert.ok(module);
  assert.equal(module.manifest.runtime.entries.klepton.graphicsHost, "explicit");
  for (const runtime of ["macapk", "aim"]) {
    assert.equal(module.manifest.runtime.entries[runtime].graphicsHost, "window");
    assert.equal(modules.getModuleInfo("android").runtime.entries[runtime].graphicsHost, "window");
  }
  assert.equal(module.manifest.detection.extensions[0].extension, ".apk");
  assert.equal(module.manifest.runtime.default, "klepton");
  assert.deepEqual(Module.manifest.runtime.supported, ["klepton", "macapk", "aim"]);
  assert.deepEqual(Module.runtimeManagers.map(manager => manager.id), ["android", "android-art", "macapk", "android-aim", "jadx"]);
  assert.deepEqual(Object.keys(Module.actions).sort(), ["addToGooglePlay", "decompileApk", "importFiles", "inspectGame", "listAngleBackends", "listGoogleAccounts", "listMediaInputs", "listVulkanRuntimes", "revealDecompiled", "runtimeStatus"]);
  for (const id of ["klepton", "macapk", "aim"]) assert.equal(Module.normalizeRuntimeId(id), id);
  assert.equal(Module.manifest.ui.accounts.stateAction, "googleAccounts");
  assert.equal(Module.manifest.ui.accountProviders[0].stateAction, "macapkGoogleAccounts");
  const aim = Module.manifest.runtime.entries.aim.settings;
  assert.equal(module.manifest.runtime.entries.aim.settings.fields.some(field => field.key === "networkIsolation"), false);
  assert.equal(Object.hasOwn(module.manifest.runtime.entries.aim.settings.defaults, "networkIsolation"), false);
  assert.equal(Object.hasOwn(aim.defaults, "launchMode"), false);
  assert.equal(aim.fields.some(field => field.key === "launchMode"), false);
  assert.equal(Object.keys(aim.defaults).some(key => key.startsWith("google")), false);
  assert.equal(aim.fields.some(field => field.key.startsWith("google")), false);
});

test("Android import reports the actual save location without preparing files", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "android-module-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userDataDir = path.join(root, "state"), entry = { gameId: "game" };
  Module.onImport(entry, { userDataDir });
  assert.equal(entry.defaultSaveDir, path.join(userDataDir, "android/apps/game/data/files"));
  assert.equal(fs.existsSync(userDataDir), false);
  assert.throws(() => Module.onImport({ gameId: "../escape" }, { userDataDir }), /saved game/);
});

test("Android save tools prepare private storage before Play and preserve legacy import files", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "android-save-tools-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userDataDir = path.join(root, "state"), old = path.join(root, "old-saves");
  fs.mkdirSync(old);fs.writeFileSync(path.join(old, "save.dat"), "original");
  const entry = { gameId: "game", defaultSaveDir: "/stale", saveDirOverride: old };
  const locations = Module.resolveSaveLocations(entry, { userDataDir });
  assert.equal(locations.primaryDirectory, path.join(userDataDir, "android/apps/game/data/files"));
  assert.equal(Module.manifest.supports.saveLocationOverride, false);
  await Module.prepareSaveLocation(entry, { userDataDir });
  assert.equal(fs.readFileSync(path.join(locations.primaryDirectory, "save.dat"), "utf8"), "original");
  assert.equal(fs.readFileSync(path.join(old, "save.dat"), "utf8"), "original");
  await Module.prepareSaveLocation(entry, { userDataDir });
});

test("Android provider selection preserves custom data and uses distinct save roots", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "android-provider-selection-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const entry = { gameId: "game", runtimeId: "klepton" };
  const original = path.join(root, "android/apps/game/data/files");
  fs.mkdirSync(original, { recursive: true });
  fs.writeFileSync(path.join(original, "save.dat"), "existing");
  assert.equal(Module.resolveSaveLocations(entry, { userDataDir: root }).primaryDirectory, original);
  for (const runtimeId of ["macapk", "aim"]) {
    const selected = { ...entry, runtimeId };
    Module.onImport(selected, { userDataDir: root });
    assert.equal(selected.defaultSaveDir, path.join(root, "android/apps/game/providers", runtimeId, "android"));
    assert.equal(Module.resolveSaveLocations(selected, { userDataDir: root }).primaryDirectory, selected.defaultSaveDir);
    assert.equal(Module.getRuntimeProvider(runtimeId).supports.saveLocationOverride, false);
  }
  assert.equal(fs.readFileSync(path.join(original, "save.dat"), "utf8"), "existing");
  assert.equal(Module.getRuntimeProvider("klepton"), null);
  assert.deepEqual(fs.readdirSync(path.join(root, "android/apps/game")), ["data"]);
});

test("Android included runtime requires ARM macOS and checks metadata identity before launch", t => {
  assert.throws(() => Runtime.resolve({ platform: "linux", arch: "arm64" }), /Apple Silicon/);
  assert.throws(() => Runtime.resolve({ platform: "darwin", arch: "x64" }), /Apple Silicon/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "android-runtime-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "runtime.json"), JSON.stringify({ schemaVersion: 1, profile: { javaMajor: 21 } }));
  assert.throws(() => Runtime.resolve({ root, platform: "darwin", arch: "arm64", macOSVersion: "27.0" }), /metadata has changed/);
  assert.equal(Runtime.status({ root, platform: "darwin", arch: "arm64" }).ready, false);
});
