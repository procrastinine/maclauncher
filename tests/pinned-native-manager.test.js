const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { createPinnedNativeManager, hashFile } = require("../src/modules/shared/runtime/pinned-native-manager");

function binary(architecture = "arm64") {
  const data = Buffer.alloc(32);
  data.writeUInt32LE(0xfeedfacf);
  data.writeUInt32LE(architecture === "arm64" ? 0x0100000c : 0x01000007, 4);
  data.writeUInt32LE(2, 12);
  return data;
}
function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pinned-native-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
const catalog = [{ version: "1.2.0", upstreamRevision: "abc123" }, { version: "1.1.0", upstreamRevision: "def456" }];
// Rows reach the manager through discovery, as a publisher lists them.
function manager(options = {}) { return createPinnedNativeManager({ id: "fixture-native", label: "Fixture", discoverCatalog: async () => catalog, ...options }); }
async function listed(options = {}, userDataDir) {
  const runtime = manager(options);
  await runtime.refreshCatalog({ userDataDir, force: true });
  return runtime;
}

test("installed inventories reuse observed folders without probing download-only catalog versions", async t => {
  const root = temporary(t), runtime = await listed({ supportsDefault: false }, root);
  const reads = [], read = fs.readFileSync;
  t.mock.method(fs, "readFileSync", (file, ...args) => { if (path.basename(String(file)) === "runtime.json") reads.push(String(file)); return read(file, ...args); });
  assert.deepEqual(runtime.getState({ userDataDir: root }).installed, []);
  assert.deepEqual(reads, [], "listed downloads do not cause missing receipt probes");
  const executable = path.join(root, "native"); fs.writeFileSync(executable, binary(process.arch === "x64" ? "x86_64" : "arm64"), { mode: 0o755 });
  runtime.core.registerLocal({ userDataDir: root, version: "1.1.0", runtimePath: executable });
  reads.length = 0;
  assert.deepEqual(runtime.getState({ userDataDir: root }).installed.map(row => row.version), ["1.1.0"]);
  assert.ok(reads.every(file => file.split(path.sep).includes("1.1.0")), "only actual installation receipts are read");
  const selected = runtime.core.getInstallDir({ userDataDir: root, version: "1.2.0" }); fs.mkdirSync(selected, { recursive: true });
  assert.equal(runtime.getState({ userDataDir: root }).installed.find(row => row.version === "1.2.0").status, "incomplete");
  fs.writeFileSync(path.join(selected, "runtime.json"), JSON.stringify({ version: "1.2.0", upstreamRevision: "abc123", catalogEntry: catalog[0],
    source: "local", architecture: process.arch === "arm64" ? "arm64" : "x64", runtimePath: executable, binarySha256: hashFile(executable) }));
  assert.equal(runtime.getState({ userDataDir: root }).installed.find(row => row.version === "1.2.0").ready, true);
  const legacy = path.join(root, "runtimes/fixture-native/1.2.0"); fs.renameSync(selected, legacy);
  assert.equal(runtime.getState({ userDataDir: root }).installed.find(row => row.version === "1.2.0").installDir, legacy);
  fs.rmSync(legacy, { recursive: true });
  assert.equal(runtime.getState({ userDataDir: root }).installed.some(row => row.version === "1.2.0"), false);
  assert.deepEqual(runtime.getState({ userDataDir: root }).catalog.versions, ["1.2.0", "1.1.0"], "downloads remain listed independently of installation changes");
});

test("existing managers observe another process's catalog and local registration offline",async t=>{
  const root=temporary(t),runtime=manager({discoverCatalog:()=>assert.fail("Local changes must not query releases")});
  assert.deepEqual(runtime.getState({userDataDir:root}).catalog.versions,[]);
  const other=manager(),pin={version:"7.0.0",upstreamRevision:"source-seven"};
  other.core.rememberResolvedVersion({userDataDir:root,entry:pin});
  const executable=path.join(root,"native-seven");fs.writeFileSync(executable,binary(process.arch==="x64"?"x86_64":"arm64"),{mode:0o755});
  other.core.registerLocal({userDataDir:root,version:pin.version,runtimePath:executable});
  const entry={runtimeData:{"fixture-native":{version:pin.version}}};
  assert.equal(runtime.resolveSelection(entry,{},root).ready,true);
  assert.equal(runtime.getState({userDataDir:root}).installed.find(row=>row.version===pin.version).runtimePath,executable);
  assert.deepEqual(runtime.getState({userDataDir:root}).catalog.versions,[],"an installed/internal selection does not become a remote release");
  const discovered={...pin,version:"8.0.0",asset:{filename:"runtime.zip",url:"https://example.test/runtime.zip",sha256:"a".repeat(64)}};
  const publisher=manager({discoverCatalog:async()=>[discovered]});
  await publisher.refreshCatalog({userDataDir:root});
  assert.deepEqual(runtime.getState({userDataDir:root}).catalog.installableVersions,[discovered.version]);
  assert.equal(runtime.resolveSelection(entry,{},root).ready,true);
});

test("registration metadata arriving after its directory is discovered remains visible",t=>{
  const root=temporary(t),runtime=manager(),pin={version:"7.0.0",upstreamRevision:"source-seven"},directory=path.join(root,"runtimes/fixture-native",pin.version);
  fs.mkdirSync(directory,{recursive:true});runtime.getState({userDataDir:root});
  const executable=path.join(root,"native-seven");fs.writeFileSync(executable,binary(process.arch==="x64"?"x86_64":"arm64"),{mode:0o755});
  fs.writeFileSync(path.join(directory,"runtime.json"),JSON.stringify({version:pin.version,upstreamRevision:pin.upstreamRevision,catalogEntry:pin,source:"local",runtimePath:executable,binarySha256:hashFile(executable)}));
  assert.equal(runtime.resolveSelection({runtimeData:{"fixture-native":{version:pin.version}}},{},root).ready,true);
});

test("Automatic without listed releases selects nothing while exact game selections remain explicit", t => {
  const root = temporary(t), runtime = manager();
  assert.deepEqual(runtime.normalizeSettings({ defaultVersion: " auto " }), { defaultVersion: null });
  assert.equal(runtime.resolveSelection({ runtimeData: { "fixture-native": { version: "auto" } } }, {}, root).version, null);
  assert.equal(runtime.resolveSelection({}, { runtimes: { "fixture-native": { defaultVersion: "auto" } } }, root).version, null);
  assert.equal(runtime.resolveSelection({ runtimeData: { "fixture-native": { version: "auto" } } },
    { runtimes: { "fixture-native": { defaultVersion: "1.1.0" } } }, root).version, "1.1.0");
  assert.equal(runtime.resolveSelection({}, {}, root).discoveryRequired, true);
  assert.equal(runtime.resolveSelection({ runtimeData: { "fixture-native": { version: "1.1.0" } } },
    { runtimes: { "fixture-native": { defaultVersion: "auto" } } }, root).version, "1.1.0");
});

test("verified installed bytes remain available for explicit offline choices without querying catalogs", { skip: process.platform !== "darwin" }, async t => {
  const root = temporary(t); let host = "99.0";
  const pins = ["1.1.0", "1.2.0", "1.10.0", "2.0.0", "9.0.0"].map(version => ({ version, upstreamRevision: version,
    ...(version === "9.0.0" ? { minimumMacOS: "99.0" } : {}) }));
  const runtime = manager({ dependencies: { systemVersionSync: () => host },
    discoverCatalog: () => assert.fail("Auto must stay offline") });
  // Releases resolved for games are known without being listed for download.
  for (const entry of pins) runtime.core.rememberResolvedVersion({ userDataDir: root, entry });
  const files = new Map();
  for (const version of ["1.1.0", "1.2.0", "1.10.0", "9.0.0"]) {
    const file = path.join(root, "native-" + version); fs.writeFileSync(file, binary(process.arch === "x64" ? "x86_64" : "arm64"), { mode: 0o755 });
    files.set(version, file); runtime.core.registerLocal({ userDataDir: root, version, runtimePath: file });
  }
  host = "13.0";
  const settings = { defaultVersion: "1.1.0", retainedOption: true }, options = { runtimes: {} };
  const opened = [], open = fs.openSync; t.mock.method(fs, "openSync", (file, ...args) => { opened.push(String(file)); return open(file, ...args); });
  assert.equal(runtime.resolveSelection({}, options, root).version, "1.10.0", "The manager defaults to the newest ready installation without listed releases");
  assert.equal(runtime.resolveSelection({}, options, root).selectionRequired, undefined);
  assert.equal(opened.includes(files.get("9.0.0")), false, "An incompatible host candidate is skipped before native reads");
  assert.equal(runtime.resolveSelection({ runtimeData: { [runtime.id]: { version: "1.1.0" } } }, options, root).version, "1.1.0");
  assert.equal(runtime.resolveSelection({ runtimeData: { [runtime.id]: { version: "2.0.0" } } }, options, root).ready, false);
  fs.appendFileSync(files.get("1.10.0"), "changed");
  assert.equal(runtime.resolveSelection({}, options, root).version, "1.2.0");
  assert.equal(runtime.resolveSelection({}, options, root, { version: "1.10.0" }).ready, false, "An explicit changed installation still fails integrity validation");
  await runtime.uninstallRuntime({ userDataDir: root, version: "1.1.0" });
  assert.equal(runtime.resolveSelection({}, options, root).selectionRequired, undefined, "A sole usable installation supplies the manager default");
  assert.equal(runtime.resolveSelection({}, options, root, { version: "1.2.0" }).ready, true);
  assert.equal((runtime.updateSettingsAfterInstall(settings, { version: "1.2.0" }) || settings).defaultVersion, "1.1.0", "Install leaves the saved default unchanged");
  assert.equal(runtime.applySettingsUpdate("setDefault", { version: "1.2.0" }, settings).defaultVersion, "1.2.0");
  assert.equal(runtime.normalizeSettings(settings).defaultVersion, "1.1.0");
  assert.equal(runtime.getState({ userDataDir: root, settings }).sections[0].supportsDefault, true);
  assert.equal(manager({ supportsDefault: false }).getState({ userDataDir: root, settings }).sections[0].supportsDefault, false);
  assert.deepEqual(settings, { defaultVersion: "1.1.0", retainedOption: true });
  // The removed 1.1.0 stays the saved preference, and Play uses the installed 1.2.0 without a download.
  const preferred = runtime.resolveSelection({}, { runtimes: { [runtime.id]: settings } }, root);
  assert.deepEqual([preferred.version, preferred.ready, preferred.preferredVersion], ["1.2.0", true, "1.1.0"], "An uninstalled Runtimes default yields to an installed version");
});

