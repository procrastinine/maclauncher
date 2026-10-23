const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), zlib = require("node:zlib");
const Cipher = require("../src/modules/catsystem2/cipher");
const Archive = require("../src/modules/catsystem2/archive");
const Scene = require("../src/modules/catsystem2/scene");
const Localization = require("../src/modules/catsystem2/localization");
const FrontEnd = require("../src/modules/catsystem2/frontend-script");
const Inspect = require("../src/modules/catsystem2/inspect");
const { detectGame } = require("../src/modules/catsystem2/detect");
const Tools = require("../src/modules/catsystem2/tools");
const Crypto = require("../src/modules/catsystem2/runtime/crypto");
const moduleBackend = require("../src/modules/catsystem2/main");
const { resourceFixture } = require("./helpers/pe-resources-fixture");
const { versionResource } = require("./helpers/pe-fixture");
const Bundle = require("../src/modules/shared/runtime/bundled-native");
const declarations = require("../src/modules/catsystem2/runtime/distribution-supplementals.json");
const nativeAvailable = process.platform === "darwin" && declarations.length > 0;

function temporary(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catsystem2-tools-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
function kif(members) {
  let offset = 8 + members.length * 72; const bytes = Buffer.alloc(offset + members.reduce((n, member) => n + member.bytes.length, 0));
  bytes.write("KIF\0"); bytes.writeUInt32LE(members.length, 4);
  members.forEach((member, i) => { bytes.write(member.name, 8 + i * 72, 64); bytes.writeUInt32LE(offset, 72 + i * 72); bytes.writeUInt32LE(member.bytes.length, 76 + i * 72); member.bytes.copy(bytes, offset); offset += member.bytes.length; });
  return bytes;
}
function script(lines = [{ type: 33, bytes: Buffer.from("Speaker") }, { type: 32, bytes: Buffer.from([0x82, 0xa0]) }, { type: 48, bytes: Buffer.from("wait 5") }, { type: 0x88, bytes: Buffer.from("opaque") }], compressed = true) {
  const inputBytes = 8, strings = inputBytes + lines.length * 4, records = lines.map(line => Buffer.concat([Buffer.from([1, line.type]), line.bytes, Buffer.from([0])]));
  const decoded = Buffer.alloc(16 + strings + records.reduce((n, b) => n + b.length, 0));
  decoded.writeUInt32LE(decoded.length - 16); decoded.writeUInt32LE(1, 4); decoded.writeUInt32LE(inputBytes, 8); decoded.writeUInt32LE(strings, 12);
  decoded.writeUInt32LE(2, 16); decoded.writeUInt32LE(1, 20); let offset = 0;
  records.forEach((bytes, i) => { decoded.writeUInt32LE(offset, 16 + inputBytes + i * 4); bytes.copy(decoded, 16 + strings + offset); offset += bytes.length; });
  const payload = compressed ? zlib.deflateSync(decoded) : decoded, bytes = Buffer.alloc(16 + payload.length);
  bytes.write("CatScene"); bytes.writeUInt32LE(compressed ? payload.length : 0, 8); bytes.writeUInt32LE(decoded.length, 12); payload.copy(bytes, 16);
  return { bytes, decoded };
}
const ff = value => Buffer.concat([Buffer.alloc(Math.floor(value / 255), 255), Buffer.from([value % 255])]);
const text = value => { const b = Buffer.from(value); return Buffer.concat([ff(b.length), b]); };
function localized() { return Buffer.concat([Buffer.from("CSTL\0\0\0\0"), ff(2), text("en"), text("jp"), ff(1), text("Speaker"), text("X".repeat(300)), text(""), text("日本語")]); }
function frontEnd(decoded = Buffer.from("screen\r\nbutton open\r\n")) { const payload = zlib.deflateSync(decoded), header = Buffer.alloc(16); header.write("FES\0"); header.writeUInt32LE(payload.length, 4); header.writeUInt32LE(decoded.length, 8); return Buffer.concat([header, payload]); }
function game(t, { nested = false, identified = true } = {}) {
  const root = temporary(t), data = nested ? path.join(root, "DATA") : root; fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, "Scene.INT"), kif([{ name: "scene.cst", bytes: script().bytes }, { name: "scene.cstl", bytes: localized() }, { name: "menu.fes", bytes: frontEnd() }]));
  fs.writeFileSync(path.join(data, "cs2.exe"), resourceFixture([{ type: 16, name: 1, language: 1033,
    data: versionResource({ fileVersion: [2, 6, 1, 76], strings: { ProductName: identified ? "CatSystem2" : "Example", FileDescription: identified ? "cs2" : "unrelated" } }) }]).bytes);
  return { root, data };
}

