// Required first: it replaces the network before modules load.
const Harness = require("./helpers/future-upstream.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Catalog = require("../src/modules/dosbox/runtime/catalog");
const Manager = require("../src/modules/dosbox/runtime/manager");
const { stoppedDownloads, assertConsentedDiscovery, assertReceiptOffline } = require("./helpers/catalog-only-runtime.cjs");

const repository = "dosbox-staging/dosbox-staging";
function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dosbox-runtime-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function release(version, { digest = true, asset = true, ...fields } = {}) {
  const value = Harness.githubRelease(repository, `v${version}`, asset ? [`dosbox-staging-macOS-v${version}.dmg`] : [], fields);
  if (!digest) for (const item of value.assets) delete item.digest;
  return value;
}
function routes(releases) { return Harness.githubRoutes(repository, releases); }
async function refresh(manager, userDataDir, releases) {
  Harness.network.routes = routes(releases);
  try { return await manager.refreshCatalog({ userDataDir, force: true }); } finally { Harness.network.routes = null; }
}

test("DOSBox Staging lists stable releases from 0.78.0 with the publisher's digests", async t => {
  const userDataDir = temporary(t), manager = Manager.createManager();
  const releases = [release("0.83.0"), release("0.82.2", { digest: false }), release("0.79.0", { asset: false }),
    release("0.78.0"), release("0.77.1"), release("0.84.0", { prerelease: true }), { ...release("0.85.0"), tag_name: "dev-latest" }];
  await refresh(manager, userDataDir, releases);
  const entries = manager.core.listDiscoveredCatalog({ userDataDir });
  assert.deepEqual([...new Set(entries.map(item => item.version))], ["0.83.0", "0.82.2", "0.79.0", "0.78.0"]);
  const row = version => entries.find(item => item.version === version);
  assert.match(row("0.83.0").upstreamRevision, /^[a-f0-9]{40}$/);
  assert.equal(row("0.83.0").asset.sha256, releases[0].assets[0].digest.slice(7));
  assert.equal(row("0.82.2").asset.integrity, "recorded-local");
  assert.equal(row("0.79.0").asset, undefined);
  assert.match(row("0.79.0").installReason, /no macOS download/);
});

test("DOSBox Staging status and selection stay offline while explicit refresh persists a replaceable catalogue", async t => {
  const userDataDir = temporary(t), releases = [release("0.83.0"), release("0.82.2")], manager = Manager.createManager();
  assert.equal(manager.id, "dosbox-staging");
  assert.equal(manager.getState({ userDataDir }).catalog.status, "idle");
  assert.deepEqual(manager.getState({ userDataDir }).catalog.versions, []);
  const automatic = manager.resolveSelection({}, {}, userDataDir);
  assert.equal(automatic.version, null); assert.equal(automatic.discoveryRequired, true);
  const before = Harness.network.requests.length;
  manager.getState({ userDataDir }); manager.resolveSelection({}, {}, userDataDir);
  assert.equal(Harness.network.requests.length, before, "Local state stays offline");
  await refresh(manager, userDataDir, releases);
  assert.deepEqual(manager.getState({ userDataDir }).catalog.versions, ["0.83.0", "0.82.2"]);
  const preferences = manager.applySettingsUpdate("setDefault", { version: "0.82.2" }, {});
  const settings = { runtimes: { "dosbox-staging": preferences } };
  assert.equal(manager.resolveSelection({}, settings, userDataDir).version, "0.82.2");
  assert.equal(manager.resolveSelection({ runtimeData: { "dosbox-staging": { version: "0.83.0" } } }, settings, userDataDir).version, "0.83.0");
  Harness.network.routes = {};
  await assert.rejects(manager.refreshCatalog({ userDataDir, force: true }));
  Harness.network.routes = null;
  assert.deepEqual(Manager.createManager().getState({ userDataDir }).catalog.versions, ["0.83.0", "0.82.2"]);
  await refresh(manager, userDataDir, releases.slice(0, 1));
  assert.deepEqual(manager.getState({ userDataDir }).catalog.versions, ["0.83.0"]);
});

test("DOSBox Staging discovers inside a consented install and keeps earlier installations offline", { skip: process.platform !== "darwin" }, async t => {
  const downloads = stoppedDownloads(), releases = [release("0.83.0"), release("0.84.0")];
  const manager = Manager.createManager({ downloadToFile: downloads.downloadToFile });
  const releasesUrl = `https://api.github.com/repos/${repository}/releases`;
  const count = () => Harness.network.requests.filter(url => url.startsWith(releasesUrl)).length, start = count();
  const discoveries = () => count() - start;
  Harness.network.routes = routes(releases);
  t.after(() => { Harness.network.routes = null; });
  await assertConsentedDiscovery({ manager, userDataDir: temporary(t), discoveries, downloads,
    newestUrl: releases[1].assets[0].browser_download_url });
  Harness.network.routes = null;
  assertReceiptOffline({ manager: Manager.createManager(), userDataDir: temporary(t),
    pin: { version: "0.83.0", upstreamRevision: "7b40053b7ac580843d0461eba8c36a47a990e66c", upstreamTag: "v0.83.0", minimumMacOS: "12.0",
      hostArchitectures: ["arm64", "x64"], localBuild: false, asset: { filename: "dosbox-staging-macOS-v0.83.0.dmg",
        url: `${Catalog.SOURCE_URL}/download/v0.83.0/dosbox-staging-macOS-v0.83.0.dmg`, bytes: 44531761,
        sha256: "d8a771adfb8010fa6b5f7fb5351abfba659273ad01c89f03675a92bdbdae8167" } } });
});

function app(root, version, cpu = 0x0100000c) {
  const bundle = path.join(root, "DOSBox Staging.app"), executable = path.join(bundle, "Contents", "MacOS", "dosbox");
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(path.join(bundle, "Contents", "Info.plist"),
    `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`);
  const header = Buffer.alloc(32);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeUInt32LE(cpu, 4);
  header.writeUInt32LE(2, 12);
  fs.writeFileSync(executable, header, { mode: 0o755 });
}

test("DOSBox Staging installation finds the app wherever the release puts it and checks its CPU", t => {
  const root = temporary(t), nested = path.join(root, "nested", "DOSBox Staging 99");
  app(root, "0.86.1-abcde");
  assert.deepEqual(Manager.prepareInstall({ unpacked: root }, { arch: "arm64" }), { architectures: ["arm64"] });
  app(root, "0.86.1-abcde", 0x01000007);
  assert.throws(() => Manager.prepareInstall({ unpacked: root }, { arch: "arm64" }), /does not support this Mac/);
  assert.deepEqual(Manager.prepareInstall({ unpacked: root }, { arch: "x64" }).architectures, ["x86_64"]);
  app(nested, "1.0.0");
  assert.equal(Manager.executablePath(path.join(root, "nested")), Manager.executablePath(nested));
});
