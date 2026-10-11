const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createLauncher } = require("../src/core/launcher");
const Nwjs = require("../src/modules/shared/web/runtime/nwjs-manager");
const modules = ["mv", "mz", "tyrano"].map(id => require(`../src/modules/${id}/main`));
const registry = {
  listModules: () => modules.map(mod => mod.manifest),
  getModule: id => modules.find(mod => mod.id === id),
  getModuleInfo: id => modules.find(mod => mod.id === id)?.manifest
};
const mac = process.platform === "darwin";
const usable = { version: "0.103.1", variant: "sdk", platformKey: "osx-x64", ready: true };

function fixture(t, options = {}) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-rpgmaker-default-"));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  let state = options.state;
  if (options.settings) fs.writeFileSync(path.join(userDataDir, "settings.json"), JSON.stringify(options.settings));
  const launcher = createLauncher({ userDataDir, registry,
    ...(options.offlineInventory ? {} : { getRuntimeManagerState: id => {
      assert.equal(id, "nwjs"); return state;
    } }) });
  return {
    launcher, userDataDir, setState: value => { state = value; },
    select: (id, requested, entry = {}, settings = launcher.loadSettings()) => {
      const mod = registry.getModule(id);
      return launcher.resolveRuntimeForEntry(requested, mod, mod.manifest, entry, settings.modules[id], settings);
    }
  };
}

test("MV/MZ prefer patched NW.js from any usable installed version without a game scan or runtime scan", { skip: !mac }, t => {
  t.mock.method(Nwjs.core, "listInstalled", () => assert.fail("Use the existing manager snapshot"));
  t.mock.method(Nwjs, "refreshCatalog", () => assert.fail("Selection is offline"));
  t.mock.method(Nwjs, "installRuntime", () => assert.fail("Selection cannot install"));
  const f = fixture(t, { state: { installed: [usable] } });
  for (const id of ["mv", "mz"]) {
    assert.equal(f.launcher.loadSettings().modules[id].defaultRuntime, "");
    assert.equal(f.select(id), "nwjs-patched");
    assert.equal(f.select(id, "unsupported"), "nwjs-patched");
  }
  assert.equal(fs.existsSync(path.join(f.userDataDir, "settings.json")), false);
});

test("MV/MZ use Electron when NW.js is absent, damaged or incompatible with the host", t => {
  t.mock.method(Nwjs.core, "listInstalled", () => assert.fail("A missing snapshot must not trigger a scan"));
  const f = fixture(t);
  const states = [undefined, { installed: [] }, { installed: [{ ...usable, ready: false }] },
    { installed: [{ ...usable, platformKey: "linux-x64" }] }, { installed: [{ ...usable, variant: "normal" }] }];
  for (const state of states) {
    f.setState(state);
    for (const id of ["mv", "mz"]) assert.equal(f.select(id), "electron");
  }
});

test("MV/MZ preserve explicit global hosts even without installed NW.js", t => {
  t.mock.method(Nwjs.core, "listInstalled", () => assert.fail("Explicit defaults need no inventory"));
  const f = fixture(t);
  for (const selected of ["electron", "nwjs", "nwjs-patched"]) {
    for (const id of ["mv", "mz"]) {
      const settings = f.launcher.loadSettings();
      settings.modules[id].defaultRuntime = selected;
      assert.equal(f.select(id, undefined, {}, settings), selected);
      assert.equal(f.launcher.getResolvedModuleSettings(settings)[id].defaultRuntime, selected);
    }
  }
});

test("MV/MZ preserve per-game host and exact version choices over automatic and global defaults", { skip: !mac }, t => {
  let lookups = 0;
  const f = fixture(t, { state: { installed: [usable] } });
  const launcher = createLauncher({ userDataDir: f.userDataDir, registry,
    getRuntimeManagerState: () => { lookups++; return { installed: [usable] }; } });
  for (const id of ["mv", "mz"]) {
    const mod = registry.getModule(id);
    for (const selected of ["electron", "nwjs", "nwjs-patched"]) {
      const entry = { runtimeId: selected, runtimeData: { [selected]: { version: "0.107.0" } } };
      const before = structuredClone(entry);
      const settings = launcher.loadSettings();
      settings.modules[id].defaultRuntime = "nwjs-patched";
      settings.runtimes.nwjs = { defaultVersion: "0.117.0" };
      assert.equal(launcher.resolveRuntimeForEntry(selected, mod, mod.manifest, entry, settings.modules[id], settings), selected);
      assert.deepEqual(entry, before);
      assert.equal(settings.runtimes.nwjs.defaultVersion, "0.117.0");
    }
  }
  assert.equal(lookups, 0, "Saved game hosts do not need an automatic-default inventory");
});

test("installed NW.js does not change Tyrano's hosted default", t => {
  const f = fixture(t, { state: { installed: [usable] } });
  assert.equal(f.select("tyrano"), "electron");
  assert.equal(f.launcher.getResolvedModuleSettings().tyrano.defaultRuntime, "electron");
});

test("resolved UI defaults follow new manager snapshots without persisting or replacing saved choices", { skip: !mac }, t => {
  const f = fixture(t, { settings: { modules: { mv: { defaultRuntime: "electron" } } } });
  const file = path.join(f.userDataDir, "settings.json"), before = fs.readFileSync(file);
  const settings = f.launcher.loadSettings(), original = structuredClone(settings);
  assert.equal(f.launcher.getResolvedModuleSettings(settings).mz.defaultRuntime, "electron");
  f.setState({ installed: [usable] });
  const displayed = f.launcher.getResolvedModuleSettings(settings);
  assert.equal(displayed.mv.defaultRuntime, "electron");
  assert.equal(displayed.mz.defaultRuntime, "nwjs-patched");
  assert.equal(f.select("mz", "electron"), "electron");
  f.setState({ installed: [] });
  assert.equal(f.launcher.getResolvedModuleSettings(settings).mz.defaultRuntime, "electron");
  assert.deepEqual(settings, original);
  assert.deepEqual(fs.readFileSync(file), before);
});

test("plain Node MV/MZ selection reuses the existing offline installed-runtime inventory", { skip: !mac }, t => {
  const f = fixture(t, { offlineInventory: true });
  t.mock.method(Nwjs, "refreshCatalog", () => assert.fail("No release lookup"));
  assert.equal(f.select("mv"), "electron");
  const app = path.join(f.userDataDir, "runtimes", "nwjs", usable.version, usable.platformKey, usable.variant, "nwjs.app");
  const executable = path.join(app, "Contents", "MacOS", "nwjs");
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(executable, "runtime fixture", { mode: 0o755 });
  fs.writeFileSync(path.join(app, "Contents", "Info.plist"), "<plist><dict><key>CFBundleExecutable</key><string>nwjs</string></dict></plist>");
  assert.equal(f.select("mv"), "nwjs-patched");
  assert.equal(f.select("mz"), "nwjs-patched");
  fs.chmodSync(executable, 0o644);
  assert.equal(f.select("mv"), "electron");
});
