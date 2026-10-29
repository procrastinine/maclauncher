const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const Tools = require("../src/modules/wolfrpg/inspection-tools");
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wolf-inspection-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source"); fs.mkdirSync(source);
  return { root, source, entry: { gameId: "wolf-tools", gamePath: source, moduleData: {} }, context: { userDataDir: path.join(root, "profile"), settings: {} } };
}
test("WolfTL stages only project data and preserves a completed export when a later command fails", async t => {
  const { entry, context } = fixture(t); let closed = 0;
  const manager = { ensure: async () => ({ version: "0.6.2" }), run: async (_entry, _context, options) => {
    assert.equal(fs.readFileSync(path.join(options.cwd, "input", "BasicData", "Game.dat"), "utf8"), "original metadata");
    assert.equal(fs.existsSync(path.join(options.cwd, "input", "Pictures", "picture.png")), false);
    const output = path.join(options.cwd, "output", "dump", "common"); fs.mkdirSync(output, { recursive: true }); fs.writeFileSync(path.join(output, "events.json"), "[]");
    return { host: "sikarugir" };
  } };
  const source = () => ({ entries: [{ name: "Data/BasicData/Game.dat", read: () => Buffer.from("original metadata") },
    { name: "Data/Pictures/picture.png", read: () => { throw Error("Images are not project metadata"); } }], close: () => closed++ });
  const result = await Tools.exportProjectJson(entry, {}, context, { manager, assets: source });
  assert.equal(closed, 1); assert.equal(result.fileCount, 1);
  manager.run = async (_entry, _context, options) => { fs.writeFileSync(options.logPath, "parsing failure"); throw Error("tool failed"); };
  await assert.rejects(Tools.exportProjectJson(entry, {}, context, { manager, assets: source }), /tool failed.*Log:/);
  assert.equal(fs.readFileSync(path.join(result.outputRoot, "dump", "common", "events.json"), "utf8"), "[]");
  assert.equal(fs.readFileSync(path.join(path.dirname(result.outputRoot), "wolftl-failure.log"), "utf8"), "parsing failure");
});
test("UberWolf decodes private containers first and restores loose-file precedence without altering originals", async t => {
  const { source, entry, context } = fixture(t);
  fs.mkdirSync(path.join(source, "Data")); fs.writeFileSync(path.join(source, "Game.exe"), "original executable");
  fs.writeFileSync(path.join(source, "Data.wolf"), "original archive"); fs.writeFileSync(path.join(source, "Data", "loose.txt"), "loose overrides archive");
  const manager = { ensure: async () => ({ version: "0.6.4" }), run: async (_entry, _context, options) => {
    assert.notEqual(options.cwd, source); assert.equal(options.args[0], "--override");
    assert.equal(fs.existsSync(path.join(options.cwd, "Data", "loose.txt")), false);
    fs.mkdirSync(path.join(options.cwd, "Data")); fs.writeFileSync(path.join(options.cwd, "Data", "loose.txt"), "archive version");
    fs.writeFileSync(path.join(options.cwd, "Data", "new.txt"), "decoded"); fs.writeFileSync(options.logPath, "extracted"); return {};
  } };
  const result = await Tools.extractAdvancedAssets(entry, {}, context, { manager });
  assert.equal(fs.readFileSync(path.join(result.outputDir, "Data", "loose.txt"), "utf8"), "loose overrides archive");
  assert.equal(fs.readFileSync(path.join(result.outputDir, "Data", "new.txt"), "utf8"), "decoded");
  assert.equal(fs.readFileSync(path.join(source, "Game.exe"), "utf8"), "original executable");
  assert.equal(fs.readFileSync(path.join(source, "Data.wolf"), "utf8"), "original archive");
  assert.equal(fs.existsSync(path.join(result.outputDir, "Game.exe")), false);
});
test("extended extraction validates its original executable prerequisite before downloading", async t => {
  const { entry, context } = fixture(t); let downloaded = false;
  await assert.rejects(Tools.extractAdvancedAssets(entry, {}, context, { manager: { ensure: async () => { downloaded = true; } } }), /original Game.exe/);
  assert.equal(downloaded, false);
});
