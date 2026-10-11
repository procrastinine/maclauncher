const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Adapter = require("../src/modules/mages/native/adapter");
const Launch = require("../src/modules/mages/native/launch");
const Managers = require("../src/modules/mages/native/manager");
const Bundle = require("../src/modules/shared/runtime/bundled-native");
const Mages = require("../src/modules/mages/main");
const NativeBuild = require("../src/modules/mages/native/build");
const overlay = require("../src/modules/mages/native/impacto-overlay.json");
const { archive, script } = require("./helpers/mages-fixture");
const { peFixture: uiPeFixture, withVersion } = require("./helpers/mages-windows-ui-fixture");
const WindowsInput = require("../src/modules/mages/native/windows-ui-data");
const InputSession = require("../src/modules/mages/native/windows-ui-session");
const AudioSession = require("../src/modules/mages/native/windows-audio-session");
const AudioBuild = require("../src/modules/mages/native/portable-audio-build");
const CheckpointSession = require("../src/modules/mages/native/windows-checkpoint-session");
const CheckpointBuild = require("../src/modules/mages/native/portable-checkpoint-build");
const CheckpointOverlay = require("../src/modules/mages/native/windows-checkpoint-overlay");
const BacklogOverlay = require("../src/modules/mages/native/windows-backlog-overlay");
const BacklogBuild = require("../src/modules/mages/native/portable-backlog-build");
const SoundEffectSession = require("../src/modules/mages/native/windows-sfx-session");
const SoundEffectOverlay = require("../src/modules/mages/native/windows-sfx-overlay");
const SoundEffectBuild = require("../src/modules/mages/native/portable-sfx-build");

function temporary(t) { const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "mages-native-")); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
function windowsGame(root) {
  const data = path.join(root, "USRDIR"); fs.mkdirSync(data, { recursive: true });
  archive(path.join(data, "script.mpk"), [{ name: "_STARTUP_WIN.SCX", id: 2, bytes: script({ returns: [16] }) }]);
  archive(path.join(data, "system.mpk"), [["DATA01.DDS", 6], ["FONT.PNG", 9], ["BACKLOG.DDS", 2], ["TITLE_CHIP.DDS", 30], ["WAVTABLE.DAT", 31]]
    .map(([name, id]) => ({ name, id, bytes: "synthetic resource" })));
  for (const name of ["bgm", "se", "voice", "bg", "chara", "mask"]) archive(path.join(data, name + ".mpk"), [{ name: "original.dat", bytes: "synthetic data" }]);
  fs.mkdirSync(path.join(data, "movie", "1920x1080"), { recursive: true });
  const movie = Buffer.alloc(40); movie.write("KB2j"); movie.writeUInt32LE(1920, 20); movie.writeUInt32LE(1080, 24);
  fs.writeFileSync(path.join(data, "movie", "1920x1080", "title.bk2"), movie);
  fs.writeFileSync(path.join(root, "Game.exe"), withVersion(uiPeFixture().bytes));
  fs.writeFileSync(path.join(root, "bink2w32.dll"), "not executed");
  return root;
}
function runtime(root) {
  fs.mkdirSync(path.join(root, "Impacto.app", "Contents", "MacOS"), { recursive: true });
  fs.mkdirSync(path.join(root, "Impacto.app", "Contents", "Resources"));
  fs.mkdirSync(path.join(root, "profiles")); fs.writeFileSync(path.join(root, "Impacto.app", "Contents", "MacOS", "Impacto"), "not executed");
  return root;
}

