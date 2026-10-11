const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const OpenGMK = require("../src/modules/gamemaker/runtime/opengmk");
const Classic = require("../src/modules/gamemaker/runtime/classic-launch");
const Inspect = require("../src/modules/gamemaker/inspect");
const Module = require("../src/modules/gamemaker/main");
const Native = require("../src/modules/shared/runtime/local-native");

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opengmk-tests-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const report = () => ({ schemaVersion: 1, engine: "gamemaker-classic", assetsVerified: true,
  version: "8.1", windowsExtensionHost: false, extensions: [], externalDefinitions: [] });

test("Classic and Studio select separate module runtimes without crossing formats", () => {
  const supported = Module.manifest.runtime.supported;
  assert.deepEqual(Module.filterRuntimeSupport({ moduleData: { executionKind: "classic" } }, supported), ["opengmk", "inspection"]);
  assert.equal(Module.canLaunchRuntime("opengmk", { moduleData: { executionKind: "studio-vm" } }), false);
  assert.equal(Module.normalizeRuntimeId("opengmk"), "opengmk");
  assert.equal(Module.manifest.runtime.managerUi.opengmk.sectionLabel, "Classic (OpenGMK)");
  assert.equal(Module.manifest.runtime.entries.inspection.launch, false);
  assert.equal(Module.canLaunchRuntime("inspection", { moduleData: { executionKind: "classic" } }), true);
});

test("OpenGMK inventories the actual Windows release separately from the exact reviewed Mac source", async () => {
  const row = await OpenGMK.mapRelease({ tag_name: "v0.2.0", published_at: "2021-07-18T01:00:17Z" }, {
    resolveRevision: async () => OpenGMK.HISTORICAL.upstreamRevision, sourceUrl: OpenGMK.HISTORICAL.sourceUrl });
  assert.equal(row.version, "0.2.0");
  assert.equal(row.upstreamRevision, "68eac1658c613a41b007baf5b7ab4516d0b4cf4f");
  assert.equal(row.asset, undefined);
  assert.equal(row.localBuild, false);
  assert.notEqual(OpenGMK.BUILD.upstreamRevision, row.upstreamRevision);
  assert.equal(OpenGMK.BUILD.windowsExtensionHost, false);
  assert.throws(() => OpenGMK.parserRuntime({ version: row.version }), /no Mac runtime/);
});

test("the separate-source package preserves its native overlay and keeps explicit prior selections", () => {
  assert.equal(OpenGMK.VERSION, "0.2.0-9ccc47a9-macos-v7");
  assert.equal(OpenGMK.BUILD.overlayVersion, "maclauncher-appkit-gl-6");
  const prior = { version: "0.2.0-9ccc47a9-macos-v6", upstreamRevision: OpenGMK.BUILD.upstreamRevision };
  assert.throws(() => OpenGMK.parserRuntime({ version: OpenGMK.VERSION, install: prior }), /identity differs from the explicit selection/);
  assert.equal(OpenGMK.parserRuntime({ version: prior.version, install: prior }), prior);
  assert.equal(OpenGMK.MAC_PROFILES.find(item => item.version === prior.version).overlayVersion, "maclauncher-appkit-gl-6");
  assert.equal(OpenGMK.MAC_PROFILES.find(item => item.version === prior.version).sourceArtifact, undefined);
  assert.equal(OpenGMK.BUILD.sourceArtifact.directoryRelative, `opengmk/${OpenGMK.VERSION}-source.tar.gz`);
  assert.match(OpenGMK.BUILD.sourceArtifact.sha256, /^[a-f0-9]{64}$/);
  assert.ok(OpenGMK.BUILD.sourceArtifact.bytes > 0);
  assert.equal(OpenGMK.manager.core.catalog.find(item => item.version === prior.version).sourceArtifact, undefined);
  assert.equal(OpenGMK.manager.core.catalog.find(item => item.version === prior.version).overlayVersion, "maclauncher-appkit-gl-6");
  assert.deepEqual(require("../scripts/distribution-model.cjs").requiredVersions(OpenGMK.manager), [OpenGMK.VERSION]);
});

test("an explicit existing Mac installation remains selected and is never used as the new default", { skip: process.platform !== "darwin" }, t => {
  const root = temporary(t), version = "0.2.0-9ccc47a9-macos-v3";
  const pin = OpenGMK.MAC_PROFILES.find(item => item.version === version);
  const executable = path.join(root, "retained-native"), bytes = Buffer.alloc(64);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(process.arch === "x64" ? 0x01000007 : 0x0100000c, 4);
  bytes.writeUInt32LE(2, 12); fs.writeFileSync(executable, bytes, { mode: 0o755 });
  const directory = path.join(root, "runtimes/opengmk", version); fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "runtime.json"), JSON.stringify({ version, catalogEntry: pin,
    upstreamRevision: pin.upstreamRevision, runtimePath: executable, binarySha256: Native.hashFile(executable), source: "local" }));
  const selected = OpenGMK.manager.resolveSelection({ runtimeData: { opengmk: { version } } }, {}, root);
  assert.equal(selected.version, version); assert.equal(selected.ready, true);
  assert.equal(OpenGMK.parserRuntime(selected).executablePath, executable);
  const automatic = OpenGMK.manager.resolveSelection({}, {}, root);
  assert.equal(automatic.version, OpenGMK.VERSION);
  assert.notEqual(automatic.install?.runtimePath, executable, "Automatic selection must never reuse the older registered executable");
  assert.equal(fs.existsSync(path.join(root, "runtimes/opengmk", OpenGMK.VERSION)), false);
  bytes[63] = 1; fs.writeFileSync(executable, bytes);
  const changed = OpenGMK.manager.resolveSelection({ runtimeData: { opengmk: { version } } }, {}, root);
  assert.equal(changed.version, version); assert.equal(changed.ready, false);
  assert.throws(() => OpenGMK.parserRuntime(changed), /retired Mac OpenGMK build is not installed/);
});

