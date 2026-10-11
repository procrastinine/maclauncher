const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const Tools = require("../src/modules/fvp/tools");
const GameData = require("../src/modules/shared/game-data");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-fvp-tools-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const game = path.join(root, "game"), userDataDir = path.join(root, "state"); fs.mkdirSync(game);
  // Independent descriptor fixture: entry point, globals, resolution, title,
  // named system-call records and custom-call count after a small code region.
  const title = Buffer.from("Sample\0"), calls = ["GraphLoad", "TextPrint"], code = Buffer.alloc(32);
  code.writeUInt32LE(code.length); code[4] = 0;
  const descriptor = Buffer.alloc(11); descriptor.writeUInt32LE(4); descriptor[8] = 8; descriptor[10] = title.length;
  const count = Buffer.alloc(2); count.writeUInt16LE(calls.length);
  const syscallRecords = calls.map(name => Buffer.concat([Buffer.from([1, name.length + 1]), Buffer.from(name + "\0")]));
  fs.writeFileSync(path.join(game, "sample.hcb"), Buffer.concat([code, descriptor, title, count, ...syscallRecords, Buffer.alloc(2)]));
  return { root, game, userDataDir, entry: { gameId: "sample-game", gamePath: game, contentRootDir: game,
    moduleData: { scriptPath: path.join(game, "sample.hcb"), textEncoding: "sjis" } }, context: { userDataDir } };
}
function pack(file, items) {
  const names = items.map(item => Buffer.isBuffer(item.name) ? Buffer.concat([item.name, Buffer.from([0])]) : Buffer.from(item.name + "\0"));
  const header = Buffer.alloc(8), table = Buffer.alloc(items.length * 12), nameTable = Buffer.concat(names);
  header.writeUInt32LE(items.length); header.writeUInt32LE(nameTable.length, 4);
  let nameOffset = 0, dataOffset = header.length + table.length + nameTable.length;
  for (let i = 0; i < items.length; i++) {
    const content = Buffer.from(items[i].content);
    table.writeUInt32LE(nameOffset, i * 12); table.writeUInt32LE(dataOffset, i * 12 + 4); table.writeUInt32LE(content.length, i * 12 + 8);
    nameOffset += names[i].length; dataOffset += content.length;
  }
  fs.writeFileSync(file, Buffer.concat([header, table, nameTable, ...items.map(item => Buffer.from(item.content))]));
}
const digest = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

test("FVP tools list and extract independent BIN bytes without conversion or original writes", t => {
  const f = fixture(t), archive = path.join(f.game, "graph.bin"), sound = path.join(f.game, "voice.bin");
  pack(archive, [{ name: "00000001", content: Buffer.from([0x68, 0x7a, 0x63, 0x31, 0, 255]) }, { name: "sub\\asset", content: "other" }]);
  pack(sound, [{ name: "00000002", content: "OggSoriginal audio" }]);
  const original = [digest(archive), digest(sound), digest(path.join(f.game, "sample.hcb"))]; let changed;
  f.context.onEntryChange = value => changed = value;
  const listing = Tools.listAssets(f.entry, {}, f.context), list = JSON.parse(fs.readFileSync(listing.outputPath));
  assert.equal(listing.fileCount, 3); assert.equal(listing.bytes, 29);
  assert.deepEqual(list.files.map(item => item.name), ["graph/00000001", "graph/sub/asset", "voice/00000002"]);
  assert.equal(changed.moduleData.assetListPath, listing.outputPath);
  const result = Tools.extractAssets(f.entry, {}, f.context);
  assert.equal(result.fileCount, 3); assert.equal(result.bytes, listing.bytes);
  assert.equal(result.outputDir, path.join(GameData.resolveGameModuleDir(f.userDataDir, f.entry.gameId, "fvp"), "exports", "assets"));
  assert.deepEqual(fs.readFileSync(path.join(result.outputDir, "graph/00000001")), Buffer.from([0x68, 0x7a, 0x63, 0x31, 0, 255]));
  assert.equal(fs.readFileSync(path.join(result.outputDir, "voice/00000002"), "utf8"), "OggSoriginal audio");
  for (const item of result.files) assert.equal(digest(path.join(result.outputDir, item.name)), item.sha256);
  assert.deepEqual([digest(archive), digest(sound), digest(path.join(f.game, "sample.hcb"))], original);
  assert.equal(changed.moduleData.assetExportDir, result.outputDir);
});

