const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const KiriDetect = require("../src/modules/kirikiri/detect");
const AliceDetect = require("../src/modules/alicesoft/detect");
const Kiri = require("../src/modules/kirikiri/main");
const Alice = require("../src/modules/alicesoft/main");
const AliceVersion = require("../src/modules/alicesoft/version");
const Bundle = require("../src/modules/shared/runtime/bundled-native");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-vn-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
function context(inputPath) {
  const stat = fs.statSync(inputPath);
  return { inputPath, rootDir: stat.isDirectory() ? inputPath : path.dirname(inputPath), stat, isAppBundle: inputPath.endsWith(".app") };
}
function chunk(type, data) {
  const header = Buffer.alloc(12); header.write(type, 0); header.writeBigUInt64LE(BigInt(data.length), 4);
  return Buffer.concat([header, data]);
}
function xp3(names, { compressed = false, protectedEntry = false } = {}) {
  const index = Buffer.concat(names.map(name => {
    const encoded = Buffer.from(name, "utf16le"); const info = Buffer.alloc(22);
    info.writeUInt32LE(protectedEntry ? 0x80000000 : 0, 0); info.writeUInt16LE(name.length, 20);
    return chunk("File", chunk("info", Buffer.concat([info, encoded])));
  }));
  const stored = compressed ? zlib.deflateSync(index) : index;
  const header = Buffer.alloc(19); KiriDetect.XP3_MAGIC.copy(header); header.writeBigUInt64LE(19n, 11);
  const block = Buffer.alloc(compressed ? 17 : 9); block[0] = Number(compressed);
  block.writeBigUInt64LE(BigInt(stored.length), 1); if (compressed) block.writeBigUInt64LE(BigInt(index.length), 9);
  return Buffer.concat([header, block, stored]);
}
function scenario(root, generation) {
  if (generation === "system4") {
    const program = Buffer.alloc(16); program.write("VERS"); program.writeUInt32LE(5, 4);
    const compressed = zlib.deflateSync(program), header = Buffer.alloc(16);
    header.write("AI2"); header.writeUInt32LE(program.length, 8); header.writeUInt32LE(compressed.length, 12);
    fs.writeFileSync(path.join(root, "Game.ain"), Buffer.concat([header, compressed]));
    fs.writeFileSync(path.join(root, "System40.ini"), 'CodeName = "Game.ain"\n'); return;
  }
  const data = Buffer.alloc(768);
  if (generation === "system35") {
    data.writeUIntLE(1, 0, 3); data.writeUIntLE(2, 3, 3);
    data[256] = 1; data.writeUInt16LE(1, 257); data.writeUInt32LE(32, 512); data.writeUInt32LE(4, 516); data.write("S380", 544);
    fs.writeFileSync(path.join(root, "ExampleSA.ALD"), data);
  } else {
    data.writeUInt16LE(2, 0); data.writeUInt16LE(3, 2);
    fs.writeFileSync(path.join(root, "ADISK.DAT"), data);
    fs.writeFileSync(path.join(root, "system3.ini"), "[config]\ngame = system3_generic\n");
  }
}
function nativeRuntime(root) {
  const data = Buffer.alloc(32); data.writeUInt32LE(0xfeedfacf, 0);
  data.writeUInt32LE(process.arch === "x64" ? 0x01000007 : 0x0100000c, 4); data.writeUInt32LE(2, 12);
  const file = path.join(root, "runtime"); fs.writeFileSync(file, data, { mode: 0o755 }); return file;
}

