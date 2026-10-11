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
function manager(options = {}) { return createPinnedNativeManager({ id: "fixture-native", label: "Fixture", catalog, ...options }); }

test("downloaded runtime floors appear in shared state and block download or build on older hosts", { skip: process.platform !== "darwin" }, async t => {
  const root = temporary(t);
  let actual = "13.6";
  const runtime = manager({ catalog: [{ version: "26.0", upstreamRevision: "new", minimumMacOS: "26.0", asset: {
    filename: "runtime.zip", url: "https://example.test/runtime.zip", sha256: "a".repeat(64) } },
    { version: "13.0", upstreamRevision: "old", minimumMacOS: "13.0", localBuild: true }],
    buildRuntime: () => assert.fail("Host floor must block compilation"),
    dependencies: { systemVersionSync: () => actual, downloadToFile: () => assert.fail("Host floor must block downloads") } });
  const state = runtime.getState({ userDataDir: root });
  assert.equal(state.catalog.versionRequirements["26.0"].minimumMacOS, "26.0");
  assert.match(state.catalog.versionRequirements["26.0"].installReason, /requires macOS 26\.0/);
  assert.deepEqual(state.catalog.installableVersions, ["13.0"]);
  assert.match(runtime.resolveSelection({}, {}, root).reason, /requires macOS 26\.0/);
  await assert.rejects(runtime.installRuntime({ userDataDir: root, version: "26.0" }), /requires macOS 26\.0/);
  actual = "12.7";
  await assert.rejects(runtime.installRuntime({ userDataDir: root, version: "13.0" }), /requires macOS 13\.0/);
  assert.equal(fs.existsSync(path.join(root, "runtimes")), false);
});

test("native runtime floor values are explicit and validated in offline and remote catalogs", async () => {
  for (const floor of ["main", "0.0", "26", 26, "26.0.0.1"]) assert.throws(() => manager({ catalog: [{ version: "1.0", upstreamRevision: "a", minimumMacOS: floor }] }), /SHA-256/);
  const runtime = manager({ discoverCatalog: async () => [{ version: "2.0", upstreamRevision: "b", minimumMacOS: "unknown" }] });
  await assert.rejects(runtime.refreshCatalog({ force: true }), /invalid version or artifact identities/);
});

test("a valid native installation is unavailable on an older host without being mislabeled as damaged", { skip: process.platform !== "darwin" }, t => {
  const root = temporary(t), executable = path.join(root, "runtime");
  fs.writeFileSync(executable, binary(process.arch === "x64" ? "x86_64" : "arm64"), { mode: 0o755 });
  let actual = "26.0";
  const runtime = manager({ catalog: [{ version: "26.0", upstreamRevision: "new", minimumMacOS: "26.0" }],
    dependencies: { systemVersionSync: () => actual } });
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
  const runtime = manager({ catalog: [{ version: "nightly", upstreamRevision: "revision", asset: { filename: "runtime.zip",
    url: "https://example.test/runtime.zip", sha256: "a".repeat(64), expiresAt: "2026-01-01T00:00:00Z" } }],
    dependencies: { now: () => Date.parse("2026-10-10T00:00:00Z"), downloadToFile: () => assert.fail("Expired artifacts must not download") } });
  assert.deepEqual(runtime.getState({ userDataDir: root }).catalog.installableVersions, []);
  assert.match(runtime.getState({ userDataDir: root }).catalog.versionRequirements.nightly.installReason, /expired.*Refresh/);
  await assert.rejects(runtime.installRuntime({ userDataDir: root, version: "nightly" }), /expired/);
  runtime.core.registerLocal({ userDataDir: root, version: "nightly", runtimePath: executable });
  assert.equal(runtime.resolveSelection({}, {}, root).ready, true);
  assert.equal((await runtime.installRuntime({ userDataDir: root, version: "nightly" })).executablePath, executable);
});

