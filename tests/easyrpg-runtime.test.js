const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Manager = require("../src/modules/easyrpg/runtime/manager");
const Catalog = require("../src/modules/easyrpg/runtime/catalog");

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "easyrpg-runtime-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function dependencies() {
  return {
    fetchGithubReleases: async () => ["0.8.1.1", "0.8.1", "0.8", "0.7.0", "unrelated"].map(tag_name => ({ tag_name })),
    fetchGithubTags: async () => ["0.8.1.1", "0.8.1", "0.8"].map(name => ({ name, commit: { sha: "a".repeat(40) } })),
    headArtifact: async () => ({ bytes: 1000 })
  };
}

test("EasyRPG catalogs live compatible releases and retains exact publisher artifact metadata", async () => {
  const entries = await Catalog.createDiscovery(dependencies())({});
  assert.deepEqual(entries.map(entry => entry.version), ["0.8.1.1", "0.8.1", "0.8"]);
  assert.ok(entries.every(entry => Catalog.validateRecordedArtifact(entry.asset, entry)));
  assert.ok(entries.every(entry => entry.upstreamRevision === "a".repeat(40)));
  const entry = entries[0];
  for (const asset of [{ ...entry.asset, url: "https://unrelated.invalid/runtime.zip" }, { ...entry.asset, artifactId: "wrong" }, { ...entry.asset, bytes: 0 }, { ...entry.asset, filename: "../runtime.zip" }]) {
    assert.equal(Catalog.validateRecordedArtifact(asset, entry), false);
  }
});

test("EasyRPG release lookup propagates cancellation and marks missing Mac archives unavailable", async () => {
  const signal = new AbortController().signal;
  let observedSignal;
  const entries = await Catalog.createDiscovery({ ...dependencies(), headArtifact: async (_url, options) => { observedSignal = options.signal; return null; } })({ signal });
  assert.equal(observedSignal, signal);
  assert.ok(entries.every(entry => !entry.asset && /No Mac app/.test(entry.installReason)));
});

test("EasyRPG keeps offline state network-free, replaces refreshed rows and retains cached releases on errors", async t => {
  const userDataDir = temporary(t), deps = dependencies();
  let requests = 0, fail = false;
  const manager = Manager.createManager({ ...deps, fetchGithubReleases: async () => { requests++; if (fail) throw new Error("catalog unavailable"); return deps.fetchGithubReleases(); } });
  assert.equal(manager.getState({ userDataDir }).catalog.status, "idle");
  assert.equal(requests, 0);
  assert.equal(manager.resolveSelection({}, {}, userDataDir).version, "0.8.1.1");
  assert.equal(requests, 0);
  await manager.refreshCatalog({ userDataDir, force: true });
  assert.deepEqual(manager.getState({ userDataDir }).catalog.versions, ["0.8.1.1", "0.8.1", "0.8"]);
  await manager.refreshCatalog({ userDataDir, force: true });
  assert.equal(new Set(manager.getState({ userDataDir }).catalog.versions).size, 3);
  fail = true;
  await assert.rejects(manager.refreshCatalog({ userDataDir, force: true }), /catalog unavailable/);
  assert.deepEqual(manager.getState({ userDataDir }).catalog.versions, ["0.8.1.1", "0.8.1", "0.8"]);
  const fresh = Manager.createManager({ fetchGithubReleases: () => { throw new Error("network must stay offline"); } });
  assert.deepEqual(fresh.getState({ userDataDir }).catalog.versions, ["0.8.1.1", "0.8.1", "0.8"]);
  const settings = manager.applySettingsUpdate("setDefault", { version: "0.8" }, { defaultVersion: "0.8" });
  assert.equal(manager.getState({ userDataDir }).supportsDefault, false);
  assert.deepEqual(manager.normalizeSettings(settings), { defaultVersion: null });
  assert.equal(manager.resolveSelection({}, { runtimes: { easyrpg: settings } }, userDataDir).version, "0.8.1.1");
  assert.equal(manager.resolveSelection({ runtimeData: { easyrpg: { version: "0.8.1" } } }, { runtimes: { easyrpg: settings } }, userDataDir).version, "0.8.1");
  assert.equal(manager.resolveSelection({ runtimeData: { easyrpg: { version: "0.8" } } }, {}, userDataDir).version, "0.8");
  assert.equal(manager.updateSettingsAfterInstall(settings, { version: "0.8.1.1" }), undefined);
});