function fixtureVersion(manager, userDataDir, version, extra = {}) {
  return manager.core.rememberResolvedVersion({ userDataDir, entry: {
    version, upstreamRevision: "a".repeat(40), minimumMacOS: "13.0", localBuild: false, ...extra
  } });
}
function installedFontBundle(manager, userDataDir, sourceRoot) {
  const version = "fixture-" + manager.id + "-fonts", upstreamRevision = "a".repeat(40);
  const installDir = manager.core.getInstallDir({ userDataDir, version });
  const projectRoot = path.join(installDir, "project-payload"), payload = path.join(projectRoot, "files");
  const data = {
    "bin/runner": fs.readFileSync(nativeRuntime(sourceRoot)),
    "fonts/gothic.ttf": Buffer.from("gothic fixture"), "fonts/mincho.ttf": Buffer.from("mincho fixture"),
    "licenses/LICENSE": Buffer.from("fixture license notice")
  };
  const files = Object.entries(data).map(([name, bytes]) => {
    const mode = name === "bin/runner" ? 0o755 : 0o644;
    const file = path.join(payload, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes, { mode });
    return { path: name, size: bytes.length, sha256: Bundle.digest(bytes), mode,
      ...(name === "bin/runner" ? { architectures: [process.arch === "x64" ? "x86_64" : "arm64"] } : {}) };
  });
  const manifest = { schemaVersion: 1, managerId: manager.id, version, upstreamRevision,
    platform: "darwin", arch: process.arch, minimumMacOS: "13.0", executableRelative: "bin/runner", files,
    provenance: { sourceRevision: upstreamRevision }, dependencies: [{ file: "bin/runner", links: ["/usr/lib/libSystem.B.dylib"] }],
    notices: [{ name: "Fixture", license: "MIT", sourceUrl: "https://example.test/fixture", path: "licenses/LICENSE" }],
    runtimeFiles: { fontGothic: "fonts/gothic.ttf", fontMincho: "fonts/mincho.ttf" } };
  const bytes = Buffer.from(JSON.stringify(manifest)), tag = manager.id + "/v" + version + "/" + process.arch;
  fs.writeFileSync(path.join(projectRoot, "manifest.json"), bytes);
  const filename = manager.id + "-" + version + "-" + process.arch + ".tar.gz";
  const projectPackage = { schemaVersion: 2, id: manager.id, version, arch: process.arch, launcherArchitectures: [process.arch],
    minimumMacOS: "13.0", manifestRelative: "manifest.json", manifestSha256: Bundle.digest(bytes),
    sourceSha256: Bundle.digest(Buffer.from("fixture source profile")), updatePolicy: "manual", tag,
    source: { repository: "example/fixture", revision: upstreamRevision },
    asset: { filename, bytes: 1, sha256: "b".repeat(64),
      url: "https://github.com/procrastinine/maclauncher-builds/releases/download/" + encodeURIComponent(tag) + "/" + filename } };
  const pin = fixtureVersion(manager, userDataDir, version, { projectPackage, asset: projectPackage.asset });
  fs.writeFileSync(path.join(installDir, "runtime.json"), JSON.stringify({ source: "download", version,
    upstreamRevision, catalogEntry: pin, archiveSha256: projectPackage.asset.sha256,
    executableRelative: "project-payload/files/bin/runner", binarySha256: files[0].sha256 }));
  assert.ok(manager.core.resolveInstalled({ userDataDir, version }));
  return { version, gothic: path.join(payload, "fonts/gothic.ttf"), mincho: path.join(payload, "fonts/mincho.ttf") };
}

test("KiriKiri detects source projects, app data and runnable compressed/uncompressed XP3", t => {
  const root = fixture(t); fs.writeFileSync(path.join(root, "startup.tjs"), "Debug.message('test');");
  assert.equal(Kiri.detectGame(context(root)).moduleData.sourceKind, "project");
  fs.writeFileSync(path.join(root, "unrelated.txt"), "x");
  assert.equal(Kiri.detectGame(context(path.join(root, "unrelated.txt"))), null);
  const app = path.join(root, "Example.app"); const data = path.join(app, "Contents", "Resources", "game");
  fs.mkdirSync(data, { recursive: true }); fs.writeFileSync(path.join(data, "startup.tjs"), "x");
  assert.equal(Kiri.detectGame(context(app)).contentRootDir, data);
  fs.rmSync(path.join(root, "startup.tjs"));
  const archive = path.join(root, "data.xp3");
  for (const compressed of [false, true]) {
    fs.writeFileSync(archive, xp3(["startup.tjs", "scenario/start.ks"], { compressed }));
    assert.equal(Kiri.detectGame(context(archive)).moduleData.launchTarget, archive);
    assert.equal(Kiri.detectGame(context(root)).moduleData.sourceKind, "xp3");
  }
});

