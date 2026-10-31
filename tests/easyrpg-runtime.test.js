// Required first: it replaces the network before modules load.
const Harness = require("./helpers/future-upstream.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Manager = require("../src/modules/easyrpg/runtime/manager");
const Catalog = require("../src/modules/easyrpg/runtime/catalog");
const Fixture = require("./future-upstream/easyrpg.cjs");

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "easyrpg-runtime-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const listings = () => Harness.network.requests.filter(url => url === Catalog.ARCHIVE_URL).length;
async function discover(routes, options = {}) {
  Harness.network.routes = routes;
  try { return await Catalog.source.discover(options); } finally { Harness.network.routes = null; }
}

test("EasyRPG lists the publisher's release folders from 0.8 with their Mac app archives", async () => {
  const entries = await discover({ ...Fixture.current, ...Fixture.scenarios.newVersion.routes });
  assert.deepEqual(entries.map(entry => entry.version), ["0.9", "0.8.1.1", "0.8.1"]);
  assert.deepEqual(entries[1].files.map(file => [file.name, file.url, file.digest]),
    [["easyrpg-player-0.8.1.1-macos.app.zip", `${Catalog.ARCHIVE_URL}0.8.1.1/easyrpg-player-0.8.1.1-macos.app.zip`, undefined]]);
  assert.equal(entries[1].sourceUrl, `${Catalog.ARCHIVE_URL}0.8.1.1/`);
  assert.deepEqual((await discover(Fixture.scenarios.newVersion.routes, { latestOnly: true })).map(entry => entry.version), ["0.9"]);
});

test("EasyRPG follows a renamed Mac archive and lists a release without one with its reason", async () => {
  const renamed = await discover(Fixture.scenarios.renamedAsset.routes);
  assert.deepEqual(renamed[0].files.map(file => file.name), ["easyrpg-player-0.9-macos-universal.dmg"]);
  const routes = { ...Fixture.current, [`${Catalog.ARCHIVE_URL}0.8.1/`]: "<a href=\"easyrpg-player-0.8.1-windows.zip\">windows</a>" };
  const entries = await discover(routes);
  assert.deepEqual(entries.find(entry => entry.version === "0.8.1").files, []);
  assert.match(entries.find(entry => entry.version === "0.8.1").installReason, /No Mac app/);
});

test("EasyRPG discovers inside a consented install and keeps earlier installations offline", { skip: process.platform !== "darwin" }, async t => {
  const { stoppedDownloads, assertConsentedDiscovery, assertReceiptOffline } = require("./helpers/catalog-only-runtime.cjs");
  const downloads = stoppedDownloads(), start = listings();
  const manager = Manager.createManager({ downloadToFile: downloads.downloadToFile });
  Harness.network.routes = Fixture.current;
  t.after(() => { Harness.network.routes = null; });
  await assertConsentedDiscovery({ manager, userDataDir: temporary(t), discoveries: () => listings() - start, downloads,
    newestUrl: `${Catalog.ARCHIVE_URL}0.8.1.1/easyrpg-player-0.8.1.1-macos.app.zip` });
  Harness.network.routes = null;
  const filename = "easyrpg-player-0.8.1.1-macos.app.zip";
  assertReceiptOffline({ manager: Manager.createManager(), userDataDir: temporary(t),
    pin: { version: "0.8.1.1", upstreamRevision: "78328fa29f465315291e161130e6682f69410370", upstreamTag: "0.8.1.1", localBuild: false,
      asset: { filename, artifactId: filename, url: `${Catalog.ARCHIVE_URL}0.8.1.1/${filename}`, bytes: 13814322, integrity: "recorded-local",
        sha256: "3e0fdcc388797fd9117aa6b1fc3b1d93dbb457b7102abfe8227d6822543aba93" } } });
});

test("EasyRPG keeps offline state network-free, replaces refreshed rows and retains cached releases on errors", async t => {
  const userDataDir = temporary(t), manager = Manager.createManager(), start = listings();
  assert.equal(manager.getState({ userDataDir }).catalog.status, "idle");
  assert.equal(manager.resolveSelection({}, {}, userDataDir).version, null);
  assert.equal(manager.resolveSelection({}, {}, userDataDir).discoveryRequired, true);
  assert.equal(listings(), start);
  const refresh = async routes => {
    Harness.network.routes = routes;
    try { return await manager.refreshCatalog({ userDataDir, force: true }); } finally { Harness.network.routes = null; }
  };
  await refresh(Fixture.current);
  assert.deepEqual(manager.getState({ userDataDir }).catalog.versions, ["0.8.1.1", "0.8.1"]);
  await refresh(Fixture.current);
  assert.equal(new Set(manager.getState({ userDataDir }).catalog.versions).size, 2);
  await assert.rejects(refresh({}));
  assert.deepEqual(manager.getState({ userDataDir }).catalog.versions, ["0.8.1.1", "0.8.1"]);
  const before = Harness.network.requests.length, fresh = Manager.createManager();
  assert.deepEqual(fresh.getState({ userDataDir }).catalog.versions, ["0.8.1.1", "0.8.1"]);
  assert.equal(Harness.network.requests.length, before, "Cached state stays offline");
  const settings = manager.applySettingsUpdate("setDefault", { version: "0.8.1" }, { defaultVersion: "0.8.1" });
  assert.equal(manager.getState({ userDataDir }).supportsDefault, true);
  assert.deepEqual(manager.normalizeSettings(settings), { defaultVersion: "0.8.1" });
  assert.equal(manager.resolveSelection({}, { runtimes: { easyrpg: settings } }, userDataDir).version, "0.8.1");
  assert.equal(manager.resolveSelection({ runtimeData: { easyrpg: { version: "0.8.1.1" } } }, { runtimes: { easyrpg: settings } }, userDataDir).version, "0.8.1.1");
  assert.deepEqual(manager.updateSettingsAfterInstall(settings, { version: "0.8.1.1" }), settings);
});
