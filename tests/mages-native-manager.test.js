const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Managers = require("../src/modules/mages/native/manager");
const Adapter = require("../src/modules/mages/native/adapter");
const Overlay = require("../src/modules/mages/native/impacto-overlay.json");
const Portable = require("../src/modules/mages/native/portable-build");
const WindowsInput = require("../src/modules/mages/native/portable-ui-build");
const WindowsAudio = require("../src/modules/mages/native/portable-audio-build");
const WindowsCheckpoint = require("../src/modules/mages/native/portable-checkpoint-build");
const WindowsBacklog = require("../src/modules/mages/native/portable-backlog-build");
const WindowsSoundEffect = require("../src/modules/mages/native/portable-sfx-build");
const Releases = require("../src/modules/mages/native/releases.json");
const WindowsVersions = require("../src/modules/mages/native/windows-versions.json");
const Bundled = require("../src/modules/shared/runtime/bundled-native");

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mages-manager-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("Impacto preserves exact offline source and Windows pins without displaying unavailable factory packages", t => {
  const root = temporary(t);
  const historical = path.join(root, "bundles", "impacto", "0.10.8.810", "arm64");
  fs.mkdirSync(historical, { recursive: true }); fs.writeFileSync(path.join(historical, "manifest.json"), "not a reviewed Windows package");
  const unavailable = () => { throw new Error("Unexpected startup network request"); };
  const manager = Managers.createManager({ resourceRoot: path.join(root, "bundles"), dependencies: { github: {
    fetchGithubReleases: unavailable, fetchGithubTags: unavailable, resolveGithubTagCommit: unavailable } } });
  const state = manager.getState({ userDataDir: path.join(root, "user") });
  assert.equal(state.catalog.recommendedVersion, null);
  assert.deepEqual(state.catalog.versions, []);
  assert.ok(state.catalog.versions.every(version => [Managers.VERSION, Managers.CURRENT_VERSION].includes(version)));
  assert.deepEqual(state.catalog.includedVersions, []);
  assert.equal(manager.core.catalog.length, Releases.length + WindowsVersions.length);
  assert.equal(new Set(manager.core.catalog.map(pin => pin.version)).size, manager.core.catalog.length);
  assert.equal(manager.resolveSelection({}, {}, path.join(root, "user")).version, Managers.CURRENT_VERSION);
  assert.deepEqual(state.catalog.installableVersions, []);
  assert.deepEqual(state.catalog.buildableVersions, []);
  assert.match(state.catalog.versionRequirements[Managers.CURRENT_VERSION].installReason, /Windows MPK2.*SC3/);
  const pin = manager.core.catalog.find(item => item.version === Managers.VERSION);
  for (const version of ["0.0.1.89", Managers.LEGACY_VERSION, Managers.V2_VERSION, Managers.V3_VERSION, Managers.V4_VERSION]) {
    assert.equal(manager.core.normalizeVersion(version), version);
    assert.ok(manager.core.catalog.some(pin => pin.version === version));
  }
  assert.equal(Managers.VERSION, Managers.V9_VERSION);
  const snapshot = Managers.reviewedVersion(Managers.CURRENT_VERSION);
  assert.equal(snapshot.upstreamRevision, "914fae7cbb9583f8aa231569a03aab27d8c042f8");
  assert.equal(snapshot.profile, Managers.V9_PROFILE);
  // This is the compiled publication's immutable producer fingerprint. The
  // current recipe includes a later package-name change without a native rebuild.
  assert.equal(snapshot.overlaySha256, "1c91af2d8a4d18658e227b812468cfd714a45b1b6c94f08f81604de5e565f725");
  assert.equal(pin.upstreamRevision, Adapter.SOURCES.impacto.revision);
  assert.equal(pin.overlaySha256, Managers.reviewedVersion(pin.version).overlaySha256);
  assert.equal(Managers.reviewedVersion(Managers.V3_VERSION).overlaySha256, Overlay.overlaySha256);
  assert.deepEqual(pin.hostArchitectures, ["arm64"]);
  assert.equal(pin.sources.ffmpeg.sha256, Adapter.SOURCES.ffmpeg.sha256);
  assert.equal(pin.minimumMacOS, "13.0");
  assert.equal(pin.overlaySha256, WindowsSoundEffect.overlayIdentity());
  assert.equal(pin.sourceArtifact.sha256, "1d2e60069f810b6d0d82bc70b48651025eb560547797e8eac9d9e9fbc3986e27");
  assert.equal(manager.distributionRequired, false);
  assert.deepEqual(new Set(WindowsVersions.filter(row => ![Managers.V5_VERSION, Managers.V6_VERSION, Managers.V7_VERSION, Managers.V8_VERSION, Managers.V9_VERSION, Managers.CURRENT_VERSION].includes(row.version)).map(row => row.version)),
    new Set([Managers.LEGACY_VERSION, Managers.V2_VERSION, Managers.V3_VERSION, Managers.V4_VERSION]));
  const previous = Managers.reviewedVersion(Managers.V4_VERSION);
  assert.equal(previous.overlaySha256, Portable.overlayIdentity());
  assert.equal(previous.sourceArtifact.sha256, "aa89d42adcca1940643f30bba263ef1169597463c67a41442b72e818d4ae7e41");
  const inputCandidate = Managers.reviewedVersion(Managers.V5_VERSION);
  assert.equal(inputCandidate.overlaySha256, WindowsInput.overlayIdentity());
  assert.equal(inputCandidate.profileSha256, WindowsInput.PROFILE_SHA256);
  assert.equal(inputCandidate.windowsInputAbi, "windows-sc3-input-v1");
  assert.equal(inputCandidate.sourceArtifact.sha256, "dd82fdeef841ed5aef0054bbc279ba726537e11b7ef3cc1cfff4ab6a05cb502c");
  const audioCandidate = Managers.reviewedVersion(Managers.V6_VERSION);
  assert.equal(audioCandidate.overlaySha256, WindowsAudio.overlayIdentity());
  assert.equal(audioCandidate.profileSha256, WindowsAudio.PROFILE_SHA256);
  assert.equal(audioCandidate.windowsInputAbi, "windows-sc3-input-v1");
  assert.equal(audioCandidate.windowsAudioAbi, "windows-sc3-voice-v1");
  assert.equal(audioCandidate.sourceArtifact.sha256, "d57521ecf9dfd1a6d262328d8aaa3ba4bd4197f471d41ad7f8bbdd99076de12b");
  const checkpointCandidate = Managers.reviewedVersion(Managers.V7_VERSION);
  assert.equal(checkpointCandidate.overlaySha256, WindowsCheckpoint.overlayIdentity());
  assert.equal(checkpointCandidate.profileSha256, WindowsCheckpoint.PROFILE_SHA256);
  assert.equal(checkpointCandidate.windowsInputAbi, "windows-sc3-input-v1");
  assert.equal(checkpointCandidate.windowsAudioAbi, "windows-sc3-voice-v1");
  assert.equal(checkpointCandidate.windowsCheckpointAbi, "windows-sc3-checkpoint-u16-v1");
  assert.equal(checkpointCandidate.sourceArtifact.sha256, "ecd0953a17b7c208380337b6a3f55affd1f549ff711b91d743518690fc95bb5f");
  const backlogCandidate = Managers.reviewedVersion(Managers.V8_VERSION);
  assert.equal(backlogCandidate.overlaySha256, WindowsBacklog.overlayIdentity());
  assert.equal(backlogCandidate.profileSha256, WindowsBacklog.PROFILE_SHA256);
  assert.equal(backlogCandidate.windowsInputAbi, "windows-sc3-input-v1");
  assert.equal(backlogCandidate.windowsAudioAbi, "windows-sc3-voice-v1");
  assert.equal(backlogCandidate.windowsCheckpointAbi, "windows-sc3-checkpoint-u16-v1");
  assert.equal(backlogCandidate.windowsBacklogAbi, "backlog-zero-capacity-v1");
  assert.equal(backlogCandidate.sourceArtifact.sha256, "06c29662631958711fc1e83705d9dd39e0075be2ac6cde98cc96cb8281af4a0d");
  const soundEffectCandidate = Managers.reviewedVersion(Managers.V9_VERSION);
  assert.equal(soundEffectCandidate.overlaySha256, WindowsSoundEffect.overlayIdentity());
  assert.equal(soundEffectCandidate.profileSha256, WindowsSoundEffect.PROFILE_SHA256);
  assert.equal(soundEffectCandidate.windowsInputAbi, "windows-sc3-input-v1");
  assert.equal(soundEffectCandidate.windowsAudioAbi, "windows-sc3-voice-v1");
  assert.equal(soundEffectCandidate.windowsCheckpointAbi, "windows-sc3-checkpoint-u16-v1");
  assert.equal(soundEffectCandidate.windowsBacklogAbi, "backlog-zero-capacity-v1");
  assert.equal(soundEffectCandidate.windowsSoundEffectAbi, "windows-sc3-sfx-v1");
  assert.equal(soundEffectCandidate.sourceArtifact.sha256, "1d2e60069f810b6d0d82bc70b48651025eb560547797e8eac9d9e9fbc3986e27");
  for (const historical of manager.core.catalog.filter(item => !Managers.reviewedVersion(item.version))) {
    assert.match(historical.upstreamRevision, /^[a-f0-9]{40}$/);
    assert.equal(historical.localBuild, false);
    assert.equal(historical.asset, undefined);
  }
});

