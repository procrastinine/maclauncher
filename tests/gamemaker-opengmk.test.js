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
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "opengmk-tests-")));
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
  assert.deepEqual(launch.args.slice(0, 4), [fs.realpathSync(gamePath), "--strict", "--singlethread", "--realtime"]);
  assert.deepEqual(launch.args.slice(4), context.gameArguments.map(argument => `--game-arg=${argument}`));
  assert.equal(launch.cwd, source);
  assert.equal(launch.args.includes("--working-directory"), false);
  assert.equal(fs.existsSync(context.userDataDir), false);
  assert.equal(entry.defaultSaveDir, source);
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
  assert.equal(OpenGMK.manager.getState({ userDataDir: root }).defaultVersion, version);
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

test("Classic preparation uses original paths and game writes survive deletion of launcher data", t => {
  const root = temporary(t), source = path.join(root, "original"), userDataDir = path.join(root, "launcher");
  fs.mkdirSync(source); const gamePath = path.join(source, "Game.exe");
  fs.writeFileSync(gamePath, "original executable"); fs.writeFileSync(path.join(source, "settings.cfg"), "creator defaults");
  const entry = { gameId: "classic", moduleData: { dataPath: gamePath } };
  const prepared = Classic.prepareClassicGame(entry, { userDataDir });
  assert.equal(prepared.gamePath, fs.realpathSync(gamePath));
  assert.equal(prepared.gameRoot, source);
  assert.equal(fs.existsSync(userDataDir), false, "ordinary preparation creates no private folder or receipt");
  assert.equal(fs.readFileSync(gamePath, "utf8"), "original executable");
  fs.writeFileSync(path.join(prepared.gameRoot, "settings.cfg"), "player settings");
  assert.equal(Classic.prepareClassicGame(entry, { userDataDir }).gameRoot, prepared.gameRoot);
  fs.mkdirSync(userDataDir); fs.writeFileSync(path.join(userDataDir, "profile-marker"), "launcher state");
  fs.rmSync(userDataDir, { recursive: true });
  assert.equal(fs.readFileSync(path.join(source, "settings.cfg"), "utf8"), "player settings");
  assert.equal(fs.readFileSync(path.join(prepared.gameRoot, "settings.cfg"), "utf8"), "player settings");
});

test("Classic default paths do not traverse launcher data links", t => {
  const root = temporary(t), source = path.join(root, "original"), userDataDir = path.join(root, "launcher");
  fs.mkdirSync(source); fs.mkdirSync(userDataDir); const file = path.join(source, "Game.exe"); fs.writeFileSync(file, "bytes");
  fs.symlinkSync(source, path.join(userDataDir, "games"));
  assert.equal(Classic.prepareClassicGame({ gameId: "classic", moduleData: { dataPath: file } }, { userDataDir }).gameRoot, source);
  assert.equal(fs.readlinkSync(path.join(userDataDir, "games")), source);
  assert.deepEqual(fs.readdirSync(source), ["Game.exe"]);
});

test("Classic explicit writable overrides preserve the original executable and cwd", async t => {
  const root = temporary(t), source = path.join(root, "original"), override = path.join(root, "chosen-saves");
  fs.mkdirSync(source); const gamePath = path.join(source, "Game.exe"); fs.writeFileSync(gamePath, "original executable");
  const entry = { gameId: "classic-override", moduleData: { dataPath: gamePath }, saveDirOverride: override };
  const context = { userDataDir: path.join(root, "launcher") };
  t.mock.method(OpenGMK, "preflight", async () => ({ parserAvailable: true, extensionCount: 0, externalDefinitionCount: 0, unsupportedLibraries: [] }));
  t.mock.method(Native, "launchLocalRuntime", options => options);
  const launch = await Classic.launchClassic(entry, context, { ready: true, version: "fixture", install: { executablePath: "/native/opengmk" } });
  assert.deepEqual(launch.args, [fs.realpathSync(gamePath), "--strict", "--singlethread", "--realtime", "--working-directory", override]);
  assert.equal(launch.cwd, source);
  assert.equal(entry.defaultSaveDir, source);
  assert.equal(fs.statSync(override).isDirectory(), true);
  assert.equal(fs.existsSync(context.userDataDir), false);
  entry.saveDirOverride = "relative";
  assert.throws(() => Classic.prepareClassicGame(entry, context), /absolute/);
});

test("Classic preflight is consumed once and rechecks changed game or runtime identity", async t => {
  const root = temporary(t), gamePath = path.join(root, "Game.exe"); fs.writeFileSync(gamePath, "original executable");
  const entry = { gameId: "prepared", moduleData: { dataPath: gamePath } }, context = { userDataDir: path.join(root, "launcher") };
  const selection = { ready: true, version: "fixture", install: { executablePath: "/native/opengmk", binarySha256: "a".repeat(64) } };
  let parses = 0;
  t.mock.method(OpenGMK, "preflight", async file => { parses++; return { parserAvailable: true,
    sourceSha256: Native.hashFile(file), extensionCount: 0, externalDefinitionCount: 0, unsupportedLibraries: [] }; });
  t.mock.method(Native, "launchLocalRuntime", options => options);
  await Classic.prepareLaunch(entry, context, selection);
  await Classic.launchClassic(entry, context, selection);
  assert.equal(parses, 1, "the same preparation uses one asset parse");
  await Classic.launchClassic(entry, context, selection);
  assert.equal(parses, 2, "preflight results are not a persistent launch cache");
  await Classic.prepareLaunch(entry, context, selection);
  fs.appendFileSync(gamePath, "changed data");
  await Classic.launchClassic(entry, context, selection);
  assert.equal(parses, 4, "changed source content is parsed again");
  await Classic.prepareLaunch(entry, context, selection);
  await Classic.launchClassic(entry, context, { ...selection, install: { ...selection.install, binarySha256: "b".repeat(64) } });
  assert.equal(parses, 6, "changed runtime identity is parsed again");
  await Classic.prepareLaunch(entry, context, selection);
  await Classic.launchClassic(entry, context, { ...selection, install: { ...selection.install, upstreamRevision: "changed-source" } });
  assert.equal(parses, 8, "changed runtime source pin is parsed again even for matching binary bytes");
  await Classic.prepareLaunch(entry, context, selection);
  await Classic.launchClassic(entry, context, { ...selection, install: { ...selection.install, executablePath: "/other/opengmk" } });
  assert.equal(parses, 10, "another installation is not the prepared selection");
  assert.equal(fs.existsSync(context.userDataDir), false);
});


test("managed Classic inspection accepts an additive report schema while checking the game API", () => {
  assert.equal(OpenGMK.validateReport({...report(),schemaVersion:99,extra:true},{managed:true}).version,"8.1");
  assert.throws(()=>OpenGMK.validateReport({...report(),schemaVersion:99}),/invalid Classic/);
  assert.throws(()=>OpenGMK.validateReport({...report(),assetsVerified:false},{managed:true}),/invalid Classic/);
});