test("native downloads retain caller cancellation alongside the shared Downloads Cancel action", async t => {
  const { DownloadManager } = require("../src/modules/shared/runtime/download-manager");
  for (const origin of ["caller", "downloads"]) await t.test(origin, async t => {
    const root = temporary(t), caller = new AbortController(), downloads = new DownloadManager();
    let started, observedSignal;
    const ready = new Promise(resolve => { started = resolve; });
    const runtime = manager({ discoverCatalog: async () => [{ version: "1.2.0", upstreamRevision: "abc123", asset: {
      filename: "runtime.zip", url: "https://example.test/runtime.zip", sha256: "a".repeat(64) } }],
      dependencies: { downloadToFile: async (_url, file, { signal, onProgress }) => {
        observedSignal = signal; fs.writeFileSync(file, "partial archive"); onProgress({ downloaded: 15, total: 100 }); started();
        await new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      }, extractArchive: () => assert.fail("Cancellation must stop before extraction") } });
    const pending = runtime.installRuntime({ userDataDir: root, version: "1.2.0", downloads, signal: caller.signal });
    const rejected = assert.rejects(pending, { name: "AbortError" });
    await ready;
    const task = downloads.list()[0];
    assert.equal(task.managerId, "fixture-native"); assert.equal(task.version, "1.2.0"); assert.equal(task.downloaded, 15);
    try {
      if (origin === "caller") caller.abort(); else assert.equal(downloads.cancel(task.id), true);
      assert.equal(observedSignal.aborted, true, "Either cancellation source aborts the actual download");
    } finally { if (!observedSignal.aborted) downloads.cancel(task.id); await rejected; }
    assert.deepEqual(downloads.list(), []);
    assert.equal(fs.existsSync(runtime.core.getInstallDir({ userDataDir: root, version: "1.2.0" })), false);
    assert.deepEqual(runtime.core.listInstalled(root), []);
  });
});

test("native library managers accept frameworks without weakening executable runtime validation", { skip: process.platform !== "darwin" }, async t => {
  const root = temporary(t), library = path.join(root, "Framework");
  const bytes = binary(process.arch === "x64" ? "x86_64" : "arm64"); bytes.writeUInt32LE(6, 12);
  fs.writeFileSync(library, bytes, { mode: 0o755 });
  const runtime = await listed({ nativeLibrary: true }, root);
  runtime.core.registerLocal({ userDataDir: root, version: "1.2.0", runtimePath: library });
  assert.equal(runtime.resolveSelection({}, {}, root, { version: "1.2.0" }).ready, true);
  assert.equal(manager().resolveSelection({}, {}, root, { version: "1.2.0" }).ready, false);
});

test("switching catalog publishers ignores the previous release list while preserving installations", { skip: process.platform !== "darwin" }, async t => {
  const root = temporary(t), executable = path.join(root, "runtime");
  fs.writeFileSync(executable, binary(process.arch === "x64" ? "x86_64" : "arm64"), { mode: 0o755 });
  const original = manager({ sourceUrl: "https://example.test/previous", discoverCatalog: async () => [{ version: "9.0", upstreamRevision: "previous" }, catalog[0]] });
  await original.refreshCatalog({ userDataDir: root });
  original.core.registerLocal({ userDataDir: root, version: "1.2.0", runtimePath: executable });
  const updated = manager({ sourceUrl: "https://example.test/current", discoverCatalog: async () => assert.fail("Reading state stays offline") });
  assert.deepEqual(updated.getState({ userDataDir: root }).catalog.versions, []);
  assert.equal(updated.getState({ userDataDir: root }).installed[0].version, "1.2.0");
  assert.equal(updated.resolveSelection({}, {}, root, { version: "1.2.0" }).ready, true);
});

test("installed versions that differ only by build hash retain catalog order and manager defaults offline", { skip: process.platform !== "darwin" }, async t => {
  const root = temporary(t), executable = path.join(root, "runtime"), hashed = "0.1.0-abcdef0";
  fs.writeFileSync(executable, binary(process.arch === "x64" ? "x86_64" : "arm64"), { mode: 0o755 });
  let listed = [];
  const runtime = manager({ discoverCatalog: async () => listed.map(version => ({ version, upstreamRevision: version })) });
  for (const version of ["0.1.0", hashed]) {
    runtime.core.rememberResolvedVersion({ userDataDir: root, entry: { version, upstreamRevision: version } });
    runtime.core.registerLocal({ userDataDir: root, version, runtimePath: executable });
  }
  assert.equal(runtime.resolveSelection({}, {}, root).selectionRequired, undefined, "Unlisted ready builds require no manual choice");
  listed = [hashed, "0.1.0"];
  await runtime.refreshCatalog({ userDataDir: root, force: true });
  const offline = manager({ discoverCatalog: () => assert.fail("Selection stays offline") });
  assert.deepEqual(offline.getState({ userDataDir: root }).catalog.versions, [hashed, "0.1.0"]);
  assert.equal(offline.resolveSelection({}, {}, root).selectionRequired, undefined, "Catalog defaults require no manual choice");
  for (const version of [hashed, "0.1.0"]) assert.equal(offline.resolveSelection({}, {}, root, { version }).ready, true);
});

test("downloaded runtime floors appear in shared state and block download or build on older hosts", { skip: process.platform !== "darwin" }, async t => {
  const root = temporary(t);
  let actual = "13.6";
  const rows = [{ version: "26.0", upstreamRevision: "new", minimumMacOS: "26.0", asset: {
    filename: "runtime.zip", url: "https://example.test/runtime.zip", sha256: "a".repeat(64) } },
    { version: "13.0", upstreamRevision: "old", minimumMacOS: "13.0", localBuild: true }];
  const runtime = manager({ discoverCatalog: async () => rows,
    buildRuntime: () => assert.fail("Host floor must block compilation"),
    dependencies: { systemVersionSync: () => actual, downloadToFile: () => assert.fail("Host floor must block downloads") } });
  await runtime.refreshCatalog();
  const state = runtime.getState({ userDataDir: root });
  assert.equal(state.catalog.versionRequirements["26.0"].minimumMacOS, "26.0");
  assert.match(state.catalog.versionRequirements["26.0"].installReason, /requires macOS 26\.0/);
  assert.deepEqual(state.catalog.installableVersions, ["13.0"]);
  assert.equal(runtime.resolveSelection({}, {}, root).version, "13.0");
  assert.equal(runtime.resolveSelection({}, {}, root).selectionRequired, undefined);
  assert.match(runtime.resolveSelection({ runtimeData: { [runtime.id]: { version: "26.0" } } }, {}, root).reason, /requires macOS 26\.0/);
  await assert.rejects(runtime.installRuntime({ userDataDir: root, version: "26.0" }), /requires macOS 26\.0/);
  actual = "12.7";
  await assert.rejects(runtime.installRuntime({ userDataDir: root, version: "13.0" }), /requires macOS 13\.0/);
  assert.equal(fs.existsSync(path.join(root, "runtimes")), false);
});

test("native runtime floor values are explicit and validated in discovered catalogs", async () => {
  for (const floor of ["main", "0.0", "26", 26, "26.0.0.1", "unknown"]) {
    const runtime = manager({ discoverCatalog: async () => [{ version: "2.0", upstreamRevision: "b", minimumMacOS: floor }] });
    await assert.rejects(runtime.refreshCatalog({ force: true }), /no version this MacLauncher can use/);
  }
});

test("an upstream download's executable floor stays with that file after it stops an installation", { skip: process.platform !== "darwin" }, async t => {
  // A Mach-O whose only load command is LC_BUILD_VERSION for macOS 14.8.
  const engine = Buffer.concat([binary(process.arch === "x64" ? "x86_64" : "arm64"), Buffer.alloc(24)]);
  engine.writeUInt32LE(1, 16); engine.writeUInt32LE(24, 20);
  [0x32, 24, 1, 0x000e0800, 0x000f0000, 0].forEach((value, index) => engine.writeUInt32LE(value, 32 + index * 4));
  for (const incomingMinimum of [undefined, "13.0", "15.2.1"]) await t.test(`incoming minimum ${incomingMinimum || "absent"}`, async t => {
    const root = temporary(t), archive = path.join(root, "archive.tar.xz");
    fs.writeFileSync(archive, "upstream archive fixture");
    let actual = "14.0", downloads = 0, sha256 = hashFile(archive), declaredMinimum;
    const options = { discoverCatalog: async () => [{ version: "1.0", upstreamRevision: "r", architecture: process.arch === "x64" ? "x64" : "arm64",
      ...(declaredMinimum ? { minimumMacOS: declaredMinimum } : {}), asset: {
        url: "https://example.test/runtime.tar.xz", filename: "runtime.tar.xz", sha256 } }],
    resolveExecutable: directory => path.join(directory, "engine"),
    dependencies: { systemVersionSync: () => actual, downloadToFile: async (_url, output) => { downloads++; fs.copyFileSync(archive, output); },
      extractArchive: async (_input, directory) => fs.writeFileSync(path.join(directory, "engine"), engine, { mode: 0o755 }) } };
    const runtime = manager(options);
    await runtime.refreshCatalog({ userDataDir: root, force: true });
    assert.equal(runtime.getState({ userDataDir: root }).catalog.versionRequirements["1.0"].installReason, null, "Upstream rows state no floor");
    await assert.rejects(runtime.installRuntime({ userDataDir: root, version: "1.0" }), /Fixture 1\.0 requires macOS 14\.8\.0\./);
    assert.equal(runtime.getState({ userDataDir: root }).catalog.versionRequirements["1.0"].minimumMacOS, "14.8.0");
    // Another process refreshes the same file's row with an absent, lower or
    // higher declared floor; the greater requirement prevents a second download.
    declaredMinimum = incomingMinimum;
    const expectedMinimum = incomingMinimum === "15.2.1" ? incomingMinimum : "14.8.0";
    const reason = `Fixture 1.0 requires macOS ${expectedMinimum}.`;
    const later = manager(options);
    await later.refreshCatalog({ userDataDir: root, force: true });
    const state = later.getState({ userDataDir: root });
    assert.equal(state.catalog.versionRequirements["1.0"].minimumMacOS, expectedMinimum);
    assert.equal(state.catalog.versionRequirements["1.0"].installReason, reason);
    assert.deepEqual(state.catalog.installableVersions, []);
    assert.equal(state.defaultVersion, null);
    const selection = later.resolveSelection({}, {}, root);
    assert.equal(selection.version, null); assert.equal(selection.reason, reason);
    await assert.rejects(later.installRuntime({ userDataDir: root, version: "1.0" }), { message: reason });
    assert.equal(downloads, 1);
    assert.equal(fs.existsSync(later.core.getInstallDir({ userDataDir: root, version: "1.0" })), false);
    actual = expectedMinimum;
    assert.deepEqual(later.getState({ userDataDir: root }).catalog.installableVersions, ["1.0"]);
    assert.equal(later.resolveSelection({}, {}, root).version, "1.0");
    // A replaced file is not bound by the earlier file's measured floor.
    actual = "14.0"; sha256 = "b".repeat(64); declaredMinimum = undefined;
    await later.refreshCatalog({ userDataDir: root, force: true });
    assert.equal(later.getState({ userDataDir: root }).catalog.versionRequirements["1.0"].minimumMacOS, null);
    assert.equal(later.getState({ userDataDir: root }).catalog.versionRequirements["1.0"].installReason, null);
    assert.deepEqual(later.getState({ userDataDir: root }).catalog.installableVersions, ["1.0"]);
  });
});