test("explicit Impacto refresh queries only Builds and keeps unavailable source identities internal", async t => {
 let calls=0;t.mock.method(require("../src/modules/shared/runtime/maclauncher-builds"),"fetchProjectCatalog",async()=>{calls++;return{packages:[]}});
 const manager=Managers.createManager({dependencies:{github:{fetchGithubReleases:()=>assert.fail("Windows releases are not Mac downloads"),fetchGithubTags:()=>assert.fail("No source tag history query")}}});
 const state=await manager.refreshCatalog({force:true});assert.equal(calls,1);assert.deepEqual(state.versions,[]);assert.deepEqual(state.installableVersions,[]);
 assert(manager.core.catalog.some(pin=>pin.version===Managers.CURRENT_VERSION));
});

test("a sealed app resource does not replace the managed Impacto Windows V9 download",
  { skip: process.platform !== "darwin" || process.arch !== "arm64" }, async t => {
    t.mock.method(require("../src/modules/shared/runtime/maclauncher-builds"), "fetchProjectCatalog", async () => ({ packages: [] }));
    const root = fs.realpathSync(temporary(t)), resourceRoot = path.join(root, "bundles");
    const pin = Managers.reviewedVersion(Managers.VERSION);
    const directory = path.join(resourceRoot, "impacto", pin.version, "arm64");
    const executableRelative = "Impacto.app/Contents/MacOS/Impacto";
    const executable = Buffer.alloc(32);
    executable.writeUInt32LE(0xfeedfacf); executable.writeUInt32LE(0x0100000c, 4); executable.writeUInt32LE(2, 12);
    const payload = path.join(directory, "files"), notice = Buffer.from("Synthetic test notice");
    fs.mkdirSync(path.dirname(path.join(payload, executableRelative)), { recursive: true });
    fs.mkdirSync(path.join(payload, "licenses"));
    fs.writeFileSync(path.join(payload, executableRelative), executable, { mode: 0o755 });
    fs.writeFileSync(path.join(payload, "licenses", "LICENSE"), notice, { mode: 0o644 });
    const manifest = { schemaVersion: 1, managerId: "impacto", version: pin.version,
      upstreamRevision: pin.upstreamRevision, platform: "darwin", arch: "arm64", minimumMacOS: "13.0", executableRelative,
      provenance: { sourceRevision: pin.upstreamRevision, verifiedBuild: false },
      notices: [{ name: "Synthetic fixture", license: "Test", sourceUrl: Managers.SOURCE_URL, path: "licenses/LICENSE" }],
      dependencies: [{ file: executableRelative, links: ["/usr/lib/libSystem.B.dylib"] }],
      files: [{ path: executableRelative, size: executable.length, mode: 0o755, architectures: ["arm64"], sha256: Bundled.digest(executable) },
        { path: "licenses/LICENSE", size: notice.length, mode: 0o644, sha256: Bundled.digest(notice) }] };
    const manifestPath = path.join(directory, "manifest.json"), bytes = Buffer.from(JSON.stringify(manifest));
    fs.writeFileSync(manifestPath, bytes);
    let queries = 0;
    const manager = Managers.createManager({ resourceRoot, dependencies: {
      bundled: { hostArch: "arm64", systemVersionSync: () => "13.6", verifySignaturesSync: () => {} },
      github: { fetchGithubReleases: async () => {
        queries++; return [{ tag_name: "0.11.0.1" }, { tag_name: "0.10.8.810" }, { tag_name: "0.11.0.1" }];
      }, fetchGithubTags: async () => [
        { name: "0.11.0.1", commit: { sha: "f".repeat(40) } },
        { name: "0.10.8.810", commit: { sha: pin.upstreamRevision } }
      ], resolveGithubTagCommit: () => assert.fail("Pinned tag revisions must remain sufficient") }
    } });
    const userDataDir = path.join(root, "user"), initial = manager.getState({ userDataDir });
    assert.equal(queries, 0); assert.equal(initial.catalog.status, "idle");
    assert.deepEqual(initial.catalog.versions, []);
    assert.deepEqual(initial.catalog.includedVersions, []);
    assert.equal(initial.catalog.recommendedVersion, null);
    assert.equal(initial.catalog.versionRequirements[pin.version].included, false);
    assert.deepEqual(initial.installed, []);
    assert.equal(fs.existsSync(userDataDir), false);
    await manager.refreshCatalog({ userDataDir, force: true });
    const refreshed = manager.getState({ userDataDir }), selected = manager.resolveSelection({}, {}, userDataDir);
    assert.deepEqual(refreshed.catalog.versions, []);
    assert.deepEqual(refreshed.catalog.includedVersions, []);
    assert.equal(refreshed.catalog.recommendedVersion, null); assert.equal(queries, 0);
    assert.deepEqual(refreshed.catalog.installableVersions, []);
    assert.equal(selected.version, Managers.CURRENT_VERSION); assert.equal(selected.ready, false);
    assert.equal(selected.install, null);
    assert.equal(manager.core.catalog.find(item => item.version === pin.version).overlaySha256, pin.overlaySha256);
    assert.equal(manager.core.catalog.find(item => item.version === pin.version).sourceArtifact.sha256, pin.sourceArtifact.sha256);
    assert.deepEqual(fs.readFileSync(manifestPath), bytes);
    assert.deepEqual(fs.readFileSync(path.join(payload, executableRelative)), executable);
    assert.equal(fs.existsSync(manager.core.getInstallDir({ userDataDir, version: pin.version })), false);
  });
