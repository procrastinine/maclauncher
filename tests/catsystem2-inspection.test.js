const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { peFixture, versionResource } = require("./helpers/pe-fixture");
const Inspect = require("../src/modules/catsystem2/inspect");
function temporary(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), "catsystem2-inspect-")); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
function runner(product = "cs2") { return peFixture({ version: versionResource({ strings: { ProductName: product, FileDescription: product } }) }).bytes; }
function kif({ encrypted = true } = {}) {
  const bytes = Buffer.alloc(168); bytes.write("KIF\0", 0); bytes.writeUInt32LE(2, 4);
  bytes.write(encrypted ? "__key__.dat" : "start.cst", 8);
  bytes.writeUInt32LE(152, 72); bytes.writeUInt32LE(16, 76); return bytes;
}
function game(root, { nested = false, name = "cs2.exe", product = "cs2" } = {}) {
  const dir = nested ? path.join(root, "data") : root; fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), runner(product)); fs.writeFileSync(path.join(dir, "scene.int"), kif()); return dir;
}

test("CatSystem2 identifies actual runner version in a nested data layout and excludes BootMenu versions", t => {
  const root = temporary(t), data = game(root, { nested: true, name: "renamed-game.exe" });
  fs.writeFileSync(path.join(root, "Game.exe"), runner("BootMenu"));
  fs.writeFileSync(path.join(data, "fes.int"), kif()); fs.writeFileSync(path.join(data, "kcs.int"), kif());
  fs.writeFileSync(path.join(data, "emotedriver.dll"), "plugin fixture");
  const before = fs.readFileSync(path.join(data, "scene.int"));
  const info = Inspect.inspectGame(root, { inputPath: path.join(root, "Game.exe") });
  assert.equal(info.originalRunnerPath, path.join(data, "renamed-game.exe"));
  assert.equal(info.detectedVersion, "1.5.7.23"); assert.match(info.detectedVersionSource, /renamed-game\.exe!RT_VERSION/);
  assert.deepEqual(info.requiredFeatures, ["FES startup/system scripts", "KCS startup/system scripts", "E-mote native plugin"]);
  assert.deepEqual(fs.readFileSync(path.join(data, "scene.int")), before);
});
test("CatSystem2 requires independent engine resource evidence and rejects ambiguous runner/game roots", t => {
  const root = temporary(t); game(root, { product: "BootMenu" }); assert.equal(Inspect.inspectGame(root), null);
  game(root); fs.writeFileSync(path.join(root, "second.exe"), runner()); assert.equal(Inspect.inspectGame(root), null);
  fs.rmSync(path.join(root, "second.exe")); game(root, { nested: true }); assert.equal(Inspect.inspectGame(root), null);
});
test("CatSystem2 KIF headers reject fake signatures, malformed indices and invalid plain first-entry extents", t => {
  const root = temporary(t), file = path.join(root, "scene.int");
  const valid = kif(); fs.writeFileSync(file, valid); assert.equal(Inspect.inspectKif(file).encrypted, true);
  valid.writeUInt32LE(100000, 4); fs.writeFileSync(file, valid); assert.equal(Inspect.inspectKif(file), null);
  valid.writeUInt32LE(1, 4); fs.writeFileSync(file, valid); assert.equal(Inspect.inspectKif(file), null);
  const plain = kif({ encrypted: false }); fs.writeFileSync(file, plain); assert.equal(Inspect.inspectKif(file).encrypted, false);
  plain.writeUInt32LE(169, 72); fs.writeFileSync(file, plain); assert.equal(Inspect.inspectKif(file), null);
  plain.write("notKIF", 0); fs.writeFileSync(file, plain); assert.equal(Inspect.inspectKif(file), null);
});
test("CatSystem2 gates PE inspection behind archive headers and confines original game paths", t => {
  const root = temporary(t), data = game(root, { nested: true }); fs.writeFileSync(path.join(data, "scene.int"), Buffer.alloc(80));
  const reads = []; const detection = { stat: fs.statSync, readdir: fs.readdirSync, readBytes: (file, offset, length) => {
    reads.push({ file, offset, length }); const fd = fs.openSync(file, "r"), bytes = Buffer.alloc(length); try { fs.readSync(fd, bytes, 0, length, offset); return bytes; } finally { fs.closeSync(fd); }
  } };
  assert.equal(Inspect.inspectGame(root, { detection }), null); assert.deepEqual(reads.map(row => path.basename(row.file)), ["scene.int"]);
  const outside = temporary(t); game(outside); fs.rmSync(data, { recursive: true }); fs.symlinkSync(outside, data);
  assert.equal(Inspect.inspectGame(root), null);
});
