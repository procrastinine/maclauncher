// Required first: it replaces the network before modules load.
require("./helpers/future-upstream.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { temporary, write, wad, context } = require("./helpers/engine-port-fixtures.cjs");
const Module = require("../src/modules/uzdoom/main");
const Catalog = require("../src/modules/uzdoom/runtime/catalog");
const Registry = require("../src/modules/registry");
const { execFileSync } = require("node:child_process");

test("a main game file or a folder holding one selects that Doom-engine game", t => {
  const root = temporary(t), folder = path.join(root, "Freedoom");
  const iwad = write(path.join(folder, "freedoom2.wad"), wad());
  write(path.join(folder, "addon.wad"), wad("PWAD"));
  write(path.join(folder, "COPYING.txt"), "BSD");
  for (const input of [folder, iwad]) {
    const detected = Module.detectGame(context(input));
    assert.equal(detected.moduleId, "uzdoom"); assert.equal(detected.runtimeId, "uzdoom");
    assert.equal(detected.name, "Freedoom: Phase 2"); assert.equal(detected.contentRootDir, folder);
    assert.deepEqual(detected.moduleData, { gameFile: "freedoom2.wad" });
    assert.equal(Registry.explainDetection(input).selectedModuleId, "uzdoom");
  }
  assert.equal(Module.detectGame(context(path.join(folder, "addon.wad"))), null, "An add-on needs a main game");
  write(path.join(folder, "freedoom1.wad"), wad());
  assert.throws(() => Module.detectGame(context(folder)), error => error.code === "DETECTION_CONFLICT" && error.choices.length === 2);
  assert.equal(Module.detectGame(context(write(path.join(root, "empty.wad"), "IW"))), null);
});

test("an IPK3, or a PK3 that defines a main game, selects that game", t => {
  const root = temporary(t), source = path.join(root, "src"), zip = (file, ...names) => execFileSync("/usr/bin/zip", ["-q", file, ...names], { cwd: source });
  write(path.join(source, "iwadinfo.txt"), "IWad { Name = \"Standalone\" }");
  write(path.join(source, "mapinfo.txt"), "map MAP01 {}");
  const ipk3 = path.join(root, "game.ipk3"), pk3 = path.join(root, "standalone.pk3"), mod = path.join(root, "mod.pk3");
  zip(ipk3, "mapinfo.txt"); zip(pk3, "iwadinfo.txt"); zip(mod, "mapinfo.txt");
  assert.equal(Module.detectGame(context(ipk3)).moduleData.gameFile, "game.ipk3");
  assert.equal(Module.detectGame(context(pk3)).name, "standalone");
  assert.equal(Module.detectGame(context(mod)), null, "A mod archive needs a main game");
});

test("UZDoom starts with the main game file in place", t => {
  const root = temporary(t), iwad = write(path.join(root, "DOOM2.WAD"), wad());
  const entry = { gamePath: root, contentRootDir: root, moduleData: { gameFile: "DOOM2.WAD" } };
  assert.deepEqual(Module.__test.launchArguments(entry), { args: ["-iwad", iwad], cwd: root });
});

test("the UZDoom catalog lists stable releases with a Mac download", () => {
  const asset = name => ({ name, browser_download_url: `https://github.com/UZDoom/UZDoom/releases/download/5.0.3/${name}`, size: 1 });
  const release = { tag_name: "5.0.3", assets: ["MacOS-UZDoom-Release-ARM64.dmg", "Windows-UZDoom-Release-x86_64.zip",
    "Linux-UZDoom-Release-x86_64.AppImage", "_release.json"].map(asset) };
  const rows = Catalog.recognize(release);
  assert.deepEqual(rows.map(row => [row.version, row.architecture, row.assets[0].name]), [["5.0.3", "arm64", "MacOS-UZDoom-Release-ARM64.dmg"]]);
  assert.equal(Catalog.recognize({ ...release, tag_name: "x-preview" }), null, "Rolling preview tags are not versions");
  assert.match(Catalog.recognize({ tag_name: "5.0.0", assets: [] }).installReason, /no macOS download/);
});