test("a valid native installation is unavailable on an older host without being mislabeled as damaged", { skip: process.platform !== "darwin" }, async t => {
  const root = temporary(t), executable = path.join(root, "runtime");
  fs.writeFileSync(executable, binary(process.arch === "x64" ? "x86_64" : "arm64"), { mode: 0o755 });
  let actual = "26.0";
  const runtime = await listed({ discoverCatalog: async () => [{ version: "26.0", upstreamRevision: "new", minimumMacOS: "26.0" }],
    dependencies: { systemVersionSync: () => actual } }, root);
  runtime.core.registerLocal({ userDataDir: root, version: "26.0", runtimePath: executable });
  actual = "13.0";
  assert.equal(runtime.core.resolveInstalled({ userDataDir: root, version: "26.0" }), null);
  const row = runtime.getState({ userDataDir: root }).installed[0];
  assert.equal(row.status, "unsupported-host"); assert.match(row.error, /requires macOS 26\.0/);
  assert.equal(fs.existsSync(executable), true);
});

test("expired public artifacts require refresh while exact installed copies remain usable", { skip: process.platform !== "darwin" }, async t => {
  const root = temporary(t), executable = path.join(root, "runtime");
  fs.writeFileSync(executable, binary(process.arch === "x64" ? "x86_64" : "arm64"), { mode: 0o755 });
  const runtime = await listed({ discoverCatalog: async () => [{ version: "nightly", upstreamRevision: "revision", asset: { filename: "runtime.zip",
    url: "https://example.test/runtime.zip", sha256: "a".repeat(64), expiresAt: "2026-01-01T00:00:00Z" } }],
    dependencies: { now: () => Date.parse("2026-10-10T00:00:00Z"), downloadToFile: () => assert.fail("Expired artifacts must not download") } }, root);
  assert.deepEqual(runtime.getState({ userDataDir: root }).catalog.installableVersions, []);
  assert.match(runtime.getState({ userDataDir: root }).catalog.versionRequirements.nightly.installReason, /expired.*Refresh/);
  await assert.rejects(runtime.installRuntime({ userDataDir: root, version: "nightly" }), /expired/);
  runtime.core.registerLocal({ userDataDir: root, version: "nightly", runtimePath: executable });
  assert.equal(runtime.resolveSelection({ runtimeData: { [runtime.id]: { version: "nightly" } } }, {}, root).ready, true);
  assert.equal(runtime.resolveSelection({}, {}, root).selectionRequired, undefined, "A sole installed runtime supplies the manager default");
  assert.equal((await runtime.installRuntime({ userDataDir: root, version: "nightly" })).executablePath, executable);
});

test("a manager without listed releases offers no download and rejects traversal or unsafe versions", async () => {
  const runtime = manager();
  assert.equal(runtime.getState({}).catalog.installable, false);
  assert.deepEqual(runtime.getState({}).catalog.installableVersions, []);
  assert.match(runtime.getState({}).catalog.installReason, /runtime can be imported/);
  assert.throws(() => runtime.core.normalizeVersion("../escape"), /Unsupported/);
  assert.throws(() => manager({ supportsDefault: true }).applySettingsUpdate("setDefault", { version: "../escape" }, {}), /Unsupported/);
  assert.throws(() => createPinnedNativeManager({ id: "../bad", discoverCatalog: async () => catalog }), /id/);
  await assert.rejects(manager({ discoverCatalog: async () => [{ version: "../bad", upstreamRevision: "a" }] }).refreshCatalog({ force: true }),
    /no version this MacLauncher can use/);
});

test("a downloadable manager has no option that names a version", async t => {
  const root = temporary(t), fixed = [{ version: "1.0", upstreamRevision: "a".repeat(40), localBuild: false }];
  const runtime = manager({ catalog: fixed, discoverCatalog: async () => [] });
  assert.deepEqual(runtime.core.catalog, [], "A fixed row passed as an option has no effect");
  assert.deepEqual(runtime.core.listCatalog({ userDataDir: root }), []);
  assert.equal(runtime.resolveSelection({ runtimeData: { [runtime.id]: { version: "1.0" } } }, {}, root).ready, false);
  assert.throws(() => createPinnedNativeManager({ id: "fixed-only", label: "Fixed", catalog: fixed }), /release source/);
});

test("native refresh forwards latest/all mode and replaces rows without reusing the other mode's cache", async t => {
  const root = temporary(t), calls = [];
  const latest = { version: "2.0", upstreamRevision: "newer" }, older = { version: "1.5", upstreamRevision: "older" };
  const runtime = manager({ discoverCatalog: async ({ latestOnly }) => {
    calls.push(latestOnly); return latestOnly === true ? [latest] : [latest, older, latest];
  } });
  assert.deepEqual((await runtime.refreshCatalog({ userDataDir: root, latestOnly: true })).versions, ["2.0"]);
  assert.equal((await runtime.refreshCatalog({ userDataDir: root, latestOnly: true })).mode, "latest");
  assert.deepEqual(calls, [true]);
  assert.deepEqual((await runtime.refreshCatalog({ userDataDir: root, latestOnly: false })).versions, ["2.0", "1.5"]);
  assert.equal((await runtime.refreshCatalog({ userDataDir: root, latestOnly: false })).mode, "all");
  assert.deepEqual(calls, [true, false]);
  assert.deepEqual((await runtime.refreshCatalog({ userDataDir: root, latestOnly: true })).versions, ["2.0"]);
  assert.deepEqual(calls, [true, false, true]);
});

test("an All versions request waits for a pending latest query and then performs its own bounded query", async t => {
  const root = temporary(t), calls = []; let release;
  const gate = new Promise(resolve => { release = resolve; });
  const runtime = manager({ discoverCatalog: async ({ latestOnly }) => {
    calls.push(latestOnly); if (latestOnly) await gate;
    return [{ version: latestOnly ? "2.0" : "3.0", upstreamRevision: "revision" }];
  } });
  const latest = runtime.refreshCatalog({ userDataDir: root, latestOnly: true });
  const all = runtime.refreshCatalog({ userDataDir: root, latestOnly: false });
  assert.deepEqual(calls, [true]); release();
  assert.equal((await latest).mode, "latest");
  assert.equal((await all).mode, "all");
  assert.deepEqual(calls, [true, false]);
});

test("a failed latest query does not fail an independent pending All versions request", async t => {
  const root = temporary(t), calls = []; let release;
  const gate = new Promise(resolve => { release = resolve; });
  const runtime = manager({ discoverCatalog: async ({ latestOnly }) => {
    calls.push(latestOnly);
    if (latestOnly) { await gate; throw Object.assign(new Error("Canceled latest query"), { name: "AbortError" }); }
    return [{ version: "2.0", upstreamRevision: "revision" }];
  } });
  const latest = assert.rejects(runtime.refreshCatalog({ userDataDir: root, latestOnly: true }), { name: "AbortError" });
  const all = runtime.refreshCatalog({ userDataDir: root, latestOnly: false }); release();
  await latest;
  assert.equal((await all).mode, "all");
  assert.deepEqual(calls, [true, false]);
});

test("a downloadable manager declares no included package versions before or after a refresh", async t => {
  const root = temporary(t);
  const runtime = manager({ discoverCatalog: async () => [{ version: "2.0.0", upstreamRevision: "b".repeat(40) }] });
  const model = require("../scripts/distribution-model.cjs");
  const requirements = () => model.nativeRequirements({ arch: "arm64", maximumMacOS: "13.0" },
    { managers: () => new Map([[runtime.id, runtime]]) });
  assert.deepEqual(runtime.distributionVersions, []);
  assert.equal(model.requiresDistribution(runtime), false);
  assert.deepEqual(requirements(), []);
  await runtime.refreshCatalog({ userDataDir: root, force: true });
  assert.equal(runtime.getState({ userDataDir: root }).catalog.recommendedVersion, undefined);
  assert.deepEqual(runtime.distributionVersions, []);
  assert.deepEqual(requirements(), []);
  assert.equal(runtime.delivery.catalog, "remote");
  assert.throws(() => manager({ distributionRequired: "true" }), /explicit booleans/);
});

test("explicit missing runtime selection never falls back to another installed version", { skip: process.platform !== "darwin" }, async t => {
  const root = temporary(t), executable = path.join(root, "runtime");
  fs.writeFileSync(executable, binary(process.arch === "x64" ? "x86_64" : "arm64"), { mode: 0o755 });
  const runtime = await listed({}, root);
  const installed = runtime.core.registerLocal({ userDataDir: root, version: "1.1.0", runtimePath: executable });
  assert.equal(installed.version, "1.1.0");
  assert.equal(installed.provenanceVerified, false);
  const selection = runtime.resolveSelection({ runtimeData: { "fixture-native": { version: "1.2.0" } } },
    { runtimes: { "fixture-native": { defaultVersion: "1.1.0" } } }, root);
  assert.equal(selection.version, "1.2.0");
  assert.equal(selection.ready, false);
  assert.equal(runtime.getState({ userDataDir: root }).installed.length, 1);
});
test("a runtime version option takes priority while automatic selection preserves the game choice", t => {
  const root = temporary(t), runtime = manager(), entry = { runtimeData: { "fixture-native": { version: "1.1.0" } } };
  const before = structuredClone(entry);
  assert.equal(runtime.resolveSelection(entry, {}, root, { version: "1.2.0" }).version, "1.2.0");
  assert.equal(runtime.resolveSelection(entry, {}, root, { version: "auto" }).version, "1.1.0");
  assert.equal(runtime.resolveSelection(entry, {}, root, { version: "missing" }).ready, false);
  assert.deepEqual(entry, before);
});

