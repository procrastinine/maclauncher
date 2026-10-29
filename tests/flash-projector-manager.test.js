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

test("Flash starts empty, discovers its universal package only on Refresh, and reuses its local catalog", async t => {
  const network = t.mock.method(https, "get", () => assert.fail("Status must remain offline"));
  const version = "fixture-projector", id = "flash-projector", tag = `${id}/v${version}/universal`;
  const filename = `${id}-${version}-universal.tar.gz`;
  const record = { schemaVersion: 2, id, version, arch: "universal", launcherArchitectures: ["arm64", "x64"],
    minimumMacOS: "13.0", manifestRelative: "manifest.json", manifestSha256: "a".repeat(64),
    sourceSha256: "b".repeat(64), updatePolicy: "manual", tag,
    asset: { filename, bytes: 1, sha256: "c".repeat(64),
      url: `https://github.com/procrastinine/maclauncher-builds/releases/download/${encodeURIComponent(tag)}/${filename}` } };
  let requests = 0;
  const manager = Projector.__test.createManager({ dependencies: { fetchUrlBuffer: async () => {
    requests++; return { status: 200, body: Buffer.from(JSON.stringify({schemaVersion: 2, projectId: id, updatePolicy: "manual", packages: [record]})) };
  } } });
  const root = temporary(t), state = manager.getState({ userDataDir: root });
  assert.deepEqual(state.catalog.versions, []);
  assert.deepEqual(state.catalog.installableVersions, []);
  assert.deepEqual(state.catalog.includedVersions, []);
  assert.deepEqual(state.installed, []);
  assert.equal(requests, 0);
  await manager.refreshCatalog({ userDataDir: root, force: true });
  const cached = manager.getState({ userDataDir: root });
  assert.deepEqual(cached.catalog.versions, [version]);
  assert.deepEqual(cached.catalog.installableVersions, [version]);
  assert.equal(cached.catalog.versionRequirements[version].requiresDownload, true);
  assert.equal(manager.resolveSelection(null, {}, root).ready, false);
  const pin = manager.core.catalog.find(pin => pin.version === version);
  assert.match(pin.asset.url, /^https:\/\/github.com\/procrastinine\/maclauncher-builds\/releases\/download\//);
  assert.deepEqual(pin.hostArchitectures, ["arm64", "x64"]);
  assert.equal(manager.delivery.included, "none");
  for (const method of ["installRuntime", "uninstallRuntime", "refreshCatalog"]) assert.equal(typeof manager[method], "function");
  assert.equal(requests, 1);
  assert.equal(network.mock.callCount(), 0);
});

test("Flash verifies the unchanged vendor version independently of the package revision", t => {
  const Bundled = require("../src/modules/shared/runtime/bundled-native");
  const AppBundle = require("../src/modules/shared/runtime/app-bundle");
  const Native = require("../src/modules/shared/runtime/local-native");
  const info = { CFBundleShortVersionString: "35.0.0.1",
    CFBundleExecutable: "Flash Player", CFBundleIdentifier: "com.macromedia.Flash Player.app" };
  t.mock.method(Bundled, "verifyPayload", () => {});
  t.mock.method(AppBundle, "readInfoPlist", () => info);
  t.mock.method(AppBundle, "validateAppBundle", () => {});
  t.mock.method(Native, "readMachOArchitectures", () => ["arm64", "x86_64"]);
  const selected = { root: temporary(t), payloadRoot: temporary(t), declaration: {}, manifest: { version: "fixture-projector" } };
  assert.doesNotThrow(() => Projector.__test.verifyProjector(selected));
  info.CFBundleShortVersionString = "not-a-vendor-version";
  assert.throws(() => Projector.__test.verifyProjector(selected), /different version/);
});

test("first projector Play obtains download consent before installing and reuses an installed player", async t => {
  const root = temporary(t), settings = { runtimes: {} }, events = [];
  const version = "fixture-projector";
  let installed = false, approve = false;
  t.mock.method(Projector, "resolveSelection", () => ({ version, ready: installed,
    install: installed ? { version } : null }));
  const args = { entry: { gameType: "scripted", runtimeId: "projector" }, mod: Flash, info: Flash.manifest,
    context: { runtimeId: "projector", userDataDir: root, settings,
      confirmRuntimeInstall: async plan => { events.push(["consent", plan.managerId, plan.version]); return approve; } },
    registry: { listModuleIds: () => ["flash"], getModule: () => Flash },
    install: async (manager, options) => { events.push(["install", manager.id, options.version]); installed = true; } };
  assert.equal(await prepareForLaunch(args), false);
  assert.deepEqual(events, [["consent", "flash-projector", version]]);
  events.length = 0; approve = true;
  assert.equal(await prepareForLaunch(args), true);
  assert.deepEqual(events, [["consent", "flash-projector", version], ["install", "flash-projector", version]]);
  events.length = 0;
  assert.equal(await prepareForLaunch(args), true);
  assert.deepEqual(events, []);
});
