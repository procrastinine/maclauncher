const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const zlib = require("node:zlib");
const X = require("../src/modules/kirikiri/xp3");
const P = require("../src/modules/kirikiri/prepare");
const D = require("../src/modules/kirikiri/detect");
const Native = require("../src/modules/shared/runtime/local-native");
const Kiri = require("../src/modules/kirikiri/main");
const { signalUnavailableOptionalPlugins, requiredNativeFeatures } = require("../src/modules/kirikiri/script");

function fixture(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), "kiri-prepare-")); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return fs.realpathSync(root); }
function missingNativeRuntime(t) {
  const manager = Kiri.runtimeManagers.find(item => item.id === "krkrsdl2");
  const resolve = manager.resolveSelection.bind(manager);
  // These cases exercise download requests. Keep real version selection while
  // modeling a host without the optional native payload, regardless of packaging.
  t.mock.method(manager, "resolveSelection", (...args) => {
    const selected = resolve(...args);
    return { ...selected, install: null, ready: false, reason: "Native payload is unavailable in this fixture." };
  });
}
function chunk(tag, bytes) { const head = Buffer.alloc(12); head.write(tag, 0, "ascii"); head.writeBigUInt64LE(BigInt(bytes.length), 4); return Buffer.concat([head, bytes]); }
function archive(file, items, { fused = false, chain = false, protectedEntry = false, encryptProtected = false } = {}) {
  const prefix = fused ? Buffer.alloc(512, 0x4d) : Buffer.alloc(0), header = Buffer.alloc(19); X.MAGIC.copy(header);
  const start = chain ? 36 : 19, blobs = [], entries = []; let cursor = start;
  for (const [name, value] of items) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value), stored = encryptProtected ? bytes.map(byte => byte ^ 0xa5) : bytes,
      packed = zlib.deflateSync(stored), encoded = Buffer.from(name, "utf16le"), info = Buffer.alloc(22);
    info.writeUInt32LE(protectedEntry ? 0x80000000 : 0, 0); info.writeBigUInt64LE(BigInt(bytes.length), 4); info.writeBigUInt64LE(BigInt(packed.length), 12); info.writeUInt16LE(encoded.length / 2, 20);
    const segment = Buffer.alloc(28); segment.writeUInt32LE(1, 0); segment.writeBigUInt64LE(BigInt(cursor), 4); segment.writeBigUInt64LE(BigInt(bytes.length), 12); segment.writeBigUInt64LE(BigInt(packed.length), 20);
    const checksum = Buffer.alloc(4); checksum.writeUInt32LE(X.adler32(bytes));
    entries.push(chunk("File", Buffer.concat([chunk("info", Buffer.concat([info, encoded])), chunk("segm", segment), chunk("adlr", checksum)]))); blobs.push(packed); cursor += packed.length;
  }
  const index = Buffer.concat(entries), packedIndex = zlib.deflateSync(index), block = Buffer.alloc(17); block[0] = 1; block.writeBigUInt64LE(BigInt(packedIndex.length), 1); block.writeBigUInt64LE(BigInt(index.length), 9);
  header.writeBigUInt64LE(BigInt(chain ? 19 : cursor), 11);
  const pointer = Buffer.alloc(chain ? 17 : 0); if (chain) { pointer[0] = 0x80; pointer.writeBigUInt64LE(BigInt(cursor), 9); }
  fs.writeFileSync(file, Buffer.concat([prefix, header, pointer, ...blobs, block, packedIndex])); return file;
}
function project(root) {
  const game = path.join(root, "original"); fs.mkdirSync(game);
  const exe = archive(path.join(game, "game.exe"), [["startup.tjs", 'Scripts.execStorage("system/Initialize.tjs");'], ["system/Initialize.tjs", 'var kagVersion = "3.24 stable";'], ["Config.tjs", ';saveDataLocation = "savedata";'], ["bgimage/large.png", Buffer.alloc(512000, 0x61)]], { fused: true });
  archive(path.join(game, "patch.xp3"), [["Config.tjs", ';saveDataLocation = "patched-savedata";'], ["scenario/first.ks", Buffer.from([0x82, 0xa0, 10])]], { chain: true });
  const entry = { ...D.detectGame({ rootDir: game, inputPath: exe, stat: fs.statSync(exe) }), gameId: "original-game" };
  return { game, exe, entry, context: { userDataDir: path.join(root, "userdata") } };
}