function installedRuntime(root, version = Managers.VERSION) {
  const pin = Managers.reviewedVersion(version);
  const windowsUiOverlay = pin.windowsInputAbi ? { abi: pin.windowsInputAbi, modes: [13, 14], files: [] } : null;
  const windowsAudioOverlay = pin.windowsAudioAbi ? { abi: pin.windowsAudioAbi, opcodes: [0x37, 0x38, 0x39], files: [] } : null;
  const windowsCheckpointOverlay = pin.windowsCheckpointAbi ? {
    abi: pin.windowsCheckpointAbi, opcodeGroup: 0x10, opcode: 0x22, checkpointType: 10, checkpointBytes: 2,
    files: Object.entries({ ...CheckpointOverlay.ORIGINALS,
      ...Object.fromEntries(Object.keys(CheckpointOverlay.COPIES).map(file => [file, null])) })
      .map(([file, originalSha256]) => ({ path: file, originalSha256, adaptedSha256: "a".repeat(64) }))
  } : null;
  const windowsBacklogOverlay = pin.windowsBacklogAbi ? {
    abi: pin.windowsBacklogAbi, disabledCapacity: 0,
    files: [{ path: BacklogOverlay.FILE, originalSha256: BacklogOverlay.ORIGINAL_SHA256, adaptedSha256: "a".repeat(64) }]
  } : null;
  const windowsSoundEffectOverlay = pin.windowsSoundEffectAbi ? {
    abi: pin.windowsSoundEffectAbi, opcodes: [0x23], channels: [0, 1, 2], types: [0, 1, 2],
    files: Object.entries({ ...SoundEffectOverlay.ORIGINALS,
      ...Object.fromEntries(Object.keys(SoundEffectOverlay.COPIES).map(file => [file, null])) })
      .map(([file, originalSha256]) => ({ path: file, originalSha256, adaptedSha256: "a".repeat(64) }))
  } : null;
  const payload = runtime(path.join(root, "files"));
  const executable = path.join(payload, "Impacto.app", "Contents", "MacOS", "Impacto");
  const bytes = Buffer.alloc(32); bytes.writeUInt32LE(0xfeedfacf); bytes.writeUInt32LE(0x0100000c, 4); bytes.writeUInt32LE(2, 12);
  fs.writeFileSync(executable, bytes, { mode: 0o755 }); fs.chmodSync(executable, 0o755);
  fs.writeFileSync(path.join(payload, "profiles", "fixture.lua"), "synthetic profile data");
  fs.writeFileSync(path.join(payload, "LICENSE"), "Synthetic notice");
  const manifest = { schemaVersion: 1, managerId: "impacto", version, upstreamRevision: pin.upstreamRevision,
    platform: "darwin", arch: "arm64", minimumMacOS: pin.minimumMacOS || "27.0", executableRelative: "Impacto.app/Contents/MacOS/Impacto",
    provenance: { sourceRevision: pin.upstreamRevision, sourceOverlay: { overlaySha256: pin.overlaySha256,
      ...(windowsUiOverlay ? { windowsUiOverlay } : {}) },
      profileSha256: pin.profileSha256,
      ...(windowsUiOverlay ? { windowsInputAbi: pin.windowsInputAbi, windowsUiOverlay } : {}),
      ...(windowsAudioOverlay ? { windowsAudioAbi: pin.windowsAudioAbi, windowsAudioOverlay } : {}),
      ...(windowsCheckpointOverlay ? { windowsCheckpointAbi: pin.windowsCheckpointAbi, windowsCheckpointOverlay } : {}),
      ...(windowsBacklogOverlay ? { windowsBacklogAbi: pin.windowsBacklogAbi, windowsBacklogOverlay } : {}),
      ...(windowsSoundEffectOverlay ? { windowsSoundEffectAbi: pin.windowsSoundEffectAbi, windowsSoundEffectOverlay } : {}),
      ...(pin.dependencyOverlaySha256 ? { dependencyOverlaySha256: pin.dependencyOverlaySha256,
        codecProbe: { sourceSha256: pin.codecProbeSourceSha256, bink2Decoder: true, headerLibraryVersionsMatch: true } } : {}),
      ...(pin.portableDependenciesVersion ? { sourceTreeSha256: pin.sourceTreeSha256,
        portableDependencies: { version: pin.portableDependenciesVersion, recipeSha256: pin.portableDependenciesRecipeSha256 } } : {}) },
    notices: [{ name: "Fixture", license: "MIT", sourceUrl: "https://example.org/source", path: "LICENSE" }], dependencies: [],
    files: Bundle.fileInventory(payload).map(relative => { const file = path.join(payload, relative), stat = fs.statSync(file);
      return { path: relative, size: stat.size, sha256: Adapter.hash(file), mode: stat.mode & 0o777,
        ...(file === executable ? { architectures: ["arm64"] } : {}) }; }) };
  if (windowsAudioOverlay) manifest.provenance.sourceOverlay.windowsAudioOverlay = windowsAudioOverlay;
  if (windowsCheckpointOverlay) manifest.provenance.sourceOverlay.windowsCheckpointOverlay = windowsCheckpointOverlay;
  if (windowsBacklogOverlay) manifest.provenance.sourceOverlay.windowsBacklogOverlay = windowsBacklogOverlay;
  if (windowsSoundEffectOverlay) manifest.provenance.sourceOverlay.windowsSoundEffectOverlay = windowsSoundEffectOverlay;
  const file = path.join(root, "bundle-manifest.json"); fs.writeFileSync(file, JSON.stringify(manifest));
  return { version, upstreamRevision: pin.upstreamRevision, source: "bundled", installDir: root,
    executablePath: executable, bundledManifestSha256: Adapter.hash(file), manifest };
}

function v6CatalogFixture(t) {
  if (Managers.reviewedVersion(Managers.V6_VERSION)) return;
  // A candidate must pass the launch contract before its catalog entry is
  // published. Keep the temporary pin local to this test's lookup.
  const lookup = Managers.reviewedVersion;
  const pin = { ...lookup(Managers.V5_VERSION), version: Managers.V6_VERSION,
    profile: AudioBuild.PROFILE, profileSha256: AudioSession.PROFILE_SHA256,
    overlaySha256: AudioBuild.overlayIdentity(), windowsAudioAbi: AudioSession.ABI };
  t.mock.method(Managers, "reviewedVersion", version => version === Managers.V6_VERSION ? pin : lookup(version));
}

function v7CatalogFixture(t) {
  if (Managers.reviewedVersion(Managers.V7_VERSION)) return;
  const lookup = Managers.reviewedVersion;
  const pin = { ...lookup(Managers.V6_VERSION), version: Managers.V7_VERSION,
    profile: Managers.V7_PROFILE, profileSha256: CheckpointSession.PROFILE_SHA256,
    overlaySha256: CheckpointBuild.overlayIdentity(), windowsCheckpointAbi: CheckpointSession.ABI };
  t.mock.method(Managers, "reviewedVersion", version => version === Managers.V7_VERSION ? pin : lookup(version));
}

function v8CatalogFixture(t) {
  if (Managers.reviewedVersion(Managers.V8_VERSION)) return;
  const lookup = Managers.reviewedVersion;
  const pin = { ...lookup(Managers.V7_VERSION), version: Managers.V8_VERSION,
    profile: Managers.V8_PROFILE, profileSha256: CheckpointSession.PROFILE_SHA256,
    overlaySha256: BacklogBuild.overlayIdentity(), windowsBacklogAbi: BacklogOverlay.ABI };
  t.mock.method(Managers, "reviewedVersion", version => version === Managers.V8_VERSION ? pin : lookup(version));
}

function v9CatalogFixture(t) {
  if (Managers.reviewedVersion(Managers.V9_VERSION)) return;
  const lookup = Managers.reviewedVersion;
  const pin = { ...lookup(Managers.V8_VERSION), version: Managers.V9_VERSION,
    profile: Managers.V9_PROFILE, profileSha256: SoundEffectSession.PROFILE_SHA256,
    overlaySha256: SoundEffectBuild.overlayIdentity(), windowsSoundEffectAbi: SoundEffectOverlay.ABI };
  t.mock.method(Managers, "reviewedVersion", version => version === Managers.V9_VERSION ? pin : lookup(version));
}

test("public build diagnostics are normalized in generated source while actual configure inputs remain intact", t => {
  const root = temporary(t), buildRoot = path.join(root, ".local", "build"); fs.mkdirSync(buildRoot, { recursive: true });
  const original = `#define FFMPEG_CONFIGURATION "--prefix=${buildRoot}/ffmpeg-install --extra-cflags=-ffile-prefix-map=${buildRoot}=IMPACTO_BUILD"\n#define OTHER 1\n`;
  const config = path.join(buildRoot, "config.h"), actualOptions = path.join(buildRoot, "config.mak");
  fs.writeFileSync(config, original); fs.writeFileSync(actualOptions, original);
  const mappings = [{ from: buildRoot, to: "IMPACTO_BUILD" }];
  const result = NativeBuild.normalizeGeneratedFfmpegConfiguration(buildRoot, mappings);
  assert.doesNotMatch(fs.readFileSync(config, "utf8"), /\.local/);
  assert.match(fs.readFileSync(config, "utf8"), /--prefix=IMPACTO_BUILD\/ffmpeg-install/);
  assert.equal(fs.readFileSync(actualOptions, "utf8"), original);
  assert.notEqual(result.originalSha256, result.normalizedSha256);
  assert.deepEqual(NativeBuild.compilerDiagnosticFlags(mappings), [`-ffile-prefix-map=${buildRoot}=IMPACTO_BUILD`, `-fmacro-prefix-map=${buildRoot}=IMPACTO_BUILD`]);
});