test("CatSystem2 inspector exposes its primary script export without expanding Advanced", () => {
  const { actions, actionGroups } = moduleBackend.manifest.ui;
  const visible = actionGroups.filter(group => !group.collapsed).flatMap(group => group.actions);
  assert.ok(visible.includes("exportScripts"));
  const grouped = actionGroups.flatMap(group => group.actions);
  assert.equal(new Set(grouped).size, grouped.length);
  assert.deepEqual([...grouped].sort(), actions.map(action => action.id).sort());
  for (const id of grouped) assert.equal(typeof moduleBackend.actions[id], "function");
  assert.equal(moduleBackend.manifest.supports.launch, false);
});

test("CatSystem2 old MT vectors and reciprocal name format distinguish the published seed version", () => {
  const values = new Map([[0, 477480905], [1, 3556162021], [4357, 2867219139], [5489, 3526893021], [0xffffffff, 1255396560]]);
  for (const [seed, expected] of values) assert.equal(Cipher.mt1999First(seed), expected);
  const name = Buffer.alloc(64); name.write("folder/scene01.cst");
  for (const seed of values.keys()) assert.deepEqual(Cipher.transformName(Cipher.transformName(name, seed), seed), name);
  assert.throws(() => Cipher.mt1999First(-1), /seed/); assert.notEqual(Cipher.tocSeed(Buffer.from("A")), Cipher.tocSeed(Buffer.from("B")));
});

test("CatSystem2 detection requires KIF structure plus independently identified original engine version", t => {
  for (const nested of [false, true]) {
    const g = game(t, { nested }), result = detectGame({ rootDir: g.root, inputPath: path.join(g.data, "cs2.exe") });
    assert.equal(result.moduleId, "catsystem2"); assert.equal(result.moduleData.detectedVersion, "2.6.1.76");
    assert.equal(result.moduleData.dataRoot, g.data); assert.equal(result.contentRootDir, g.data); assert.match(result.moduleData.detectedVersionSource, /RT_VERSION/);
    assert.ok(fs.existsSync(result.detectionEvidence[0].path));
    assert.equal(moduleBackend.manifest.supports.launch, false); assert.equal(result.runtimeId, "catsystem2-tools");
    assert.equal(detectGame({ rootDir: g.root, isAppBundle: true }), null);
  }
  assert.equal(Inspect.inspectGame(game(t, { identified: false }).root), null);
  const g = game(t); fs.writeFileSync(path.join(g.root, "Scene.INT"), Buffer.from("KIF\0invalid")); assert.equal(Inspect.inspectGame(g.root), null);
});

test("KIF bounds reject corrupt tables, escaping names and replaced sources without modifying originals", async t => {
  const root = temporary(t), file = path.join(root, "scene.int"), bytes = kif([{ name: "scene.cst", bytes: script().bytes }]); fs.writeFileSync(file, bytes);
  const archive = await Archive.inspectArchive(file), member = archive.entries[0];
  assert.deepEqual(await Archive.readEntry(archive, member), script().bytes); assert.deepEqual(fs.readFileSync(file), bytes);
  await assert.rejects(() => Archive.readEntry(archive, { ...member }), /validated/);
  await assert.rejects(() => Archive.readEntry(archive, member, { maximumBytes: 1 }), /limit/);
  for (const corrupt of [
    b => b.writeUInt32LE(100001, 4), b => b.writeUInt32LE(b.length + 1, 72), b => b.writeUInt32LE(0xffffffff, 76),
    b => b.write("../outside.cst\0", 8), b => b.fill(65, 8, 72)
  ]) { const b = Buffer.from(bytes); corrupt(b); fs.writeFileSync(file, b); await assert.rejects(() => Archive.inspectArchive(file)); }
  fs.writeFileSync(file, bytes); const changed = await Archive.inspectArchive(file); fs.appendFileSync(file, "x");
  await assert.rejects(() => Archive.readEntry(changed, changed.entries[0]), /changed/); Archive.releaseArchive(archive); Archive.releaseArchive(changed);
});

