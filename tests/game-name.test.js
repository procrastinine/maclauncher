const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { resolveGameName } = require("../src/core/game-name");
const Registry = require("../src/modules/registry");
function fixture(t, title) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-title-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, title); fs.mkdirSync(dir); return dir;
}
test("folder titles survive executable discovery in both registry detection routes", async t => {
  const dir = fixture(t, "The Garden Story");
  fs.writeFileSync(path.join(dir, "index.html"), "<html><title>The Garden Story</title></html>");
  fs.writeFileSync(path.join(dir, "internal.exe"), "MZ");
  assert.equal(Registry.detectGame(dir).name, "The Garden Story");
  assert.equal((await Registry.detectGameAsync(dir, { workerMode: "inline" })).name, "The Garden Story");
});
test("KiriKiri folder and selected script routes retain the same title", async t => {
  const dir = fixture(t, "The Garden Story");
  fs.writeFileSync(path.join(dir, "startup.tjs"), "// KAG");
  fs.writeFileSync(path.join(dir, "internal.exe"), "MZ");
  assert.equal(Registry.detectGame(dir).name, "The Garden Story");
  assert.equal(Registry.detectGame(path.join(dir, "startup.tjs")).name, "The Garden Story");
});
test("related file identifiers use readable folder titles while named single files keep their identity", t => {
  for (const [folder, file, name] of [["Nekopara Vol. 3", "NEKOPARAvol3.exe", "NEKOPARAvol3"], ["Garden Story", "GardenStory.exe", "GardenStory"], ["Minicraft Plus", "minicraft-plus-2.2.4.jar", "minicraft-plus"], ["Cityglitch", "cityglitch.love", "cityglitch"], ["Haven", "Haven-Optimized.exe", "Haven-Optimized"]]) {
    const dir = fixture(t, folder), input = path.join(dir, file); fs.writeFileSync(input, "fixture");
    assert.equal(resolveGameName({ name, gamePath: input, contentRootDir: dir }), folder);
    assert.equal(resolveGameName({ name, gamePath: input, contentRootDir: dir }, { metadata: true }), folder);
  }
  const dir = fixture(t, "Downloads"), input = path.join(dir, "GardenStory.exe"); fs.writeFileSync(input, "fixture");
  assert.equal(resolveGameName({ name: "Garden Story", gamePath: input, contentRootDir: dir }), "Garden Story");
  assert.equal(resolveGameName({ name: "GardenStory", gamePath: input, contentRootDir: dir }), "GardenStory");
});
test("window key hints do not become part of the title and authoritative titles remain intact", t => {
  const dir = fixture(t, "Garden Story");
  assert.equal(resolveGameName({ name: "Game ver. 1.09a (F5: Screen Size, F1: Settings, F12: Reset)", gamePath: dir }), "Garden Story");
  for (const name of ["DOOM", "Celeste", "東方紅魔郷", "one", "The Garden Story (Chapter 2)"]) {
    assert.equal(resolveGameName({ name, gamePath: dir }, { metadata: true }), name);
  }
});