test("KiriKiri identifies declared KAG/TJS versions and leaves archive host generation unknown", t => {
  const root = fixture(t); fs.writeFileSync(path.join(root, "startup.tjs"), "Scripts.execStorage('system/Initialize.tjs');");
  fs.mkdirSync(path.join(root, "system"));
  const init = path.join(root, "system", "Initialize.tjs");
  fs.writeFileSync(init, '\ufeffvar kagVersion = "3.32 stable rev. 2";');
  let found = Kiri.detectGame(context(root)).moduleData;
  assert.equal(found.detectedVersion, "KAG 3.32 stable rev. 2"); assert.equal(found.detectedVersionConfidence, "declared");
  assert.match(found.engineGeneration, /host generation unknown/);
  fs.writeFileSync(init, '// var kagVersion = "2.30";\n/* var kagVersion = "2.32"; */');
  assert.equal(Kiri.detectGame(context(root)).moduleData.detectedVersion, "unknown");
  fs.writeFileSync(init, '\ufeffvar kagVersion = "2.30";');
  assert.equal(Kiri.detectGame(context(root)).moduleData.kagVersion, "2.30");
  fs.writeFileSync(init, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('var tjsVersion = "1";', "utf16le")]));
  assert.equal(Kiri.detectGame(context(root)).moduleData.tjsVersion, "1");
  const archive = path.join(root, "data.xp3"); fs.writeFileSync(archive, xp3(["startup.tjs", "system/Initialize.tjs"]));
  found = Kiri.detectGame(context(archive)).moduleData;
  assert.equal(found.detectedVersion, "unknown"); assert.equal(found.detectedVersionConfidence, "unknown");
});

test("KiriKiri rejects asset-only, malformed, huge and chained XP3 indexes", t => {
  const root = fixture(t); const archive = path.join(root, "data.xp3");
  for (const data of [xp3(["background.png"]), Buffer.alloc(100), xp3(["nested/startup.tjs"])]) {
    fs.writeFileSync(archive, data); assert.equal(Kiri.detectGame(context(archive)), null);
  }
  const malformed = xp3(["startup.tjs"]);
  malformed.writeBigUInt64LE(2n ** 63n, 11);
  fs.writeFileSync(archive, malformed); assert.equal(KiriDetect.readXp3Index(archive), null);
  const chained = xp3(["startup.tjs"]); chained[19] = 0x80;
  fs.writeFileSync(archive, chained); assert.equal(KiriDetect.readXp3Index(archive), null);
  const oversized = xp3(["startup.tjs"], { compressed: true }); oversized.writeBigUInt64LE(32n * 1024n * 1024n, 28);
  fs.writeFileSync(archive, oversized); assert.equal(KiriDetect.readXp3Index(archive), null);
});

test("known legacy KAG saves beside the runtime are refused without rewriting scripts", async t => {
  const root = fixture(t); fs.writeFileSync(path.join(root, "startup.tjs"), "Scripts.execStorage('system/Initialize.tjs');");
  fs.mkdirSync(path.join(root, "system"));
  fs.writeFileSync(path.join(root, "system/MainWindow.tjs"), "if(saveDataLocation.indexOf(':') == -1) saveDataLocation = System.exePath + saveDataLocation;");
  const config = path.join(root, "Config.tjs"), source = 'function KAGWindow_config(){ saveDataLocation = "savedata"; }';
  fs.writeFileSync(config, source);
  const entry = Kiri.detectGame(context(root));
  assert.equal(entry.moduleData.unsafeRuntimeSavePath, true);
  await assert.rejects(Kiri.launchRuntime("krkrsdl2", entry, { spawnDetachedChecked: () => assert.fail("unsafe legacy saves must be refused before spawn") }), /saveDataLocation.*runtime/);
  assert.equal(fs.readFileSync(config, "utf8"), source);
  fs.writeFileSync(config, 'function KAGWindow_config(){ saveDataLocation = System.dataPath; }');
  assert.equal(Kiri.detectGame(context(root)).moduleData.unsafeRuntimeSavePath, false);
  assert.match(Kiri.detectGame(context(root)).moduleData.kagSaveRouting, /System.dataPath/);
  fs.writeFileSync(config, '// saveDataLocation = "savedata";\n');
  assert.equal(Kiri.detectGame(context(root)).moduleData.unsafeRuntimeSavePath, false);
});