test("default GM8.1 header evidence checks PE, split magic, version and settings bounds", t => {
  const root = temporary(t), file = path.join(root, "Classic.exe"), header = 3800100;
  const bytes = Buffer.alloc(header + 1000);
  bytes.write("MZ"); bytes.writeUInt32LE(0x80, 0x3c);
  Buffer.from([0x50, 0x45, 0, 0, 0x4c, 1]).copy(bytes, 0x80);
  bytes.writeUInt32LE(0xf7000011, header); bytes.writeUInt32LE(0x00140067, header + 4);
  bytes.writeUInt32LE(800, header + 32); bytes.writeUInt32LE(100, header + 36);
  bytes.writeUInt16BE(0x789c, header + 40);
  fs.writeFileSync(file, bytes);
  const detected = Inspect.inspectClassic(file);
  assert.equal(detected.classicVersion, "8.1");
  assert.equal(detected.assetsVerified, false);
  assert.equal(detected.exactEngineVersion, null);
  bytes.writeUInt32LE(100000, header + 36); fs.writeFileSync(file, bytes);
  assert.equal(Inspect.inspectClassic(file), null);
});

test("preflight validates real extension ABI and distinguishes declarations from executable calls", () => {
  const value = report();
  value.extensions = [{ name: "Audio", files: [{ name: "Audio.dll", kind: "dll", functions: [{
    name: "play", symbol: "play", callingConvention: "cdecl", argumentCount: 1,
    argumentTypes: ["real"], returnType: "real" }] }] }];
  const inspected = OpenGMK.validateReport(value);
  assert.equal(inspected.dllDeclarations[0].library, "Audio.dll");
  assert.equal(inspected.externalDefinitionCount, 0);
  assert.equal(inspected.compatibility, "beta-format-candidate");
  value.extensions[0].files[0].functions[0].argumentTypes = ["pointer"];
  assert.throws(() => OpenGMK.validateReport(value), /Unsupported Classic extension ABI/);
  assert.throws(() => OpenGMK.validateReport({ ...report(), assetsVerified: false }), /invalid Classic asset/);
});

test("native extension availability requires the actual declared symbol and ABI", () => {
  const value = report();
  value.nativeExtensionProfiles = [{ id: "supersound-string-abi-v1", libraries: ["supersound.dll"], functions: [
    { symbol: "SS_LoadSound", argumentCount: 2, argumentTypes: ["string", "string"], returnType: "string" }] }];
  value.externalDefinitions = [{ library: "sound\\SuperSound.dll", symbol: "SS_LoadSound", argumentCount: 2,
    argumentTypes: [{ identifier: "ty_string" }, { identifier: "ty_string" }], returnType: { identifier: "ty_string" } }];
  assert.deepEqual(OpenGMK.validateReport(value).unsupportedLibraries, []);
  value.externalDefinitions[0].argumentTypes[1] = { identifier: "ty_real" };
  assert.deepEqual(OpenGMK.validateReport(value).unsupportedLibraries, ["sound\\SuperSound.dll"]);
  value.nativeExtensionProfiles[0].functions[0].argumentCount = 1;
  assert.throws(() => OpenGMK.validateReport(value), /Invalid native Classic extension capabilities/);
});

test("Classic launch preparation reads the original executable in place and creates only writable data", t => {
  const root = temporary(t), source = path.join(root, "original"), userDataDir = path.join(root, "launcher");
  fs.mkdirSync(source); const gamePath = path.join(source, "Game.exe");
  fs.writeFileSync(gamePath, "original executable"); fs.writeFileSync(path.join(source, "settings.cfg"), "creator defaults");
  const entry = { gameId: "classic", moduleData: { dataPath: gamePath } };
  const prepared = Classic.prepareClassicGame(entry, { userDataDir });
  assert.equal(prepared.gamePath, fs.realpathSync(gamePath));
  assert.deepEqual(fs.readdirSync(prepared.gameRoot), []);
  assert.equal(fs.readFileSync(gamePath, "utf8"), "original executable");
  fs.writeFileSync(path.join(prepared.gameRoot, "settings.cfg"), "player settings");
  assert.equal(Classic.prepareClassicGame(entry, { userDataDir }).gameRoot, prepared.gameRoot);
  assert.equal(fs.readFileSync(path.join(source, "settings.cfg"), "utf8"), "creator defaults");
  assert.equal(fs.readFileSync(path.join(prepared.gameRoot, "settings.cfg"), "utf8"), "player settings");
});

test("private Classic game writes reject a symlinked launcher data directory", t => {
  const root = temporary(t), source = path.join(root, "original"), userDataDir = path.join(root, "launcher");
  fs.mkdirSync(source); fs.mkdirSync(userDataDir); const file = path.join(source, "Game.exe"); fs.writeFileSync(file, "bytes");
  fs.symlinkSync(source, path.join(userDataDir, "games"));
  assert.throws(() => Classic.prepareClassicGame({ gameId: "classic", moduleData: { dataPath: file } }, { userDataDir }), /symlink/);
});