test("reviewed V1 installations keep their exact identity alongside V2 without rebinding their source/profile", t => {
  const root = temporary(t);
  const v1 = installedRuntime(path.join(root, "v1"), Managers.LEGACY_VERSION), v2 = installedRuntime(path.join(root, "v2"), Managers.V2_VERSION);
  assert.equal(Launch.verifyNativeProfile(v1).pin.version, Managers.LEGACY_VERSION);
  assert.equal(Launch.verifyNativeProfile(v2).pin.version, Managers.V2_VERSION);
  assert.equal(Adapter.hash(Managers.profilePath(Managers.LEGACY_VERSION)), Managers.reviewedVersion(Managers.LEGACY_VERSION).profileSha256);
  assert.throws(() => Launch.verifyNativeProfile({ ...v1, version: "0.10.8.810-windows-v99" }), /Mac Windows HD runtime/);
  assert.equal(v1.manifest.version, Managers.LEGACY_VERSION);
});

test("V3 native launch requires its own verified decoder dependency and probe identity", t => {
  const root = temporary(t), installed = installedRuntime(path.join(root, "v3"), Managers.V3_VERSION);
  assert.equal(Launch.verifyNativeProfile(installed).pin.version, Managers.V3_VERSION);
  installed.manifest.provenance.dependencyOverlaySha256 = "f".repeat(64);
  const file = path.join(installed.installDir, "bundle-manifest.json");
  fs.writeFileSync(file, JSON.stringify(installed.manifest));
  installed.bundledManifestSha256 = Adapter.hash(file);
  assert.throws(() => Launch.verifyNativeProfile(installed), /Bink 2 dependencies do not match/);
});

test("V4 binds the portable dependency recipe, source tree and deployment floor without changing older profiles", t => {
  const root = temporary(t), changes = [
    manifest => { manifest.minimumMacOS = "27.0"; },
    manifest => { manifest.provenance.sourceTreeSha256 = "a".repeat(64); },
    manifest => { manifest.provenance.portableDependencies.version = "another-version"; },
    manifest => { manifest.provenance.portableDependencies.recipeSha256 = "b".repeat(64); }
  ];
  for (const [index, mutate] of changes.entries()) {
    const installed = installedRuntime(path.join(root, String(index)), Managers.V4_VERSION);
    assert.equal(Launch.verifyNativeProfile(installed).manifest.minimumMacOS, "13.0");
    mutate(installed.manifest);
    const file = path.join(installed.installDir, "bundle-manifest.json"); fs.writeFileSync(file, JSON.stringify(installed.manifest));
    installed.bundledManifestSha256 = Adapter.hash(file);
    assert.throws(() => Launch.verifyNativeProfile(installed), /dependency version or checksum changed/);
  }
  const older = installedRuntime(path.join(root, "older"), Managers.V3_VERSION);
  assert.equal(Launch.verifyNativeProfile(older).manifest.minimumMacOS, "27.0");
  assert.equal(older.manifest.provenance.portableDependencies, undefined);
});

test("V5 binds its input ABI and overlay metadata while selection follows the declared default and older profiles stay unchanged", t => {
  const root = temporary(t);
  assert.equal(Managers.createManager().resolveSelection({}, {}, path.join(root, "empty-user")).version, Managers.VERSION);
  assert.deepEqual(Managers.createManager().distributionVersions, [Managers.VERSION]);
  assert.equal(Managers.profilePath(Managers.V5_VERSION), InputSession.PROFILE_SOURCE);
  assert.equal(Adapter.hash(Managers.profilePath(Managers.V5_VERSION)), InputSession.PROFILE_SHA256);
  assert.equal(Managers.reviewedVersion(Managers.V5_VERSION).windowsInputAbi, WindowsInput.ABI);
  for (const version of [Managers.LEGACY_VERSION, Managers.V2_VERSION, Managers.V3_VERSION, Managers.V4_VERSION])
    assert.equal(Adapter.hash(Managers.profilePath(version)), Managers.reviewedVersion(version).profileSha256);
  const changes = [
    manifest => { delete manifest.provenance.windowsInputAbi; },
    manifest => { manifest.provenance.windowsInputAbi = "unknown-input-abi"; },
    manifest => { manifest.provenance.windowsUiOverlay.abi = "unknown-input-abi"; },
    manifest => { manifest.provenance.windowsUiOverlay.modes = [13, 99]; },
    manifest => { delete manifest.provenance.windowsUiOverlay; },
    manifest => { delete manifest.provenance.sourceOverlay.windowsUiOverlay; },
    manifest => { manifest.provenance.sourceOverlay.windowsUiOverlay = { ...manifest.provenance.windowsUiOverlay, files: [{ path: "different.cpp" }] }; }
  ];
  for (const [index, mutate] of changes.entries()) {
    const installed = installedRuntime(path.join(root, String(index)), Managers.V5_VERSION);
    assert.equal(Launch.verifyNativeProfile(installed).pin.profile, Managers.V5_PROFILE);
    mutate(installed.manifest);
    const file = path.join(installed.installDir, "bundle-manifest.json"); fs.writeFileSync(file, JSON.stringify(installed.manifest));
    installed.bundledManifestSha256 = Adapter.hash(file);
    assert.throws(() => Launch.verifyNativeProfile(installed), /Windows input version or checksum changed/);
  }
});