test("AliceSoft distinguishes legacy generations and excludes malformed System4 and invalid filename matches", t => {
  const root = fixture(t); scenario(root, "system3");
  assert.equal(Alice.detectGame(context(root)).moduleData.generation, "system3");
  assert.deepEqual(Alice.filterRuntimeSupport(Alice.detectGame(context(root))), ["system3"]);
  fs.rmSync(path.join(root, "ADISK.DAT")); scenario(root, "system35");
  const detected = Alice.detectGame(context(path.join(root, "ExampleSA.ALD")));
  assert.equal(detected.moduleData.generation, "system35");
  assert.deepEqual(Alice.filterRuntimeSupport(detected), ["xsystem35"]);
  fs.writeFileSync(path.join(root, "System40.ini"), "x");
  assert.equal(Alice.detectGame(context(root)), null);
  fs.rmSync(path.join(root, "System40.ini")); fs.writeFileSync(path.join(root, "ExampleSA.ALD"), "invalid");
  assert.equal(Alice.detectGame(context(root)), null);
  const app = path.join(root, "Example.app"); const resources = path.join(app, "Contents", "Resources");
  fs.mkdirSync(resources, { recursive: true }); scenario(resources, "system35");
  assert.equal(Alice.detectGame(context(app)).contentRootDir, resources);
});

test("System4 detection checks AIN headers, separates format version, and confines configured program paths", t => {
  const root = fixture(t); scenario(root, "system4");
  let found = Alice.detectGame(context(root));
  assert.equal(found.moduleData.generation, "system4");
  assert.equal(found.moduleData.ainVersion, 5);
  assert.match(found.moduleData.detectedVersion, /engine build unknown/);
  assert.deepEqual(Alice.filterRuntimeSupport(found), ["xsystem4"]);
  const encrypted = Buffer.alloc(16); Buffer.from("VERS").copy(encrypted); encrypted.writeUInt32LE(6, 4);
  const xor = Buffer.from("28b050e9d6cf935b", "hex"); for (let i = 0; i < 8; i++) encrypted[i] ^= xor[i];
  fs.writeFileSync(path.join(root, "Game.ain"), encrypted);
  assert.equal(Alice.detectGame(context(root)).moduleData.ainVersion, 6);
  fs.writeFileSync(path.join(root, "Game.ain"), "AINI legacy System39");
  assert.equal(Alice.detectGame(context(root)), null);
  scenario(root, "system4");
  fs.writeFileSync(path.join(root, "System40.ini"), 'CodeName = "../outside.ain"\n');
  assert.equal(Alice.detectGame(context(root)), null);
  fs.writeFileSync(path.join(root, "System40.ini"), 'CodeName = "C:\\Game.ain"\n');
  assert.equal(Alice.detectGame(context(root)), null);
  fs.writeFileSync(path.join(root, "System40.ini"), 'CodeName = "Escape.ain"\n');
  const outside = path.join(fixture(t), "outside.ain"); fs.copyFileSync(path.join(root, "Game.ain"), outside);
  fs.symlinkSync(outside, path.join(root, "Escape.ain"));
  assert.equal(Alice.detectGame(context(root)), null);
});

