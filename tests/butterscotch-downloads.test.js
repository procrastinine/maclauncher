const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Downloads = require("../src/modules/gamemaker/runtime/butterscotch-downloads");
const { createManager } = require("../src/modules/gamemaker/runtime/butterscotch");
const { BUTTERSCOTCH_BUILDS } = require("../src/modules/gamemaker/runtime/catalog");

const now = Date.parse("2026-10-10T00:00:00Z");
function temporary(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), "butterscotch-download-")); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
function binary({ architecture = "arm64", floor = 0x1a0000, external } = {}) {
  const version = Buffer.alloc(24); version.writeUInt32LE(0x32); version.writeUInt32LE(24, 4); version.writeUInt32LE(1, 8); version.writeUInt32LE(floor, 12);
  const commands = [version];
  if (external) { const text = Buffer.from(external + "\0"), item = Buffer.alloc(Math.ceil((24 + text.length) / 8) * 8); item.writeUInt32LE(0xc); item.writeUInt32LE(item.length, 4); item.writeUInt32LE(24, 8); text.copy(item, 24); commands.push(item); }
  const header = Buffer.alloc(32); header.writeUInt32LE(0xfeedfacf); header.writeUInt32LE(architecture === "arm64" ? 0x0100000c : 0x01000007, 4);
  header.writeUInt32LE(2, 12); header.writeUInt32LE(commands.length, 16); header.writeUInt32LE(commands.reduce((sum, part) => sum + part.length, 0), 20);
  return Buffer.concat([header, ...commands]);
}

test("Butterscotch exact public nightly pins retain separate CPU, source, artifact, digest and macOS identities", () => {
  for (const pin of Downloads.PUBLIC_BUILDS) {
    assert.equal(pin.upstreamRevision, Downloads.PUBLIC_REVISION); assert.equal(pin.sourceKind, "commit");
    assert.equal(pin.minimumMacOS, "26.0.0"); assert.equal(pin.workflow.branch, "main"); assert.equal(pin.workflow.event, "push");
    assert.match(pin.asset.url, new RegExp(`/actions/artifacts/${pin.workflow.artifactId}\\.zip$`));
    assert.match(pin.asset.sha256, /^[a-f0-9]{64}$/); assert.notEqual(pin.version, "main"); assert.equal(pin.versionFlagAvailable, false);
  }
});

test("Butterscotch automatic selection downloads only on compatible hosts and preserves explicit game/global choices", t => {
  const root = temporary(t), runtime = createManager({ now: () => now, systemVersionSync: () => "26.0" });
  const publicVersion = Downloads.PUBLIC_BUILDS.find(pin => pin.hostArchitectures.includes(process.arch)).version;
  assert.equal(runtime.resolveSelection({}, {}, root).version, publicVersion);
  assert.equal(runtime.getState({ userDataDir: root }).catalog.recommendedVersion, publicVersion);
  assert.equal(runtime.getState({ userDataDir: root }).catalog.supportsLatestOnly, true);
  const old = BUTTERSCOTCH_BUILDS[0].version;
  assert.deepEqual(runtime.distributionVersions, [old]);
  assert.equal(runtime.resolveSelection({ runtimeData: { butterscotch: { version: old } } }, {}, root).version, old);
  assert.equal(runtime.resolveSelection({}, { runtimes: { butterscotch: { defaultVersion: old } } }, root).version, old);
  assert.equal(runtime.resolveSelection({}, {}, root, { version: old }).version, old);
  const olderHost = createManager({ now: () => now, systemVersionSync: () => "13.0" });
  assert.equal(olderHost.resolveSelection({}, {}, root).version, old);
  assert.equal(olderHost.getState({ userDataDir: root }).catalog.installableVersions.includes(publicVersion), false);
  const expired = createManager({ now: () => Date.parse("2030-01-01"), systemVersionSync: () => "26.0" });
  assert.equal(expired.resolveSelection({}, {}, root).version, old);
});

test("Butterscotch validates actual architecture, deployment floor and portable closure before running help", async t => {
  const root = temporary(t), file = path.join(root, "butterscotch"), pin = Downloads.PUBLIC_BUILDS[0];
  fs.writeFileSync(file, binary(), { mode: 0o755 });
  const calls = [], metadata = await Downloads.prepareInstall({ unpacked: root, pin }, { run: async (command, args) => {
    calls.push([command, args]); return { stdout: "--save-folder <directory>\n--renderer <renderer>\n" };
  } });
  assert.equal(metadata.minimumMacOS, "26.0.0"); assert.equal(calls.length, 3); assert.deepEqual(calls.at(-1)[1], ["--help"]);
  for (const bytes of [binary({ architecture: "x86_64" }), binary({ floor: 0x1b0000 }), binary({ external: "/opt/homebrew/lib/libSDL2.dylib" })]) {
    fs.writeFileSync(file, bytes);
    await assert.rejects(Downloads.prepareInstall({ unpacked: root, pin }, { run: () => assert.fail("Invalid native requirements must block execution") }), /architecture|macOS|dependency/);
  }
});

