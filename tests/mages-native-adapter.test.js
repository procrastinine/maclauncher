const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Adapter = require("../src/modules/mages/native/adapter");
const Launch = require("../src/modules/mages/native/launch");
const Managers = require("../src/modules/mages/native/manager");
// Earlier Impacto Mac packages, as their manifests describe them. The launcher
// keeps no version table; these facts build fixture manifests.
const Packages = require("./fixtures/mages-windows-versions.json");
const reviewed = version => Packages.find(row => row.version === version) || null;
const Versions = { VERSION: "0.10.8.810-windows-v9", CURRENT_VERSION: "0.10.8.903-MCLv1", LEGACY_VERSION: "0.10.8.810-windows-v1",
  ...Object.fromEntries([2, 3, 4, 5, 6, 7, 8, 9].map(n => [`V${n}_VERSION`, `0.10.8.810-windows-v${n}`])) };
const Bundle = require("../src/modules/shared/runtime/bundled-native");
const Mages = require("../src/modules/mages/main");
const overlay = require("../src/modules/mages/native/impacto-overlay.json");
const { archive, script } = require("./helpers/mages-fixture");
const { peFixture: uiPeFixture, withVersion } = require("./helpers/mages-windows-ui-fixture");
const WindowsInput = require("../src/modules/mages/native/windows-ui-data");
const InputSession = require("../src/modules/mages/native/windows-ui-session");
const AudioSession = require("../src/modules/mages/native/windows-audio-session");
const CheckpointSession = require("../src/modules/mages/native/windows-checkpoint-session");
const BacklogOverlay = require("../src/modules/mages/native/windows-backlog-overlay");
const SoundEffectSession = require("../src/modules/mages/native/windows-sfx-session");
const SoundEffectOverlay = require("../src/modules/mages/native/windows-sfx-overlay");

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

const ABI_FIELDS = ["windowsInputAbi", "windowsAudioAbi", "windowsCheckpointAbi", "windowsBacklogAbi", "windowsSoundEffectAbi"];
function installedRuntime(root, version = Versions.VERSION, pin = reviewed(version)) {
  const payload = runtime(path.join(root, "files"));
  const executable = path.join(payload, "Impacto.app", "Contents", "MacOS", "Impacto");
  const bytes = Buffer.alloc(32); bytes.writeUInt32LE(0xfeedfacf); bytes.writeUInt32LE(0x0100000c, 4); bytes.writeUInt32LE(2, 12);
  fs.writeFileSync(executable, bytes, { mode: 0o755 }); fs.chmodSync(executable, 0o755);
  fs.writeFileSync(path.join(payload, "profiles", "fixture.lua"), "synthetic profile data");
  fs.writeFileSync(path.join(payload, "LICENSE"), "Synthetic notice");
  // Current packages declare their contracts as one profile; earlier ones as separate fields.
  const contracts = pin.currentWindowsAbiProfile ? { currentWindowsAbiProfile: { ...pin.currentWindowsAbiProfile } } :
    Object.fromEntries(ABI_FIELDS.filter(field => pin[field]).map(field => [field, pin[field]]));
  const manifest = { schemaVersion: 1, managerId: "impacto", version, upstreamRevision: pin.upstreamRevision,
    platform: "darwin", arch: "arm64", minimumMacOS: pin.minimumMacOS || "27.0", executableRelative: "Impacto.app/Contents/MacOS/Impacto",
    provenance: { sourceRevision: pin.upstreamRevision, sourceOverlay: { overlaySha256: pin.overlaySha256 },
      profileSha256: pin.profileSha256, ...contracts,
      ...(pin.dependencyOverlaySha256 ? { dependencyOverlaySha256: pin.dependencyOverlaySha256,
        codecProbe: { sourceSha256: pin.codecProbeSourceSha256, bink2Decoder: true, headerLibraryVersionsMatch: true } } : {}) },
    notices: [{ name: "Fixture", license: "MIT", sourceUrl: "https://example.org/source", path: "LICENSE" }], dependencies: [],
    files: Bundle.fileInventory(payload).map(relative => { const file = path.join(payload, relative), stat = fs.statSync(file);
      return { path: relative, size: stat.size, sha256: Adapter.hash(file), mode: stat.mode & 0o777,
        ...(file === executable ? { architectures: ["arm64"] } : {}) }; }) };
  const file = path.join(root, "bundle-manifest.json"); fs.writeFileSync(file, JSON.stringify(manifest));
  return { version, upstreamRevision: pin.upstreamRevision, source: "bundled", installDir: root,
    executablePath: executable, bundledManifestSha256: Adapter.hash(file), manifest };
}
function rewriteManifest(installed, mutate) {
  mutate(installed.manifest);
  const file = path.join(installed.installDir, "bundle-manifest.json"); fs.writeFileSync(file, JSON.stringify(installed.manifest));
  installed.bundledManifestSha256 = Adapter.hash(file);
}