test("AliceSoft versions use actual scenario tags, recognized game IDs and pinned fingerprints", t => {
  const root = fixture(t); scenario(root, "system3");
  let data = Alice.detectGame(context(root)).moduleData;
  assert.equal(data.detectedVersion, "System 3"); assert.equal(data.detectedVersionConfidence, "declared");
  fs.writeFileSync(path.join(root, "system3.ini"), "[string]\ngame = system2_generic\n");
  assert.equal(Alice.detectGame(context(root)).moduleData.detectedVersionConfidence, "unknown");
  fs.writeFileSync(path.join(root, "system3.ini"), "game = unknown_game\n");
  data = Alice.detectGame(context(root)).moduleData;
  assert.equal(data.detectedVersion, "unknown (System 1–3)");
  assert.equal(AliceVersion.crc32(Buffer.from("123456789")), 0xcbf43926);
  assert.equal(AliceVersion.identifySystem3(0x2fffbd60, 0).detectedVersion, "System 1");
  assert.equal(AliceVersion.identifySystem3(0x47a399a1, 0).detectedVersion, "System 2");
  assert.equal(AliceVersion.identifySystem3(0xe27dd441, 0).detectedVersion, "System 3");
  assert.equal(AliceVersion.identifySystem3(0xab4cda48, 0).detectedVersionConfidence, "unknown");
  assert.equal(AliceVersion.identifySystem3(0xab4cda48, 0xe405d57c).detectedGameId, "dps_sg_fahren");
  fs.rmSync(path.join(root, "ADISK.DAT")); scenario(root, "system35");
  data = Alice.detectGame(context(root)).moduleData;
  assert.equal(data.scenarioFormat, "S380"); assert.equal(data.detectedVersion, "System 3.8–3.9");
  const ain = Buffer.alloc(8); ain.write("AINI"); ain.writeUInt32LE(1, 4); fs.writeFileSync(path.join(root, "System39.ain"), ain);
  data = Alice.detectGame(context(root)).moduleData;
  assert.equal(data.detectedVersion, "System 3.9"); assert.equal(data.detectedVersionConfidence, "high");
  fs.writeFileSync(path.join(root, "System39.ain"), "fake");
  assert.equal(Alice.detectGame(context(root)).moduleData.detectedVersion, "System 3.8–3.9");
  for (const [tag, version] of [["S350", "System 3.5–3.9"], ["S351", "System 3.5–3.9"], ["153S", "System 3.5–3.9"], ["S360", "System 3.6–3.9"], ["S380", "System 3.8–3.9"]]) {
    const file = path.join(root, "ExampleSA.ALD"), bytes = fs.readFileSync(file); bytes.write(tag, 544); fs.writeFileSync(file, bytes);
    const badAin = Buffer.alloc(8); badAin.write("AINI"); badAin.writeUInt32LE(99, 4); fs.writeFileSync(path.join(root, "System39.ain"), badAin);
    data = Alice.detectGame(context(root)).moduleData;
    assert.equal(data.scenarioFormat, tag); assert.equal(data.detectedVersion, version);
    assert.equal(data.detectedVersionConfidence, "family");
    badAin.write("AIN?"); badAin.writeUInt32LE(1, 4); fs.writeFileSync(path.join(root, "System39.ain"), badAin);
    assert.equal(Alice.detectGame(context(root)).moduleData.detectedVersion, version);
  }
});