test("production V5 sessions load the original PE input table and leave old V4 sessions and original files intact", t => {
  const root = temporary(t), game = windowsGame(path.join(root, "game")), originalExecutable = path.join(game, "Game.exe");
  const executable = withVersion(uiPeFixture().bytes); fs.writeFileSync(originalExecutable, executable);
  const before = { hash: Adapter.hash(originalExecutable), mtimeMs: fs.statSync(originalExecutable).mtimeMs };
  const installed = installedRuntime(path.join(root, "runtime"), Managers.V5_VERSION);
  const entry = { gameId: "input-v5", contentRootDir: game, moduleData: {} };
  const context = { userDataDir: path.join(root, "user") };
  const session = Launch.prepareLaunch(entry, context, installed);
  assert.equal(session.inputMetadata.abi, WindowsInput.ABI); assert.equal(session.inputMetadata.regions, 2);
  assert.equal(session.profileSha256, InputSession.PROFILE_SHA256);
  assert.equal(session.preparation.runtimeVersion, Managers.V5_VERSION);
  assert.equal(session.preparation.profile, Managers.V5_PROFILE);
  assert.deepEqual(session.env, {}); assert.equal(session.args.includes("--diagnostic-frames"), false);
  assert.match(fs.readFileSync(session.inputMetadata.file, "utf8"), /Id = 3, ParentId = 0/);
  assert.match(fs.readFileSync(path.join(session.sessionDir, "windows-game.lua"), "utf8"), /windows-ui-input\.lua/);
  assert.equal(entry.moduleData.nativeRuntimeVersion, Managers.V5_VERSION);
  assert.deepEqual({ hash: Adapter.hash(originalExecutable), mtimeMs: fs.statSync(originalExecutable).mtimeMs }, before);
  const v4 = installedRuntime(path.join(root, "old-runtime"), Managers.V4_VERSION);
  const oldSession = Launch.prepareLaunch({ ...entry, gameId: "input-v4", moduleData: {} }, context, v4);
  assert.equal(oldSession.inputMetadata, undefined);
  assert.equal(oldSession.preparation.runtimeVersion, Managers.V4_VERSION);
  assert.equal(fs.existsSync(path.join(oldSession.sessionDir, "patches", "windows-ui-input.lua")), false);
  fs.writeFileSync(originalExecutable, withVersion(uiPeFixture({ duplicateDispatch: true }).bytes));
  const unsupported = { ...entry, gameId: "unsupported-input", moduleData: {} };
  assert.throws(() => Launch.prepareLaunch(unsupported, context, installed), /ambiguous/);
  assert.equal(fs.existsSync(Launch.sessionDirectory(unsupported, context)), false);
  assert.deepEqual(unsupported.moduleData, {});
});

test("V6 requires both Windows input and voice contracts while keeping prior version profiles", t => {
  v6CatalogFixture(t);
  const root = temporary(t);
  assert.equal(Managers.V6_VERSION, AudioBuild.VERSION);
  assert.equal(Managers.V6_PROFILE, AudioBuild.PROFILE);
  assert.equal(Managers.profilePath(Managers.V6_VERSION), AudioSession.PROFILE_SOURCE);
  assert.equal(Adapter.hash(Managers.profilePath(Managers.V6_VERSION)), AudioSession.PROFILE_SHA256);
  assert.equal(Managers.createManager().resolveSelection({}, {}, path.join(root, "empty-user")).version, Managers.VERSION);
  assert.deepEqual(Managers.createManager().distributionVersions, [Managers.VERSION]);
  for (const version of [Managers.LEGACY_VERSION, Managers.V2_VERSION, Managers.V3_VERSION, Managers.V4_VERSION, Managers.V5_VERSION])
    assert.equal(Adapter.hash(Managers.profilePath(version)), Managers.reviewedVersion(version).profileSha256);
  const changes = [
    ["input", manifest => { delete manifest.provenance.windowsInputAbi; }],
    ["input", manifest => { manifest.provenance.windowsUiOverlay.modes = [13, 99]; }],
    ["audio", manifest => { delete manifest.provenance.windowsAudioAbi; }],
    ["audio", manifest => { manifest.provenance.windowsAudioAbi = "unknown-voice-abi"; }],
    ["audio", manifest => { manifest.provenance.windowsAudioOverlay.abi = "unknown-voice-abi"; }],
    ["audio", manifest => { manifest.provenance.windowsAudioOverlay.opcodes = [0x37, 0x38]; }],
    ["audio", manifest => { manifest.provenance.windowsAudioOverlay.opcodes = [0x37, 0x38, 0x39, 0x40]; }],
    ["audio", manifest => { manifest.provenance.windowsAudioOverlay.opcodes = [0x37, 0x38, 0x38]; }],
    ["audio", manifest => { delete manifest.provenance.windowsAudioOverlay; }],
    ["audio", manifest => { delete manifest.provenance.sourceOverlay.windowsAudioOverlay; }],
    ["audio", manifest => { manifest.provenance.sourceOverlay.windowsAudioOverlay = { ...manifest.provenance.windowsAudioOverlay, files: [{ path: "different.cpp" }] }; }]
  ];
  for (const [index, [contract, mutate]] of changes.entries()) {
    const installed = installedRuntime(path.join(root, String(index)), Managers.V6_VERSION);
    assert.equal(Launch.verifyNativeProfile(installed).pin.profile, Managers.V6_PROFILE);
    mutate(installed.manifest);
    const file = path.join(installed.installDir, "bundle-manifest.json");
    fs.writeFileSync(file, JSON.stringify(installed.manifest)); installed.bundledManifestSha256 = Adapter.hash(file);
    assert.throws(() => Launch.verifyNativeProfile(installed), new RegExp("Windows " + contract + " version or checksum changed"));
  }
});