test("optional unavailable Windows plugins use the publisher's existing catch without simulating its API", () => {
  const source = 'try { // Optional publisher service.\nPlugins.link("service.dll");\n} catch (err) { global.Service = void; }';
  const adapted = signalUnavailableOptionalPlugins(source);
  assert.match(adapted, /throw new Exception\("Windows plugin unavailable: service\.dll"\);/);
  assert.match(adapted, /catch \(err\) \{ global\.Service = void; \}/);
  for (const untouched of [
    'Plugins.link("required.dll");',
    'try { initialize(); Plugins.link("service.dll"); } catch (err) { fallback(); }',
    'var prose = \'try { Plugins.link("service.dll"); } catch\';',
    '// try { Plugins.link("service.dll"); } catch\nvar x=1;',
    'var pattern = /try { Plugins.link("service.dll"); } catch/;',
    'try { Plugins.link(path); } catch (err) { fallback(); }'
  ]) assert.equal(signalUnavailableOptionalPlugins(untouched), untouched);
});

test("version-aware native feature selection upgrades the automatic runtime while retaining explicit older choices", async t => {
  missingNativeRuntime(t);
  const root = fixture(t), file = archive(path.join(root, "data.xp3"), [["startup.tjs", 'Scripts.execStorage("Initialize.tjs");'],
    ["Initialize.tjs", 'var kagVersion="3.26";var list=Storages.dirlist("fonts/");System.addFont("real.ttf",true);']], { protectedEntry: true });
  const detected = D.detectGame({ rootDir: root, inputPath: file, stat: fs.statSync(file) });
  assert.deepEqual(detected.moduleData.requiredNativeFeatures, ["storage.dirlist", "system.addFont"]);
  assert.doesNotMatch(detected.moduleData.compatibility, /Unsupported XP3/);
  assert.deepEqual(requiredNativeFeatures('// Storages.dirlist("fake");\nvar prose="System.addFont(fake)";'), []);
  const entry = { ...detected, gameId: "native-api-game" };
  const context = { userDataDir: path.join(root, "userdata"), runtimeId: "krkrsdl2", runtimeSettings: { version: "auto" },
    settings: { runtimes: { krkrsdl2: { defaultVersion: "snapshot-124bdf8-macos-v2" } } } };
  assert.deepEqual(await Kiri.ensureRuntime(entry, context), { managerId: "krkrsdl2", version: "snapshot-124bdf8-macos-v3" });
  context.runtimeSettings.version = "snapshot-124bdf8-macos-v2";
  await assert.rejects(Kiri.ensureRuntime(entry, context), /lacks required native APIs.*snapshot-124bdf8-macos-v3/);
  assert.equal(fs.existsSync(context.userDataDir), false);
});

test("bounded XP3 reader supports fused executables and valid chained compressed patches", t => {
  const root = fixture(t), f = project(root), base = X.inspectArchive(f.exe), patch = X.inspectArchive(path.join(f.game, "patch.xp3"));
  assert.equal(base.base, 512); assert.equal(base.members.size, 4); assert.equal(patch.members.size, 2);
  assert.match(X.readScript(base, base.members.get("system/initialize.tjs")).toString(), /3.24/);
  assert.equal(f.entry.moduleData.archivePath, f.exe);
  assert.equal(f.entry.moduleData.kagVersion, "3.24 stable");
  assert.match(f.entry.moduleData.detectedVersionSource, /game\.exe!\/system\/Initialize\.tjs/);
  assert.equal(D.detectGame({ rootDir: f.game, inputPath: f.game, stat: fs.statSync(f.game) }).engine, "kirikiri");
});