test("downloaded Impacto profiles verify their relocated manifest and sealed payload before Play", t => {
  const root = temporary(t), install = installedRuntime(root), version = install.version;
  const directory = path.join(root, "project-payload"); fs.mkdirSync(directory);
  fs.renameSync(path.join(root, "files"), path.join(directory, "files"));
  const manifest = path.join(directory, "manifest.json");
  fs.renameSync(path.join(root, "bundle-manifest.json"), manifest);
  const tag = `impacto/v${version}/arm64`, filename = `impacto-${version}-arm64.tar.gz`, archiveSha256 = "b".repeat(64);
  const record = { schemaVersion: 2, id: "impacto", version, arch: "arm64", launcherArchitectures: ["arm64"],
    minimumMacOS: "13.0", manifestRelative: "manifest.json", manifestSha256: install.bundledManifestSha256,
    sourceSha256: reviewed(version).sourceArtifact.sha256, updatePolicy: "manual", tag,
    asset: { filename, sha256: archiveSha256, bytes: 1234,
      url: `https://github.com/procrastinine/maclauncher-builds/releases/download/${encodeURIComponent(tag)}/${filename}` } };
  Object.assign(install, { source: "download", archiveSha256, catalogEntry: { projectPackage: record },
    installationMetadata: { manifestSha256: record.manifestSha256 },
    executablePath: path.join(directory, "files", "Impacto.app/Contents/MacOS/Impacto") });
  assert.equal(Launch.verifyNativeProfile(install).runtimeRoot, path.join(directory, "files"));
  const bytes = fs.readFileSync(manifest); fs.appendFileSync(manifest, " ");
  assert.throws(() => Launch.verifyNativeProfile(install), /manifest changed/);
  fs.writeFileSync(manifest, bytes);
  fs.appendFileSync(install.executablePath, "changed native bytes");
  assert.throws(() => Launch.verifyNativeProfile(install), /limit|size|checksum/);
});

test("current Impacto declares its Windows contracts as one manifest profile", t => {
  const root = temporary(t), installed = installedRuntime(root, Versions.CURRENT_VERSION);
  assert.deepEqual(Launch.verifyNativeProfile(installed).abis, reviewed(Versions.CURRENT_VERSION).currentWindowsAbiProfile);
  rewriteManifest(installed, manifest => { manifest.provenance.currentWindowsAbiProfile.soundEffect = "different-opcodes"; });
  assert.throws(() => Launch.verifyNativeProfile(installed), /requires a newer MacLauncher\./);
});

test("each earlier Impacto package verifies from the contracts and game profile its manifest declares", t => {
  const root = temporary(t);
  assert.equal(Managers.createManager().resolveSelection({}, {}, path.join(root, "empty-user")).version, null);
  assert.deepEqual(Managers.createManager().distributionVersions, []);
  for (const pin of Packages) {
    const verified = Launch.verifyNativeProfile(installedRuntime(path.join(root, pin.version), pin.version));
    assert.equal(verified.manifest.version, pin.version);
    assert.equal(Adapter.hash(verified.profileSource), pin.profileSha256);
  }
  assert.equal(Managers.profileFor(reviewed(Versions.V5_VERSION).profileSha256), InputSession.PROFILE_SOURCE);
  assert.equal(Managers.profileFor(reviewed(Versions.V6_VERSION).profileSha256), AudioSession.PROFILE_SOURCE);
  assert.equal(Managers.profileFor("f".repeat(64)), null);
});

