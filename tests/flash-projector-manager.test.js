const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), https = require("node:https");
const Projector = require("../src/modules/flash/runtime/projector-manager");
const Flash = require("../src/modules/flash/main");
const { prepareForLaunch } = require("../src/core/runtime-preparation");

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flash-projector-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("Flash offers its exact universal Builds package offline without an included installation", t => {
  const network = t.mock.method(https, "get", () => assert.fail("Status must remain offline"));
  const root = temporary(t), state = Projector.getState({ userDataDir: root });
  assert.deepEqual(state.catalog.versions, ["35.0.0.60"]);
  assert.deepEqual(state.catalog.installableVersions, ["35.0.0.60"]);
  assert.deepEqual(state.catalog.includedVersions, []);
  assert.deepEqual(state.installed, []);
  assert.equal(state.catalog.versionRequirements["35.0.0.60"].requiresDownload, true);
  assert.equal(Projector.resolveSelection(null, {}, root).ready, false);
  const pin = Projector.core.catalog.find(pin => pin.version === "35.0.0.60");
  assert.match(pin.asset.url, /^https:\/\/github.com\/procrastinine\/maclauncher-builds\/releases\/download\//);
  assert.deepEqual(pin.hostArchitectures, ["arm64", "x64"]);
  assert.equal(Projector.delivery.included, "none");
  for (const method of ["installRuntime", "uninstallRuntime", "refreshCatalog"]) assert.equal(typeof Projector[method], "function");
  assert.equal(network.mock.callCount(), 0);
});

test("first projector Play obtains download consent before installing and reuses an installed player", async t => {
  const root = temporary(t), settings = { runtimes: {} }, events = [];
  let installed = false, approve = false;
  t.mock.method(Projector, "resolveSelection", () => ({ version: "35.0.0.60", ready: installed,
    install: installed ? { version: "35.0.0.60" } : null }));
  const args = { entry: { gameType: "scripted", runtimeId: "projector" }, mod: Flash, info: Flash.manifest,
    context: { runtimeId: "projector", userDataDir: root, settings,
      confirmRuntimeInstall: async plan => { events.push(["consent", plan.managerId, plan.version]); return approve; } },
    registry: { listModuleIds: () => ["flash"], getModule: () => Flash },
    install: async (manager, options) => { events.push(["install", manager.id, options.version]); installed = true; } };
  assert.equal(await prepareForLaunch(args), false);
  assert.deepEqual(events, [["consent", "flash-projector", "35.0.0.60"]]);
  events.length = 0; approve = true;
  assert.equal(await prepareForLaunch(args), true);
  assert.deepEqual(events, [["consent", "flash-projector", "35.0.0.60"], ["install", "flash-projector", "35.0.0.60"]]);
  events.length = 0;
  assert.equal(await prepareForLaunch(args), true);
  assert.deepEqual(events, []);
});