test("KIF duplicate generations remain inspectable, while overlapping bytes fail closed", async t => {
  const file = path.join(temporary(t), "scene.int"), bytes = kif([{ name: "scene.cst", bytes: Buffer.from("old") }, { name: "SCENE.cst", bytes: Buffer.from("new") }]);
  fs.writeFileSync(file, bytes); const archive = await Archive.inspectArchive(file);
  assert.equal(archive.duplicateNames, 1); assert.equal(archive.entries.length, 2); assert.equal((await Archive.readEntry(archive, archive.entries[1])).toString(), "new");
  Archive.releaseArchive(archive); bytes.writeUInt32LE(bytes.readUInt32LE(72), 144); fs.writeFileSync(file, bytes);
  await assert.rejects(() => Archive.inspectArchive(file), /overlaps/);
});

test("CatScene decompression, input/string extents and unknown line types preserve readable and raw records", async () => {
  for (const compressed of [false, true]) {
    const scene = await Scene.inspectScene(script(undefined, compressed).bytes);
    assert.equal(scene.lineCount, 4); assert.equal(scene.lines[1].text, "あ"); assert.deepEqual(scene.unknownTypes, [0x88]);
    assert.equal(scene.lines[1].rawBase64, Buffer.from([0x82, 0xa0]).toString("base64")); assert.match(Scene.decompile(scene), /type-0x88/);
  }
  for (const corrupt of [b => b.writeUInt32LE(0xffffffff, 12), b => b[16] ^= 0xff, b => b.writeUInt32LE(1, 8)]) {
    const b = Buffer.from(script().bytes); corrupt(b); await assert.rejects(() => Scene.inspectScene(b));
  }
  for (const corrupt of [b => b.writeUInt32LE(0xffffffff, 8), b => b.writeUInt32LE(999, 20), b => b.writeUInt32LE(0, 28)]) {
    const b = Buffer.from(script().decoded); corrupt(b); assert.throws(() => Scene.parseScript(b));
  }
  const suffix = Buffer.concat([script().bytes, Buffer.alloc(1)]); await assert.rejects(() => Scene.inspectScene(suffix), /range/);
});

test("CSTL parses bounded FF strings and languages, rejecting truncation, invalid UTF-8 and unknown revisions", () => {
  const report = Localization.inspectLocalization(localized()); assert.deepEqual(report.languages, ["en", "jp"]);
  assert.equal(report.messages[0].localizations[0].text.length, 300); assert.equal(report.messages[0].localizations[1].text, "日本語");
  assert.match(Localization.decompile(report), /0:en/);
  for (const b of [localized().subarray(0, 18), Buffer.concat([localized(), Buffer.alloc(1)]), Buffer.from("CSTL\1\0\0\0\1\2en\0"), Buffer.concat([Buffer.from("CSTL\0\0\0\0"), Buffer.alloc(100, 255)])]) assert.throws(() => Localization.inspectLocalization(b));
  const bad = localized(); bad[bad.length - 1] = 255; assert.throws(() => Localization.inspectLocalization(bad));
});

test("FES preserves bounded original menu text without claiming an executable front-end VM", async () => {
  const report = await FrontEnd.inspectFrontEndScript(frontEnd()); assert.equal(report.format, "FES"); assert.match(report.text, /button open/);
  assert.equal(report.executionSupported, false); assert.deepEqual(Buffer.from(report.rawBase64, "base64"), Buffer.from(report.text));
  const unicode = await FrontEnd.inspectFrontEndScript(frontEnd(Buffer.from("—")));
  assert.equal(unicode.sourceEncoding, "UTF-8"); assert.equal(unicode.text, "—"); assert.equal(unicode.runtimeEncodingProven, false);
  assert.match(unicode.encodingSource, /inferred/);
  await assert.rejects(() => FrontEnd.inspectFrontEndScript(frontEnd(Buffer.from([255]))), /encoding/);
  for (const corrupt of [b => b.writeUInt32LE(1, 4), b => b.writeUInt32LE(0xffffffff, 8), b => b.writeUInt32LE(1, 12), b => b[16] ^= 1]) {
    const b = Buffer.from(frontEnd()); corrupt(b); await assert.rejects(() => FrontEnd.inspectFrontEndScript(b));
  }
});