test("local registration records SHA identity, rejects replaced executables and preserves external build on uninstall", { skip: process.platform !== "darwin" }, async t => {
  const root = temporary(t), executable = path.join(root, "runtime");
  fs.writeFileSync(executable, binary(process.arch === "x64" ? "x86_64" : "arm64"), { mode: 0o755 });
  const runtime = await listed({}, root);
  const record = runtime.core.registerLocal({ userDataDir: root, version: "1.2.0", runtimePath: executable });
  assert.equal(record.binarySha256, hashFile(executable));
  assert.throws(() => runtime.core.registerLocal({ userDataDir: root, version: "1.2.0", runtimePath: executable }), /already registered/);
  fs.appendFileSync(executable, "replacement");
  assert.equal(runtime.core.resolveInstalled({ userDataDir: root, version: "1.2.0" }), null);
  const damaged = runtime.getState({ userDataDir: root }).sections[0].installed[0];
  assert.equal(damaged.version, "1.2.0"); assert.equal(damaged.ready, false); assert.equal(damaged.status, "damaged");
  assert.match(damaged.error, /checksum changed/);
  assert.match(runtime.resolveSelection({}, {}, root, { version: "1.2.0" }).reason, /checksum changed/);
  runtime.uninstallRuntime({ userDataDir: root, version: "1.2.0", installDir: root });
  assert.equal(fs.existsSync(executable), true);
  assert.equal(fs.existsSync(path.join(root, "runtimes", "fixture-native", "1.2.0")), false);
});

test("selection and Runtimes expose the blocking inspection reason and recover after repair", { skip: process.platform !== "darwin" }, async t => {
  const root = temporary(t), executable = path.join(root, "runtime"), component = path.join(root, "required-component");
  fs.writeFileSync(executable, binary(process.arch === "x64" ? "x86_64" : "arm64"), { mode: 0o755 });
  fs.writeFileSync(component, "present");
  const runtime = await listed({ inspectRuntime(options) {
    if (!fs.existsSync(component)) throw new Error("Required runtime library libfixture.dylib is missing.");
    return require("../src/modules/shared/runtime/local-native").resolveLocalRuntime(options);
  } }, root);
  runtime.core.registerLocal({ userDataDir: root, version: "1.2.0", runtimePath: executable });
  fs.unlinkSync(component);
  const failed = runtime.resolveSelection({}, {}, root, { version: "1.2.0" });
  assert.equal(failed.ready, false);
  assert.match(failed.reason, /Required runtime library libfixture\.dylib is missing/);
  const damaged = runtime.getState({ userDataDir: root }).installed.find(row => row.version === "1.2.0");
  assert.match(damaged.error, /Required runtime library libfixture\.dylib is missing/);
  assert.doesNotMatch(failed.reason, /executable changed/);
  fs.writeFileSync(component, "repaired");
  assert.equal(runtime.resolveSelection({}, {}, root, { version: "1.2.0", verification: "status" }).ready, true,
    "repairing a blocking component recovers status without touching the primary executable or version record");
  assert.equal(runtime.resolveSelection({}, {}, root, { version: "1.2.0" }).ready, true);
  assert.equal(runtime.getState({ userDataDir: root }).installed.find(row => row.version === "1.2.0").error, undefined);
});

test("an absent selected build names its CPU instead of suggesting changed executable bytes", async t => {
  const root = temporary(t), runtime = await listed({}, root);
  for (const [architecture, label] of [["arm64", "Apple Silicon"], ["x64", "Intel"]]) {
    const selection = runtime.resolveSelection({}, {}, root, { version: "1.2.0", architecture });
    assert.equal(selection.ready, false);
    assert.match(selection.reason, new RegExp("not installed for " + label));
    assert.doesNotMatch(selection.reason, /executable changed/);
  }
});

test("incomplete native build directories remain visible and removable in runtime UI state", async t => {
  const root = temporary(t), runtime = await listed({}, root);
  const directory = runtime.core.getInstallDir({ userDataDir: root, version: "1.2.0" });
  fs.mkdirSync(path.join(directory, "build"), { recursive: true });
  fs.writeFileSync(path.join(directory, "build", "error.log"), "native compilation failed");
  assert.deepEqual(runtime.core.listInstalled(root), []);
  const rows = runtime.getState({ userDataDir: root }).sections[0].installed;
  assert.equal(rows.length, 1); assert.equal(rows[0].status, "incomplete"); assert.equal(rows[0].ready, false);
  assert.match(rows[0].error, /incomplete/);
  runtime.uninstallRuntime({ userDataDir: root, ...rows[0] });
  assert.equal(fs.existsSync(directory), false);
  assert.deepEqual(runtime.getState({ userDataDir: root }).sections[0].installed, []);
});

test("verified native build records bind source and overlay evidence to the selected revision", { skip: process.platform !== "darwin" }, async t => {
  const root = temporary(t), executable = path.join(root, "runtime");
  fs.writeFileSync(executable, binary(process.arch === "x64" ? "x86_64" : "arm64"), { mode: 0o755 });
  const runtime = await listed({}, root);
  const verifiedBuild = { sourceRevision: "abc123", sourceTreeSha256: "a".repeat(64), overlaySha256: "b".repeat(64), configureOptions: ["-DFETCHCONTENT_FULLY_DISCONNECTED=ON"] };
  assert.throws(() => runtime.core.registerLocal({ userDataDir: root, version: "1.2.0", runtimePath: executable,
    verifiedBuild: { ...verifiedBuild, sourceRevision: "wrong" } }), /selected source revision/);
  const record = runtime.core.registerLocal({ userDataDir: root, version: "1.2.0", runtimePath: executable, verifiedBuild });
  assert.equal(record.provenanceVerified, true); assert.deepEqual(record.verifiedBuild, verifiedBuild);
});

test("pinned download digest failure blocks extraction and removes partial staging", { skip: process.platform !== "darwin" }, async t => {
  const root = temporary(t);
  let extracted = false;
  const runtime = manager({ discoverCatalog: async () => [{ version: "1.0", upstreamRevision: "a", asset: {
    url: "https://example.test/runtime.zip", filename: "runtime.zip", sha256: "0".repeat(64) } }],
  dependencies: { downloadToFile: async (_url, output) => fs.writeFileSync(output, "wrong artifact"),
    extractArchive: async () => { extracted = true; } } });
  await assert.rejects(runtime.installRuntime({ userDataDir: root, version: "1.0" }), /SHA-256/);
  assert.equal(extracted, false);
  assert.deepEqual(fs.readdirSync(path.dirname(runtime.core.getInstallDir({userDataDir: root, version: "1.0"}))), []);
});

test("pinned download persists selected revision and validates the published executable", { skip: process.platform !== "darwin" }, async t => {
  const root = temporary(t), archive = path.join(root, "archive.zip");
  fs.writeFileSync(archive, "trusted archive fixture");
  const runtime = manager({ discoverCatalog: async () => [{ version: "1.0", upstreamRevision: "revision-a", asset: {
    url: "https://example.test/runtime.zip", filename: "runtime.zip", sha256: hashFile(archive) } }],
  resolveExecutable: directory => path.join(directory, "engine"),
  dependencies: { downloadToFile: async (_url, output) => fs.copyFileSync(archive, output),
    extractArchive: async (_input, directory) => fs.writeFileSync(path.join(directory, "engine"),
      binary(process.arch === "x64" ? "x86_64" : "arm64"), { mode: 0o755 }) } });
  const record = await runtime.installRuntime({ userDataDir: root, version: "1.0" });
  assert.deepEqual(runtime.getState({ userDataDir: root }).catalog.versions, ["1.0"], "The install discovered the release list");
  assert.equal(runtime.getState({ userDataDir: root }).installed[0].ready, true);
  assert.equal(record.upstreamRevision, "revision-a");
  assert.equal(record.provenanceVerified, true);
  assert.equal(record.source, "download");
  assert.equal(record.binarySha256, hashFile(record.executablePath));
  assert.deepEqual(fs.readdirSync(path.dirname(runtime.core.getInstallDir({userDataDir: root, version: "1.0"}))), ["1.0"]);
});

test("legacy publisher MD5 requires an independent signed-artifact verifier", async () => {
  const legacy = [{ version: "1.0", upstreamRevision: "revision-a", asset: {
    url: "https://publisher.test/runtime.pkg", filename: "runtime.pkg", integrity: "publisher-md5", md5: "a".repeat(32) } }];
  await assert.rejects(manager({ discoverCatalog: async () => legacy }).refreshCatalog({ force: true }), /no version this MacLauncher can use/);
  assert.throws(() => manager({ discoverCatalog: async () => legacy, verifyArtifact: true }), /verification requires a callback/);
  assert.deepEqual((await listed({ discoverCatalog: async () => legacy, verifyArtifact: async () => ({ verified: true }) })).getState({}).catalog.versions, ["1.0"]);
});

test("an explicitly resolved old game version survives bounded catalog refresh without duplicate rows", async t => {
  const root = temporary(t), options = { discoverCatalog: async () => [{ version: "2.0", upstreamRevision: "newer" }] };
  const runtime = manager(options);
  runtime.core.rememberResolvedVersion({ userDataDir: root, entry: { version: "0.9", upstreamRevision: "older", localBuild: false } });
  runtime.core.rememberResolvedVersion({ userDataDir: root, entry: { version: "0.9", upstreamRevision: "older", localBuild: false } });
  assert.deepEqual((await runtime.refreshCatalog({ userDataDir: root, force: true })).versions, ["2.0"]);
  const restored = manager(options).getState({ userDataDir: root });
  assert.deepEqual(restored.catalog.versions, ["2.0"]);
  assert.equal(runtime.resolveSelection({ runtimeData: { "fixture-native": { version: "0.9" } } }, {}, root).version, "0.9");
  assert.throws(() => runtime.core.rememberResolvedVersion({ userDataDir: root, entry: { version: "../bad", upstreamRevision: "bad" } }), /identity/);
});

