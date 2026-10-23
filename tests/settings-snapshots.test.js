const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createSettingsSnapshots } = require("../src/core/settings-snapshots");
const { createRuntimeCoordinator } = require("../src/core/runtime-coordinator");
const { readJsonObject, writeJsonAtomic } = require("../src/core/json-files");

function environment(t, initial = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-settings-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "settings.json");
  writeJsonAtomic(file, initial);
  const coordinator = createRuntimeCoordinator({ userDataDir: root });
  const host = coordinator.client(), worker = coordinator.client();
  const normalize = value => {
    value.launcher = { showIcons: true, ...value.launcher };
    value.modules = value.modules || {};
    value.runtimes = value.runtimes || {};
    delete value.obsolete;
    return value;
  };
  const store = createSettingsSnapshots({
    readSettings: () => readJsonObject(file), normalize,
    commitSettings: (before, after) => host.applySettings(before, after)
  });
  return { file, worker, store };
}

test("delayed host edits preserve worker runtime selections and current migrations", async t => {
  const { file, worker, store } = environment(t, { obsolete: true });
  const settings = store.load();
  await Promise.resolve().then(() => worker.applySettings({}, {
    runtimes: { runner: { defaultVersion: "2", versions: { one: true } } }
  }));
  settings.launcher.compact = true;
  store.save(settings);
  const saved = readJsonObject(file);
  assert.equal(saved.launcher.compact, true);
  assert.equal(saved.runtimes.runner.defaultVersion, "2");
  assert.deepEqual(saved.runtimes.runner.versions, { one: true });
  assert.equal(Object.hasOwn(saved, "obsolete"), false);
  assert.deepEqual(settings, saved);
});

test("a cold host's implicit defaults do not overwrite a newer explicit preference", t => {
  const { file, worker, store } = environment(t);
  const settings = store.load();
  assert.equal(settings.launcher.showIcons, true);
  worker.applySettings({}, { launcher: { showIcons: false }, modules: { demo: { defaultRuntime: "native" } } });
  settings.launcher.compact = true;
  store.save(settings);
  assert.equal(readJsonObject(file).launcher.showIcons, false);
  assert.equal(settings.launcher.showIcons, false);
  assert.equal(settings.modules.demo.defaultRuntime, "native");
});

test("saving a refreshed snapshot again does not replay an earlier edit", t => {
  const { file, worker, store } = environment(t);
  const settings = store.load();
  settings.launcher.compact = true;
  store.save(settings);
  worker.applySettings({ launcher: { compact: true } }, { launcher: { compact: false } });
  settings.launcher.showIcons = false;
  store.save(settings);
  assert.deepEqual(readJsonObject(file).launcher, { showIcons: false, compact: false });
  assert.equal(settings.launcher.compact, false);
});

test("explicit deletion survives normalization and unrelated worker changes", t => {
  const { file, worker, store } = environment(t, { modules: { demo: { preferred: "one", keep: true } } });
  const settings = store.load();
  worker.applySettings({}, { runtimes: { runner: { defaultVersion: "3" } } });
  delete settings.modules.demo.preferred;
  store.save(settings);
  const saved = readJsonObject(file);
  assert.deepEqual(saved.modules.demo, { keep: true });
  assert.equal(saved.runtimes.runner.defaultVersion, "3");
});

test("untracked settings objects cannot replace an existing document", t => {
  const { file, store } = environment(t, { launcher: { showIcons: false } });
  assert.throws(() => store.save({ launcher: {} }), /loaded snapshot/);
  assert.deepEqual(readJsonObject(file), { launcher: { showIcons: false } });
});
