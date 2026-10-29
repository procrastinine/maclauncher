const assert = require("node:assert/strict");
const fs = require("node:fs");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const Manager = require("../src/modules/shared/web/runtime/nwjs-manager");
const Nwjs = require("../src/modules/shared/web/runtime/nwjs-launcher");
const Patched = require("../src/modules/shared/web/runtime/nwjs-patched-launcher");
const Python = require("../src/modules/shared/runtime/python");

test("missing shared NW.js runtimes fail launch without contacting catalogs or installing", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-hardening-offline-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const network = t.mock.method(https, "get", () => { throw new Error("unexpected network request"); });
  const install = t.mock.method(Manager, "installRuntime", () => { throw new Error("unexpected installation"); });
  t.mock.method(Manager.core, "resolveBestInstalled", () => null);
  for (const launcher of [Nwjs, Patched]) {
    await assert.rejects(launcher.launchRuntime({
      userDataDir: root,
      entry: { gameId: "game", gamePath: root, contentRootDir: root, gameType: "web" },
      settings: {}
    }), /not installed.*Install it from Runtimes/);
  }
  assert.equal(network.mock.callCount(), 0);
  assert.equal(install.mock.callCount(), 0);
});

test("shared bundled Python resolution and command construction remain offline", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-hardening-python-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const network = t.mock.method(https, "get", () => { throw new Error("unexpected network request"); });
  assert.ok(Python.resolvePythonBinary({ userDataDir: root }).pythonPath);
  assert.deepEqual(Python.buildEvbunpackCommand({ userDataDir: root }).args, ["-B", "-m", "evbunpack"]);
  assert.equal(network.mock.callCount(), 0);
});
