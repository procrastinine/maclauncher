const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { parseXml, memberPath } = require("../src/modules/catsystem2/startup");
const { createAssets } = require("../src/modules/catsystem2/runtime/assets");
const { createRegistry, archiveList } = require("../src/modules/catsystem2/runtime/asset-registry");
const xml = Buffer.from('<document><INT><int00><name>image</name><int>image.lst</int><ext>hg3</ext><dir>image</dir></int00><int01 voice="A"><name>voice_a</name><int>a.int</int><ext>ogg</ext><dir>sound\\@a</dir></int01></INT></document>');

test("CatSystem asset reads remain confined and preserve original files", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cat-assets-")); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "画面.txt"), bytes = Buffer.from("original"); fs.writeFileSync(file, bytes);
  const before = fs.statSync(file), hash = crypto.createHash("sha256").update(bytes).digest("hex"), assets = createAssets({ dataRoot: directory, archives: [] });
  assert.deepEqual(await assets.read("画面.txt"), bytes); await assert.rejects(assets.read("画面.txt", { maximumBytes: 3 }), /bounded/);
  fs.symlinkSync(file, path.join(directory, "link")); await assert.rejects(assets.read("link"), /regular paths/);
  for (const name of ["../file", "dir/../../file", "/file", "x\\file", "x\0file", "x\ud800"]) assert.throws(() => memberPath(name), /unsafe/);
  assert.equal(crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"), hash); assert.equal(fs.statSync(file).mtimeMs, before.mtimeMs);
});

test("CatSystem authored resource registries keep archive order, language and ambiguity", async () => {
  const first = { path: "/original/first.int", entries: [{ name: "screen_en.hg3" }] }, second = { path: "/original/second.int", entries: [] }, loaded = [];
  const assets = { read: async name => { loaded.push(name); return name === "image.lst" ? Buffer.from("image\\pack/first.int\r\nimage/second.int\r\n") : Buffer.from("image"); } };
  const registry = createRegistry({ document: parseXml(xml), assets, language: "en", archiveIndex: async name => name.endsWith("first.int") ? first : second });
  assert.deepEqual(await registry.read("image", "screen_%LANG%"), Buffer.from("image")); assert.deepEqual(loaded, ["image.lst", "first.int/screen_en.hg3"]);
  second.entries.push({ name: "screen_en.hg3" }); await assert.rejects(registry.read("image", "screen_en"), /ambiguous/);
  await assert.rejects(registry.read("image", "../../screen"), /unsafe/); assert.equal(registry.types.get("voice_a").directory, "sound/@a");
  assert.throws(() => archiveList(Buffer.from("first.int\nfirst.int\n")), /repeated/);
});
test("CatSystem loose authored directories work without a redundant archive and reject changed observations", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cat-loose-assets-")); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, "font")); const file = path.join(directory, "font", "authored.ttf"), bytes = Buffer.from("original-font"); fs.writeFileSync(file, bytes);
  const assets = createAssets({ dataRoot: directory, archives: [] });
  const document = parseXml(Buffer.from('<document><INT><int00><name>font</name><int>missing.int</int><ext>ttf</ext><dir>font</dir></int00></INT></document>'));
  let archiveLookups = 0; const registry = createRegistry({ document, assets, archiveIndex: async () => { archiveLookups++; throw new Error("absent"); } });
  const located = await registry.locate("font", "authored"); assert.equal(located.sourcePath, "font/authored.ttf");
  assert.deepEqual(await registry.read("font", "authored"), bytes); assert.equal(archiveLookups, 0); await registry.verify(located);
  fs.appendFileSync(file, "changed"); await assert.rejects(registry.verify(located), /resource changed/);
  fs.symlinkSync(file, path.join(directory, "font", "link.ttf")); await assert.rejects(registry.read("font", "link"), /regular paths/);
  await assert.rejects(assets.observe("font/../authored.ttf"), /unsafe/);
});