test("Butterscotch source profile derives supported flags and floor without inventing a version command", () => {
  const source = { args: '{"save-folder",required_argument,nullptr,1},{"renderer",required_argument,nullptr,2}; "legacy-gl"; case \'H\': printUsage(argv[0]); exit(0);',
    entry: "parseCommandLineArgs(&args, argc, argv);", cmake: ['14','16','17'].map(v => `option(ENABLE_WAD${v} "support" ON)`).join('\n') + '\noption(ENABLE_LEGACY_GL "renderer" ON)',
    workflow: "  build-appkit-macos:\n    - label: arm64\n      runner: macos-26\n    -DBACKEND=appkit \\\n" };
  const profile = Downloads.parseSourceProfile(source, "arm64"); assert.equal(profile.minimumMacOS, "26.0.0"); assert.equal(profile.versionFlagAvailable, false);
  assert.throws(() => Downloads.parseSourceProfile({ ...source, args: source.args.replace('legacy-gl', 'changed') }, "arm64"), /unsupported/);
  assert.throws(() => Downloads.parseSourceProfile({ ...source, workflow: source.workflow + '-DENABLE_LEGACY_GL=OFF\n' }, "arm64"), /unsupported/);
});

test("Butterscotch shared Actions mapper selects its host artifact and retains publisher digests", async () => {
  const pin = Downloads.PUBLIC_BUILDS[0], sha = Downloads.PUBLIC_REVISION;
  const workflow = { id: pin.workflow.id, status: "completed", conclusion: "success", head_branch: "main", event: "push", path: ".github/workflows/build.yml",
    head_sha: sha, created_at: "2026-10-08T22:01:51Z", repository: { full_name: "ButterscotchRunner/Butterscotch" }, head_repository: { full_name: "ButterscotchRunner/Butterscotch" } };
  const artifact = { id: pin.asset.assetId, name: "butterscotch-appkit-macos-arm64", expired: false, size_in_bytes: 991480,
    digest: `sha256:${pin.asset.sha256}`, created_at: pin.publishedAt, expires_at: pin.asset.expiresAt,
    workflow_run: { id: workflow.id, head_sha: sha, head_branch: "main" } };
  const entries = await Downloads.createDownloadDiscovery({ architecture: "arm64", dependencies: { now: () => now,
    request: async url => ({ status: 200, body: Buffer.from(JSON.stringify(url.includes('/artifacts?') ? { artifacts: [artifact] } : { workflow_runs: [workflow] })) }) } })();
  assert.equal(entries.length, 1); assert.equal(entries[0].version, pin.version); assert.equal(entries[0].asset.sha256, pin.asset.sha256);
});

test("Butterscotch Reload and All versions use distinct bounded catalog queries", async t => {
  const root = temporary(t), pin = Downloads.PUBLIC_BUILDS.find(entry => entry.hostArchitectures.includes(process.arch)), calls = [];
  const label = process.arch === "x64" ? "x86_64" : "arm64";
  const runs = [1, 2, 3].map(id => ({ id, status: "completed", conclusion: "success", head_branch: "main", event: "push",
    path: ".github/workflows/build.yml", head_sha: Downloads.PUBLIC_REVISION, created_at: "2026-10-09T00:00:00Z",
    repository: { full_name: "ButterscotchRunner/Butterscotch" }, head_repository: { full_name: "ButterscotchRunner/Butterscotch" } }));
  const runtime = createManager({ now: () => now, systemVersionSync: () => "26.0", request: async url => {
    calls.push(url); const runId = Number(/actions\/runs\/(\d+)\//.exec(url)?.[1]);
    const body = runId ? { artifacts: [{ id: 100 + runId, name: `butterscotch-appkit-macos-${label}`, expired: false,
      size_in_bytes: 1024, digest: `sha256:${pin.asset.sha256}`, expires_at: "2027-01-01T00:00:00Z", created_at: "2026-10-09T00:00:00Z",
      workflow_run: { id: runId, head_sha: Downloads.PUBLIC_REVISION, head_branch: "main" } }] } : { workflow_runs: runs };
    return { status: 200, body: Buffer.from(JSON.stringify(body)) };
  } });
  const latest = await runtime.refreshCatalog({ userDataDir: root });
  assert.equal(latest.mode, "latest");
  assert.equal(latest.versions.filter(version => /2026-10-09/.test(version)).length, 1);
  assert.equal(calls.length, 2);
  const all = await runtime.refreshCatalog({ userDataDir: root, latestOnly: false });
  assert.equal(all.versions.filter(version => /2026-10-09/.test(version)).length, 3);
  assert.equal(new Set(all.versions).size, all.versions.length);
  assert.equal(calls.length, 6);
});