test("an executable's asset-only embedded XP3 does not hide a sibling protected game archive", t => {
  const root = fixture(t), exe = archive(path.join(root, "host.exe"), [["plugin.dat", "asset"]], { fused: true });
  const game = archive(path.join(root, "data.xp3"), [["startup.tjs", "protected framework"]], { protectedEntry: true });
  const before = Native.hashFile(game);
  const result = D.detectGame({ rootDir: root, inputPath: exe, stat: fs.statSync(exe) });
  assert.equal(result.moduleData.archivePath, game);
  assert.equal(result.moduleData.protectedEntries, 1);
  assert.equal(result.moduleData.detectedVersion, "unknown");
  assert.equal(Native.hashFile(game), before);
  const asset = archive(path.join(root, "assets.xp3"), [["image.png", "asset"]]);
  assert.equal(D.detectGame({ rootDir: root, inputPath: asset, stat: fs.statSync(asset) }), null);
  const malformed = path.join(root, "malformed.xp3"); fs.writeFileSync(malformed, "not an archive");
  assert.equal(D.detectGame({ rootDir: root, inputPath: malformed, stat: fs.statSync(malformed) }), null);
});

test("protection flags on checksum-verified plain KAG3 scripts do not imply a cipher", t => {
  const root = fixture(t), original = path.join(root, "game"); fs.mkdirSync(original);
  const items = [["startup.tjs", 'Scripts.execStorage("system/Initialize.tjs");'], ["system/Initialize.tjs", 'var kagVersion = "3.26";'],
    ["system/Config.tjs", ';saveDataLocation = "savedata";'], ["scenario/first.ks", "Plain scenario"]];
  const file = archive(path.join(original, "data.xp3"), items, { protectedEntry: true });
  const before = Native.hashFile(file);
  const found = D.detectGame({ rootDir: original, inputPath: file, stat: fs.statSync(file) });
  assert.equal(found.moduleData.kagVersion, "3.26");
  assert.equal(found.moduleData.xp3ContentProfile, "verified-plain-v1");
  const prepared = P.prepareGame({ ...found, gameId: "plain-protected" }, { userDataDir: path.join(root, "userdata") });
  assert.equal(prepared.contentProfile, "verified-plain-v1");
  assert.equal(Native.hashFile(file), before);
  assert.match(fs.readFileSync(path.join(prepared.preparedRoot, "scenario/first.ks"), "utf8"), /Plain scenario/);
  const encrypted = archive(path.join(root, "encrypted.xp3"), items, { protectedEntry: true, encryptProtected: true });
  const encryptedArchive = X.inspectArchive(encrypted);
  assert.throws(() => X.readScript(encryptedArchive, encryptedArchive.members.get("startup.tjs"), { allowPlainProtected: true }), /plaintext checksum/);
  assert.equal(D.detectGame({ rootDir: root, inputPath: encrypted, stat: fs.statSync(encrypted) }).moduleData.xp3ContentProfile, null);
});

test("declared language archives select the publisher default or explicit argument without mixing scripts", t => {
  const root = fixture(t), original = path.join(root, "game"); fs.mkdirSync(original);
  const initialize = 'var kagVersion="3.26";\nvar language=System.getArgument("-language");\n' +
    'if (language == "japanese" || language == "jp") { language="jp"; } else { language="en"; }\n' +
    'var language_arc=System.exePath + "data_" + language + ".xp3";\nSystem.setArgument("-datapath", "publisher-save-path");';
  const file = archive(path.join(original, "data.xp3"), [["startup.tjs", 'Scripts.execStorage("system/Initialize.tjs");'],
    ["system/Initialize.tjs", initialize]], { protectedEntry: true });
  for (const language of ["en", "jp"]) archive(path.join(original, `data_${language}.xp3`), [
    ["scenario/first.ks", `${language} story`], ["system/Config.tjs", ';saveDataLocation="original-saves";']
  ], { protectedEntry: true });
  const found = D.detectGame({ rootDir: original, inputPath: file, stat: fs.statSync(file) });
  const entry = { ...found, gameId: "localized-game" }, userDataDir = path.join(root, "userdata");
  const first = P.prepareGame(entry, { userDataDir, runtimeSettings: { args: [] } });
  assert.equal(first.language.selected, "en");
  assert.equal(first.sourceArchives.length, 2);
  assert.match(fs.readFileSync(path.join(first.preparedRoot, "scenario/first.ks"), "utf8"), /en story/);
  assert.equal(fs.readlinkSync(path.join(first.preparedRoot, "first.ks")), "scenario/first.ks");
  const adapted = fs.readFileSync(path.join(first.preparedRoot, "system/Initialize.tjs"), "utf8");
  assert.match(adapted, /System\.exePath \+ "data_"/);
  assert.match(adapted, /System\.setArgument\("-datapath", "publisher-save-path"\)/);
  const startup = fs.readFileSync(path.join(first.preparedRoot, "startup.tjs"), "utf8");
  assert.ok(startup.includes(JSON.stringify(fs.realpathSync(original) + "/")));
  assert.match(startup, /name == "-datapath" \? host\.dataPath : value/);
  const second = P.prepareGame(entry, { userDataDir, runtimeSettings: { args: ["-language=japanese"] } });
  assert.equal(second.language.selected, "jp");
  assert.notEqual(second.preparedRoot, first.preparedRoot);
  assert.match(fs.readFileSync(path.join(second.preparedRoot, "scenario/first.ks"), "utf8"), /jp story/);
  assert.equal(P.prepareGame(entry, { userDataDir, runtimeSettings: { args: ["-language=japanese"] } }).cached, true);
});

