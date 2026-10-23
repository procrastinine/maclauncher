const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const test = require("node:test");
const Isolation = require("../src/modules/shared/runtime/network-isolation");
const { launchIsolatedHost, ASSET_ORIGIN_ENV } = require("../src/modules/shared/web/runtime/isolated-host");

test("runtime metadata has no duplicate network control and preserves independent child-process choices", () => {
  const source = { runtime: { supported: ["native", "web"], entries: { web: { settings: {
    defaults: { enableProtections: true, networkIsolation: true }, fields: [
      { key: "enableProtections", type: "boolean", label: "Enable protections", description: "Old network help" },
      { key: "networkIsolation", type: "boolean" }] } } } } };
  const once = Isolation.withNetworkSettings(source);
  assert.deepEqual(Isolation.withNetworkSettings(once), once);
  assert.equal(source.runtime.entries.native, undefined);
  assert.equal(source.runtime.entries.web.settings.defaults.networkIsolation, true);
  assert.deepEqual(once.runtime.entries.native.settings, { defaults: {}, fields: [] });
  const web = once.runtime.entries.web.settings;
  assert.deepEqual(web.defaults, { enableProtections: true });
  assert.equal(web.fields[0].label, "Block child processes");
  assert.doesNotMatch(web.fields[0].description, /network|Internet/i);
  const registry = require("../src/modules/registry");
  for (const module of registry.listModules()) for (const entry of Object.values(module.runtime?.entries || {})) {
    if (entry.launch === false) continue;
    assert.equal(entry.settings.fields.some(field => field.key === "networkIsolation"), false, module.id);
    assert.equal(Object.hasOwn(entry.settings.defaults, "networkIsolation"), false, module.id);
  }
});

test("network normalization preserves legacy choices, initial defaults and fixed capability limits", () => {
  const Policy = require("../src/core/network-access");
  const info = { runtime: { entries: { runner: {}, fixed: { networkAccess: false } } } };
  const entry = { runtimeId: "runner", runtimeSettings: {
    runner: { networkIsolation: false, enableProtections: true },
    other: { networkIsolation: true } } };
  assert.equal(Policy.overrideForEntry(entry, "other"), true);
  assert.equal(Policy.allowedForEntry(entry, {}, info, "runner"), true);
  assert.equal(Policy.allowedForEntry({ ...entry, networkAccess: false }, { launcher: { networkAccess: true } }, info, "runner"), false);
  assert.equal(Policy.allowedForEntry({ ...entry, networkAccess: null }, {}, info, "runner"), false);
  assert.equal(Policy.allowedForEntry({ ...entry, networkAccess: null }, { launcher: { networkAccess: true } }, info, "runner"), true);
  assert.equal(Policy.allowedForEntry({ networkAccess: true }, { launcher: { networkAccess: true } }, info, "fixed"), false);
  assert.equal(Policy.allowedForEntry({}, {}, info, "runner"), false);
  assert.equal(Policy.allowedForEntry({}, { launcher: { networkAccess: "true" } }, info, "runner"), false);
  assert.equal(Policy.overrideForEntry({ runtimeSettings: { runner: { enableProtections: false } } }, "runner"), true);
  assert.equal(Policy.overrideForEntry({ runtimeId: "runner", runtimeSettings: { other: { networkIsolation: false } } }), null);
  const android = Isolation.withNetworkSettings(require("../src/modules/android/manifest.json"));
  for (const [id, entry] of Object.entries(android.runtime.entries)) {
    assert.equal(entry.settings.fields.some(field => field.key === "networkIsolation"), false);
    if (entry.networkAccess === false)
      assert.equal(Policy.allowedForEntry({ networkAccess: true }, { launcher: { networkAccess: true } }, android, id), false);
  }
});

test("sandbox command preserves DYLD as literal arguments and permits only the selected asset IP port", { skip: process.platform !== "darwin" }, () => {
  const literal = "spaces $(must-not-run) `nor-this` ; = quoted";
  const [command, args] = Isolation.wrap("/Game/bin/game", ["--literal", literal], { DYLD_INSERT_LIBRARIES: literal, SECRET: "omit" }, { platform: "darwin", assetPort: 32123 });
  assert.equal(command, "/usr/bin/sandbox-exec");
  assert.ok(args.includes(`DYLD_INSERT_LIBRARIES=${literal}`)); assert.ok(!args.includes("omit"));
  assert.match(args[1], /deny network\*/); assert.match(args[1], /localhost:32123/);
  assert.doesNotMatch(args[1], /ip "\*|localhost:\*/);
  assert.deepEqual(args.slice(-3), ["/Game/bin/game", "--literal", literal]);
  assert.throws(() => Isolation.profile({ assetPort: '1") (allow network*)' }), /invalid port/);
  assert.throws(() => Isolation.wrap("/usr/bin/open", [], {}, { platform: "darwin" }), /directly/);
  assert.throws(() => Isolation.wrap("/game", [], {}, { platform: "linux" }), /requires macOS/);
});

test("checked isolation fails closed when policy confirmation never arrives; Android applied policy is not nested", { skip: process.platform !== "darwin" }, async () => {
  const { PassThrough } = require("node:stream");
  const { createProcessLauncher } = require("../src/core/processes");
  const calls = [];
  let child;
  const launcher = createProcessLauncher({ spawn: (...args) => {
    calls.push(args); child = new EventEmitter(); child.pid = 123; child.exitCode = child.signalCode = null;
    child.stdio = [null, null, null, new PassThrough()];
    child.unref = () => { child.emit("spawn"); child.stdio[3].end(); };
    child.kill = () => { child.killed = true; };
    return child;
  } });
  await assert.rejects(launcher.spawnDetachedChecked("/game", [], { networkIsolation: true }), /could not enforce/);
  assert.equal(child.killed, true);
  await launcher.spawnDetachedChecked("/usr/bin/sandbox-exec", ["-f", "/owned/android.sb", "/java"],
    { networkIsolation: true, networkIsolationApplied: true });
  assert.deepEqual(calls[1], ["/usr/bin/sandbox-exec", ["-f", "/owned/android.sb", "/java"],
    { stdio: "ignore", detached: true }]);
  await assert.rejects(launcher.spawnDetachedChecked("/usr/bin/open", [], { networkIsolation: true }, true), /directly/);
});

test("isolated web host owns one confined asset port and closes it after startup failure or child exit", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "network-host-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const indexHtml = path.join(root, "index.html"); fs.writeFileSync(indexHtml, "game");
  const entry = { gamePath: root, indexHtml, moduleId: "web" };
  const context = { runtimeSettings: { networkIsolation: true } };
  let closed = 0, forwarded;
  const child = new EventEmitter(); child.exitCode = child.signalCode = null;
  const dependencies = { registry: { getModule: () => ({}) },
    createServer: async directory => { assert.equal(directory, root); return { port: 32123, close: async () => { closed++; } }; },
    launch: async options => { assert.equal(options.env[ASSET_ORIGIN_ENV], "http://127.0.0.1:32123");
      options.spawn("electron", ["host"], { env: options.env }); return child; } };
  assert.equal(await launchIsolatedHost({ env: {}, spawn: (...args) => { forwarded = args; } }, entry, context, dependencies), child);
  assert.equal(forwarded[2].networkIsolation, true); assert.equal(forwarded[2].networkAssetPort, 32123);
  child.emit("exit", 0); assert.equal(closed, 1);
  await assert.rejects(launchIsolatedHost({ env: {} }, entry, context, { ...dependencies, launch: async () => { throw new Error("failed"); } }), /failed/);
  assert.equal(closed, 2);
});
