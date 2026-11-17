const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { createPinnedNativeManager } = require("../src/modules/shared/runtime/pinned-native-manager");
const { runRuntimeManagerAction } = require("../src/core/runtime-manager-service");
const { createRuntimeCoordinator } = require("../src/core/runtime-coordinator");
const Origins = require("../src/core/runtime-install-origins");

async function fixture(t) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "direct-tool-origins-"));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  const archive = Buffer.from("publisher archive fixture"), binary = Buffer.alloc(32);
  binary.writeUInt32LE(0xfeedfacf); binary.writeUInt32LE(process.arch === "arm64" ? 0x0100000c : 0x01000007, 4); binary.writeUInt32LE(2, 12);
  const pins = ["1.0", "2.0"].map(version => ({ version, upstreamRevision: "a".repeat(40),
    asset: { filename: "tool.zip", url: "https://example.test/" + version, bytes: archive.length,
      sha256: crypto.createHash("sha256").update(archive).digest("hex") } }));
  let downloads = 0;
  const manager = createPinnedNativeManager({ id: "direct-tool", label: "Direct tool", discoverCatalog: async () => pins,
    resolveExecutable: root => path.join(root, "tool"),
    dependencies: { systemVersionSync: () => "26.0", downloadToFile: async (_url, destination) => { downloads++; fs.writeFileSync(destination, archive); },
      extractArchive: async (_file, directory) => fs.writeFileSync(path.join(directory, "tool"), binary, { mode: 0o755 }) } });
  await manager.refreshCatalog({ userDataDir, force: true });
  const coordinator = createRuntimeCoordinator({ userDataDir, isProcessAlive: () => true }).client();
  // Tools call their manager directly after consent, just as ordinary Play
  // does. This callback does not call the explicit Runtimes Install service.
  const automatic = version => manager.installRuntime({ userDataDir, version, automatic: true });
  const prune = () => Origins.pruneSuperseded({ userDataDir, managers: [manager],
    remove: ({ managerId, ...payload }) => runRuntimeManagerAction({ manager, action: "uninstall", payload, userDataDir, runtimeCoordinator: coordinator }) });
  return { userDataDir, manager, coordinator, automatic, prune, binary, downloads: () => downloads };
}

test("direct automatic Tools installation records its measured facade identity", async t => {
  const f = await fixture(t); await f.automatic("1.0");
  const rows = Origins.read(f.userDataDir), installed = f.manager.getState({ userDataDir: f.userDataDir }).installed[0];
  assert.equal(rows.length, 1); assert.equal(rows[0].version, "1.0");
  assert.equal(rows[0].variant, installed.variant);
});

test("second direct automatic Tools installation retires only the unused earlier copy", async t => {
  const f = await fixture(t); await f.automatic("1.0"); await f.automatic("2.0");
  assert.equal(Origins.read(f.userDataDir).length, 2);
  const row = f.manager.getState({ userDataDir: f.userDataDir }).installed.find(row => row.version === "1.0");
  const lease = await f.coordinator.acquireUse({ managerId: f.manager.id, version: row.version, variant: row.variant, sourcePath: row.installDir });
  f.coordinator.bindUse(lease, process.pid);
  assert.deepEqual((await f.prune()).removed, []);
  assert.equal(Origins.read(f.userDataDir).length, 2, "active-use refusal preserves provenance");
  await f.coordinator.release(lease);
  assert.deepEqual((await f.prune()).removed.map(row => row.version), ["1.0"]);
  assert.deepEqual(f.manager.getState({ userDataDir: f.userDataDir }).installed.map(row => row.version), ["2.0"]);
});

test("normal explicit Install and Set default keep their ownership and default behavior", async t => {
  const f = await fixture(t); await f.automatic("1.0"); await f.automatic("2.0");
  let settings = {};
  const action = (action, version) => runRuntimeManagerAction({ manager: f.manager, action, payload: { version }, userDataDir: f.userDataDir,
    runtimeCoordinator: f.coordinator, readSettings: () => settings, saveSettings: next => { settings = next; } });
  await action("setDefault", "1.0");
  await action("install", "2.0");
  assert.equal(settings.defaultVersion, "1.0", "explicit Install preserves a separately saved default");
  assert.deepEqual(Origins.read(f.userDataDir), []);
  await f.prune();
  assert.deepEqual(f.manager.getState({ userDataDir: f.userDataDir }).installed.map(row => row.version).sort(), ["1.0", "2.0"]);
  assert.equal(f.downloads(), 2, "explicit use of the ready copy does not fetch again");
});

test("direct automatic bookkeeping and the shared planner are idempotent", async t => {
  const f = await fixture(t); await f.automatic("1.0");
  const file = path.join(f.userDataDir, "runtimes", "automatic-installs.json"), stored = JSON.parse(fs.readFileSync(file));
  stored.installs[0].installedAt = "2001-01-01T00:00:00.000Z"; fs.writeFileSync(file, JSON.stringify(stored));
  const result = f.manager.resolveSelection({}, {}, f.userDataDir).install;
  assert.equal(Origins.recordPlayInstall({ userDataDir: f.userDataDir, manager: f.manager, plan: { version: "1.0", automatic: true }, result }), true);
  assert.equal(Origins.read(f.userDataDir).length, 1);
  assert.equal(Origins.read(f.userDataDir)[0].installedAt, "2001-01-01T00:00:00.000Z");
});

test("an earlier explicit copy is not claimed by a later direct automatic request", async t => {
  const f = await fixture(t);
  await f.manager.installRuntime({ userDataDir: f.userDataDir, version: "1.0" });
  await f.automatic("1.0"); await f.automatic("2.0"); await f.prune();
  assert.deepEqual(Origins.read(f.userDataDir).map(row => row.version), ["2.0"]);
  assert.ok(f.manager.getState({ userDataDir: f.userDataDir }).installed.some(row => row.version === "1.0"));
  assert.equal(f.downloads(), 2);
});

test("a custom runtime cannot become an automatic copy through a direct Tools callback", async t => {
  const f = await fixture(t), runtimePath = path.join(f.userDataDir, "user-tool");
  fs.writeFileSync(runtimePath, f.binary, { mode: 0o755 });
  await f.manager.registerCustomRuntime({ userDataDir: f.userDataDir, runtimePath });
  await f.automatic(runtimePath);
  assert.deepEqual(Origins.read(f.userDataDir), []);
  assert.ok(fs.existsSync(runtimePath));
});