test("legacy publisher digest and signer failures both block extraction", { skip: process.platform !== "darwin" }, async t => {
  const root = temporary(t), bytes = Buffer.from("legacy installer fixture");
  const md5 = crypto.createHash("md5").update(bytes).digest("hex");
  let verified = 0, extracted = 0;
  function fixture(digest, evidence) {
    return listed({ discoverCatalog: async () => [{ version: "1.0", upstreamRevision: "revision-a", asset: {
      url: "https://publisher.test/runtime.pkg", filename: "runtime.pkg", integrity: "publisher-md5", md5: digest } }],
      verifyArtifact: async () => { verified++; return evidence; },
      dependencies: { downloadToFile: async (_url, output) => fs.writeFileSync(output, bytes),
        extractArchive: async () => { extracted++; } } }, root);
  }
  await assert.rejects((await fixture("0".repeat(32), null)).installRuntime({ userDataDir: root, version: "1.0" }), /MD5/);
  assert.equal(verified, 0);
  await assert.rejects((await fixture(md5, { verified: false })).installRuntime({ userDataDir: root, version: "1.0" }), /signed artifact identity/);
  assert.equal(verified, 1); assert.equal(extracted, 0);
  assert.deepEqual(fs.readdirSync(path.join(root, "runtimes", "fixture-native", process.arch)), []);
});

test("signed legacy downloads record SHA-256 and verified publisher identity", { skip: process.platform !== "darwin" }, async t => {
  const root = temporary(t), bytes = Buffer.from("signed installer fixture");
  const archiveSha256 = crypto.createHash("sha256").update(bytes).digest("hex"), md5 = crypto.createHash("md5").update(bytes).digest("hex");
  const evidence = { verified: true, identity: "Example Publisher (TEAM1234)", archiveSha256, certificateSha256: "b".repeat(64) };
  const runtime = manager({ discoverCatalog: async () => [{ version: "1.0", upstreamRevision: "revision-a", asset: {
    url: "https://publisher.test/runtime.pkg", filename: "runtime.pkg", integrity: "publisher-md5", md5 } }],
    verifyArtifact: async () => evidence,
    resolveExecutable: directory => path.join(directory, "engine"),
    dependencies: { downloadToFile: async (_url, output) => fs.writeFileSync(output, bytes),
      extractArchive: async (_archive, directory) => fs.writeFileSync(path.join(directory, "engine"), binary(process.arch === "x64" ? "x86_64" : "arm64"), { mode: 0o755 }) } });
  const installed = await runtime.installRuntime({ userDataDir: root, version: "1.0" });
  assert.equal(installed.archiveSha256, archiveSha256); assert.equal(installed.archiveMd5, md5);
  assert.deepEqual(installed.artifactVerification, evidence); assert.equal(installed.provenanceVerified, true);
  assert.equal(installed.integritySource, "publisher-md5-and-signature");
  const recordPath = path.join(installed.installDir, "runtime.json"), record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  record.artifactVerification.verified = false; fs.writeFileSync(recordPath, JSON.stringify(record));
  assert.equal(runtime.core.resolveInstalled({ userDataDir: root, version: "1.0" }), null);
});