test("FVP loose resources override packed names and unrelated folders are excluded", t => {
  const f = fixture(t); pack(path.join(f.game, "graph.bin"), [{ name: "image", content: "archived" }, { name: "other", content: "remaining" }]);
  fs.mkdirSync(path.join(f.game, "GRAPH")); fs.writeFileSync(path.join(f.game, "GRAPH", "IMAGE"), "loose");
  fs.mkdirSync(path.join(f.game, "voice")); fs.writeFileSync(path.join(f.game, "voice", "line"), "voice");
  fs.mkdirSync(path.join(f.game, "save")); fs.writeFileSync(path.join(f.game, "save", "slot"), "private save");
  const result = Tools.extractAssets(f.entry, {}, f.context);
  assert.equal(result.fileCount, 3);
  assert.equal(fs.readFileSync(path.join(result.outputDir, "graph/IMAGE"), "utf8"), "loose");
  assert.equal(result.files.find(item => item.name === "graph/IMAGE").source, "loose");
  assert.equal(fs.existsSync(path.join(result.outputDir, "save")), false);
});

test("FVP asset names use the selected Japanese or translated encoding", t => {
  const f = fixture(t), archive = path.join(f.game, "graph.bin");
  pack(archive, [{ name: Buffer.from([0x82, 0xa0]), content: "Japanese name" }]);
  let result = Tools.extractAssets(f.entry, {}, f.context);
  assert.equal(fs.readFileSync(path.join(result.outputDir, "graph/あ"), "utf8"), "Japanese name");
  pack(archive, [{ name: Buffer.from("雪"), content: "Translated name" }]);
  result = Tools.extractAssets(f.entry, {}, { ...f.context, runtimeSettings: { textEncoding: "utf8" } });
  assert.equal(fs.readFileSync(path.join(result.outputDir, "graph/雪"), "utf8"), "Translated name");
});

test("FVP exports reject traversal, ambiguous names and file/folder conflicts", t => {
  const f = fixture(t), archive = path.join(f.game, "graph.bin");
  for (const name of ["../escape", "/absolute", "C:\\escape", "safe/../../escape", "a//b", "a\nb"]) {
    pack(archive, [{ name, content: "data" }]); assert.throws(() => Tools.extractAssets(f.entry, {}, f.context), /unsafe/);
  }
  for (const names of [["image", "IMAGE"], ["a", "a/b"]]) {
    pack(archive, names.map(name => ({ name, content: "data" })));
    assert.throws(() => Tools.extractAssets(f.entry, {}, f.context), /ambiguous|conflict/);
  }
  const exports = path.join(GameData.resolveGameModuleDir(f.userDataDir, f.entry.gameId, "fvp"), "exports");
  assert.equal(fs.readdirSync(exports).some(name => name.startsWith(".extract-")), false);
});

test("FVP BIN reader rejects invalid metadata, invalid encoding and out-of-range assets", t => {
  const f = fixture(t), archive = path.join(f.game, "graph.bin");
  function read() {
    const fd = fs.openSync(archive, "r");
    try { return Tools.__test.parseArchive({ fd, size: fs.statSync(archive).size }, "utf8"); } finally { fs.closeSync(fd); }
  }
  pack(archive, [{ name: "image", content: "data" }]);
  let bytes = fs.readFileSync(archive); bytes.writeUInt32LE(0xffffffff, 0); fs.writeFileSync(archive, bytes); assert.throws(read, /metadata/);
  pack(archive, [{ name: "image", content: "data" }]);
  bytes = fs.readFileSync(archive); bytes.writeUInt32LE(1, 8); fs.writeFileSync(archive, bytes); assert.throws(read, /invalid/);
  pack(archive, [{ name: "image", content: "data" }]);
  bytes = fs.readFileSync(archive); bytes.writeUInt32LE(bytes.length, 12); fs.writeFileSync(archive, bytes); assert.throws(read, /invalid/);
  pack(archive, [{ name: Buffer.from([255]), content: "data" }]); assert.throws(read, /encoding/);
});

test("FVP tools reject damaged companion resource archives instead of producing a partial export", t => {
  const f = fixture(t); pack(path.join(f.game, "graph.bin"), [{ name: "image", content: "original" }]);
  fs.writeFileSync(path.join(f.game, "voice.bin"), "not a valid archive");
  assert.throws(() => Tools.extractAssets(f.entry, {}, f.context), /unsupported|damaged/);
});

test("FVP export limits are checked before copying large sparse archive payloads", t => {
  const f = fixture(t), archive = path.join(f.game, "graph.bin");
  pack(archive, [{ name: "large", content: "" }]);
  let bytes = fs.readFileSync(archive); bytes.writeUInt32LE(Tools.__test.LIMITS.fileBytes + 1, 16);
  fs.writeFileSync(archive, bytes); fs.truncateSync(archive, bytes.length + Tools.__test.LIMITS.fileBytes + 1);
  assert.throws(() => Tools.extractAssets(f.entry, {}, f.context), /1 GB/);
  pack(archive, Array.from({ length: 9 }, (_, i) => ({ name: "asset" + i, content: "" })));
  bytes = fs.readFileSync(archive);
  for (let i = 0; i < 9; i++) { bytes.writeUInt32LE(bytes.length, 12 + i * 12); bytes.writeUInt32LE(Tools.__test.LIMITS.fileBytes, 16 + i * 12); }
  fs.writeFileSync(archive, bytes); fs.truncateSync(archive, bytes.length + Tools.__test.LIMITS.fileBytes);
  assert.throws(() => Tools.extractAssets(f.entry, {}, f.context), /8 GB/);
});