test("production V6 sessions use the voice profile and original input data without copying or modifying games", t => {
  v6CatalogFixture(t);
  const root = temporary(t), game = windowsGame(path.join(root, "game"));
  const originalExecutable = path.join(game, "Game.exe");
  const before = { hash: Adapter.hash(originalExecutable), mtimeMs: fs.statSync(originalExecutable).mtimeMs };
  const installed = installedRuntime(path.join(root, "runtime"), Managers.V6_VERSION);
  const entry = { gameId: "voice-v6", contentRootDir: game, moduleData: {} };
  const context = { userDataDir: path.join(root, "user") };
  const session = Launch.prepareLaunch(entry, context, installed);
  assert.equal(session.audioAbi, AudioSession.ABI);
  assert.equal(session.inputMetadata.abi, WindowsInput.ABI); assert.equal(session.inputMetadata.regions, 2);
  assert.equal(session.profileSha256, AudioSession.PROFILE_SHA256);
  assert.equal(session.preparation.runtimeVersion, Managers.V6_VERSION);
  assert.equal(session.preparation.profile, Managers.V6_PROFILE);
  assert.equal(session.preparation.originalDataCopied, false);
  assert.equal(session.preparation.originalDataModified, false);
  assert.deepEqual(session.env, {}); assert.equal(session.args.includes("--diagnostic-frames"), false);
  assert.equal(session.args[session.args.indexOf("-ll") + 1], "Info");
  assert.match(fs.readFileSync(path.join(session.sessionDir, "windows-game.lua"), "utf8"), /WindowsVoiceOpcodeExtensions = true/);
  assert.deepEqual({ hash: Adapter.hash(originalExecutable), mtimeMs: fs.statSync(originalExecutable).mtimeMs }, before);
  const oldInstall = installedRuntime(path.join(root, "v5"), Managers.V5_VERSION);
  const oldSession = Launch.prepareLaunch({ ...entry, gameId: "voice-v5", moduleData: {} }, context, oldInstall);
  assert.equal(oldSession.audioAbi, undefined); assert.equal(oldSession.profileSha256, InputSession.PROFILE_SHA256);
  assert.doesNotMatch(fs.readFileSync(path.join(oldSession.sessionDir, "windows-game.lua"), "utf8"), /WindowsVoiceOpcodeExtensions/);
  fs.writeFileSync(originalExecutable, withVersion(uiPeFixture({ duplicateDispatch: true }).bytes));
  const unsupported = { ...entry, gameId: "unsupported-voice", moduleData: {} };
  assert.throws(() => Launch.prepareLaunch(unsupported, context, installed), /ambiguous/);
  assert.equal(fs.existsSync(Launch.sessionDirectory(unsupported, context)), false);
  assert.deepEqual(unsupported.moduleData, {});
});

test("V7 rejects incompatible checkpoint operands, source contracts and missing input/audio ABIs before launch", t => {
  v7CatalogFixture(t);
  const root = temporary(t);
  const mutations = [
    ["checkpoint", manifest => { delete manifest.provenance.windowsCheckpointAbi; }],
    ["checkpoint", manifest => { manifest.provenance.windowsCheckpointOverlay.checkpointBytes = 4; }],
    ["checkpoint", manifest => { manifest.provenance.windowsCheckpointOverlay.opcode = 0x23; }],
    ["checkpoint", manifest => { manifest.provenance.windowsCheckpointOverlay.files.pop(); }],
    ["checkpoint", manifest => { manifest.provenance.windowsCheckpointOverlay.files[0] = null; }],
    ["checkpoint", manifest => { manifest.provenance.windowsCheckpointOverlay.files[0].originalSha256 = "b".repeat(64); }],
    ["checkpoint", manifest => { delete manifest.provenance.sourceOverlay.windowsCheckpointOverlay; }],
    ["audio", manifest => { delete manifest.provenance.windowsAudioAbi; }],
    ["input", manifest => { delete manifest.provenance.windowsInputAbi; }]
  ];
  for (const [index, [contract, mutate]] of mutations.entries()) {
    const installed = installedRuntime(path.join(root, String(index)), Managers.V7_VERSION);
    assert.equal(Launch.verifyNativeProfile(installed).pin.profile, Managers.V7_PROFILE);
    mutate(installed.manifest);
    const file = path.join(installed.installDir, "bundle-manifest.json");
    fs.writeFileSync(file, JSON.stringify(installed.manifest));
    installed.bundledManifestSha256 = Adapter.hash(file);
    assert.throws(() => Launch.verifyNativeProfile(installed), new RegExp("Windows " + contract + " version or checksum changed"));
  }
});

test("V7 ordinary preparation retains voice/input/checkpoint contracts and reads original data", t => {
  v7CatalogFixture(t);
  const root = temporary(t), game = windowsGame(path.join(root, "game"));
  const original = path.join(game, "Game.exe"), originalHash = Adapter.hash(original);
  const installed = installedRuntime(path.join(root, "runtime"), Managers.V7_VERSION);
  const session = Launch.prepareLaunch({ gameId: "checkpoint-v7", title: "Native game", contentRootDir: game, moduleData: {} },
    { userDataDir: path.join(root, "user") }, installed);
  assert.equal(session.checkpointAbi, CheckpointSession.ABI);
  assert.equal(session.audioAbi, AudioSession.ABI);
  assert.equal(session.inputMetadata.abi, WindowsInput.ABI);
  assert.equal(session.profileSha256, CheckpointSession.PROFILE_SHA256);
  assert.equal(session.preparation.generatedProfileSha256, Adapter.hash(path.join(session.sessionDir, "windows-game.lua")));
  assert.deepEqual(session.env, {});
  assert.equal(session.args.includes("--diagnostic-frames"), false);
  assert.equal(session.preparation.originalDataCopied, false);
  assert.equal(Adapter.hash(original), originalHash);
});

test("V8 rejects disabled-backlog mismatches and retains its input, voice and checkpoint requirements", t => {
  v8CatalogFixture(t);
  const root = temporary(t), mutations = [
    ["backlog", manifest => { delete manifest.provenance.windowsBacklogAbi; }],
    ["backlog", manifest => { manifest.provenance.windowsBacklogOverlay.disabledCapacity = 1; }],
    ["backlog", manifest => { manifest.provenance.windowsBacklogOverlay.files[0] = null; }],
    ["backlog", manifest => { manifest.provenance.windowsBacklogOverlay.files[0].originalSha256 = "b".repeat(64); }],
    ["backlog", manifest => { delete manifest.provenance.sourceOverlay.windowsBacklogOverlay; }],
    ["checkpoint", manifest => { delete manifest.provenance.windowsCheckpointAbi; }],
    ["audio", manifest => { delete manifest.provenance.windowsAudioAbi; }],
    ["input", manifest => { delete manifest.provenance.windowsInputAbi; }]
  ];
  for (const [index, [contract, mutate]] of mutations.entries()) {
    const installed = installedRuntime(path.join(root, String(index)), Managers.V8_VERSION);
    assert.equal(Launch.verifyNativeProfile(installed).pin.profile, Managers.V8_PROFILE);
    mutate(installed.manifest);
    const file = path.join(installed.installDir, "bundle-manifest.json");
    fs.writeFileSync(file, JSON.stringify(installed.manifest));
    installed.bundledManifestSha256 = Adapter.hash(file);
    assert.throws(() => Launch.verifyNativeProfile(installed), new RegExp("Windows " + contract + " version or checksum changed"));
  }
});

