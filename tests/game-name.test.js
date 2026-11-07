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

test("Windows imports use Steam titles and clean install folders instead of Unreal project names", async t => {
  const { peFixture, versionResource } = require("./helpers/pe-fixture");
  const root = fixture(t, "Deep Rock Galactic-windows-public-26107973-a1b2c3"), shipping = path.join(root, "FSD", "Binaries", "Win64", "FSD-Win64-Shipping.exe");
  fs.mkdirSync(path.dirname(shipping), { recursive: true });
  const pe = peFixture({ is64: true, version: versionResource({ strings: { ProductName: "FSD", FileDescription: "FSD" } }) });
  pe.bytes.writeUInt16LE(2, pe.peOffset + 22); pe.bytes.writeUInt16LE(2, pe.optional + 68);
  const bytes = pe.bytes;
  fs.writeFileSync(shipping, bytes); fs.writeFileSync(path.join(root, "FSD.exe"), bytes);
  const receipt = path.join(root, ".maclauncher-steam.json");
  fs.writeFileSync(receipt, JSON.stringify({ schema: 1, complete: true, platform: "windows", appId: 548430,
    name: "Steam publisher title", defaultWindowsLaunch: { executable: "FSD/Binaries/Win64/FSD-Win64-Shipping.exe" } }));
  assert.equal(Registry.detectGame(root).name, "Steam publisher title");
  assert.equal((await Registry.detectGameAsync(shipping, { workerMode: "inline" })).name, "Steam publisher title");
  fs.rmSync(receipt);
  assert.equal(Registry.detectGame(shipping).name, "Deep Rock Galactic");
  for (const moduleId of ["minori", "mages", "nitroplus"]) {
    const entry = { moduleId, gamePath: root, contentRootDir: root, name: "FSD", moduleData: {
      originalRunnerPath: shipping, originalRunner: { strings: { ProductName: "FSD" } }
    } };
    assert.equal(resolveGameName(entry, { metadata: true }), "Deep Rock Galactic", "PE title consumers share the same precedence");
    assert.equal(resolveGameName(entry, { userName: "My custom title" }), "My custom title");
  }
});

test("Windows Steam manifests and cached app-ID names precede folders without a network lookup", t => {
  const root = fixture(t, "Install codename"), executable = path.join(root, "internal.exe");
  fs.writeFileSync(executable, "fixture"); fs.writeFileSync(path.join(root, "steam_appid.txt"), "42\n");
  const entry = { name: "internal", gamePath: executable, contentRootDir: root };
  const manifest = path.join(root, "appmanifest_42.acf");
  fs.writeFileSync(manifest, '"AppState" { "appid" "42" "name" "Manifest game title" "installdir" "Install codename" }');
  assert.equal(resolveGameName(entry), "Manifest game title");
  fs.rmSync(manifest);
  const userDataDir = fixture(t, "Profile"), catalog = path.join(userDataDir, "steam", "catalog"); fs.mkdirSync(catalog, { recursive: true });
  fs.writeFileSync(path.join(catalog, "42.json"), JSON.stringify({ appId: 42, name: "Cached Steam title" }));
  assert.equal(resolveGameName(entry, { userDataDir }), "Cached Steam title");
  assert.equal(resolveGameName(entry), "Install codename", "an app ID alone does not invent or fetch a title");
  const install = path.join(root, "steamapps", "common", "Other install"); fs.mkdirSync(install, { recursive: true });
  fs.writeFileSync(path.join(root, "steamapps", "appmanifest_7.acf"), '"AppState" { "appid" "7" "name" "Installed Steam title" "installdir" "Other install" }');
  assert.equal(resolveGameName({ name: "internal", gameType: "windows", gamePath: install }), "Installed Steam title");
  assert.equal(resolveGameName({ name: "Authored engine title", gameType: "web", gamePath: executable, contentRootDir: root }), "Authored engine title",
    "another engine detected from a Windows executable keeps its own title");
});

test("Windows PE product and description are fallbacks and Unreal shipping metadata is never a title", t => {
  const { peFixture, versionResource } = require("./helpers/pe-fixture");
  const root = fixture(t, "Downloads"), executable = path.join(root, "runner.exe");
  const entry = { name: "runner", gamePath: executable, contentRootDir: root };
  const write = strings => fs.writeFileSync(executable, peFixture({ version: versionResource({ strings }) }).bytes);
  write({ ProductName: "Actual product title", FileDescription: "Description title" });
  assert.equal(resolveGameName(entry), "Actual product title");
  write({ ProductName: "Unreal Engine", FileDescription: "Description title" });
  assert.equal(resolveGameName(entry), "Description title");
  write({ ProductName: "Unreal Engine", FileDescription: "Launcher" });
  assert.equal(resolveGameName(entry), "runner");
  const shipping = path.join(root, "Project-Win64-Shipping.exe"); fs.copyFileSync(executable, shipping);
  assert.equal(resolveGameName({ ...entry, name: "Project", gamePath: shipping }), "Project-Win64-Shipping");
});
