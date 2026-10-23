const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const Module = require("../src/modules/easyrpg/main");
const Tools = require("../src/modules/easyrpg/tools");

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "easyrpg-tools-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
async function project(root, engine = "2k") {
  const codec = await import("rpgrt");
  fs.mkdirSync(root, { recursive: true });
  const database = codec.defaultRecord("Database", engine);
  const actor = { ...codec.defaultRecord("Actor", engine), id: 1, name: "Sample actor" };
  database.actors = [actor];
  fs.writeFileSync(path.join(root, "RPG_RT.ldb"), codec.encodeDatabase(database, { engine }));
  fs.writeFileSync(path.join(root, "RPG_RT.lmt"), codec.encodeTreeMap(codec.defaultRecord("TreeMap", engine), { engine }));
  const map = codec.defaultRecord("MapUnit", engine);
  const event = { ...codec.defaultRecord("Event", engine), id: 1, name: "Sample event" };
  map.events = [event];
  fs.writeFileSync(path.join(root, "Map0001.lmu"), codec.encodeMapUnit(map, { engine }));
  return { gameId: "sample", gamePath: root, contentRootDir: root, moduleData: {} };
}

test("EasyRPG exports decoded database/map JSON through bundled code without modifying source", async t => {
  const root = temporary(t), entry = await project(path.join(root, "original"));
  const originals = Object.fromEntries(Tools.projectFiles(entry.gamePath).map(name => [name, fs.readFileSync(path.join(entry.gamePath, name))]));
  const context = { userDataDir: path.join(root, "data"), onEntryChange: updated => assert.equal(updated, entry) };
  const result = await Module.actions.exportProjectJson(entry, { encoding: "1252" }, context);
  assert.equal(result.fileCount, 3);
  assert.equal(result.engine, "2k");
  assert.ok(result.exportRoot.startsWith(path.join(context.userDataDir, "games", "sample", "modules", "easyrpg", "exports")));
  const database = JSON.parse(fs.readFileSync(path.join(result.exportRoot, "RPG_RT.ldb.json"), "utf8"));
  assert.equal(database.data.actors[0].name, "Sample actor");
  assert.equal(database.format, "ldb");
  for (const [name, bytes] of Object.entries(originals)) assert.deepEqual(fs.readFileSync(path.join(entry.gamePath, name)), bytes);
});

test("EasyRPG exports text with source field addresses and reveals only owned output", async t => {
  const root = temporary(t), entry = await project(path.join(root, "original"), "2k3");
  const context = { userDataDir: path.join(root, "data"), ui: { shell: { showItemInFolder: file => assert.equal(file, entry.moduleData.exportRoot) } } };
  const result = await Module.actions.exportProjectText(entry, { engine: "2k3" }, context);
  assert.equal(result.engine, "2k3");
  assert.ok(result.textCount > 0);
  const text = JSON.parse(fs.readFileSync(path.join(result.exportRoot, "Map0001.lmu.json"), "utf8"));
  assert.ok(text.data.some(item => item.path === "events.0.name" && item.text === "Sample event"));
  assert.deepEqual(Module.actions.revealExport(entry, {}, context), { revealed: true });
  entry.moduleData.exportRoot = entry.gamePath;
  assert.throws(() => Module.actions.revealExport(entry, {}, context), /No LCF export/);
  entry.moduleData.exportRoot = path.join(result.exportRoot, "removed");
  assert.throws(() => Module.actions.revealExport(entry, {}, context), /No LCF export/);
});

test("EasyRPG export rejects invalid headers, oversized files and canceled actions without partial exports", async t => {
  const root = temporary(t), entry = await project(path.join(root, "original"));
  const context = { userDataDir: path.join(root, "data") };
  const map = path.join(entry.gamePath, "Map0001.lmu");
  fs.writeFileSync(map, "invalid map bytes");
  await assert.rejects(Module.actions.exportProjectJson(entry, {}, context), /invalid.*header/);
  const outputs = path.join(context.userDataDir, "games", "sample", "modules", "easyrpg", "exports");
  assert.deepEqual(fs.readdirSync(outputs), []);
  const fd = fs.openSync(map, "w"); fs.ftruncateSync(fd, Tools.LIMITS.fileBytes + 1); fs.closeSync(fd);
  await assert.rejects(Module.actions.exportProjectJson(entry, {}, context), /larger than 16 MB/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(Module.actions.exportProjectJson(entry, {}, { ...context, signal: controller.signal }), error => error.name === "AbortError");
  assert.equal(entry.moduleData.exportRoot, undefined);
});

test("EasyRPG's Node compatibility exception applies only to the tested JavaScript package", () => {
  const { readPackage } = require("../.pnpmfile.cjs").hooks;
  const upstream = { name: "rpgrt", version: "0.2.0", engines: { node: ">=24", npm: ">=10" } };
  assert.deepEqual(readPackage(upstream).engines, { node: ">=22.12.0", npm: ">=10" });
  assert.equal(upstream.engines.node, ">=24");
  for (const pkg of [{ ...upstream, name: "another-package" }, { ...upstream, version: "0.3.0" }]) {
    assert.equal(readPackage(pkg), pkg);
    assert.equal(pkg.engines.node, ">=24");
  }
});