test("host path preparation preserves literal text and quoted KAG expressions in original scripts", t => {
  const root = fixture(t), original = path.join(root, "original"); fs.mkdirSync(original);
  const init = 'var kagVersion="3.26";\n// System.exePath is described here.\nvar help="System.exePath";\nSystem.setArgument("-datapath","publisher");';
  const scene = '[eval exp="System.exePath"]\nThe text says System.exePath.\n';
  const file = archive(path.join(original, "data.xp3"), [["startup.tjs", 'Scripts.execStorage("Initialize.tjs");'], ["Initialize.tjs", init], ["first.ks", scene]]);
  const found = D.detectGame({ rootDir: original, inputPath: file, stat: fs.statSync(file) });
  const result = P.prepareGame({ ...found, gameId: "literal-source" }, { userDataDir: path.join(root, "userdata") });
  assert.equal(fs.readFileSync(path.join(result.preparedRoot, "Initialize.tjs"), "utf8"), "\ufeff" + init);
  assert.equal(fs.readFileSync(path.join(result.preparedRoot, "first.ks"), "utf8"), "\ufeff" + scene);
  assert.match(fs.readFileSync(path.join(result.preparedRoot, "startup.tjs"), "utf8"), /&global\.System\.exePath = &_MacLauncherExePath/);
});

test("automatic KAG3 preparation transcodes scripts, applies patch priority and references assets without copying", t => {
  const root = fixture(t), f = project(root), before = Native.hashFile(f.exe), result = P.prepareGame(f.entry, f.context);
  assert.equal(result.profile, "kag3-sdl2-v1"); assert.equal(result.cached, false);
  const first = fs.readFileSync(path.join(result.preparedRoot, "scenario/first.ks")); assert.ok(first.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))); assert.match(first.toString(), /あ/);
  assert.match(fs.readFileSync(path.join(result.preparedRoot, "Config.tjs"), "utf8"), /System.dataPath/);
  assert.equal(fs.existsSync(path.join(result.preparedRoot, "bgimage/large.png")), false);
  assert.match(fs.readFileSync(path.join(result.preparedRoot, "startup.tjs"), "utf8"), /game\.exe>bgimage\//);
  assert.equal(fs.lstatSync(path.join(result.preparedRoot, "system_polyfill")).isSymbolicLink(), true);
  assert.equal(Native.hashFile(f.exe), before);
  assert.equal(P.prepareGame(f.entry, f.context).cached, true);
});

test("archive preparation repairs the stock MessageLayer in the private overlay while preserving its source archive", t => {
  const root = fixture(t), f = project(root), patch = path.join(f.game, "patch.xp3");
  archive(patch, [["system/MessageLayer.tjs", 'class MessageLayer extends KAGLayer {\n var face;\n function clearLayer() {\n  face=dfProvince;\n  colorRect(0,0,640,480,0);\n  face=dfAuto;\n }\n}\n']]);
  const before = Native.hashFile(patch), result = P.prepareGame(f.entry, f.context);
  assert.match(fs.readFileSync(path.join(result.preparedRoot, "system/MessageLayer.tjs"), "utf8"), /super\.face=dfProvince/);
  assert.ok(result.changes.some(change => change.file === "system/MessageLayer.tjs" && /inherited drawing face/.test(change.operation)));
  assert.equal(Native.hashFile(patch), before);
});

