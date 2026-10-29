const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const Modules = require("../src/modules/registry");
const Manager = require("../src/modules/crossover/runtime/manager");
const Detection = require("../src/modules/crossover/detect");
const { composeRuntimeProviders } = require("../src/modules/shared/runtime/providers");
const { createLauncher } = require("../src/core/launcher");
const { canLaunchEntry, resolveRuntimeSupportForEntry } = require("../src/core/launch-capability");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "windows-engine-play-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bytes = Buffer.alloc(1024), executable = path.join(root, "Game.exe");
  bytes.writeUInt16LE(0x5a4d, 0); bytes.writeUInt32LE(128, 60);
  bytes.writeUInt32LE(0x4550, 128); bytes.writeUInt16LE(0x14c, 132); bytes.writeUInt16LE(1, 134);
  bytes.writeUInt16LE(240, 148); bytes.writeUInt16LE(2, 150);
  bytes.writeUInt16LE(0x10b, 152); bytes.writeUInt16LE(2, 220);
  fs.writeFileSync(executable, bytes);
  return { root, launcher: createLauncher({ userDataDir: root, registry: Modules }),
    entry: Detection.decorateEntry({ gameId: "game", gamePath: root, contentRootDir: root }) };
}

for (const id of ["bgi", "catsystem2", "haxe"]) {
  test(`${id} automatically plays with CrossOver when installed, otherwise Sikarugir`, { skip: process.platform !== "darwin" }, t => {
    const { root, launcher, entry } = fixture(t), mod = Modules.getModule(id), info = mod.manifest;
    entry.moduleId = id; entry.runtimeId = info.runtime.default;
    const before = JSON.stringify(entry), actions = Object.keys(require(`../src/modules/${id}/main`).actions || {});
    for (const available of [false, true]) {
      const mock = t.mock.method(Manager, "isAvailable", () => available);
      const context = { userDataDir: root, settings: {} };
      const selected = launcher.resolveRuntimeForEntry(entry.runtimeId, mod, info, entry, {}, {});
      assert.equal(selected, available ? "crossover" : "sikarugir");
      assert.equal(canLaunchEntry({ mod, info, entry, runtimeId: selected, context }), true);
      assert.equal(canLaunchEntry({ mod, info, entry, runtimeId: info.runtime.default, context }), false);
      assert.equal(launcher.resolveRuntimeForEntry("sikarugir", mod, info, entry, {}, {}), "sikarugir");
      if (available) assert.equal(launcher.resolveRuntimeForEntry(null, mod, info, entry,
        { defaultRuntime: "sikarugir" }, {}), "sikarugir");
      assert.equal(JSON.stringify(entry), before);
      assert.equal(mod.id, id);
      for (const action of actions) assert.equal(typeof mod.actions[action], "function", action);
      mock.mock.restore();
    }
  });

  test(`${id} data without a Windows executable remains inspectable`, t => {
    const { root, launcher, entry } = fixture(t), mod = Modules.getModule(id), info = mod.manifest;
    fs.rmSync(path.join(root, "Game.exe"));
    entry.moduleId = id;
    const context = { userDataDir: root, settings: {} };
    const selected = launcher.resolveRuntimeForEntry(info.runtime.default, mod, info, entry, {}, {});
    assert.equal(canLaunchEntry({ mod, info, entry, runtimeId: selected, context }), false);
    assert.ok(!resolveRuntimeSupportForEntry(mod, info, entry, {}, context).includes("sikarugir"));
  });
}

test("provider fallback follows actual engine applicability and retains a working engine default", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "engine-provider-fallback-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const nativeAppPath = path.join(root, "Future.app");
  fs.mkdirSync(nativeAppPath);
  const mod = composeRuntimeProviders({ id: "future-engine", manifest: { id: "future-engine", runtime: {
    default: "native", supported: ["native"] } }, canLaunchRuntime: (_id, entry) => entry.nativeCompatible },
  [{ runtimeId: "shared", supportsEntry: entry => entry.sharedCompatible, launchRuntime() {} }]);
  const registry = { listModules: () => [mod.manifest], getModule: () => mod, getModuleInfo: () => mod.manifest,
    listSharedRuntimeManagers: () => [] };
  const launcher = createLauncher({ userDataDir: root, registry });
  for (const nativeCompatible of [true, false]) {
    const entry = { moduleId: mod.id, nativeAppPath, gamePath: root, nativeCompatible, sharedCompatible: true };
    assert.equal(launcher.resolveRuntimeForEntry(null, mod, mod.manifest, entry, {}, {}), nativeCompatible ? "native" : "shared");
  }
});