test("a later Impacto revision launches when this launcher implements its contracts and game profile", t => {
  const root = temporary(t), game = windowsGame(path.join(root, "game")), later = "0.10.8.903-MCLv2";
  const installed = installedRuntime(path.join(root, "later"), later, reviewed(Versions.CURRENT_VERSION));
  const session = Launch.prepareLaunch({ gameId: "later", contentRootDir: game, moduleData: {} }, { userDataDir: path.join(root, "user") }, installed);
  assert.equal(session.preparation.runtimeVersion, later);
  assert.equal(session.soundEffectAbi, SoundEffectOverlay.ABI);
  assert.equal(session.profileSha256, SoundEffectSession.PROFILE_SHA256);
  const changes = [
    [manifest => { manifest.provenance.currentWindowsAbiProfile.input = "unknown-input-abi"; }, /requires a newer MacLauncher\./],
    [manifest => { manifest.provenance.currentWindowsAbiProfile = ["input"]; }, /manifest is invalid/],
    [manifest => { manifest.provenance.profileSha256 = "f".repeat(64); }, /newer MacLauncher game profile/]
  ];
  for (const [index, [mutate, error]] of changes.entries()) {
    const changed = installedRuntime(path.join(root, String(index)), later, reviewed(Versions.CURRENT_VERSION));
    rewriteManifest(changed, mutate);
    assert.throws(() => Launch.verifyNativeProfile(changed), error);
  }
  const earlier = installedRuntime(path.join(root, "v6"), Versions.V6_VERSION);
  rewriteManifest(earlier, manifest => { manifest.provenance.windowsAudioAbi = "unknown-voice-abi"; });
  assert.throws(() => Launch.verifyNativeProfile(earlier), /requires a newer MacLauncher\./);
});

test("production V5 sessions load the original PE input table and leave old V4 sessions and original files intact", t => {
  const root = temporary(t), game = windowsGame(path.join(root, "game")), originalExecutable = path.join(game, "Game.exe");
  const executable = withVersion(uiPeFixture().bytes); fs.writeFileSync(originalExecutable, executable);
  const before = { hash: Adapter.hash(originalExecutable), mtimeMs: fs.statSync(originalExecutable).mtimeMs };
  const installed = installedRuntime(path.join(root, "runtime"), Versions.V5_VERSION);
  const entry = { gameId: "input-v5", contentRootDir: game, moduleData: {} };
  const context = { userDataDir: path.join(root, "user") };
  const session = Launch.prepareLaunch(entry, context, installed);
  assert.equal(session.inputMetadata.abi, WindowsInput.ABI); assert.equal(session.inputMetadata.regions, 2);
  assert.equal(session.profileSha256, InputSession.PROFILE_SHA256);
  assert.equal(session.preparation.runtimeVersion, Versions.V5_VERSION);
  assert.equal(session.preparation.profile, path.basename(InputSession.PROFILE_SOURCE, ".lua"));
  assert.deepEqual(session.env, {}); assert.equal(session.args.includes("--diagnostic-frames"), false);
  assert.match(fs.readFileSync(session.inputMetadata.file, "utf8"), /Id = 3, ParentId = 0/);
  assert.match(fs.readFileSync(path.join(session.sessionDir, "windows-game.lua"), "utf8"), /windows-ui-input\.lua/);
  assert.equal(entry.moduleData.nativeRuntimeVersion, Versions.V5_VERSION);
  assert.deepEqual({ hash: Adapter.hash(originalExecutable), mtimeMs: fs.statSync(originalExecutable).mtimeMs }, before);
  const v4 = installedRuntime(path.join(root, "old-runtime"), Versions.V4_VERSION);
  const oldSession = Launch.prepareLaunch({ ...entry, gameId: "input-v4", moduleData: {} }, context, v4);
  assert.equal(oldSession.inputMetadata, undefined);
  assert.equal(oldSession.preparation.runtimeVersion, Versions.V4_VERSION);
  assert.equal(fs.existsSync(path.join(oldSession.sessionDir, "patches", "windows-ui-input.lua")), false);
  fs.writeFileSync(originalExecutable, withVersion(uiPeFixture({ duplicateDispatch: true }).bytes));
  const unsupported = { ...entry, gameId: "unsupported-input", moduleData: {} };
  assert.throws(() => Launch.prepareLaunch(unsupported, context, installed), /ambiguous/);
  assert.equal(fs.existsSync(Launch.sessionDirectory(unsupported, context)), false);
  assert.deepEqual(unsupported.moduleData, {});
});