test("native VN modules repair incomplete registrations and launch explicit versions with isolated saves without Electron", { skip: process.platform !== "darwin" }, async t => {
  const root = fixture(t); const runtimePath = nativeRuntime(root); const userDataDir = path.join(root, "userdata");
  for (const [mod, generation, runtimeId, version] of [[Kiri, "kirikiri", "krkrsdl2", "snapshot-124bdf8"], [Alice, "system3", "system3", "1.8.0"], [Alice, "system35", "xsystem35", "2.20.0"]]) {
    const game = path.join(root, generation); fs.mkdirSync(game);
    if (generation === "kirikiri") fs.writeFileSync(path.join(game, "startup.tjs"), "Debug.message('test');"); else scenario(game, generation);
    const entry = { ...mod.detectGame(context(game)), moduleId: mod.id, gameId: generation, runtimeId };
    const manager = mod.runtimeManagers.find(item => item.id === runtimeId);
    fixtureVersion(manager, userDataDir, version);
    // An incomplete owned installation must not silently resolve to an included
    // runtime. Registering a local executable completes this real missing case.
    fs.mkdirSync(manager.core.getInstallDir({ userDataDir, version }), { recursive: true });
    const calls = [];
    const ctx = { userDataDir, settings: {}, runtimeSettings: { runtimePath, version, textHook: "copy", fullscreen: true },
      spawnDetachedChecked: (...input) => { calls.push(input); return "process"; } };
    assert.equal(mod.actions.runtimeStatus(entry, {}, ctx).ready, false);
    await assert.rejects(() => mod.launchRuntime(runtimeId, entry, ctx), /not installed/);
    const registered = await mod.actions.registerRuntime(entry, {}, ctx);
    assert.equal(registered.version, version); assert.match(registered.sha256, /^[a-f0-9]{64}$/);
    assert.equal(mod.actions.runtimeStatus(entry, {}, ctx).ready, true);
    assert.equal(await mod.launchRuntime(runtimeId, entry, ctx), "process");
    assert.equal(calls[0][0], runtimePath); assert.equal(calls[0][2].cwd, game);
    assert.ok(entry.defaultSaveDir.startsWith(path.join(userDataDir, "games", generation)));
    assert.ok(fs.statSync(entry.defaultSaveDir).isDirectory());
    assert.ok(calls[0][1].some(arg => arg.includes(entry.defaultSaveDir)));
    if (generation === "kirikiri") assert.ok(calls[0][1].includes(`-datapath=${entry.defaultSaveDir}${path.sep}`));
    assert.equal(fs.existsSync(path.join(game, "saves")), false);
    if (generation !== "kirikiri") {
      assert.ok(calls[0][1].includes("-texthook")); assert.ok(calls[0][1].includes("-fullscreen"));
      await assert.rejects(() => mod.launchRuntime(runtimeId === "system3" ? "xsystem35" : "system3", entry, ctx), /generation/);
    }
    const portable = path.join(root, `portable-${generation}`);
    entry.saveDirOverride = portable;
    await mod.launchRuntime(runtimeId, entry, ctx);
    assert.ok(fs.statSync(portable).isDirectory());
    const actualArgs = calls.at(-1)[1];
    assert.ok(actualArgs.includes(generation === "kirikiri" ? `-datapath=${portable}${path.sep}` : portable));
    assert.ok(entry.defaultSaveDir.startsWith(path.join(userDataDir, "games", generation)));
    entry.saveDirOverride = "relative/save";
    await assert.rejects(() => mod.launchRuntime(runtimeId, entry, ctx), /absolute/);
    delete entry.saveDirOverride;
    fs.appendFileSync(runtimePath, "changed");
    assert.equal(mod.actions.runtimeStatus(entry, {}, ctx).ready, false);
    await assert.rejects(() => mod.launchRuntime(runtimeId, entry, ctx), /not installed|changed/);
    fs.truncateSync(runtimePath, 32);
  }
});

test("Register Runtime uses injected file dialog and cancels cleanly", { skip: process.platform !== "darwin" }, async t => {
  const root = fixture(t), runtimePath = nativeRuntime(root), userDataDir = path.join(root, "userdata"), version = "fixture-kirikiri-registration";
  fixtureVersion(Kiri.runtimeManagers[0], userDataDir, version);
  const entry = { gameId: "example", runtimeData: { krkrsdl2: { version } } };
  const ctx = { userDataDir, settings: {}, runtimeSettings: {},
    ui: { dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) } } };
  assert.deepEqual(await Kiri.actions.registerRuntime(entry, {}, ctx), { canceled: true });
  ctx.ui.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [runtimePath] });
  assert.equal((await Kiri.actions.registerRuntime(entry, {}, ctx)).ready, true);
  await assert.rejects(() => Kiri.actions.registerRuntime(entry, { version: "latest", runtimePath }, ctx), /Unsupported/);
});