test("FVP aborted or failed replacement preserves the previous completed export", t => {
  const f = fixture(t), archive = path.join(f.game, "graph.bin");
  pack(archive, [{ name: "image", content: "first" }]); const result = Tools.extractAssets(f.entry, {}, f.context);
  pack(archive, [{ name: "image", content: "replacement" }]);
  let checks = 0;
  assert.throws(() => Tools.extractAssets(f.entry, {}, { ...f.context, signal: { get aborted() { return ++checks >= 5; } } }), /cancel/);
  assert.equal(fs.readFileSync(path.join(result.outputDir, "graph/image"), "utf8"), "first");
  pack(archive, [{ name: "../bad", content: "bad" }]); assert.throws(() => Tools.extractAssets(f.entry, {}, f.context), /unsafe/);
  assert.equal(fs.readFileSync(path.join(result.outputDir, "graph/image"), "utf8"), "first");
  assert.equal(fs.readdirSync(path.dirname(result.outputDir)).some(name => /^(?:\.extract-|\.previous-)/.test(name)), false);
  pack(archive, [{ name: "image", content: "replacement" }]); Tools.extractAssets(f.entry, {}, f.context);
  assert.equal(fs.readFileSync(path.join(result.outputDir, "graph/image"), "utf8"), "replacement");
});

test("FVP actions reject export aliases and never replace their targets", t => {
  const f = fixture(t); pack(path.join(f.game, "graph.bin"), [{ name: "image", content: "data" }]);
  const result = Tools.extractAssets(f.entry, {}, f.context), target = path.join(f.root, "unrelated");
  fs.mkdirSync(target); fs.writeFileSync(path.join(target, "keep"), "unchanged");
  fs.rmSync(result.outputDir, { recursive: true }); fs.symlinkSync(target, result.outputDir);
  for (const action of [Tools.extractAssets, Tools.revealAssets, Tools.removeAssets]) assert.throws(() => action(f.entry, {}, f.context), /aliases/);
  assert.equal(fs.readFileSync(path.join(target, "keep"), "utf8"), "unchanged");
});

test("FVP reveal and removal use the owned export and retain source/listing files", t => {
  const f = fixture(t), archive = path.join(f.game, "graph.bin"); pack(archive, [{ name: "image", content: "original" }]);
  const original = digest(archive), listing = Tools.listAssets(f.entry, {}, f.context);
  assert.throws(() => Tools.revealAssets(f.entry, {}, f.context), /Extract/);
  const result = Tools.extractAssets(f.entry, {}, f.context); let revealed;
  Tools.revealAssets(f.entry, {}, { ...f.context, ui: { shell: { showItemInFolder: value => revealed = value } } });
  assert.equal(revealed, result.outputDir);
  assert.deepEqual(Tools.removeAssets(f.entry, {}, f.context), { removed: true });
  assert.equal(fs.existsSync(result.outputDir), false); assert.equal(f.entry.moduleData.assetExportDir, null);
  assert.equal(fs.existsSync(listing.outputPath), true); assert.equal(digest(archive), original);
});

test("FVP loose assets reject aliases and ambiguous filesystem names", t => {
  const f = fixture(t), folder = path.join(f.game, "graph"); fs.mkdirSync(folder);
  fs.symlinkSync(path.join(f.game, "sample.hcb"), path.join(folder, "alias"));
  assert.throws(() => Tools.extractAssets(f.entry, {}, f.context), /aliases/);
  fs.unlinkSync(path.join(folder, "alias")); fs.writeFileSync(path.join(folder, "image"), "one"); fs.writeFileSync(path.join(folder, "IMAGE"), "two");
  // A case-insensitive filesystem cannot contain both names; its single file
  // still has a valid deterministic export.
  if (fs.readdirSync(folder).length > 1) assert.throws(() => Tools.extractAssets(f.entry, {}, f.context), /ambiguous/);
  else assert.equal(Tools.extractAssets(f.entry, {}, f.context).fileCount, 1);
});

test("FVP exports cannot write into the original game or escape a game ID", t => {
  const f = fixture(t); pack(path.join(f.game, "graph.bin"), [{ name: "image", content: "original" }]);
  const before = fs.readdirSync(f.game).sort();
  assert.throws(() => Tools.extractAssets(f.entry, {}, { userDataDir: path.join(f.game, "state") }), /outside/);
  assert.deepEqual(fs.readdirSync(f.game).sort(), before);
  assert.throws(() => Tools.extractAssets({ ...f.entry, gameId: "../other" }, {}, f.context), /owned/);
});