test("V8 ordinary preparation shares the verified checkpoint profile and reads original game data", t => {
  v8CatalogFixture(t);
  const root = temporary(t), game = windowsGame(path.join(root, "game"));
  const original = path.join(game, "Game.exe"), originalHash = Adapter.hash(original);
  const installed = installedRuntime(path.join(root, "runtime"), Managers.V8_VERSION);
  const session = Launch.prepareLaunch({ gameId: "backlog-v8", title: "Native game", contentRootDir: game, moduleData: {} },
    { userDataDir: path.join(root, "user") }, installed);
  assert.equal(session.backlogAbi, BacklogOverlay.ABI);
  assert.equal(session.checkpointAbi, CheckpointSession.ABI);
  assert.equal(session.audioAbi, AudioSession.ABI);
  assert.equal(session.inputMetadata.abi, WindowsInput.ABI);
  assert.equal(session.profileSha256, CheckpointSession.PROFILE_SHA256);
  assert.equal(session.preparation.generatedProfileSha256, Adapter.hash(path.join(session.sessionDir, "windows-game.lua")));
  assert.deepEqual(session.env, {});
  assert.equal(session.args.includes("--diagnostic-frames"), false);
  assert.equal(session.preparation.originalDataCopied, false);
  assert.equal(Adapter.hash(original), originalHash);
});

test("V9 rejects incompatible sound-effect operands and keeps every inherited contract", t => {
  v9CatalogFixture(t);
  const root = temporary(t), mutations = [
    ["sound-effect", manifest => { delete manifest.provenance.windowsSoundEffectAbi; }],
    ["sound-effect", manifest => { manifest.provenance.windowsSoundEffectOverlay.types = [0, 1]; }],
    ["sound-effect", manifest => { manifest.provenance.windowsSoundEffectOverlay.channels = [6, 7, 8]; }],
    ["sound-effect", manifest => { manifest.provenance.windowsSoundEffectOverlay.opcodes = [0x24]; }],
    ["sound-effect", manifest => { manifest.provenance.windowsSoundEffectOverlay.files[0] = null; }],
    ["sound-effect", manifest => { delete manifest.provenance.sourceOverlay.windowsSoundEffectOverlay; }],
    ["backlog", manifest => { delete manifest.provenance.windowsBacklogAbi; }],
    ["checkpoint", manifest => { delete manifest.provenance.windowsCheckpointAbi; }],
    ["audio", manifest => { delete manifest.provenance.windowsAudioAbi; }],
    ["input", manifest => { delete manifest.provenance.windowsInputAbi; }]
  ];
  for (const [index, [contract, mutate]] of mutations.entries()) {
    const installed = installedRuntime(path.join(root, String(index)), Managers.V9_VERSION);
    assert.equal(Launch.verifyNativeProfile(installed).pin.profile, Managers.V9_PROFILE);
    mutate(installed.manifest);
    const file = path.join(installed.installDir, "bundle-manifest.json");
    fs.writeFileSync(file, JSON.stringify(installed.manifest));
    installed.bundledManifestSha256 = Adapter.hash(file);
    assert.throws(() => Launch.verifyNativeProfile(installed), new RegExp("Windows " + contract + " version or checksum changed"));
  }
});

test("V9 ordinary preparation enables the sound-effect profile without modifying or copying original data", t => {
  v9CatalogFixture(t);
  const root = temporary(t), game = windowsGame(path.join(root, "game"));
  const original = path.join(game, "Game.exe"), originalHash = Adapter.hash(original);
  const installed = installedRuntime(path.join(root, "runtime"), Managers.V9_VERSION);
  const session = Launch.prepareLaunch({ gameId: "sound-v9", title: "Native game", contentRootDir: game, moduleData: {} },
    { userDataDir: path.join(root, "user") }, installed);
  assert.equal(session.soundEffectAbi, SoundEffectOverlay.ABI);
  assert.equal(session.backlogAbi, BacklogOverlay.ABI);
  assert.equal(session.checkpointAbi, CheckpointSession.ABI);
  assert.equal(session.audioAbi, AudioSession.ABI);
  assert.equal(session.inputMetadata.abi, WindowsInput.ABI);
  assert.equal(session.profileSha256, SoundEffectSession.PROFILE_SHA256);
  assert.match(fs.readFileSync(path.join(session.sessionDir, "windows-game.lua"), "utf8"), /WindowsSoundEffectOpcodeExtensions = true/);
  assert.equal(session.preparation.generatedProfileSha256, Adapter.hash(path.join(session.sessionDir, "windows-game.lua")));
  assert.deepEqual(session.env, {});
  assert.equal(session.args.includes("--diagnostic-frames"), false);
  assert.equal(session.preparation.originalDataCopied, false);
  assert.equal(Adapter.hash(original), originalHash);
});

test("a selected existing V2 keeps its identity but fails before startup because its decoder is missing", t => {
  const root = temporary(t), installed = installedRuntime(path.join(root, "v2"), Managers.V2_VERSION);
  const userDataDir = path.join(root, "user");
  assert.equal(Launch.verifyNativeProfile(installed).pin.version, Managers.V2_VERSION);
  assert.throws(() => Launch.prepareLaunch({ gameId: "gate", moduleData: {} }, { userDataDir }, installed), /v2 lacks the Bink 2 decoder.*default version/);
  assert.equal(fs.existsSync(userDataDir), false);
  assert.equal(installed.version, Managers.V2_VERSION);
});

