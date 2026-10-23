const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { buildStoragePatchScript, buildNwjsStorageInjection } = require("../src/modules/shared/mvmz/storage-patch");
const { buildRpgmakerModule } = require("../src/modules/shared/mvmz/rpgmaker-module");
const Nwjs = require("../src/modules/shared/web/runtime/nwjs-launcher");
const PatchedNwjs = require("../src/modules/shared/web/runtime/nwjs-patched-launcher");

for (const engineId of ["mv", "mz"]) {
  test(`${engineId} storage loaded after the host injection writes only to the selected save folder`, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-storage-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const original = path.join(root, "original", "save");
    const selected = path.join(root, "selected saves 'quoted'");
    fs.mkdirSync(original, { recursive: true });
    const pending = [];
    const window = {};
    const sandbox = { window, console, setTimeout: callback => pending.push(callback) };
    const injection = buildNwjsStorageInjection(engineId, { defaultSaveDir: original, saveDirOverride: selected });
    vm.runInNewContext(injection.extraFiles[0].contents, sandbox);
    assert.equal(pending.length, 1);
    const storage = { isLocalMode: () => false };
    const method = engineId === "mv" ? "localFileDirectoryPath" : "fileDirectoryPath";
    storage[method] = () => original + path.sep;
    const save = name => {
      const folder = storage[method]();
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(path.join(folder, name), "saved-state");
    };
    storage[engineId === "mv" ? "save" : "saveZip"] = save;
    window.StorageManager = storage;
    pending.shift()();
    const name = engineId === "mv" ? "file1.rpgsave" : "file1.rmmzsave";
    save(name);
    assert.equal(storage.isLocalMode(), true);
    assert.equal(fs.readFileSync(path.join(selected, name), "utf8"), "saved-state");
    assert.deepEqual(fs.readdirSync(original), []);
    assert.equal(pending.length, 0);
    // Repeated host injection preserves the exact installed methods.
    const installedMethod = storage[method];
    vm.runInNewContext(buildStoragePatchScript(engineId, selected), sandbox);
    assert.equal(storage[method], installedMethod);
  });
}

test("storage injection retains the detected save location without an override and stops polling absent APIs", () => {
  assert.deepEqual(buildNwjsStorageInjection("mv", {}), {});
  const injection = buildNwjsStorageInjection("mv", { defaultSaveDir: "/detected/save" });
  assert.deepEqual(injection.injectStart, [injection.extraFiles[0].path]);
  const pending = [];
  vm.runInNewContext(injection.extraFiles[0].contents, {
    window: {}, console, setTimeout: callback => pending.push(callback)
  });
  let calls = 0;
  while (pending.length) { pending.shift()(); calls++; }
  assert.equal(calls, 4000);
});

test("both MV/MZ module launch paths supply the same chosen save location to ordinary and patched NW.js", async t => {
  const previous = [Nwjs.launchRuntime, PatchedNwjs.launchRuntime];
  t.after(() => { [Nwjs.launchRuntime, PatchedNwjs.launchRuntime] = previous; });
  Nwjs.launchRuntime = async options => options;
  PatchedNwjs.launchRuntime = async options => options;
  for (const engineId of ["mv", "mz"]) {
    const module = buildRpgmakerModule({ manifest: { id: engineId, supports: {} }, engineId });
    const entry = { gamePath: "/original", defaultSaveDir: "/original/save", saveDirOverride: "/selected/save",
      runtimeData: { "nwjs-patched": { version: "0.117.0" } } };
    const context = { userDataDir: "/profile", settings: {} };
    const ordinary = await module.launchRuntime("nwjs", entry, context);
    const patched = await module.launchRuntime("nwjs-patched", entry, context);
    const expected = buildNwjsStorageInjection(engineId, entry);
    for (const result of [ordinary, patched]) {
      assert.deepEqual(result.injectStart, expected.injectStart);
      assert.deepEqual(result.extraFiles, expected.extraFiles);
    }
  }
});
