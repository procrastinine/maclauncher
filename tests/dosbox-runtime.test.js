const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Catalog = require("../src/modules/dosbox/runtime/catalog");
const Manager = require("../src/modules/dosbox/runtime/manager");

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dosbox-runtime-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function release(version, { digest = "a".repeat(64), asset = true, ...fields } = {}) {
  const tag_name = `v${version}`, filename = `dosbox-staging-macOS-v${version}.dmg`;
  return { tag_name, assets: asset ? [{ id: 123, name: filename, size: 100,
    browser_download_url: `${Catalog.SOURCE_URL}/download/${tag_name}/${filename}`,
    ...(digest ? { digest: `sha256:${digest}` } : {}) }] : [], ...fields };
}

function discovery(releases) {
  return { fetchGithubReleases: async () => releases,
    fetchGithubTags: async () => releases.map(item => ({ name: item.tag_name, commit: { sha: "b".repeat(40) } })) };
}

test("DOSBox Staging discovers the complete stable universal era with exact publisher identities", async () => {
  const entries = await Catalog.createDiscovery(discovery([
    release("0.83.0"), release("0.82.2", { digest: null }), release("0.79.0", { asset: false }),
    release("0.78.0"), release("0.77.1"), release("0.84.0", { prerelease: true }),
    { tag_name: "dev-latest" }
  ]))();
  assert.deepEqual(entries.map(item => item.version), ["0.83.0", "0.82.2", "0.79.0", "0.78.0"]);
  assert.equal(entries[0].upstreamRevision, "b".repeat(40));
  assert.equal(entries[0].minimumMacOS, "12.0");
  assert.equal(entries[1].minimumMacOS, "11.0");
  assert.equal(entries[0].asset.sha256, "a".repeat(64));
  assert.equal(entries[1].asset.integrity, "recorded-local");
  assert.equal(entries[1].asset.assetId, 123);
  assert.equal(entries[2].asset, undefined);
  assert.match(entries[2].installReason, /universal macOS archive/);
  const wrongOrigin = release("0.83.0");
  wrongOrigin.assets[0].browser_download_url = "https://unrelated.invalid/runtime.dmg";
  const [blocked] = await Catalog.createDiscovery(discovery([wrongOrigin]))();
  assert.equal(blocked.asset, undefined);
});

test("DOSBox Staging status and selection stay offline while explicit refresh persists a replaceable catalogue", async t => {
  const userDataDir = temporary(t), releases = [release("0.83.0"), release("0.82.2")];
  let requests = 0, failure = false;
  const dependencies = discovery(releases);
  const manager = Manager.createManager({ ...dependencies, fetchGithubReleases: async () => {
    requests++;
    if (failure) throw new Error("catalog unavailable");
    return releases;
  } });
  assert.equal(manager.id, "dosbox-staging");
  assert.equal(manager.getState({ userDataDir }).catalog.status, "idle");
  assert.deepEqual(manager.getState({ userDataDir }).catalog.versions, []);
  assert.equal(manager.resolveSelection({}, {}, userDataDir).version, Manager.DEFAULT_VERSION);
  assert.equal(requests, 0);
  await manager.refreshCatalog({ userDataDir, force: true });
  assert.deepEqual(manager.getState({ userDataDir }).catalog.versions, ["0.83.0", "0.82.2"]);
  const preferences = manager.applySettingsUpdate("setDefault", { version: "0.82.2" }, {});
  const settings = { runtimes: { "dosbox-staging": preferences } };
  assert.equal(manager.resolveSelection({}, settings, userDataDir).version, "0.82.2");
  assert.equal(manager.resolveSelection({ runtimeData: { "dosbox-staging": { version: "0.83.0" } } }, settings, userDataDir).version, "0.83.0");
  assert.equal(requests, 1);
  failure = true;
  await assert.rejects(manager.refreshCatalog({ userDataDir, force: true }), /catalog unavailable/);
  const restarted = Manager.createManager({ fetchGithubReleases: () => assert.fail("Local state must not query GitHub") });
  assert.deepEqual(restarted.getState({ userDataDir }).catalog.versions, ["0.83.0", "0.82.2"]);
  failure = false;
  releases.pop();
  await manager.refreshCatalog({ userDataDir, force: true });
  assert.deepEqual(manager.getState({ userDataDir }).catalog.versions, ["0.83.0"]);
});

function app(root, version, cpu = 0x0100000c) {
  const executable = Manager.executablePath(root), bundle = path.join(root, "DOSBox Staging.app");
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(path.join(bundle, "Contents", "Info.plist"),
    `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`);
  const header = Buffer.alloc(32);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeUInt32LE(cpu, 4);
  header.writeUInt32LE(2, 12);
  fs.writeFileSync(executable, header, { mode: 0o755 });
}

test("DOSBox Staging installation checks the selected app version and native executable", async t => {
  const root = temporary(t), [pin] = await Catalog.createDiscovery(discovery([release("0.86.1")]))();
  app(root, "0.86.1-abcde");
  assert.deepEqual(Manager.prepareInstall({ unpacked: root, pin }),
    { appVersion: "0.86.1-abcde", architectures: ["arm64"] });
  app(root, "0.82.2");
  assert.throws(() => Manager.prepareInstall({ unpacked: root, pin }), /app version differs/);
  app(root, "0.86.1-abcde", 0x01000007);
  assert.throws(() => Manager.prepareInstall({ unpacked: root, pin }), /does not support Apple Silicon/);
});