test("AliceSoft registration resolves automatic tool versions from the current runtime selection", { skip: process.platform !== "darwin" }, async t => {
  const root = fixture(t), runtimePath = nativeRuntime(root), userDataDir = path.join(root, "userdata");
  for (const [generation, runtimeId, version] of [["system3", "system3", "1.8.0"], ["system35", "xsystem35", "2.20.0"], ["system4", "xsystem4", "snapshot-04333ad-macos-v1"]]) {
    fixtureVersion(Alice.runtimeManagers.find(item => item.id === runtimeId), userDataDir, version);
    const entry = { gameId: generation, moduleData: { generation }, runtimeData: { [runtimeId]: { version } } };
    const result = await Alice.actions.registerRuntime(entry, {}, { userDataDir, settings: {}, runtimeSettings: { version: "auto", runtimePath } });
    assert.equal(result.version, version);
    assert.equal(Alice.manifest.runtime.entries[runtimeId].settings.defaults.version, "auto");
    assert.equal(Alice.actions.runtimeStatus(entry, {}, { userDataDir, settings: {} }).version, version);
  }
});

test("AliceSoft managed launches use verified default fonts and retain explicit font overrides", { skip: process.platform !== "darwin" }, async t => {
  const root = fixture(t), userDataDir = path.join(root, "userdata"), customFont = path.join(root, "custom.ttf");
  fs.writeFileSync(customFont, "user selected font");
  for (const [generation, runtimeId] of [["system3", "system3"], ["system35", "xsystem35"], ["system4", "xsystem4"]]) {
    const manager = Alice.runtimeManagers.find(item => item.id === runtimeId);
    const fonts = installedFontBundle(manager, userDataDir, root);
    const game = path.join(root, generation); fs.mkdirSync(game); scenario(game, generation);
    const entry = { ...Alice.detectGame(context(game)), gameId: generation, runtimeId, runtimeData: { [runtimeId]: { version: fonts.version } }, saveDirOverride: path.join(root, "custom-saves", generation) };
    const calls = [], ctx = { userDataDir, settings: {}, runtimeSettings: {}, spawnDetachedChecked: (...args) => calls.push(args) };
    await Alice.launchRuntime(runtimeId, entry, ctx);
    const fontFlag = runtimeId === "system3" ? "-fontfile" : runtimeId === "xsystem35" ? "-ttfont_gothic" : "--font-gothic";
    assert.equal(calls[0][1][calls[0][1].indexOf(fontFlag) + 1], fonts.gothic);
    if (runtimeId === "xsystem35") assert.equal(calls[0][1][calls[0][1].indexOf("-ttfont_mincho") + 1], fonts.mincho);
    if (runtimeId === "xsystem4") {
      assert.equal(calls[0][1][calls[0][1].indexOf("--font-mincho") + 1], fonts.mincho);
      assert.equal(calls[0][1][calls[0][1].indexOf("--save-folder") + 1], entry.saveDirOverride);
      assert.equal(calls[0][1].at(-1), path.join(game, "System40.ini"));
      await assert.rejects(Alice.launchRuntime("xsystem35", entry, ctx), /requires xsystem4/);
    }
    ctx.runtimeSettings.fontPath = customFont;
    await Alice.launchRuntime(runtimeId, entry, ctx);
    assert.equal(calls[1][1][calls[1][1].indexOf(fontFlag) + 1], customFont);
    if (runtimeId === "xsystem35") assert.equal(calls[1][1][calls[1][1].indexOf("-ttfont_mincho") + 1], customFont);
    fs.writeFileSync(fonts.gothic, "changed managed asset");
    ctx.runtimeSettings = {};
    await assert.rejects(Alice.launchRuntime(runtimeId, entry, ctx), /not installed|changed/);
    assert.equal(calls.length, 2);
  }
});

test("protected XP3 games refuse native launch before any process starts", async t => {
  const root = fixture(t); const archive = path.join(root, "data.xp3");
  fs.writeFileSync(archive, xp3(["startup.tjs"], { protectedEntry: true }));
  const entry = Kiri.detectGame(context(archive)); assert.equal(entry.moduleData.protectedEntries, 1);
  await assert.rejects(() => Kiri.launchRuntime("krkrsdl2", entry, { spawnDetachedChecked: () => assert.fail("spawned") }), /Protected XP3/);
});
