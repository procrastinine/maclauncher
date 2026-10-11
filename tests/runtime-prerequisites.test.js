const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createLauncher } = require("../src/core/launcher");
const { prepareForLaunch } = require("../src/core/runtime-preparation");
const Nscripter = require("../src/modules/nscripter/manifest.json");

function fixture(t, { webReady = false, hostReady = false, decline = null, hostDamaged = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-runtime-prerequisites-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const gamePath = path.join(root, "game");
  fs.mkdirSync(gamePath);
  const userDataDir = path.join(root, "userData");
  fs.mkdirSync(userDataDir);
  const settings = { runtimes: { onsyuri: { web: { defaultVersion: "0.7.7beta" } }, nwjs: { defaultVersion: "0.107.0" } } };
  fs.writeFileSync(path.join(userDataDir, "settings.json"), JSON.stringify(settings));
  const calls = [], ready = { web: webReady, host: hostReady };
  const managers = [
    { id: "onsyuri", label: "Onscripter Yuri", getState: () => ({ sections: [
      { id: "mac", defaultVersion: "mac-release", installed: [] },
      { id: "web", defaultVersion: "0.7.7beta", installed: ready.web ? [{ version: "0.7.7beta" }] : [] }
    ] }), installRuntime: async payload => { calls.push(["install", "onsyuri", payload.version, payload.sectionId]); ready.web = true; } },
    { id: "nwjs", label: "NW.js", getState: () => ({ sections: [
      { id: "default", defaultVersion: "0.107.0", defaultVariant: "sdk", installed:
        ready.host || hostDamaged ? [{ version: "0.117.0", variant: "sdk", ready: !hostDamaged }] : [] },
      { id: "greenworks", defaultVersion: "unrelated", installed: [] }
    ] }), installRuntime: async payload => { calls.push(["install", "nwjs", payload.version, payload.sectionId, payload.variant]); ready.host = true; } }
  ];
  const mod = { id: "nscripter", manifest: structuredClone(Nscripter), runtimeManagers: [],
    launchRuntime: async runtimeId => {
      assert.equal(runtimeId, "onsyuri_web");
      assert.equal(ready.web, true, "Yuri payload must be installed before launch");
      assert.equal(ready.host, true, "NW host must be installed before launch");
      calls.push(["launch"]);
      return { pid: 123 };
    } };
  const registry = { listModules: () => [mod.manifest], listModuleIds: () => [mod.id], getModule: () => mod, getModuleInfo: () => mod.manifest,
    listSharedRuntimeManagers: () => managers,
    detectGame: input => ({ moduleId: mod.id, name: "Original title", gamePath: input }) };
  const launcher = createLauncher({ userDataDir, registry,
    confirmRuntimeInstall: plan => { calls.push(["consent", plan.managerId, plan.version]); return plan.managerId !== decline; } });
  const entry = { moduleId: mod.id, gamePath, gameId: "test", runtimeId: "onsyuri_web",
    runtimeData: { "nwjs-patched": { version: "0.117.0", variant: "sdk" } } };
  return { calls, settings, userDataDir, launcher, entry, mod, registry, managers, ready };
}

test("original Yuri web declaration prepares its payload and NW host through the Node launcher", async t => {
  const f = fixture(t);
  assert.deepEqual(Nscripter.runtime.prerequisites.onsyuri_web,
    [{ managerId: "nwjs", runtimeId: "nwjs-patched", sectionId: "default" }]);
  assert.equal((await f.launcher.launchEntry(f.entry)).kind, "process");
  assert.deepEqual(f.calls, [
    ["consent", "onsyuri", "0.7.7beta"], ["consent", "nwjs", "0.117.0"],
    ["install", "onsyuri", "0.7.7beta", "web"], ["install", "nwjs", "0.117.0", "default", "sdk"], ["launch"]
  ]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.userDataDir, "settings.json"))), f.settings);
});

test("an installed Yuri web payload still prepares a missing NW host using its exact separate override", async t => {
  const f = fixture(t, { webReady: true });
  f.entry.runtimeData.onsyuri_web = { version: "0.7.7beta" };
  await f.launcher.launchEntry(f.entry);
  assert.deepEqual(f.calls, [["consent", "nwjs", "0.117.0"], ["install", "nwjs", "0.117.0", "default", "sdk"], ["launch"]]);
});