test("pure Node CatSystem2 actions export scripts privately, preserve originals and reject foreign state paths", async t => {
  const g = game(t), entry = { gameId: "fixture", contentRootDir: g.root }, context = { userDataDir: path.join(temporary(t), "user-data") }, original = fs.readFileSync(path.join(g.data, "Scene.INT"));
  const inspection = await moduleBackend.actions.inspectArchives(entry, {}, context);
  assert.equal(inspection.archiveCount, 1); assert.equal(inspection.scriptCount, 3); assert.equal(inspection.engineVersion, "2.6.1.76");
  const exported = await moduleBackend.actions.exportScripts(entry, {}, context); assert.equal(exported.scriptCount, 3);
  const output = path.join(exported.path, "Scene.INT/entries/000000/scene.cst"); assert.deepEqual(fs.readFileSync(output), script().bytes);
  assert.ok(fs.existsSync(output + ".txt")); assert.equal(JSON.parse(fs.readFileSync(output + ".json")).lines[1].text, "あ");
  assert.deepEqual(fs.readFileSync(path.join(g.data, "Scene.INT")), original);
  const again = await moduleBackend.actions.exportScripts(entry, {}, context); assert.notEqual(again.path, exported.path);
  assert.throws(() => moduleBackend.actions.exportArchive(entry, { archive: "../scene.int" }, context), /filename/);
  assert.throws(() => Tools.outputRoot({ ...entry, gameId: "../other" }, context), /Import/);
  const games = path.join(context.userDataDir, "games"); fs.rmSync(games, { recursive: true }); fs.symlinkSync(g.root, games);
  assert.throws(() => Tools.outputRoot(entry, context), /symlinks/);
  await assert.rejects(() => moduleBackend.ensureRuntime(entry, context), /not yet supported for play/);
});

test("KIF cipher request validation is bounded before spawning, with no game key in arguments", async () => {
  await assert.rejects(() => Crypto.transform({ executablePath: "/unused" }, Buffer.alloc(3), Buffer.alloc(8)), /bounded/);
  await assert.rejects(() => Crypto.transform({ executablePath: "/unused" }, Buffer.alloc(4), Buffer.alloc(9)), /bounded/);
  const controller = new AbortController(); controller.abort(); assert.throws(() => Crypto.transform({ executablePath: "/unused" }, Buffer.alloc(4), Buffer.alloc(8), { signal: controller.signal }));
});

test("Included KIF crypto has exact source/CPU/seal identity and executes the independent Blowfish vector", { skip: !nativeAvailable }, async t => {
  const helper = await Crypto.resolveHelper(); assert.equal(helper.version, "1.0.0-ml1"); assert.equal(helper.shared, true);
  assert.equal((await Crypto.transform(helper, Buffer.alloc(4), Buffer.alloc(8), { encrypt: true })).toString("hex"), "4597f94e78dd9861");
  assert.deepEqual(await Crypto.transform(helper, Buffer.alloc(4), Buffer.from("4597f94e78dd9861", "hex")), Buffer.alloc(8));
  assert.deepEqual(await Crypto.transform(helper, Buffer.alloc(4), Buffer.alloc(0)), Buffer.alloc(0));
  await assert.rejects(() => Crypto.resolveHelper({ helperVersion: "newest" }), /no KIF helper .*selected version/);
  await assert.rejects(() => Crypto.resolveHelper({ dependencies: { systemVersion: async () => "10.15" } }), /macOS 11/);
  const pin = declarations[0], resources = temporary(t), directory = path.join(resources, "native-runtimes", pin.directoryRelative);
  fs.cpSync(path.dirname(helper.executablePath), directory, { recursive: true });
  const bytes = fs.readFileSync(path.join(directory, "kif-crypto")); bytes[100] ^= 1; fs.writeFileSync(path.join(directory, "kif-crypto"), bytes);
  await assert.rejects(() => Crypto.resolveHelper({ resourcesRoot: resources }), /changed|differs|match|integrity|checksum|hash/i);
});