test("global source installation uses the explicit selected pin without a game or network", { skip: process.platform !== "darwin" }, async t => {
  const root = temporary(t), executable = path.join(root, "runtime");
  fs.writeFileSync(executable, binary(process.arch === "x64" ? "x86_64" : "arm64"), { mode: 0o755 });
  let called, taskMeta;
  const runtime = manager({ sourceUrl: "https://example.test/pinned-source", buildHelpUrl: "https://example.test/setup", discoverCatalog: async () => catalog,
    buildRuntime: async args => {
      called = args;
      args.onProgress({ downloaded: 4, total: 4 });
      return args.manager.core.registerLocal({ userDataDir: args.userDataDir, version: args.version, runtimePath: executable });
    }, dependencies: { downloadToFile: async () => assert.fail("source builds must not download") } });
  await runtime.refreshCatalog();
  const state = runtime.getState({}).catalog;
  assert.equal(state.installable, true); assert.equal(state.installLabel, "Build");
  assert.equal(state.source, "https://example.test/pinned-source"); assert.equal(state.installHelpUrl, "https://example.test/setup");
  assert.doesNotMatch(state.installReason, /docs\//);
  const progress = [];
  const installed = await runtime.installRuntime({ userDataDir: root, version: "1.1.0", sourceDir: path.join(root, "checkout"),
    downloads: { runTask: (meta, runner) => { taskMeta = meta; return runner({ signal: null, onProgress: value => progress.push(value) }); } } });
  assert.equal(called.manager, runtime); assert.equal(called.version, "1.1.0"); assert.equal(called.userDataDir, root);
  assert.equal(called.sourceDir, path.join(root, "checkout")); assert.equal(called.entry, undefined);
  assert.equal(installed.upstreamRevision, "def456"); assert.equal(taskMeta.kind, "runtime-build");
  assert.deepEqual(progress, [{ downloaded: 4, total: 4 }]);
  await assert.rejects(runtime.installRuntime({ userDataDir: root, version: "../escape" }), /Unsupported|not available/);
});

test("failed, canceled and unregistered source builds cannot report global installation success", { skip: process.platform !== "darwin" }, async t => {
  const root = temporary(t);
  const failed = manager({ buildRuntime: async () => { throw new Error("Missing native library"); } });
  await assert.rejects(failed.installRuntime({ userDataDir: root, version: "1.2.0" }), /Missing native library/);
  assert.deepEqual(failed.core.listInstalled(root), []);
  const wrong = manager({ buildRuntime: async () => ({ version: "1.1.0" }) });
  await assert.rejects(wrong.installRuntime({ userDataDir: root, version: "1.2.0" }), /selected pinned runtime/);
  const controller = new AbortController();
  const canceled = manager({ buildRuntime: async () => { controller.abort(); return { version: "1.2.0" }; } });
  await assert.rejects(canceled.installRuntime({ userDataDir: root, version: "1.2.0", signal: controller.signal }), error => error.name === "AbortError");
  assert.deepEqual(canceled.core.listInstalled(root), []);
});

test("available bundled runtimes install before source builds and verify installed inventory", { skip: process.platform !== "darwin" }, async t => {
  const root = temporary(t);
  let verified = 0;
  const runtime = manager({ buildRuntime: async () => assert.fail("an available bundle must install without build tools"),
    bundledRuntime: { resolve: () => ({ source: "bundled" }),
      verifyInstalled: ({ record, pin }) => { verified++; return record.upstreamRevision === pin.upstreamRevision; },
      install: async ({ manager: owner, userDataDir, version }) => {
        const directory = owner.core.getInstallDir({ userDataDir, version }); fs.mkdirSync(directory, { recursive: true });
        const executable = path.join(directory, "runtime");
        fs.writeFileSync(executable, binary(process.arch === "x64" ? "x86_64" : "arm64"), { mode: 0o755 });
        const record = { version, upstreamRevision: "abc123", binarySha256: hashFile(executable), source: "bundled", executableRelative: "runtime" };
        fs.writeFileSync(path.join(directory, "runtime.json"), JSON.stringify(record));
        return owner.core.resolveInstalled({ userDataDir, version });
      } } });
  assert.equal(runtime.getState({}).catalog.installLabel, "Install");
  const installed = await runtime.installRuntime({ userDataDir: root, version: "1.2.0" });
  assert.equal(installed.source, "bundled"); assert.ok(verified >= 2);
  fs.appendFileSync(installed.runtimePath, "tampered");
  assert.equal(runtime.core.resolveInstalled({ userDataDir: root, version: "1.2.0" }), null);
});

test("a corrupt present bundle exposes its reason and blocks source fallback", { skip: process.platform !== "darwin" }, async t => {
  const runtime = await listed({ buildRuntime: async () => assert.fail("corrupt bundles must not fall back to source"),
    bundledRuntime: { resolve: () => { throw new Error("Bundled manifest pin mismatch"); },
      install: async () => { throw new Error("Bundled manifest pin mismatch"); }, verifyInstalled: () => false } });
  assert.equal(runtime.getState({}).catalog.installable, false);
  assert.match(runtime.getState({}).catalog.installReason, /Bundled manifest pin mismatch/);
  await assert.rejects(runtime.installRuntime({ userDataDir: temporary(t), version: "1.2.0" }), /pin mismatch/);
});

test("a missing packaged source checkout cannot advertise a source Build action", async t => {
  const root = temporary(t), source = path.join(root, "source");
  const runtime = manager({ buildRuntime: async () => {}, buildSourcePath: source, discoverCatalog: async () => catalog });
  await runtime.refreshCatalog();
  assert.equal(runtime.getState({}).catalog.installable, false);
  assert.deepEqual(runtime.getState({}).catalog.buildableVersions, []);
  assert.match(runtime.getState({}).catalog.installReason, /No runtime is included/);
  fs.mkdirSync(source); fs.writeFileSync(path.join(source, ".git"), "gitdir: fixture\n");
  assert.equal(runtime.getState({}).catalog.installable, true);
  assert.equal(runtime.getState({}).catalog.installLabel, "Build");
  assert.deepEqual(runtime.getState({}).catalog.buildableVersions, ["1.2.0", "1.1.0"]);
});

test("runtime broadcasts reuse native display checks while selection and Reload verify the payload", { skip: process.platform !== "darwin" }, async t => {
  const root = temporary(t), Native = require("../src/modules/shared/runtime/local-native");
  let nativeChecks = 0, fullChecks = 0, auxiliaryDamaged = false;
  const resolve = Native.resolveLocalRuntime;
  Native.resolveLocalRuntime = (...args) => { nativeChecks++; return resolve(...args); };
  t.after(() => { Native.resolveLocalRuntime = resolve; });
  const runtime = await listed({ bundledRuntime: { resolve: () => null, install: async () => null,
    verifyInstalled: ({ verification }) => { if (verification === "full") { fullChecks++; return !auxiliaryDamaged; } return true; } } }, root);
  const directory = runtime.core.getInstallDir({ userDataDir: root, version: "1.2.0" }); fs.mkdirSync(directory, { recursive: true });
  const executable = path.join(directory, "runner");
  fs.writeFileSync(executable, binary(process.arch === "x64" ? "x86_64" : "arm64"), { mode: 0o755 });
  fs.writeFileSync(path.join(directory, "runtime.json"), JSON.stringify({ version: "1.2.0", upstreamRevision: "abc123",
    source: "bundled", executableRelative: "runner", binarySha256: hashFile(executable) }));
  for (let i = 0; i < 30; i++) assert.equal(runtime.getState({ userDataDir: root }).installed[0].ready, true);
  assert.equal(nativeChecks, 1); assert.equal(fullChecks, 0);
  auxiliaryDamaged = true;
  assert.equal(runtime.resolveSelection(null, null, root, { version: "1.2.0" }).ready, false);
  assert.ok(fullChecks > 0, "selection fully verifies the auxiliary payload");
  const failedChecks = fullChecks;
  assert.equal(runtime.getState({ userDataDir: root }).installed[0].ready, false, "a failed full check stays visible after warm broadcasts");
  assert.ok(fullChecks > failedChecks, "status fully rechecks a known failure instead of accepting the weaker check");
  auxiliaryDamaged = false;
  const beforeRepair = fullChecks;
  assert.equal(runtime.getState({ userDataDir: root }).installed[0].ready, true, "status recovers after auxiliary repair without touching the executable or record");
  assert.ok(fullChecks > beforeRepair, "recovery requires a successful full payload check");
  const healthyNative = nativeChecks, healthyFull = fullChecks;
  for (let i = 0; i < 30; i++) assert.equal(runtime.getState({ userDataDir: root }).installed[0].ready, true);
  assert.equal(nativeChecks, healthyNative, "healthy broadcasts add no native inspection");
  assert.equal(fullChecks, healthyFull, "healthy broadcasts add no full payload checks");
  const beforeReload = fullChecks;
  await runtime.refreshCatalog({ userDataDir: root, force: true });
  assert.equal(fullChecks, beforeReload + 1, "explicit Reload still fully verifies the installed payload");
  assert.equal(runtime.getState({ userDataDir: root }).installed[0].ready, true);
  runtime.uninstallRuntime({ userDataDir: root, version: "1.2.0" });
  assert.deepEqual(runtime.getState({ userDataDir: root }).installed, []);
});

test("a warmed display invalidates on a same-size executable edit with restored mtime", { skip: process.platform !== "darwin" }, async t => {
  const root = temporary(t), executable = path.join(root, "runner"), runtime = await listed({}, root);
  fs.writeFileSync(executable, binary(process.arch === "x64" ? "x86_64" : "arm64"), { mode: 0o755 });
  runtime.core.registerLocal({ userDataDir: root, version: "1.2.0", runtimePath: executable });
  assert.equal(runtime.getState({ userDataDir: root }).installed[0].ready, true);
  const stat = fs.statSync(executable), bytes = fs.readFileSync(executable); bytes[31] = 1;
  fs.writeFileSync(executable, bytes); fs.utimesSync(executable, stat.atime, stat.mtime);
  assert.equal(runtime.getState({ userDataDir: root }).installed[0].ready, false);
  assert.equal(runtime.resolveSelection(null, null, root, { version: "1.2.0" }).ready, false);
});

test("native preparation evidence is cloned, persisted and immutable without replacing shared identities", { skip: process.platform !== "darwin" }, async t => {
  const root = temporary(t), archive = Buffer.from("reviewed native archive");
  const digest = crypto.createHash("sha256").update(archive).digest("hex");
  const evidence = { profile: "direct-host-v1", sourceRevision: "abc123", profileSha256: "a".repeat(64),
    signature: { verified: true, identity: "reviewed publisher" }, files: ["lib/engine.dylib"], version: "cannot override version" };
  const runtime = await listed({ discoverCatalog: async () => [{ version: "1.2.0", upstreamRevision: "abc123", asset: { url: "https://example.com/native.tar.gz", filename: "native.tar.gz", sha256: digest } }],
    prepareInstall: async () => evidence, resolveExecutable: destination => path.join(destination, "runner"),
    dependencies: { downloadToFile: async (_url, destination) => fs.writeFileSync(destination, archive),
      extractArchive: async (_archive, destination) => fs.writeFileSync(path.join(destination, "runner"), binary(process.arch === "x64" ? "x86_64" : "arm64"), { mode: 0o755 }) } }, root);
  const installed = await runtime.core.installVersion({ userDataDir: root, version: "1.2.0" });
  assert.equal(installed.version, "1.2.0"); assert.equal(installed.archiveSha256, digest); assert.deepEqual(installed.installationMetadata, evidence);
  assert(Object.isFrozen(installed.installationMetadata)); assert(Object.isFrozen(installed.installationMetadata.signature));
  assert(Object.isFrozen(installed.installationMetadata.files));
  evidence.signature.identity = "later mutation"; evidence.files.push("later file");
  const record = JSON.parse(fs.readFileSync(path.join(installed.installDir, "runtime.json"), "utf8"));
  assert.equal(record.installationMetadata.signature.identity, "reviewed publisher"); assert.deepEqual(record.installationMetadata.files, ["lib/engine.dylib"]);
  assert.equal(runtime.core.resolveInstalled({ userDataDir: root, version: "1.2.0" }).installationMetadata.signature.identity, "reviewed publisher");
});

test("invalid preparation evidence cannot publish a native runtime", { skip: process.platform !== "darwin" }, async t => {
  const root = temporary(t), archive = Buffer.from("verified archive"), digest = crypto.createHash("sha256").update(archive).digest("hex");
  // Evidence size is not limited; a cycle cannot be recorded.
  const cyclic = { files: [] }; cyclic.files.push(cyclic);
  for (const evidence of [{ file: () => "not serializable" }, { size: Infinity }, cyclic]) {
    const runtime = await listed({ discoverCatalog: async () => [{ version: "1.2.0", upstreamRevision: "abc123", asset: { url: "https://example.com/native.tar.gz", filename: "native.tar.gz", sha256: digest } }],
      prepareInstall: async () => evidence, resolveExecutable: destination => path.join(destination, "runner"),
      dependencies: { downloadToFile: async (_url, destination) => fs.writeFileSync(destination, archive),
        extractArchive: async (_archive, destination) => fs.writeFileSync(path.join(destination, "runner"), binary(process.arch === "x64" ? "x86_64" : "arm64"), { mode: 0o755 }) } }, root);
    await assert.rejects(runtime.core.installVersion({ userDataDir: root, version: "1.2.0" }), /metadata/);
    assert.equal(fs.existsSync(path.join(root, "runtimes", "fixture-native", "1.2.0", "runtime.json")), false);
  }
});

test("local imports are opt-in and do not seed download version choices", () => {
  const standard = manager();
  assert.equal(standard.importRuntime, undefined);
  assert.equal(standard.getState({}).catalog.importable, undefined);
  const runtime = manager({ importLocal: true, discoverCatalog: () => assert.fail("Local import stays offline") });
  const state = runtime.getState({});
  assert.deepEqual(state.catalog.versions, []);
  assert.equal(state.catalog.importVersionRequired, true);
  assert.deepEqual(state.catalog.importInputKinds, ["file", "directory"]);
  assert.throws(() => runtime.importRuntime({}), /Select the version/);
  assert.throws(() => manager({ importLocal: "yes" }), /explicitly enabled/);
});

test("Runtimes local import validates the selected build and removal preserves external files", { skip: process.platform !== "darwin" }, async t => {
  const root = temporary(t), runtimePath = path.join(root, "local-runtime");
  fs.writeFileSync(runtimePath, binary(process.arch === "x64" ? "x86_64" : "arm64"), { mode: 0o755 });
  const runtime = await listed({ importLocal: true }, root), { runRuntimeManagerAction } = require("../src/core/runtime-manager-service");
  let settings = {};
  const result = await runRuntimeManagerAction({ manager: runtime, action: "import", userDataDir: root,
    payload: { version: "1.1.0", runtimePath }, readSettings: () => settings, saveSettings: next => { settings = next; } });
  assert.equal(result.version, "1.1.0");
  assert.equal(result.provenanceVerified, false);
  assert.equal(settings.defaultVersion, "1.1.0", "First import saves the first installation as default");
  const chosen = { runtimeData: { [runtime.id]: { version: "1.1.0" } } };
  assert.equal(runtime.resolveSelection({}, { runtimes: { [runtime.id]: settings } }, root).selectionRequired, undefined);
  assert.equal(runtime.resolveSelection(chosen, { runtimes: { [runtime.id]: settings } }, root).ready, true);
  await assert.rejects(runtime.importRuntime({ userDataDir: root, version: "1.1.0", runtimePath }), /already registered/);
  const unlisted = await runtime.importRuntime({ userDataDir: root, version: "unknown", runtimePath });
  assert.equal(unlisted.version, "unknown"); assert.equal(unlisted.provenanceVerified, false);
  assert.equal(unlisted.upstreamRevision, "local");
  assert.equal(runtime.resolveSelection({ runtimeData: { [runtime.id]: { version: "unknown" } } }, {}, root).ready, true);
  const reopened = manager({ discoverCatalog: () => assert.fail("Local registrations reopen offline") });
  assert.equal(reopened.resolveSelection({ runtimeData: { [runtime.id]: { version: "unknown" } } }, {}, root).ready, true);
  assert.deepEqual(runtime.getState({ userDataDir: root }).catalog.versions, ["1.2.0", "1.1.0"], "Local registration does not invent a remote release");
  fs.appendFileSync(runtimePath, "changed");
  assert.equal(runtime.resolveSelection(chosen, { runtimes: { [runtime.id]: settings } }, root).ready, false);
  await runRuntimeManagerAction({ manager: runtime, action: "uninstall", userDataDir: root,
    payload: { version: "1.1.0" }, readSettings: () => settings, saveSettings: next => { settings = next; } });
  assert.equal(settings.defaultVersion ?? null, null);
  assert.equal(fs.existsSync(runtimePath), true);
});

test("local imports cannot label a native executable as a different selected architecture", { skip: process.platform !== "darwin" }, async t => {
  const root = temporary(t), runtimePath = path.join(root, "local-runtime");
  fs.writeFileSync(runtimePath, binary(process.arch === "x64" ? "x86_64" : "arm64"), { mode: 0o755 });
  const architecture = process.arch === "x64" ? "arm64" : "x86_64";
  const runtime = await listed({ importLocal: true, discoverCatalog: async () => [{ ...catalog[0], architecture }] }, root);
  assert.throws(() => runtime.importRuntime({ userDataDir: root, version: "1.2.0", runtimePath }), new RegExp(`requires a ${architecture} executable|does not support this Mac's`));
  assert.deepEqual(runtime.core.listInstalled(root), []);
});

test("download choices require explicit refresh, cache offline, keep the last list on an empty answer and retire removed releases", async t => {
  const root = temporary(t), asset = version => ({ version, upstreamRevision: version, asset: {
    filename: version + '.tar.gz', url: 'https://example.test/' + version + '.tar.gz', sha256: 'a'.repeat(64) } });
  let rows = [asset('2.0')], requests = 0;
  const options = { sourceUrl: 'https://example.test/releases',
    discoverCatalog: async () => { requests++; return rows; } };
  const runtime = manager(options);
  assert.deepEqual(runtime.getState({ userDataDir: root }).catalog.versions, []);
  assert.equal(requests, 0);
  assert.deepEqual((await runtime.refreshCatalog({ userDataDir: root, force: true })).versions, ['2.0']);
  const cached = manager(options);
  assert.deepEqual(cached.getState({ userDataDir: root }).catalog.versions, ['2.0']);
  assert.equal(requests, 1, 'Loading cached choices stays offline');
  rows = [];
  await assert.rejects(cached.refreshCatalog({ userDataDir: root, force: true }), /previous list is kept/);
  assert.deepEqual(manager(options).getState({ userDataDir: root }).catalog.versions, ['2.0']);
  rows = [asset('3.0')];
  assert.deepEqual((await cached.refreshCatalog({ userDataDir: root, force: true })).versions, ['3.0']);
  assert.deepEqual(manager(options).getState({ userDataDir: root }).catalog.versions, ['3.0']);
});

test("reinstall atomically repairs damaged downloaded bytes and preserves them when replacement fails", { skip: process.platform !== 'darwin' }, async t => {
  const root = temporary(t), archive = Buffer.from('verified replacement'), digest = crypto.createHash('sha256').update(archive).digest('hex');
  let invalidArchive = false, downloads = 0;
  const runtime = manager({ discoverCatalog: async () => [{ version: '1.2.0', upstreamRevision: 'abc123', asset: {
    url: 'https://example.test/native.tar.gz', filename: 'native.tar.gz', sha256: digest } }],
    resolveExecutable: destination => path.join(destination, 'runner'),
    dependencies: { downloadToFile: async (_url, destination) => { downloads++; fs.writeFileSync(destination, invalidArchive ? 'incorrect' : archive); },
      extractArchive: async (_archive, destination) => fs.writeFileSync(path.join(destination, 'runner'), binary(process.arch === 'x64' ? 'x86_64' : 'arm64'), { mode: 0o755 }) } });
  const first = await runtime.installRuntime({ userDataDir: root, version: '1.2.0' });
  const executable = first.executablePath, record = fs.readFileSync(path.join(first.installDir, 'runtime.json'));
  fs.writeFileSync(executable, 'damaged');
  assert.equal(runtime.getState({ userDataDir: root }).installed[0].ready, false);
  invalidArchive = true;
  await assert.rejects(runtime.installRuntime({ userDataDir: root, version: '1.2.0' }), /SHA-256/);
  assert.equal(fs.readFileSync(executable).subarray(-7).toString(), 'damaged');
  assert.deepEqual(fs.readFileSync(path.join(first.installDir, 'runtime.json')), record);
  invalidArchive = false;
  const repaired = await runtime.installRuntime({ userDataDir: root, version: '1.2.0' });
  assert.equal(repaired.binarySha256, first.binarySha256);
  assert.equal(runtime.getState({ userDataDir: root }).installed[0].ready, true);
  assert.equal(downloads, 3);
  assert(!fs.readdirSync(path.dirname(first.installDir)).some(name => name.startsWith('.install-')));
});

 test("cached published versions provide compatible stable manager defaults and preserve explicit choices offline", async t => {
  const root = temporary(t), row = (version, extra = {}) => ({ version, upstreamRevision: "source-" + version,
    asset: { filename: "runtime.zip", url: "https://example.test/" + version + ".zip", sha256: "a".repeat(64) }, ...extra });
  const published = [row("1.2.0"), row("1.10.0"), row("2.0.0", { channel: "development" }),
    row("3.0.0", { prerelease: true }), row("4.0.0", { minimumMacOS: "99.0" }), row("5.0.0", { deprecated: true })];
  const runtime = manager({ discoverCatalog: async () => published, dependencies: { systemVersionSync: () => "13.0" } });
  assert.equal(runtime.resolveSelection({}, {}, root).discoveryRequired, true);
  await runtime.refreshCatalog({ userDataDir: root });
  const cached = manager({ discoverCatalog: () => assert.fail("Selection must stay offline"), dependencies: { systemVersionSync: () => "13.0" } });
  assert.equal(cached.resolveSelection({}, {}, root).version, "1.10.0");
  assert.equal(cached.resolveSelection({}, {}, root).selectionRequired, undefined);
  assert.ok(cached.getState({ userDataDir: root }).catalog.versions.includes("1.10.0"));
  assert.equal(cached.resolveSelection({}, {}, root, { compatible: pin => pin.version === "1.2.0" }).version, "1.2.0", "The manager default honors the game profile");
  assert.equal(cached.resolveSelection({ runtimeData: { "fixture-native": { version: "missing-choice" } } }, {}, root).version, "missing-choice");
  assert.equal(cached.resolveSelection({}, { runtimes: { "fixture-native": { defaultVersion: "1.2.0" } } }, root).version, "1.2.0");
});

test("automatic defaults use a compatible installed consumer build before a newer cached download", async t => {
  const Architecture = require("../src/modules/shared/runtime/architecture");
  for (const consumer of ["arm64", "x64"]) {
    const root = temporary(t), other = consumer === "arm64" ? "x64" : "arm64";
    let hostVersion = "100.0";
    const row = (version, architecture, extra = {}) => ({ version, architecture, upstreamRevision: "source-" + version,
      asset: { filename: version + ".zip", url: "https://example.test/" + version + ".zip", sha256: "a".repeat(64) }, ...extra });
    const published = [row("3.0.0", consumer), row("2.0.0", consumer, { minimumMacOS: "99.0" }),
      row("1.0.0", consumer), row("9.0.0", other)];
    const runtime = Architecture.withArchitecture(consumer, () => manager({
      discoverCatalog: async () => published, dependencies: { systemVersionSync: () => hostVersion,
        hostArch: "arm64", hostCapabilities: { platform: "darwin", hardwareArch: "arm64", rosettaAvailable: true },
        downloadToFile: () => assert.fail("Automatic selection must not download") } }));
    await runtime.refreshCatalog({ userDataDir: root });
    const register = (version, architecture) => Architecture.withArchitecture(architecture, () => {
      const file = path.join(root, version + "-" + architecture);
      fs.writeFileSync(file, binary(architecture === "x64" ? "x86_64" : "arm64"), { mode: 0o755 });
      return runtime.core.registerLocal({ userDataDir: root, version, runtimePath: file });
    });
    const select = options => runtime.resolveSelection({}, {}, root, { architecture: consumer, ...options });
    register("2.0.0", consumer);hostVersion = "13.0";
    assert.equal(select().version, "3.0.0", "An installed build above the actual macOS floor is ineligible");
    assert.equal(select().requiresDownload, true, "The catalog is used when no eligible installed copy exists");
    register("1.0.0", consumer);register("9.0.0", other);
    const automatic = select();
    assert.equal(automatic.version, "1.0.0");assert.equal(automatic.ready, true);assert.equal(automatic.requiresDownload, false);
    assert.equal(Architecture.recordArchitecture(automatic.install), consumer, "A newer other-CPU copy does not displace this consumer's installed build");
    assert.equal(runtime.getState({ userDataDir: root }).defaultVersion, "1.0.0", "Runtimes and Play agree on the automatic default");
    const incompatible = select({ compatible: pin => pin.version === "3.0.0" });
    assert.equal(incompatible.version, "3.0.0");assert.equal(incompatible.ready, false);
    // A saved default that is not installed yields to the installed version;
    // a version chosen for the game stays exact.
    const saved = runtime.resolveSelection({}, { runtimes: { [runtime.id]: { defaultVersion: "3.0.0" } } }, root, { architecture: consumer });
    assert.equal(saved.version, "1.0.0");assert.equal(saved.ready, true, "An uninstalled saved default asks for no download while an installed version is usable");
    assert.equal(saved.preferredVersion, "3.0.0");
    const savedIncompatible = runtime.resolveSelection({}, { runtimes: { [runtime.id]: { defaultVersion: "3.0.0" } } }, root,
      { architecture: consumer, compatible: pin => pin.version === "3.0.0" });
    assert.equal(savedIncompatible.version, "3.0.0");assert.equal(savedIncompatible.ready, false, "An installed version the compatibility rule rejects does not replace it");
    const withdrawn = runtime.resolveSelection({}, { runtimes: { [runtime.id]: { defaultVersion: "unavailable-choice" } } }, root, { architecture: consumer });
    assert.equal(withdrawn.version, "1.0.0");assert.equal(withdrawn.ready, true, "A withdrawn unavailable default uses the ordinary installed fallback");
    assert.equal(select({ recommendedVersion: "3.0.0" }).version, "3.0.0");
    const game = runtime.resolveSelection({ runtimeData: { [runtime.id]: { version: "3.0.0" } } }, {}, root, { architecture: consumer });
    assert.equal(game.version, "3.0.0");assert.equal(game.ready, false);
    const cached = Architecture.withArchitecture(consumer, () => manager({
      discoverCatalog: () => assert.fail("Reading an existing catalog must stay offline"), dependencies: {
        systemVersionSync: () => hostVersion, hostArch: "arm64",
        hostCapabilities: { platform: "darwin", hardwareArch: "arm64", rosettaAvailable: true } } }));
    assert.equal(cached.resolveSelection({}, {}, root, { architecture: consumer }).version, "1.0.0");
  }
});

test("catalog selection stays with its launcher data directory", async t => {
  const root = temporary(t), first = path.join(root, "first"), second = path.join(root, "second");
  const runtime = manager({ discoverCatalog: async () => [{version:"7.0",upstreamRevision:"source-seven",
    asset:{filename:"runtime.zip",url:"https://example.test/runtime.zip",sha256:"a".repeat(64)}}] });
  await runtime.refreshCatalog({userDataDir:first});
  assert.equal(runtime.resolveSelection({}, {}, first, { version: "7.0" }).version,"7.0");
  assert.equal(runtime.resolveSelection({}, {}, second).version,null);
  assert.deepEqual(runtime.getState({userDataDir:second}).catalog.versions,[]);
  assert.equal(runtime.resolveSelection({}, {}, first, { version: "7.0" }).version,"7.0");
});

test("a catalog-only manager discovers inside a consented install and its receipt plays offline after the release leaves the list", { skip: process.platform !== "darwin" }, async t => {
  const root = temporary(t), archive = path.join(root, "archive.zip"); let discoveries = 0;
  fs.writeFileSync(archive, "published archive fixture");
  const row = version => ({ version, upstreamRevision: "source-" + version,
    asset: { url: `https://example.test/${version}.zip`, filename: "runtime.zip", sha256: hashFile(archive) } });
  let published = [row("1.0"), row("2.0")];
  const options = { resolveExecutable: directory => path.join(directory, "engine"),
    discoverCatalog: async () => { discoveries++; return published; },
    dependencies: { downloadToFile: async (_url, output) => fs.copyFileSync(archive, output),
      extractArchive: async (_input, directory) => fs.writeFileSync(path.join(directory, "engine"),
        binary(process.arch === "x64" ? "x86_64" : "arm64"), { mode: 0o755 }) } };
  const runtime = manager(options);
  assert.equal(runtime.resolveSelection({}, {}, root).discoveryRequired, true);
  assert.equal(discoveries, 0, "Selection stays offline");
  const installed = await runtime.installRuntime({ userDataDir: root });
  assert.equal(discoveries, 1); assert.equal(installed.version, "2.0", "The newest discovered release installs");
  published = [row("3.0")];
  await runtime.refreshCatalog({ userDataDir: root, force: true });
  const catalogs = path.join(root, "runtimes", "fixture-native");
  for (const name of fs.readdirSync(catalogs).filter(name => /^catalog.*\.json$/.test(name))) fs.rmSync(path.join(catalogs, name));
  const offline = manager({ ...options, discoverCatalog: () => assert.fail("Installed receipts stay offline") });
  assert.equal(offline.resolveSelection({}, {}, root).version, "2.0");
  assert.equal(offline.resolveSelection({}, {}, root).ready, true);
  assert.equal(offline.resolveSelection({}, { runtimes: { "fixture-native": { defaultVersion: "2.0" } } }, root).ready, true);
});

test("a download without a publisher size or digest installs with a recorded hash and stays installed", { skip: process.platform !== "darwin" }, async t => {
  const root = temporary(t);
  const runtime = manager({ resolveExecutable: directory => path.join(directory, "engine"),
    discoverCatalog: async () => [{ version: "1.0", upstreamRevision: "1.0", asset: { url: "https://example.test/1.0.zip", filename: "runtime.zip", integrity: "recorded-local" } }],
    dependencies: { downloadToFile: async (_url, output) => fs.writeFileSync(output, "archive"),
      extractArchive: async (_input, directory) => fs.writeFileSync(path.join(directory, "engine"),
        binary(process.arch === "x64" ? "x86_64" : "arm64"), { mode: 0o755 }) } });
  const installed = await runtime.installRuntime({ userDataDir: root });
  assert.equal(installed.version, "1.0");
  assert.equal(runtime.resolveSelection({}, {}, root).ready, true);
});

test("an install from a cached list whose file the publisher removed reads the current list once and installs its newest release", { skip: process.platform !== "darwin" }, async t => {
  const root = temporary(t), archive = path.join(root, "archive.zip"); let discoveries = 0;
  fs.writeFileSync(archive, "published archive fixture");
  const row = version => ({ version, upstreamRevision: "source-" + version,
    asset: { url: `https://example.test/${version}.zip`, filename: "runtime.zip", sha256: hashFile(archive) } });
  let published = [row("1.0")];
  const runtime = manager({ resolveExecutable: directory => path.join(directory, "engine"),
    discoverCatalog: async () => { discoveries++; return published; },
    dependencies: { downloadToFile: async (url, output) => {
      if (url.endsWith("/1.0.zip")) throw Object.assign(new Error("HTTP 404"), { statusCode: 404 });
      fs.copyFileSync(archive, output);
    }, extractArchive: async (_input, directory) => fs.writeFileSync(path.join(directory, "engine"),
      binary(process.arch === "x64" ? "x86_64" : "arm64"), { mode: 0o755 }) } });
  await runtime.refreshCatalog({ userDataDir: root, force: true });
  published = [row("2.0")];
  const installed = await runtime.installRuntime({ userDataDir: root });
  assert.equal(installed.version, "2.0");
  assert.equal(discoveries, 2, "One refresh follows the missing file");
});

test("removing one copy of a version leaves other CPUs', earlier layouts' and replaced managers' copies", async t => {
  const { runRuntimeManagerAction } = require("../src/core/runtime-manager-service");
  const coordinator = { acquireMutation: async () => "token", extendMutation: async () => {}, release: async () => {} };
  // An Intel copy with its record, which Apple silicon may also use through Rosetta.
  const copy = (folder, architecture) => {
    fs.mkdirSync(path.join(folder, "bin"), { recursive: true }); fs.writeFileSync(path.join(folder, "bin", "tool"), binary(architecture));
    fs.writeFileSync(path.join(folder, "runtime.json"), JSON.stringify({ version: "1.2.0", architecture, source: "download", executableRelative: "bin/tool" }));
    return path.join(folder, "bin", "tool");
  };
  const incomplete = folder => { fs.mkdirSync(path.join(folder, "build"), { recursive: true }); return folder; };
  const remove = (runtime, root) => runRuntimeManagerAction({ manager: runtime, action: "uninstall", userDataDir: root, runtimeCoordinator: coordinator,
    payload: { version: "1.2.0", variant: "architecture:arm64" } });
  for (const refuse of [false, true]) {
    const root = temporary(t), runtimes = path.join(root, "runtimes", "fixture-native");
    const runtime = await listed({ dependencies: { hostArch: "arm64" } }, root);
    const arm = incomplete(path.join(runtimes, "arm64", "1.2.0")), intel = copy(path.join(runtimes, "x64", "1.2.0"), "x64");
    if (refuse) {
      const original = runtime.uninstallRuntime;
      runtime.uninstallRuntime = async payload => { await original.call(runtime, payload); throw new Error("Removal refused."); };
      await assert.rejects(remove(runtime, root), /refused/);
    } else assert.equal(await remove(runtime, root), true);
    assert.ok(fs.existsSync(intel), `the Intel copy stays${refuse ? " after a refusal" : ""}`);
    if (!refuse) assert.ok(!fs.existsSync(arm));
    assert.deepEqual(fs.readdirSync(path.join(root, "runtimes")).filter(name => name.startsWith(".maclauncher-")), []);
  }
  const root = temporary(t), runtime = await listed({ dependencies: { hostArch: "arm64" }, formerIds: ["fixture-former"] }, root);
  const current = incomplete(path.join(root, "runtimes", "fixture-native", "arm64", "1.2.0"));
  const earlier = copy(path.join(root, "runtimes", "fixture-native", "1.2.0"), "arm64"), former = copy(path.join(root, "runtimes", "fixture-former", "1.2.0"), "arm64");
  assert.equal(await remove(runtime, root), true);
  assert.ok(!fs.existsSync(current));
  assert.ok(fs.existsSync(earlier) && fs.existsSync(former), "copies of an earlier layout and a replaced manager stay");
});


test("downloaded launch identities describe the current executable without pinning receipt bytes", async t => {
  const root=temporary(t), version="7.0", executable=path.join(root,"runtimes","identity-fixture",version,"runner");
  fs.mkdirSync(path.dirname(executable),{recursive:true});fs.writeFileSync(executable,binary(process.arch==='x64'?'x86_64':'arm64'),{mode:0o755});
  const initial=crypto.createHash('sha256').update(fs.readFileSync(executable)).digest('hex'),asset={url:'https://example.test/fixture.zip',filename:'fixture.zip',sha256:'a'.repeat(64)};
  fs.writeFileSync(path.join(path.dirname(executable),'runtime.json'),JSON.stringify({version,upstreamRevision:'observed-source',source:'download',binarySha256:initial,executableRelative:'runner',archiveSha256:asset.sha256,catalogEntry:{version,upstreamRevision:'observed-source',asset}}));
  const selected=require('../src/modules/shared/runtime/pinned-native-manager').createPinnedNativeManager({id:'identity-fixture',label:'Identity fixture',discoverCatalog:async()=>[]});
  fs.appendFileSync(executable,'additive native content');
  const result=selected.resolveSelection({runtimeData:{'identity-fixture':{version}}},{},root);
  assert.equal(result.ready,true);assert.notEqual(result.install.binarySha256,initial);
  assert.equal(result.install.binarySha256,result.install.sha256);
});

test("an uninstalled saved default yields to an installed version for Play while Install installs the saved default", { skip: process.platform !== "darwin" }, async t => {
  const root = temporary(t), archive = Buffer.from("saved default archive"), digest = crypto.createHash("sha256").update(archive).digest("hex");
  const runner = binary(process.arch === "x64" ? "x86_64" : "arm64"), local = path.join(root, "local-runner");
  fs.writeFileSync(local, runner, { mode: 0o755 });
  const runtime = await listed({ discoverCatalog: async () => ["1.2.0", "1.1.0"].map(version => ({ version, upstreamRevision: version,
    asset: { url: `https://example.com/native-${version}.tar.gz`, filename: `native-${version}.tar.gz`, sha256: digest } })),
    resolveExecutable: destination => path.join(destination, "runner"),
    dependencies: { downloadToFile: async (_url, destination) => fs.writeFileSync(destination, archive),
      extractArchive: async (_archive, destination) => fs.writeFileSync(path.join(destination, "runner"), runner, { mode: 0o755 }) } }, root);
  runtime.core.registerLocal({ userDataDir: root, version: "1.1.0", runtimePath: local });
  const settings = { runtimes: { "fixture-native": { defaultVersion: "1.2.0" } } };
  const play = runtime.resolveSelection({}, settings, root);
  assert.deepEqual([play.version, play.ready, play.requiresDownload, play.preferredVersion], ["1.1.0", true, false, "1.2.0"]);
  assert.equal(runtime.resolveSelection({ runtimeData: { "fixture-native": { version: "1.2.0" } } }, settings, root).ready, false, "a game's own version stays exact");
  const installed = await runtime.installRuntime({ userDataDir: root, settings });
  assert.equal(installed.version, "1.2.0", "Install installs the saved default");
  assert.equal(runtime.resolveSelection({}, settings, root).version, "1.2.0", "the installed saved default applies again");
});
