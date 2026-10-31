const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createPinnedNativeManager } = require("../src/modules/shared/runtime/pinned-native-manager");

const artifact = { version: "1.0", upstreamRevision: "release-1.0", asset: {
  url: "https://publisher.test/releases/1.0/runtime.zip", filename: "runtime.zip", artifactId: "release-1.0-runtime", bytes: 7, integrity: "recorded-local"
} };
const create = options => createPinnedNativeManager({ id: "publisher-test", label: "Publisher", discoverCatalog: async () => [artifact], ...options });
function temporary(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), "publisher-artifact-")); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
function binary() { const value = Buffer.alloc(32); value.writeUInt32LE(0xfeedfacf); value.writeUInt32LE(process.arch === "x64" ? 0x01000007 : 0x0100000c, 4); value.writeUInt32LE(2, 12); return value; }

test("publisher size mismatch stops installation before extraction", async t => {
  const root = temporary(t);
  const manager = create({ dependencies: {
    downloadToFile: async (_url, file) => fs.writeFileSync(file, "short"),
    extractArchive: () => assert.fail("Invalid artifact cannot be extracted")
  } });
  await assert.rejects(manager.installRuntime({ userDataDir: root, version: "1.0" }), /archive size/);
  assert.equal(fs.existsSync(path.join(root, "runtimes", manager.id, "1.0")), false);
});

test("publisher download identity and local SHA persist across restart and detect tampered records", { skip: process.platform !== "darwin" }, async t => {
  const root = temporary(t), options = { resolveExecutable: folder => path.join(folder, "player"), dependencies: {
    downloadToFile: async (_url, file) => fs.writeFileSync(file, "archive"),
    extractArchive: async (_archive, folder) => fs.writeFileSync(path.join(folder, "player"), binary(), { mode: 0o755 })
  } };
  const manager = create(options), installed = await manager.installRuntime({ userDataDir: root, version: "1.0" });
  assert.equal(installed.artifactId, artifact.asset.artifactId);
  assert.equal(installed.archiveBytes, 7);
  assert.match(installed.archiveSha256, /^[a-f0-9]{64}$/);
  assert.equal(installed.provenanceVerified, false);
  assert.ok(create(options).core.resolveInstalled({ userDataDir: root, version: "1.0" }));
  const file = path.join(installed.installDir, "runtime.json"), record = JSON.parse(fs.readFileSync(file, "utf8"));
  record.artifactId = "another-release"; fs.writeFileSync(file, JSON.stringify(record));
  assert.equal(create(options).core.resolveInstalled({ userDataDir: root, version: "1.0" }), null);
});