test("production V6 sessions use the voice profile and original input data without copying or modifying games", t => {
  const root = temporary(t), game = windowsGame(path.join(root, "game"));
  const originalExecutable = path.join(game, "Game.exe");
  const before = { hash: Adapter.hash(originalExecutable), mtimeMs: fs.statSync(originalExecutable).mtimeMs };
  const installed = installedRuntime(path.join(root, "runtime"), Versions.V6_VERSION);
  const entry = { gameId: "voice-v6", contentRootDir: game, moduleData: {} };
  const context = { userDataDir: path.join(root, "user") };
  const session = Launch.prepareLaunch(entry, context, installed);
  assert.equal(session.audioAbi, AudioSession.ABI);
  assert.equal(session.inputMetadata.abi, WindowsInput.ABI); assert.equal(session.inputMetadata.regions, 2);
  assert.equal(session.profileSha256, AudioSession.PROFILE_SHA256);
  assert.equal(session.preparation.runtimeVersion, Versions.V6_VERSION);
  assert.equal(session.preparation.profile, path.basename(AudioSession.PROFILE_SOURCE, ".lua"));
  assert.equal(session.preparation.originalDataCopied, false);
  assert.equal(session.preparation.originalDataModified, false);
  assert.deepEqual(session.env, {}); assert.equal(session.args.includes("--diagnostic-frames"), false);
  assert.equal(session.args[session.args.indexOf("-ll") + 1], "Info");
  assert.match(fs.readFileSync(path.join(session.sessionDir, "windows-game.lua"), "utf8"), /WindowsVoiceOpcodeExtensions = true/);
  assert.deepEqual({ hash: Adapter.hash(originalExecutable), mtimeMs: fs.statSync(originalExecutable).mtimeMs }, before);
  const oldInstall = installedRuntime(path.join(root, "v5"), Versions.V5_VERSION);
  const oldSession = Launch.prepareLaunch({ ...entry, gameId: "voice-v5", moduleData: {} }, context, oldInstall);
  assert.equal(oldSession.audioAbi, undefined); assert.equal(oldSession.profileSha256, InputSession.PROFILE_SHA256);
  assert.doesNotMatch(fs.readFileSync(path.join(oldSession.sessionDir, "windows-game.lua"), "utf8"), /WindowsVoiceOpcodeExtensions/);
  fs.writeFileSync(originalExecutable, withVersion(uiPeFixture({ duplicateDispatch: true }).bytes));
  const unsupported = { ...entry, gameId: "unsupported-voice", moduleData: {} };
  assert.throws(() => Launch.prepareLaunch(unsupported, context, installed), /ambiguous/);
  assert.equal(fs.existsSync(Launch.sessionDirectory(unsupported, context)), false);
  assert.deepEqual(unsupported.moduleData, {});
});