test("V3 direct bundled launches verify the resource manifest and keep writable session files separate", t => {
  const root = temporary(t), game = windowsGame(path.join(root, "game"));
  const direct = installedRuntime(path.join(root, "bundle"), Managers.V3_VERSION);
  fs.renameSync(path.join(direct.installDir, "bundle-manifest.json"), path.join(direct.installDir, "manifest.json"));
  direct.bundledExecution = "direct";
  direct.readOnly = true;
  const title = 'A "window" \\ title\n日本語';
  const session = Launch.prepareLaunch({ gameId: "gate", title, gamePath: game, contentRootDir: game, moduleData: {} },
    { userDataDir: path.join(root, "user") }, direct);
  assert.equal(session.executable, direct.executablePath);
  assert.equal(session.preparation.runtimeVersion, Managers.V3_VERSION);
  const profile = fs.readFileSync(path.join(session.sessionDir, "windows-game.lua"), "utf8");
  assert.ok(profile.endsWith(`\nroot.WindowName = ${Adapter.luaString(title)};\n`));
  assert.equal(session.preparation.profileSha256, Managers.reviewedVersion(Managers.V3_VERSION).profileSha256);
  assert.equal(session.preparation.generatedProfileSha256, Adapter.hash(path.join(session.sessionDir, "windows-game.lua")));
  assert.equal(fs.existsSync(path.join(root, "user", "runtimes")), false);
  assert.ok(session.sessionDir.startsWith(path.join(root, "user", "games", "gate") + path.sep));
  assert.equal(fs.existsSync(path.join(direct.installDir, "bundle-manifest.json")), false);
});

test("native diagnostic sessions validate Windows resource ids and keep all writable paths outside original data", t => {
  const root = temporary(t), game = windowsGame(path.join(root, "game")), engine = runtime(path.join(root, "engine"));
  const original = Adapter.hash(path.join(game, "USRDIR", "script.mpk"));
  const session = Adapter.prepareWindowsSession({ gamePath: game, runtimeRoot: engine, sessionDir: path.join(root, "session") });
  assert.equal(session.upstreamRevision, Adapter.SOURCES.impacto.revision); assert.match(session.qualification, /story and save compatibility varies/);
  const base = fs.readFileSync(path.join(session.sessionDir, "basepaths.lua"), "utf8");
  assert.ok(base.includes(Adapter.luaString(path.join(game, "USRDIR"))));
  assert.ok(base.includes(Adapter.luaString(path.join(session.sessionDir, "saves"))));
  assert.ok(session.args.includes(path.join(session.sessionDir, "userconfig.toml")));
  assert.equal(Adapter.hash(path.join(game, "USRDIR", "script.mpk")), original);
  assert.throws(() => Adapter.prepareWindowsSession({ gamePath: game, runtimeRoot: engine, sessionDir: path.join(game, "state") }), /separate/);
  assert.throws(() => Adapter.prepareWindowsSession({ gamePath: game, runtimeRoot: engine, sessionDir: engine }), /separate/);
  archive(path.join(game, "USRDIR", "system.mpk"), [{ name: "DATA01.DDS", id: 7, bytes: "wrong mapping" }]);
  assert.throws(() => Adapter.validateWindowsData(game), /mapping differs/);
});

test("native diagnostic state refuses symbolic links and hard links that could overwrite original game files", t => {
  const root = temporary(t), game = windowsGame(path.join(root, "game")), engine = runtime(path.join(root, "engine"));
  const source = path.join(game, "Game.exe"), original = Adapter.hash(source), state = path.join(root, "state"); fs.mkdirSync(state);
  fs.symlinkSync(source, path.join(state, "windows-game.lua"));
  assert.throws(() => Adapter.prepareWindowsSession({ gamePath: game, runtimeRoot: engine, sessionDir: state }), /without links/);
  fs.unlinkSync(path.join(state, "windows-game.lua")); fs.linkSync(source, path.join(state, "native.log"));
  assert.throws(() => Adapter.prepareWindowsSession({ gamePath: game, runtimeRoot: engine, sessionDir: state }), /without links/);
  assert.equal(Adapter.hash(source), original);
});

test("hidden native diagnostics are explicitly bounded and do not change ordinary session input or audio", t => {
  const root = temporary(t), game = windowsGame(path.join(root, "game")), engine = runtime(path.join(root, "engine"));
  const options = { gamePath: game, runtimeRoot: engine, sessionDir: path.join(root, "session") };
  for (const frames of [0, -1, 3601, 1.5, NaN, "60"]) {
    assert.throws(() => Adapter.prepareWindowsSession({ ...options, diagnosticFrames: frames }), /integer from 1 to 3600/);
  }
  assert.equal(fs.existsSync(options.sessionDir), false);
  const diagnostic = Adapter.prepareWindowsSession({ ...options, diagnosticFrames: 600 });
  assert.deepEqual(diagnostic.args.slice(-2), ["--diagnostic-frames", "600"]);
  assert.equal(diagnostic.env.SDL_MAC_BACKGROUND_APP, "1");
  assert.equal(diagnostic.env.ALSOFT_DRIVERS, "null");
  const ordinary = Adapter.prepareWindowsSession(options);
  assert.equal(ordinary.args.includes("--diagnostic-frames"), false);
  assert.deepEqual(ordinary.env, {});
  assert.equal(ordinary.args[ordinary.args.indexOf("-ll") + 1], "Info");
  for (const diagnosticConfirmFrame of [0, -1, 600, 601, 1.5, NaN, "60"]) {
    assert.throws(() => Adapter.prepareWindowsSession({ ...options, diagnosticFrames: 600, diagnosticConfirmFrame }), /before its diagnostic frame limit/);
  }
  assert.throws(() => Adapter.prepareWindowsSession({ ...options, diagnosticConfirmFrame: 60 }), /before its diagnostic frame limit/);
  const confirmed = Adapter.prepareWindowsSession({ ...options, diagnosticFrames: 600, diagnosticConfirmFrame: 500 });
  assert.deepEqual(confirmed.args.slice(-2), ["--diagnostic-confirm-frame", "500"]);
});

test("Windows native movie mapping rejects changed dimensions and symbolic links without writing data", t => {
  const root = temporary(t), game = windowsGame(path.join(root, "game"));
  const movie = path.join(game, "USRDIR", "movie", "1920x1080", "title.bk2"), original = fs.readFileSync(movie);
  const changed = Buffer.from(original); changed.writeUInt32LE(1280, 20); fs.writeFileSync(movie, changed);
  assert.throws(() => Adapter.validateWindowsData(game), /1920×1080 Bink 2 format/);
  fs.writeFileSync(movie, original);
  const realMovie = path.join(root, "original.bk2"); fs.renameSync(movie, realMovie); fs.symlinkSync(realMovie, movie);
  assert.throws(() => Adapter.validateWindowsData(game), /regular Bink 2 file/);
  assert.deepEqual(fs.readFileSync(realMovie), original);
});