test("modified prepared scripts are preserved and cannot silently satisfy the compatibility profile", t => {
  const root = fixture(t), f = project(root), result = P.prepareGame(f.entry, f.context), script = path.join(result.preparedRoot, "startup.tjs");
  fs.chmodSync(script, 0o644); fs.appendFileSync(script, "// user change");
  assert.throws(() => P.prepareGame(f.entry, f.context), /script cache changed/);
  assert.match(fs.readFileSync(script, "utf8"), /user change/);
});

test("warm preparation verifies archive/output identities and reuses decoded scripts", t => {
  const root = fixture(t), f = project(root), first = P.prepareGame(f.entry, f.context), read = X.readScript;
  try {
    X.readScript = () => assert.fail("unchanged scripts must not be extracted again");
    const second = P.prepareGame(f.entry, f.context);
    assert.equal(second.cached, true);
    assert.equal(second.preparedRoot, first.preparedRoot);
  } finally { X.readScript = read; }
});

test("the native module launches its automatic prepared project with saves outside the runtime and original game", { skip: process.platform !== "darwin" }, async t => {
  const root = fixture(t), f = project(root), binary = path.join(root, "native-runtime"), bytes = Buffer.alloc(32); bytes.writeUInt32LE(0xfeedfacf); bytes.writeUInt32LE(process.arch === "arm64" ? 0x0100000c : 0x01000007, 4); bytes.writeUInt32LE(2, 12); fs.writeFileSync(binary, bytes, { mode: 0o755 });
  const manager = Kiri.runtimeManagers[0]; manager.core.registerLocal({ userDataDir: f.context.userDataDir, version: "snapshot-124bdf8-macos-v2", runtimePath: binary });
  const override = path.join(root, "custom-saves"); f.entry.saveDirOverride = override; let call;
  const context = { ...f.context, runtimeId: "krkrsdl2", settings: {}, runtimeSettings: { version: "snapshot-124bdf8-macos-v2" }, spawnDetachedChecked: (...args) => { call = args; return "native-process"; } };
  Kiri.prepareLaunch(f.entry, context);
  assert.equal(f.entry.moduleData.kagVersion, "3.24 stable");
  assert.equal(await Kiri.launchRuntime("krkrsdl2", f.entry, context), "native-process");
  assert.equal(call[1].at(-1), f.entry.moduleData.preparedRoot);
  assert.equal(call[2].cwd, f.entry.moduleData.preparedRoot);
  assert.ok(call[1].includes(`-datapath=${override}${path.sep}`));
  assert.equal(f.entry.contentRootDir, f.game);
  assert.equal(fs.existsSync(path.join(f.game, "savedata")), false);
  const newer = path.join(root, "newer-native-runtime"); fs.writeFileSync(newer, Buffer.concat([bytes, Buffer.from("v3")]), { mode: 0o755 });
  manager.core.registerLocal({ userDataDir: f.context.userDataDir, version: "snapshot-124bdf8-macos-v3", runtimePath: newer });
  f.entry.runtimeData = { krkrsdl2: { version: "snapshot-124bdf8-macos-v2" } };
  context.runtimeSettings.version = "snapshot-124bdf8-macos-v3";
  await Kiri.launchRuntime("krkrsdl2", f.entry, context);
  assert.equal(call[0], fs.realpathSync(newer));
  assert.equal(f.entry.runtimeData.krkrsdl2.version, "snapshot-124bdf8-macos-v2");
});

test("XP3 traversal, protected data, chained loops and bad script checksums fail before preparation", t => {
  const root = fixture(t), unsafe = archive(path.join(root, "unsafe.xp3"), [["../outside.tjs", "danger"]]);
  assert.throws(() => X.inspectArchive(unsafe), /Unsafe/);
  const protectedFile = archive(path.join(root, "protected.xp3"), [["startup.tjs", "script"]], { protectedEntry: true });
  const protectedArchive = X.inspectArchive(protectedFile); assert.equal(protectedArchive.protectedEntries, 1);
  assert.throws(() => X.readScript(protectedArchive, protectedArchive.members.get("startup.tjs")), /Protected/);
  const loop = archive(path.join(root, "loop.xp3"), [["startup.tjs", "script"]], { chain: true }), data = fs.readFileSync(loop); data.writeBigUInt64LE(19n, 28); fs.writeFileSync(loop, data);
  assert.throws(() => X.inspectArchive(loop), /looping/);
  const good = X.inspectArchive(protectedFile), member = { ...good.members.get("startup.tjs"), protectedEntry: false, checksum: 0 };
  assert.throws(() => X.readScript(good, member), /checksum/);
});

