const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { createProjectBuildManager } = require("../src/modules/shared/runtime/project-build-manager");

async function fixture(t) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "project-intent-"));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  const id = "project-intent", runtimeId = "project-runtime", repository = "example/runtime-builds";
  const packages = ["2.0", "1.0"].map(version => {
    const tag = `${id}/v${version}/universal`, filename = `${id}-${version}-universal.tar.gz`;
    return { schemaVersion: 2, id, version, arch: "universal", launcherArchitectures: ["arm64", "x64"], minimumMacOS: "13.0",
      manifestRelative: "manifest.json", manifestSha256: "a".repeat(64), sourceSha256: "b".repeat(64), updatePolicy: "manual", tag,
      asset: { filename, bytes: 1, sha256: "c".repeat(64),
        url: `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${filename}` } };
  });
  let requests = 0;
  const manager = createProjectBuildManager({ projectId: id, runtimeId, label: "Project intent", repository,
    manifestRelative: "manifest.json", sourceRelative: null, executableRelative: "entry.js", dataOnly: true,
    verifyPayload: () => assert.fail("Selection must not install or inspect an unavailable payload"),
    dependencies: { systemVersionSync: () => "26.0", fetchUrlBuffer: async () => {
      requests++; return { status: 200, body: Buffer.from(JSON.stringify({ schemaVersion: 2, projectId: id, updatePolicy: "manual", packages })) };
    } } });
  await manager.refreshCatalog({ userDataDir, force: true });
  const select = (entry = {}, settings = {}, options = {}) => {
    const before = requests, result = manager.resolveSelection(entry, settings, userDataDir, options);
    assert.equal(requests, before, "selection uses the explicitly refreshed catalog offline");
    return result;
  };
  return { id, runtimeId, select, userDataDir };
}

test("project manager preserves an automatic caller through internal exact-version selection", async t => {
  const f = await fixture(t), selected = f.select();
  assert.equal(selected.version, "2.0"); assert.equal(selected.automatic, true);
  assert.equal(selected.selectionSource, "default");
  assert.equal(selected.ready, false); assert.equal(selected.install, null);
});

test("project manager retains explicit game and action version ownership", async t => {
  const f = await fixture(t);
  for (const selected of [f.select({}, {}, { version: "1.0" }), f.select({ runtimeData: { [f.runtimeId]: { version: "1.0" } } })]) {
    assert.equal(selected.version, "1.0"); assert.equal(selected.automatic, false);
    assert.equal(selected.selectionSource, "manual");
  }
});

test("project manager retains saved-default ownership without promoting a recommendation", async t => {
  const f = await fixture(t), settings = { runtimes: { [f.id]: { defaultVersion: "1.0" } } };
  const saved = f.select({}, settings); assert.equal(saved.version, "1.0"); assert.equal(saved.automatic, false);
  assert.equal(saved.selectionSource, "default");
  const recommended = f.select({}, settings, { recommendedVersion: "2.0" });
  assert.equal(recommended.version, "2.0"); assert.equal(recommended.automatic, true,
    "the detected compatible version is automatic even when a different version is saved as default");
  assert.equal(recommended.selectionSource, "recommended");
});

test("project manager preserves explicit custom-path intent", async t => {
  const f = await fixture(t), custom = path.join(f.userDataDir, "custom");
  for (const selected of [f.select({}, {}, { version: custom }), f.select({}, { runtimes: { [f.id]: { defaultVersion: custom } } })]) {
    assert.equal(selected.version, custom); assert.notEqual(selected.automatic, true,
      "the shared custom-path wrapper never promotes an explicit path to automatic ownership");
  }
});