test("encrypted original KIF uses bounded PE key resources, index generations and unencrypted tails", { skip: !nativeAvailable }, async t => {
  const helper = await Crypto.resolveHelper(), root = temporary(t), runner = path.join(root, "cs2.exe"), file = path.join(root, "scene.int");
  const keyCode = Buffer.from("fixture!"), code = Buffer.from("EXAMPLE-CODE"), padded = Buffer.alloc(16); code.copy(padded);
  const encryptedCode = await Crypto.transform(helper, keyCode, padded, { encrypt: true });
  fs.writeFileSync(runner, resourceFixture([{ type: "KEY_CODE", name: "KEY", data: Buffer.from(keyCode.map(byte => byte ^ 0xcd)) },
    { type: "V_CODE2", name: "DATA", data: encryptedCode }]).bytes);
  const seed = await Archive.readTocSeed(runner, helper); assert.equal(seed, Cipher.tocSeed(code));
  const members = [{ name: "scene.cst", bytes: script().bytes }, { name: "SCENE.cst", bytes: Buffer.from("abcdefghijk") }], count = members.length + 1;
  const archiveSeed = 12345, key = Buffer.alloc(4); key.writeUInt32LE(Cipher.mt1999First(archiveSeed));
  let offset = 8 + count * 72; const index = Buffer.alloc(offset), payloads = [];
  index.write("KIF\0"); index.writeUInt32LE(count, 4); index.write("__key__.dat", 8); index.writeUInt32LE(archiveSeed, 76);
  for (let i = 0; i < members.length; i++) {
    const member = members[i], id = i + 1, name = Buffer.alloc(64); name.write(member.name);
    Cipher.transformName(name, (seed + id) >>> 0).copy(index, 8 + id * 72);
    const metadata = Buffer.alloc(8); metadata.writeUInt32LE(offset); metadata.writeUInt32LE(member.bytes.length, 4);
    const encoded = await Crypto.transform(helper, key, metadata, { encrypt: true });
    index.writeUInt32LE((encoded.readUInt32LE(0) - id) >>> 0, 72 + id * 72); index.writeUInt32LE(encoded.readUInt32LE(4), 76 + id * 72);
    const length = Math.floor(member.bytes.length / 8) * 8, encrypted = await Crypto.transform(helper, key, member.bytes.subarray(0, length), { encrypt: true });
    payloads.push(Buffer.concat([encrypted, member.bytes.subarray(length)])); offset += member.bytes.length;
  }
  const original = Buffer.concat([index, ...payloads]); fs.writeFileSync(file, original);
  const archive = await Archive.inspectArchive(file, { helper, tocSeed: seed }); assert.equal(archive.encrypted, true); assert.equal(archive.duplicateNames, 1);
  assert.deepEqual(await Archive.readEntry(archive, archive.entries[0]), members[0].bytes);
  assert.deepEqual(await Archive.readEntry(archive, archive.entries[1]), members[1].bytes);
  assert.equal((await Scene.inspectScene(await Archive.readEntry(archive, archive.entries[0]))).lineCount, 4);
  const publicIndex = JSON.stringify(archive); assert.ok(!publicIndex.includes("fileKey")); assert.ok(!publicIndex.includes("tocSeed")); assert.ok(!publicIndex.includes("keyCode"));
  assert.deepEqual(fs.readFileSync(file), original); Archive.releaseArchive(archive);
  await assert.rejects(() => Archive.readEntry(archive, archive.entries[0]), /validated/);
  await assert.rejects(() => Archive.inspectArchive(file), /key resources/);
  const missing = path.join(root, "missing.exe"); fs.writeFileSync(missing, resourceFixture([{ type: "V_CODE2", name: "DATA", data: encryptedCode }]).bytes);
  await assert.rejects(() => Archive.readTocSeed(missing, helper), /resource pair/);
  const pin = declarations[0]; Bundle.verifyPayload(path.dirname(helper.executablePath), pin);
});
