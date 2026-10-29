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

test("Classic game arguments use the emulator's game transport without becoming emulator options", async t => {
  const root = temporary(t), source = path.join(root, "source"), gamePath = path.join(source, "Game.exe");
  fs.mkdirSync(source); fs.writeFileSync(gamePath, "original game data");
  const entry = { gameId: "classic-arguments", moduleData: { dataPath: gamePath } };
  const context = { userDataDir: path.join(root, "data"), gameArguments: ["--windowed", "  A quoted game  ", "", "$(literal)", "first\nsecond"] };
  t.mock.method(OpenGMK, "preflight", async () => ({ parserAvailable: true, extensionCount: 0, externalDefinitionCount: 0, unsupportedLibraries: [] }));
  t.mock.method(Native, "launchLocalRuntime", options => options);
  const launch = await Classic.launchClassic(entry, context, { ready: true, version: "fixture", install: { executablePath: "/native/opengmk" } });
  assert.deepEqual(launch.args.slice(0, 6), [fs.realpathSync(gamePath), "--strict", "--singlethread", "--realtime", "--working-directory", launch.cwd]);
  assert.deepEqual(launch.args.slice(6), context.gameArguments.map(argument => `--game-arg=${argument}`));
  assert.equal(fs.readFileSync(gamePath, "utf8"), "original game data");
});

test("Classic and Studio select separate module runtimes without crossing formats", () => {
  const supported = Module.manifest.runtime.supported;
  assert.deepEqual(Module.filterRuntimeSupport({ moduleData: { executionKind: "classic" } }, supported), ["opengmk", "inspection"]);
  assert.equal(Module.canLaunchRuntime("opengmk", { moduleData: { executionKind: "studio-vm" } }), false);
  assert.equal(Module.normalizeRuntimeId("opengmk"), "opengmk");
  assert.equal(Module.manifest.runtime.managerUi.opengmk.sectionLabel, "Classic (OpenGMK)");
  assert.equal(Module.manifest.runtime.entries.inspection.launch, false);
  assert.equal(Module.canLaunchRuntime("inspection", { moduleData: { executionKind: "classic" } }), true);
});

test("OpenGMK discovers exact upstream release source without seeding a Mac package", async () => {
  const revision="a".repeat(40),sourceUrl="https://github.com/OpenGMK/OpenGMK/releases/tag/v3.2.1";
  const row=await OpenGMK.mapRelease({tag_name:"v3.2.1",published_at:"2026-10-01T01:00:00Z"},{resolveRevision:async()=>revision,sourceUrl});
  assert.equal(row.version,"3.2.1");assert.equal(row.upstreamRevision,revision);assert.equal(row.sourceUrl,sourceUrl);
  assert.equal(row.asset,undefined);assert.equal(row.localBuild,false);assert.match(row.installReason,/Windows binaries/);
  assert.equal(OpenGMK.parserRuntime({version:row.version}),null);
});
test("Mac builds use selected installed receipts without launcher historical tables", () => {
  assert.deepEqual(OpenGMK.manager.core.catalog,[]);
  const install={version:"3.1.0-macos",upstreamRevision:"b".repeat(40)};
  assert.equal(OpenGMK.parserRuntime({version:install.version,install}),install);
  assert.equal(OpenGMK.manager.distributionRequired,false);
  assert.equal(OpenGMK.parserRuntime({version:"3.2.0-macos"}),null);
  assert.equal(OpenGMK.parserRuntime({version:null}),null);
});
test("an explicit existing Mac installation remains selected and sole verified installs remain usable", { skip: process.platform !== "darwin" }, t => {
  const root = temporary(t), version = "3.1.0-macos";
  const pin = {version,upstreamRevision:"b".repeat(40),minimumMacOS:"13.0",backend:"appkit"};
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
  assert.equal(automatic.version, version);
  assert.equal(automatic.install?.runtimePath, executable, "The sole compatible verified installation remains usable");
  assert.equal(OpenGMK.manager.getState({ userDataDir: root }).defaultVersion, null);
  assert.equal(fs.readdirSync(path.join(root, "runtimes/opengmk")).length, 1, "No other version was installed");
  bytes[63] = 1; fs.writeFileSync(executable, bytes);
  const changed = OpenGMK.manager.resolveSelection({ runtimeData: { opengmk: { version } } }, {}, root);
  assert.equal(changed.version, version); assert.equal(changed.ready, false);
  assert.equal(OpenGMK.parserRuntime(changed), null);
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
  assert.equal(inspected.compatibility, "format-candidate");
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