test("V7 ordinary preparation retains voice/input/checkpoint contracts and reads original data", t => {
  const root = temporary(t), game = windowsGame(path.join(root, "game"));
  const original = path.join(game, "Game.exe"), originalHash = Adapter.hash(original);
  const installed = installedRuntime(path.join(root, "runtime"), Versions.V7_VERSION);
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

test("V8 ordinary preparation shares the verified checkpoint profile and reads original game data", t => {
  const root = temporary(t), game = windowsGame(path.join(root, "game"));
  const original = path.join(game, "Game.exe"), originalHash = Adapter.hash(original);
  const installed = installedRuntime(path.join(root, "runtime"), Versions.V8_VERSION);
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

test("V9 ordinary preparation enables the sound-effect profile without modifying or copying original data", t => {
  const root = temporary(t), game = windowsGame(path.join(root, "game"));
  const original = path.join(game, "Game.exe"), originalHash = Adapter.hash(original);
  const installed = installedRuntime(path.join(root, "runtime"), Versions.V9_VERSION);
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

test("a selected runtime without the Bink 2 decoder keeps its identity but fails before startup", t => {
  const root = temporary(t), installed = installedRuntime(path.join(root, "v2"), Versions.V2_VERSION);
  const userDataDir = path.join(root, "user");
  assert.equal(Launch.verifyNativeProfile(installed).manifest.version, Versions.V2_VERSION);
  assert.throws(() => Launch.prepareLaunch({ gameId: "gate", moduleData: {} }, { userDataDir }, installed), /lacks the Bink 2 decoder/);
  const probed = installedRuntime(path.join(root, "v3"), Versions.V3_VERSION);
  rewriteManifest(probed, manifest => { manifest.provenance.codecProbe.bink2Decoder = false; });
  assert.throws(() => Launch.prepareLaunch({ gameId: "gate", moduleData: {} }, { userDataDir }, probed), /lacks the Bink 2 decoder/);
  assert.equal(fs.existsSync(userDataDir), false);
  assert.equal(installed.version, Versions.V2_VERSION);
});

test("V3 direct bundled launches verify the resource manifest and keep writable session files separate", t => {
  const root = temporary(t), game = windowsGame(path.join(root, "game"));
  const direct = installedRuntime(path.join(root, "bundle"), Versions.V3_VERSION);
  fs.renameSync(path.join(direct.installDir, "bundle-manifest.json"), path.join(direct.installDir, "manifest.json"));
  direct.bundledExecution = "direct";
  direct.readOnly = true;
  const title = 'A "window" \\ title\n日本語';
  const session = Launch.prepareLaunch({ gameId: "gate", title, gamePath: game, contentRootDir: game, moduleData: {} },
    { userDataDir: path.join(root, "user") }, direct);
  assert.equal(session.executable, direct.executablePath);
  assert.equal(session.preparation.runtimeVersion, Versions.V3_VERSION);
  const profile = fs.readFileSync(path.join(session.sessionDir, "windows-game.lua"), "utf8");
  assert.ok(profile.endsWith(`\nroot.WindowName = ${Adapter.luaString(title)};\n`));
  assert.equal(session.preparation.profileSha256, reviewed(Versions.V3_VERSION).profileSha256);
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
  assert.equal(prepared.preparation.runtimeVersion, Versions.VERSION);
  assert.equal(prepared.preparation.minimumMacOS, "13.0");
  assert.equal(prepared.preparation.originalDataCopied, false);
  assert.equal(prepared.preparation.originalDataModified, false);
  assert.deepEqual({ hash: Adapter.hash(originalFile), mtime: fs.statSync(originalFile).mtimeMs }, before);
  assert.equal(entry.moduleData.nativeOverlaySha256, reviewed(install.version).overlaySha256);
  assert.throws(() => Launch.prepareLaunch({ ...entry, gameId: "../escape" }, context, install), /Import this game/);
  assert.throws(() => Launch.prepareLaunch(entry, { userDataDir: game }, install), /separate/);
  for (const changed of [{ version: overlay.upstreamVersion }, { upstreamRevision: "a".repeat(40) }])
    assert.throws(() => Launch.verifyNativeProfile({ ...install, ...changed }), /differs from the selected catalog entry/);
  assert.throws(() => Launch.verifyNativeProfile({ ...install, source: "local" }), /Mac Windows HD runtime/);
  fs.appendFileSync(path.join(install.installDir, "bundle-manifest.json"), " ");
  assert.throws(() => Launch.verifyNativeProfile(install), /manifest changed/);
});

test("Node module dispatch plans an offline bundled install and spawns only the reviewed native executable", async t => {
  const root = temporary(t), game = windowsGame(path.join(root, "game")), install = installedRuntime(path.join(root, "runtime"));
  const entry = { gameId: "gate", contentRootDir: game, moduleData: {} }, calls = [];
  let selection = { version: Versions.VERSION, ready: false, install: null, reason: "Missing bundled install" };
  const manager = { id: "impacto", resolveSelection: () => selection };
  const module = Mages.__test.createModule({ manager, launchEnabled: true });
  const context = { userDataDir: path.join(root, "user"), settings: {}, gameArguments: ["--loglevel", "Debug"],
    spawnDetachedChecked: async (...args) => { calls.push(args); return { pid: 123 }; } };
  assert.equal(module.normalizeRuntimeId("mages-tools"), "impacto");
  assert.deepEqual(await module.ensureRuntime(entry, context), { managerId: "impacto", version: Versions.VERSION, requiresDownload: false, installOptions: {} });
  assert.equal(calls.length, 0);
  selection = { ...selection, ready: true, install };
  assert.equal(await module.ensureRuntime(entry, context), null);
  assert.deepEqual(await module.launchRuntime("impacto", entry, context), { pid: 123 });
  assert.equal(calls.length, 1); assert.equal(calls[0][0], install.executablePath);
  assert.deepEqual(calls[0][1].slice(-2), context.gameArguments);
  assert.equal(calls[0][1].filter(argument => argument === "--loglevel").length, 1);
  assert.ok(calls[0][1].includes(path.join(context.userDataDir, "games", "gate", "modules", "mages", "session", "basepaths.lua")));
  assert.equal(calls[0][2].cwd, path.join(install.installDir, "files", "Impacto.app", "Contents", "Resources"));
  assert.equal(calls[0][1].includes("--diagnostic-confirm-frame"), false);
  selection = { version: overlay.upstreamVersion, ready: false, install: null, reason: "Install this version first." };
  await assert.rejects(module.launchRuntime("impacto", entry, context), /Install this version first/);
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