test("text decoding is explicit and rejects invalid encodings without inventing a script", () => {
  assert.equal(P.decode(Buffer.from([0x82, 0xa0])), "あ");
  assert.equal(P.decode(Buffer.from([0xff, 0xfe, 0x42, 0x30])), "あ");
  assert.throws(() => P.decode(Buffer.from([0x81])), /encoded data/);
  assert.doesNotMatch(P.guardUnavailableAudio('class KAGMIDISoundBuffer extends MIDISoundBuffer, KAGSoundBuffer\n{\n function finalize() { }\n}\nclass BGM {}'), /extends MIDISoundBuffer/);
});

test("the reviewed legacy opening wait is inline and later sound waits remain unchanged", () => {
  const text = '[playse buf=2 storage=wa.wav][ws canskip=true]\r\n[playse storage=hasi][ws canskip=true]\r\n[ws]\r\n';
  assert.equal(P.skipLegacyOpeningWait(text), '[playse buf=2 storage=wa.wav]\r\n[playse storage=hasi][ws canskip=true]\r\n[ws]\r\n');
  assert.equal(P.skipLegacyOpeningWait('[playse buf=2 storage=other.wav][ws canskip=true]'), '[playse buf=2 storage=other.wav][ws canskip=true]');
});

test("legacy MIDI music tags are omitted while Wave music, effects and dynamic storage stay intact", () => {
  const text = '[fadeinbgm time=50 storage=sorawomitsumete.mid]\r\n@playbgm storage="town 7.mid"\r\n[playbgm storage="music.ogg"][playse storage=effect.mid]\r\n[fadeinbgm storage=&f.track]\r\n';
  assert.equal(P.silenceLegacyMidiTags(text), '[stopbgm]\r\n@stopbgm\r\n[playbgm storage="music.ogg"][playse storage=effect.mid]\r\n[fadeinbgm storage=&f.track]\r\n');
});

test("stock MessageLayer drawing assignments bypass its font face shadow without changing fonts or child layers", () => {
  const text = 'class MessageLayer extends KAGLayer {\n var face;\n function clearLayer() {\n  face = dfAuto;\n  fillRect(0,0,640,480,0);\n  face = dfProvince;\n  colorRect(0,0,640,480,0);\n  face = defaultFace;\n  lineLayer.face = dfAuto;\n  font.face = face;\n }\n}\n';
  const adapted = P.disambiguateMessageDrawFace(text);
  assert.match(adapted, /super\.face = dfAuto;/);
  assert.match(adapted, /super\.face = dfProvince;/);
  assert.match(adapted, /face = defaultFace;/);
  assert.match(adapted, /lineLayer\.face = dfAuto;/);
  assert.match(adapted, /font\.face = face;/);
  assert.equal(P.disambiguateMessageDrawFace(adapted), adapted);
  const unrelated = text.replace('class MessageLayer', 'class CustomLayer');
  assert.equal(P.disambiguateMessageDrawFace(unrelated), unrelated);
});

test("original archive generation is checked before a runtime install can be requested", async t => {
  missingNativeRuntime(t);
  const root = fixture(t), f = project(root);
  const context = { ...f.context, runtimeId: "krkrsdl2", settings: {} };
  assert.equal((await Kiri.ensureRuntime(f.entry, context)).managerId, "krkrsdl2");
  archive(f.exe, [["startup.tjs", 'Scripts.execStorage("system/Initialize.tjs");'], ["system/Initialize.tjs", 'var kagVersion = "2.30";']], { fused: true });
  await assert.rejects(Kiri.ensureRuntime(f.entry, context), /TJS1\/KAG2/);
  archive(f.exe, [["startup.tjs", "protected"]], { fused: true, protectedEntry: true });
  await assert.rejects(Kiri.ensureRuntime(f.entry, context), /Protected XP3/);
  assert.equal(fs.existsSync(f.context.userDataDir), false);
});