test("production preparation binds a reviewed bundled overlay/profile and opens original data with private state", t => {
  const root = temporary(t), game = windowsGame(path.join(root, "game")), install = installedRuntime(path.join(root, "runtime"));
  const context = { userDataDir: path.join(root, "user") }, entry = { gameId: "gate", contentRootDir: game, moduleData: {} };
  const originalFile = path.join(game, "USRDIR", "script.mpk"), before = { hash: Adapter.hash(originalFile), mtime: fs.statSync(originalFile).mtimeMs };
  const prepared = Launch.prepareLaunch(entry, context, install);
  assert.equal(prepared.sessionDir, path.join(context.userDataDir, "games", "gate", "modules", "mages", "session"));
  assert.equal(prepared.executable, install.executablePath);
  assert.equal(prepared.args.includes("--diagnostic-frames"), false);
  assert.deepEqual(prepared.env, {});
  assert.equal(prepared.preparation.runtimeVersion, Managers.VERSION);
  assert.equal(prepared.preparation.minimumMacOS, "13.0");
  assert.equal(prepared.preparation.originalDataCopied, false);
  assert.equal(prepared.preparation.originalDataModified, false);
  assert.deepEqual({ hash: Adapter.hash(originalFile), mtime: fs.statSync(originalFile).mtimeMs }, before);
  assert.equal(entry.moduleData.nativeOverlaySha256, Managers.reviewedVersion(install.version).overlaySha256);
  assert.throws(() => Launch.prepareLaunch({ ...entry, gameId: "../escape" }, context, install), /Import this game/);
  assert.throws(() => Launch.prepareLaunch(entry, { userDataDir: game }, install), /separate/);
  for (const changed of [{ version: overlay.upstreamVersion }, { upstreamRevision: "a".repeat(40) }, { source: "local" }])
    assert.throws(() => Launch.verifyNativeProfile({ ...install, ...changed }), /Mac Windows HD runtime/);
  install.manifest.provenance.sourceOverlay.overlaySha256 = "b".repeat(64);
  const manifestPath = path.join(install.installDir, "bundle-manifest.json"); fs.writeFileSync(manifestPath, JSON.stringify(install.manifest));
  assert.throws(() => Launch.verifyNativeProfile({ ...install, bundledManifestSha256: Adapter.hash(manifestPath) }), /source or game profile checksum changed/);
});

test("Node module dispatch plans an offline bundled install and spawns only the reviewed native executable", async t => {
  const root = temporary(t), game = windowsGame(path.join(root, "game")), install = installedRuntime(path.join(root, "runtime"));
  const entry = { gameId: "gate", contentRootDir: game, moduleData: {} }, calls = [];
  let selection = { version: Managers.VERSION, ready: false, install: null, reason: "Missing bundled install" };
  const manager = { id: "impacto", resolveSelection: () => selection };
  const module = Mages.__test.createModule({ manager, launchEnabled: true });
  const context = { userDataDir: path.join(root, "user"), settings: {}, spawnDetachedChecked: async (...args) => { calls.push(args); return { pid: 123 }; } };
  assert.equal(module.normalizeRuntimeId("mages-tools"), "impacto");
  assert.deepEqual(await module.ensureRuntime(entry, context), { managerId: "impacto", version: Managers.VERSION, requiresDownload: false, installOptions: {} });
  assert.equal(calls.length, 0);
  selection = { ...selection, ready: true, install };
  assert.equal(await module.ensureRuntime(entry, context), null);
  assert.deepEqual(await module.launchRuntime("impacto", entry, context), { pid: 123 });
  assert.equal(calls.length, 1); assert.equal(calls[0][0], install.executablePath);
  assert.ok(calls[0][1].includes(path.join(context.userDataDir, "games", "gate", "modules", "mages", "session", "basepaths.lua")));
  assert.equal(calls[0][2].cwd, path.join(install.installDir, "files", "Impacto.app", "Contents", "Resources"));
  assert.equal(calls[0][1].includes("--diagnostic-confirm-frame"), false);
  selection = { ...selection, version: overlay.upstreamVersion };
  await assert.rejects(module.ensureRuntime(entry, context), /Other versions support different editions/);
  assert.equal(calls.length, 1);
  assert.equal(Object.keys(require.cache).some(file => /(?:^|\/)electron\//.test(file)), false);
});

test("owned Impacto overlay applies exact hashes to staged copies and refuses Git sources or changed files", async t => {
  const source = path.resolve(__dirname, "../src/external/impacto");
  if (!fs.existsSync(path.join(source, "CMakeLists.txt"))) { t.skip("Initialize the pinned Impacto source submodule to validate its overlay."); return; }
  const root = temporary(t), staged = path.join(root, "source"); fs.mkdirSync(staged);
  const originals = overlay.files.map(file => file.originalSha256 === null ? null : Adapter.hash(path.join(source, file.path)));
  for (const file of overlay.files) {
    if (file.originalSha256 === null) continue;
    const target = path.join(staged, file.path); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(path.join(source, file.path), target);
  }
  const result = await Adapter.applyImpactoOverlay(staged, { logPath: path.join(root, "overlay.log") });
  assert.equal(result.upstreamRevision, Adapter.SOURCES.impacto.revision);
  overlay.files.forEach(file => assert.equal(Adapter.hash(path.join(staged, file.path)), file.adaptedSha256));
  assert.deepEqual(overlay.files.map(file => file.originalSha256 === null ? null : Adapter.hash(path.join(source, file.path))), originals);
  overlay.files.filter(file => file.originalSha256 === null).forEach(file => assert.equal(fs.existsSync(path.join(source, file.path)), false));
  await assert.rejects(Adapter.applyImpactoOverlay(source, { logPath: path.join(root, "rejected.log") }), /owned staged source/);
  await assert.rejects(Adapter.applyImpactoOverlay(staged, { logPath: path.join(root, "changed.log") }), /source file differs/);
});