test("pinned native catalogs are offline, finite and reject traversal/unknown versions", async () => {
  const runtime = manager();
  assert.deepEqual((await runtime.refreshCatalog()).versions, ["1.2.0", "1.1.0"]);
  assert.equal(runtime.getState({}).catalog.installable, false);
  assert.deepEqual(runtime.getState({}).catalog.installableVersions, []);
  assert.match(runtime.getState({}).catalog.installReason, /runtime can be imported/);
  assert.throws(() => runtime.core.normalizeVersion("../escape"), /Unsupported/);
  assert.throws(() => runtime.applySettingsUpdate("setDefault", { version: "latest" }, {}), /Unsupported/);
  assert.throws(() => createPinnedNativeManager({ id: "../bad", catalog }), /id/);
  assert.throws(() => manager({ catalog: [{ version: "../bad", upstreamRevision: "a" }] }), /safe names/);
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

test("included source-only runtime requirements reach the distribution model", () => {
  const runtime = manager({ distributionRequired: true,
    catalog: [{ version: "1.2.0", upstreamRevision: "a".repeat(40), localBuild: false }] });
  runtime.distributionVersions = ["1.2.0"];
  const model = require("../scripts/distribution-model.cjs");
  assert.deepEqual(model.nativeRequirements({ arch: "arm64", maximumMacOS: "13.0" },
    { managers: () => new Map([[runtime.id, runtime]]) }),
  [{ managerId: runtime.id, version: "1.2.0", arch: "arm64", upstreamRevision: "a".repeat(40) }]);
  assert.equal(model.requiresDistribution(manager({ catalog: runtime.core.catalog })), false);
  assert.throws(() => manager({ distributionRequired: "true" }), /explicit booleans/);
});

test("explicit missing runtime selection never falls back to another installed version", { skip: process.platform !== "darwin" }, t => {
  const root = temporary(t), executable = path.join(root, "runtime");
  fs.writeFileSync(executable, binary(process.arch === "x64" ? "x86_64" : "arm64"), { mode: 0o755 });
  const runtime = manager();
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

test("local registration records SHA identity, rejects replaced executables and preserves external build on uninstall", { skip: process.platform !== "darwin" }, t => {
  const root = temporary(t), executable = path.join(root, "runtime");
  fs.writeFileSync(executable, binary(process.arch === "x64" ? "x86_64" : "arm64"), { mode: 0o755 });
  const runtime = manager();
  const record = runtime.core.registerLocal({ userDataDir: root, version: "1.2.0", runtimePath: executable });
  assert.equal(record.binarySha256, hashFile(executable));
  assert.throws(() => runtime.core.registerLocal({ userDataDir: root, version: "1.2.0", runtimePath: executable }), /already registered/);
  fs.appendFileSync(executable, "replacement");
  assert.equal(runtime.core.resolveInstalled({ userDataDir: root, version: "1.2.0" }), null);
  const damaged = runtime.getState({ userDataDir: root }).sections[0].installed[0];
  assert.equal(damaged.version, "1.2.0"); assert.equal(damaged.ready, false); assert.equal(damaged.status, "damaged");
  assert.match(damaged.error, /changed/);
  runtime.uninstallRuntime({ userDataDir: root, version: "1.2.0", installDir: root });
  assert.equal(fs.existsSync(executable), true);
  assert.equal(fs.existsSync(path.join(root, "runtimes", "fixture-native", "1.2.0")), false);
});

test("incomplete native build directories remain visible and removable in runtime UI state", t => {
  const root = temporary(t), runtime = manager();
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

test("verified native build records bind source and overlay evidence to the selected revision", { skip: process.platform !== "darwin" }, t => {
  const root = temporary(t), executable = path.join(root, "runtime");
  fs.writeFileSync(executable, binary(process.arch === "x64" ? "x86_64" : "arm64"), { mode: 0o755 });
  const runtime = manager();
  const verifiedBuild = { sourceRevision: "abc123", sourceTreeSha256: "a".repeat(64), overlaySha256: "b".repeat(64), configureOptions: ["-DFETCHCONTENT_FULLY_DISCONNECTED=ON"] };
  assert.throws(() => runtime.core.registerLocal({ userDataDir: root, version: "1.2.0", runtimePath: executable,
    verifiedBuild: { ...verifiedBuild, sourceRevision: "wrong" } }), /selected source revision/);
  const record = runtime.core.registerLocal({ userDataDir: root, version: "1.2.0", runtimePath: executable, verifiedBuild });
  assert.equal(record.provenanceVerified, true); assert.deepEqual(record.verifiedBuild, verifiedBuild);
});

test("pinned download digest failure blocks extraction and removes partial staging", { skip: process.platform !== "darwin" }, async t => {
  const root = temporary(t);
  let extracted = false;
  const runtime = manager({ catalog: [{ version: "1.0", upstreamRevision: "a", asset: {
    url: "https://example.test/runtime.zip", filename: "runtime.zip", sha256: "0".repeat(64) } }],
  dependencies: { downloadToFile: async (_url, output) => fs.writeFileSync(output, "wrong artifact"),
    extractArchive: async () => { extracted = true; } } });
  await assert.rejects(runtime.installRuntime({ userDataDir: root, version: "1.0" }), /SHA-256/);
  assert.equal(extracted, false);
  assert.deepEqual(fs.readdirSync(path.join(root, "runtimes", "fixture-native")), []);
});

test("pinned download persists selected revision and validates the published executable", { skip: process.platform !== "darwin" }, async t => {
  const root = temporary(t), archive = path.join(root, "archive.zip");
  fs.writeFileSync(archive, "trusted archive fixture");
  const runtime = manager({ catalog: [{ version: "1.0", upstreamRevision: "revision-a", asset: {
    url: "https://example.test/runtime.zip", filename: "runtime.zip", sha256: hashFile(archive) } }],
  resolveExecutable: directory => path.join(directory, "engine"),
  dependencies: { downloadToFile: async (_url, output) => fs.copyFileSync(archive, output),
    extractArchive: async (_input, directory) => fs.writeFileSync(path.join(directory, "engine"),
      binary(process.arch === "x64" ? "x86_64" : "arm64"), { mode: 0o755 }) } });
  const record = await runtime.installRuntime({ userDataDir: root, version: "1.0" });
  assert.equal(runtime.getState({ userDataDir: root }).catalog.installable, true);
  assert.deepEqual(runtime.getState({ userDataDir: root }).catalog.installableVersions, ["1.0"]);
  assert.equal(record.upstreamRevision, "revision-a");
  assert.equal(record.provenanceVerified, true);
  assert.equal(record.source, "download");
  assert.equal(record.binarySha256, hashFile(record.executablePath));
  assert.deepEqual(fs.readdirSync(path.join(root, "runtimes", "fixture-native")), ["1.0"]);
});

test("legacy publisher MD5 requires an independent signed-artifact verifier", () => {
  const legacy = [{ version: "1.0", upstreamRevision: "revision-a", asset: {
    url: "https://publisher.test/runtime.pkg", filename: "runtime.pkg", integrity: "publisher-md5", md5: "a".repeat(32) } }];
  assert.throws(() => manager({ catalog: legacy }), /SHA-256/);
  assert.throws(() => manager({ catalog: legacy, verifyArtifact: true }), /verification requires a callback/);
  assert.doesNotThrow(() => manager({ catalog: legacy, verifyArtifact: async () => ({ verified: true }) }));
});

test("an explicitly resolved old game version survives bounded catalog refresh without duplicate rows", async t => {
  const root = temporary(t), options = { discoverCatalog: async () => [{ version: "2.0", upstreamRevision: "newer" }] };
  const runtime = manager(options);
  runtime.core.rememberResolvedVersion({ userDataDir: root, entry: { version: "0.9", upstreamRevision: "older", localBuild: false } });
  runtime.core.rememberResolvedVersion({ userDataDir: root, entry: { version: "0.9", upstreamRevision: "older", localBuild: false } });
  assert.deepEqual((await runtime.refreshCatalog({ userDataDir: root, force: true })).versions, ["2.0", "0.9"]);
  const restored = manager(options).getState({ userDataDir: root });
  assert.deepEqual(restored.catalog.versions, ["2.0", "0.9"]);
  assert.equal(runtime.resolveSelection({ runtimeData: { "fixture-native": { version: "0.9" } } }, {}, root).version, "0.9");
  assert.throws(() => runtime.core.rememberResolvedVersion({ userDataDir: root, entry: { version: "../bad", upstreamRevision: "bad" } }), /identity/);
});

test("legacy publisher digest and signer failures both block extraction", { skip: process.platform !== "darwin" }, async t => {
  const root = temporary(t), bytes = Buffer.from("legacy installer fixture");
  const md5 = crypto.createHash("md5").update(bytes).digest("hex");
  let verified = 0, extracted = 0;
  function fixture(digest, evidence) {
    return manager({ catalog: [{ version: "1.0", upstreamRevision: "revision-a", asset: {
      url: "https://publisher.test/runtime.pkg", filename: "runtime.pkg", integrity: "publisher-md5", md5: digest } }],
      verifyArtifact: async () => { verified++; return evidence; },
      dependencies: { downloadToFile: async (_url, output) => fs.writeFileSync(output, bytes),
        extractArchive: async () => { extracted++; } } });
  }
  await assert.rejects(fixture("0".repeat(32), null).installRuntime({ userDataDir: root, version: "1.0" }), /MD5/);
  assert.equal(verified, 0);
  await assert.rejects(fixture(md5, { verified: false }).installRuntime({ userDataDir: root, version: "1.0" }), /signed artifact identity/);
  assert.equal(verified, 1); assert.equal(extracted, 0);
  assert.deepEqual(fs.readdirSync(path.join(root, "runtimes", "fixture-native")), []);
});

test("signed legacy downloads record SHA-256 and verified publisher identity", { skip: process.platform !== "darwin" }, async t => {
  const root = temporary(t), bytes = Buffer.from("signed installer fixture");
  const archiveSha256 = crypto.createHash("sha256").update(bytes).digest("hex"), md5 = crypto.createHash("md5").update(bytes).digest("hex");
  const evidence = { verified: true, identity: "Example Publisher (TEAM1234)", archiveSha256, certificateSha256: "b".repeat(64) };
  const runtime = manager({ catalog: [{ version: "1.0", upstreamRevision: "revision-a", asset: {
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
  const runtime = manager({ sourceUrl: "https://example.test/pinned-source", buildHelpUrl: "https://example.test/setup",
    buildRuntime: async args => {
      called = args;
      args.onProgress({ downloaded: 4, total: 4 });
      return args.manager.core.registerLocal({ userDataDir: args.userDataDir, version: args.version, runtimePath: executable });
    }, dependencies: { downloadToFile: async () => assert.fail("source builds must not download") } });
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
  await assert.rejects(runtime.installRuntime({ userDataDir: root, version: "" }), /Unsupported/);
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
  const runtime = manager({ buildRuntime: async () => assert.fail("corrupt bundles must not fall back to source"),
    bundledRuntime: { resolve: () => { throw new Error("Bundled manifest pin mismatch"); },
      install: async () => { throw new Error("Bundled manifest pin mismatch"); }, verifyInstalled: () => false } });
  assert.equal(runtime.getState({}).catalog.installable, false);
  assert.match(runtime.getState({}).catalog.installReason, /Bundled manifest pin mismatch/);
  await assert.rejects(runtime.installRuntime({ userDataDir: temporary(t), version: "1.2.0" }), /pin mismatch/);
});

test("a missing packaged source checkout cannot advertise a source Build action", t => {
  const root = temporary(t), source = path.join(root, "source");
  const runtime = manager({ buildRuntime: async () => {}, buildSourcePath: source });
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
  const runtime = manager({ bundledRuntime: { resolve: () => null, install: async () => null,
    verifyInstalled: ({ verification }) => { if (verification === "full") { fullChecks++; return !auxiliaryDamaged; } return true; } } });
  const directory = runtime.core.getInstallDir({ userDataDir: root, version: "1.2.0" }); fs.mkdirSync(directory, { recursive: true });
  const executable = path.join(directory, "runner");
  fs.writeFileSync(executable, binary(process.arch === "x64" ? "x86_64" : "arm64"), { mode: 0o755 });
  fs.writeFileSync(path.join(directory, "runtime.json"), JSON.stringify({ version: "1.2.0", upstreamRevision: "abc123",
    source: "bundled", executableRelative: "runner", binarySha256: hashFile(executable) }));
  for (let i = 0; i < 30; i++) assert.equal(runtime.getState({ userDataDir: root }).installed[0].ready, true);
  assert.equal(nativeChecks, 1); assert.equal(fullChecks, 0);
  auxiliaryDamaged = true;
  assert.equal(runtime.resolveSelection(null, null, root).ready, false);
  assert.equal(fullChecks, 1);
  assert.equal(runtime.getState({ userDataDir: root }).installed[0].ready, false, "a failed full check stays visible after warm broadcasts");
  auxiliaryDamaged = false;
  await runtime.refreshCatalog({ userDataDir: root, force: true });
  assert.equal(fullChecks, 2);
  assert.equal(runtime.getState({ userDataDir: root }).installed[0].ready, true);
  runtime.uninstallRuntime({ userDataDir: root, version: "1.2.0" });
  assert.deepEqual(runtime.getState({ userDataDir: root }).installed, []);
});

test("a warmed display invalidates on a same-size executable edit with restored mtime", { skip: process.platform !== "darwin" }, t => {
  const root = temporary(t), executable = path.join(root, "runner"), runtime = manager();
  fs.writeFileSync(executable, binary(process.arch === "x64" ? "x86_64" : "arm64"), { mode: 0o755 });
  runtime.core.registerLocal({ userDataDir: root, version: "1.2.0", runtimePath: executable });
  assert.equal(runtime.getState({ userDataDir: root }).installed[0].ready, true);
  const stat = fs.statSync(executable), bytes = fs.readFileSync(executable); bytes[31] = 1;
  fs.writeFileSync(executable, bytes); fs.utimesSync(executable, stat.atime, stat.mtime);
  assert.equal(runtime.getState({ userDataDir: root }).installed[0].ready, false);
  assert.equal(runtime.resolveSelection(null, null, root).ready, false);
});

test("native preparation evidence is cloned, persisted and immutable without replacing shared identities", { skip: process.platform !== "darwin" }, async t => {
  const root = temporary(t), archive = Buffer.from("reviewed native archive");
  const digest = crypto.createHash("sha256").update(archive).digest("hex");
  const evidence = { profile: "direct-host-v1", sourceRevision: "abc123", profileSha256: "a".repeat(64),
    signature: { verified: true, identity: "reviewed publisher" }, files: ["lib/engine.dylib"], version: "cannot override version" };
  const runtime = manager({ catalog: [{ version: "1.2.0", upstreamRevision: "abc123", asset: { url: "https://example.com/native.tar.gz", filename: "native.tar.gz", sha256: digest } }],
    prepareInstall: async () => evidence, resolveExecutable: destination => path.join(destination, "runner"),
    dependencies: { downloadToFile: async (_url, destination) => fs.writeFileSync(destination, archive),
      extractArchive: async (_archive, destination) => fs.writeFileSync(path.join(destination, "runner"), binary(process.arch === "x64" ? "x86_64" : "arm64"), { mode: 0o755 }) } });
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
  for (const evidence of [{ file: () => "not serializable" }, { size: Infinity }, { text: "x".repeat(65537) }]) {
    const runtime = manager({ catalog: [{ version: "1.2.0", upstreamRevision: "abc123", asset: { url: "https://example.com/native.tar.gz", filename: "native.tar.gz", sha256: digest } }],
      prepareInstall: async () => evidence, resolveExecutable: destination => path.join(destination, "runner"),
      dependencies: { downloadToFile: async (_url, destination) => fs.writeFileSync(destination, archive),
        extractArchive: async (_archive, destination) => fs.writeFileSync(path.join(destination, "runner"), binary(process.arch === "x64" ? "x86_64" : "arm64"), { mode: 0o755 }) } });
    await assert.rejects(runtime.core.installVersion({ userDataDir: root, version: "1.2.0" }), /metadata/);
    assert.equal(fs.existsSync(path.join(root, "runtimes", "fixture-native", "1.2.0", "runtime.json")), false);
  }
});
