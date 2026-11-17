const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { createPinnedNativeManager } = require("../src/modules/shared/runtime/pinned-native-manager");
const { prepareForLaunch } = require("../src/core/runtime-preparation");
const Origins = require("../src/core/runtime-install-origins");
const { runRuntimeManagerAction } = require("../src/core/runtime-manager-service");
const { createRuntimeCoordinator } = require("../src/core/runtime-coordinator");

function profile(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-automatic-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function binary() {
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32LE(0xfeedfacf); bytes.writeUInt32LE(process.arch === "arm64" ? 0x0100000c : 0x01000007, 4);
  bytes.writeUInt32LE(2, 12); return bytes;
}
async function fixture(t) {
  const root = profile(t), archive = Buffer.from("publisher archive fixture"), events = [], uses = [];
  const pins = ["1.0.0", "2.0.0", "3.0.0"].map(version => ({ version, upstreamRevision: "a".repeat(40),
    asset: { filename: "runtime.zip", url: "https://example.test/" + version, bytes: archive.length,
      sha256: crypto.createHash("sha256").update(archive).digest("hex") } }));
  const manager = createPinnedNativeManager({ id: "automatic-runtime-fixture", runtimeId: "runner", label: "Runtime fixture",
    versionCompatibility: "exact", discoverCatalog: async () => pins,
    resolveExecutable: root => path.join(root, "runner"),
    dependencies: { systemVersionSync: () => "26.0", downloadToFile: async (url, destination) => {
      events.push(["download", url]); fs.writeFileSync(destination, archive);
    }, extractArchive: async (_archive, directory) => fs.writeFileSync(path.join(directory, "runner"), binary(), { mode: 0o755 }) } });
  await manager.refreshCatalog({ userDataDir: root, force: true });
  // A module's detected format recommends the compatible line through the
  // manager's ordinary selection API; it is not a user's saved choice.
  const select = manager.resolveSelection.bind(manager);
  manager.resolveSelection = (entry, settings, userDataDir, options = {}) => select(entry, settings, userDataDir,
    { ...options, recommendedVersion: entry?.moduleData?.formatVersion });
  const mod = { id: "automatic-runtime-module", runtimeManagers: [manager] }, settings = { runtimes: {} };
  const context = { runtimeId: "runner", userDataDir: root, settings,
    confirmRuntimeInstall: async () => { events.push(["consent"]); return true; }, recordRuntimeUse: row => uses.push(row) };
  const prepare = version => prepareForLaunch({ entry: { moduleData: { formatVersion: version } }, mod,
    info: { runtime: { manager: { runner: manager.id } } }, context,
    registry: { listModuleIds: () => [mod.id], getModule: () => mod },
    runAction: () => assert.fail("Unexpected setup action"),
    install: (selected, options) => { events.push(["intent", options.automatic]); return selected.installRuntime({ ...options, userDataDir: root }); } });
  const coordinator = createRuntimeCoordinator({ userDataDir: root, isProcessAlive: () => true }).client();
  const remove = payload => runRuntimeManagerAction({ manager, action: "uninstall", payload, userDataDir: root,
    runtimeCoordinator: coordinator, readSettings: () => settings.runtimes[manager.id] });
  const prune = () => Origins.pruneSuperseded({ userDataDir: root, managers: [manager], settings,
    remove: ({ managerId, ...payload }) => { assert.equal(managerId, manager.id); return remove(payload); } });
  return { root, manager, prepare, context, settings, events, uses, prune, coordinator };
}

test("automatic Play records architecture-facade installs and retires the prior unused copy", async t => {
  const f = await fixture(t);
  assert.equal(await f.prepare("1.0.0"), true);
  const first = Origins.read(f.root);
  assert.equal(first.length, 1, "the resolveSelection plan must retain automatic installation intent");
  const row = f.manager.getState({ userDataDir: f.root }).installed.find(row => row.version === "1.0.0");
  assert.equal(first[0].variant, row.variant, "install results and architecture-tagged state use the same identity");
  assert.equal(first[0].variant, "architecture:" + (process.arch === "arm64" ? "arm64" : "x64"));
  assert.deepEqual(f.events.find(row => row[0] === "intent"), ["intent", true]);
  assert.equal(await f.prepare("2.0.0"), true);
  assert.equal(Origins.read(f.root).length, 2);
  const { removed } = await f.prune();
  assert.deepEqual(removed.map(row => row.version), ["1.0.0"]);
  assert.deepEqual(f.manager.getState({ userDataDir: f.root }).installed.map(row => row.version), ["2.0.0"]);
  assert.deepEqual(Origins.read(f.root).map(row => row.version), ["2.0.0"]);
});

test("ready installed Play remains offline and records the exact runtime use", async t => {
  const f = await fixture(t);
  await f.prepare("1.0.0"); f.events.length = 0; f.uses.length = 0;
  f.context.confirmRuntimeInstall = () => assert.fail("A ready installation needs no consent");
  assert.equal(await f.prepare("1.0.0"), true);
  assert.deepEqual(f.events, [], "no catalog, download or installation repeats");
  assert.equal(f.uses.at(-1).managerId, f.manager.id);
  assert.equal(f.uses.at(-1).version, "1.0.0");
  assert.equal(f.uses.at(-1).variant, Origins.read(f.root)[0].variant);
  assert.equal(f.uses.at(-1).sourcePath, f.manager.getState({ userDataDir: f.root }).installed[0].installDir);
});

test("automatic retirement uses existing active-use leases and preserves explicitly installed versions", async t => {
  const f = await fixture(t);
  await f.prepare("1.0.0"); await f.prepare("2.0.0");
  const row = f.manager.getState({ userDataDir: f.root }).installed.find(row => row.version === "1.0.0");
  const token = await f.coordinator.acquireUse({ managerId: f.manager.id, version: row.version, variant: row.variant, sourcePath: row.installDir });
  f.coordinator.bindUse(token, process.pid);
  assert.deepEqual((await f.prune()).removed, [], "the ordinary removal action refuses a live runtime lease");
  assert.equal(Origins.read(f.root).length, 2, "a refusal retains both origin records");
  await f.coordinator.release(token);
  // An explicit Install of an already-installed version changes its origin,
  // without another fetch, before the newer copy supersedes it.
  await runRuntimeManagerAction({ manager: f.manager, action: "install", payload: { version: "1.0.0" }, userDataDir: f.root,
    runtimeCoordinator: f.coordinator, readSettings: () => f.settings.runtimes[f.manager.id],
    saveSettings: next => { f.settings.runtimes[f.manager.id] = next; } });
  assert.equal(Origins.read(f.root).some(row => row.version === "1.0.0"), false);
  await f.prune();
  assert.ok(f.manager.getState({ userDataDir: f.root }).installed.some(row => row.version === "1.0.0"));
});

test("default and custom selections retain user ownership while recommendations remain automatic", async t => {
  const f = await fixture(t);
  await f.prepare("1.0.0");
  assert.equal(f.manager.resolveSelection({ moduleData: { formatVersion: "1.0.0" } }, {}, f.root).automatic, true);
  assert.equal(f.manager.resolveSelection({ runtimeData: { [f.manager.id]: { version: "1.0.0" } } }, {}, f.root).automatic, false);
  assert.equal(f.manager.resolveSelection({}, { runtimes: { [f.manager.id]: { defaultVersion: "1.0.0" } } }, f.root).automatic, false);
  assert.equal(f.manager.resolveSelection({ moduleData: { formatVersion: "2.0.0" } },
    { runtimes: { [f.manager.id]: { defaultVersion: "1.0.0" } } }, f.root).automatic, true,
  "a different saved default does not make a detected format's installation explicit");
  await f.prepare("2.0.0");
  await runRuntimeManagerAction({ manager: f.manager, action: "setDefault", payload: { version: "1.0.0" }, userDataDir: f.root,
    runtimeCoordinator: f.coordinator, readSettings: () => f.settings.runtimes[f.manager.id],
    saveSettings: next => { f.settings.runtimes[f.manager.id] = next; } });
  assert.deepEqual(Origins.read(f.root).map(row => row.version), ["2.0.0"]);
  const custom = path.join(f.root, "user-runtime"); fs.writeFileSync(custom, binary(), { mode: 0o755 });
  const registered = await f.manager.registerCustomRuntime({ userDataDir: f.root, runtimePath: custom });
  assert.ok(registered);
  await f.prune();
  assert.ok(fs.existsSync(custom), "the manager never deletes the user's custom bytes");
  assert.ok(f.manager.getState({ userDataDir: f.root }).installed.some(row => row.version === "1.0.0"));
});

test("untagged origin records are retained while an architecture annotation remains installed", async t => {
  const root = profile(t), rows = [{ version: "1", variant: "architecture:arm64", architecture: "arm64", ready: true }];
  fs.mkdirSync(path.join(root, "runtimes"), { recursive: true });
  fs.writeFileSync(path.join(root, "runtimes", "automatic-installs.json"), JSON.stringify({ schemaVersion: 1,
    installs: [{ managerId: "facade", version: "1", sectionId: "default" }] }));
  const manager = { id: "facade", getState: () => ({ installed: rows, catalog: { versions: ["1"] } }) };
  await Origins.pruneSuperseded({ userDataDir: root, managers: [manager], isRunning: () => true, remove: () => assert.fail("Still in use") });
  assert.equal(Origins.read(root).length, 1);
  rows.push({ version: "1", variant: "architecture:x64", architecture: "x64", ready: true });
  await Origins.pruneSuperseded({ userDataDir: root, managers: [manager], remove: () => assert.fail("Ambiguous CPU identity") });
  assert.equal(Origins.read(root).length, 1, "a still-installed copy's origin is never silently forgotten");
});