test("a transient explicit web selection plans the web section while preserving the stored native selection", async t => {
  const f = fixture(t, { hostReady: true });
  f.entry.runtimeId = "onsyuri_mac";
  await f.launcher.launchEntry(f.entry, { runtimeId: "onsyuri_web" });
  assert.deepEqual(f.calls, [["consent", "onsyuri", "0.7.7beta"], ["install", "onsyuri", "0.7.7beta", "web"], ["launch"]]);
  assert.equal(f.entry.runtimeId, "onsyuri_mac");
});

test("a ready NW host needs no prompt or installation when only the Yuri payload is missing", async t => {
  const f = fixture(t, { hostReady: true });
  await f.launcher.launchEntry(f.entry);
  assert.deepEqual(f.calls, [["consent", "onsyuri", "0.7.7beta"], ["install", "onsyuri", "0.7.7beta", "web"], ["launch"]]);
});

test("a fresh backend reuses installed Yuri web metadata when its catalog and global default are empty", async t => {
  const f = fixture(t, { webReady: true, hostReady: true });
  f.managers[0].getState = () => ({ sections: [{ id: "web", defaultVersion: null,
    catalog: { versions: [], latestInstalledVersion: "0.7.7beta" }, installed: [{ version: "0.7.7beta" }] }] });
  f.managers[0].refreshCatalog = () => assert.fail("An installed web payload must stay offline on a warm launch");
  await f.launcher.launchEntry(f.entry);
  assert.deepEqual(f.calls, [["launch"]]);
});

test("catalog resolution rechecks an already installed selected release before planning a download", async t => {
  const f = fixture(t, { webReady: true, hostReady: true });
  let refreshed = false;
  f.managers[0].getState = () => ({ sections: [{ id: "web", defaultVersion: null,
    catalog: { versions: refreshed ? ["0.7.7beta"] : [] }, installed: [{ version: "0.7.7beta" }] }] });
  f.managers[0].refreshCatalog = async () => { refreshed = true; };
  await f.launcher.launchEntry(f.entry);
  assert.equal(refreshed, true);
  assert.deepEqual(f.calls, [["launch"]]);
});

test("declining the second prerequisite prevents both installations and launch", async t => {
  const f = fixture(t, { decline: "nwjs" });
  assert.equal((await f.launcher.launchEntry(f.entry)).kind, "cancelled");
  assert.deepEqual(f.calls, [["consent", "onsyuri", "0.7.7beta"], ["consent", "nwjs", "0.117.0"]]);
});

test("a damaged installed host is prepared again and does not count as ready", async t => {
  const f = fixture(t, { webReady: true, hostDamaged: true });
  await f.launcher.launchEntry(f.entry);
  assert.deepEqual(f.calls, [["consent", "nwjs", "0.117.0"], ["install", "nwjs", "0.117.0", "default", "sdk"], ["launch"]]);
});

test("module rejection precedes prerequisite lookups or consent", async t => {
  const f = fixture(t);
  f.mod.ensureRuntime = () => { throw new Error("Unsupported original export"); };
  f.managers[1].getState = () => assert.fail("An incompatible game must not plan a host");
  await assert.rejects(f.launcher.launchEntry(f.entry), /Unsupported original export/);
  assert.deepEqual(f.calls, []);
});

test("duplicate declarations install the same exact host once", async t => {
  const f = fixture(t, { webReady: true });
  f.mod.manifest.runtime.prerequisites.onsyuri_web.push({ ...f.mod.manifest.runtime.prerequisites.onsyuri_web[0] });
  await f.launcher.launchEntry(f.entry);
  assert.deepEqual(f.calls, [["consent", "nwjs", "0.117.0"], ["install", "nwjs", "0.117.0", "default", "sdk"], ["launch"]]);
});

test("dependency resolvers receive their selection runtime without changing the game's selected runtime", async () => {
  const entry = { runtimeId: "game", runtimeData: { host: { version: "3" } } };
  const manager = { id: "host", resolveSelection: async value => {
    assert.equal(value.runtimeId, "host");
    return { version: value.runtimeData.host.version, ready: false };
  }, installRuntime() {} };
  const installed = [];
  assert.equal(await prepareForLaunch({ entry, mod: {}, info: { runtime: { prerequisites: { game: [{ managerId: "host", runtimeId: "host" }] } } },
    context: { runtimeId: "game", settings: { runtimes: {} }, userDataDir: "/private-profile" },
    registry: { listModuleIds: () => [], listSharedRuntimeManagers: () => [manager] },
    install: async (_manager, payload) => installed.push(payload.version)
  }), true);
  assert.deepEqual(installed, ["3"]);
  assert.equal(entry.runtimeId, "game");
});
