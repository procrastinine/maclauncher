// Required first: it replaces the network before modules load.
require("./helpers/future-upstream.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { temporary, write, grp, context } = require("./helpers/engine-port-fixtures.cjs");
const Module = require("../src/modules/raze/main");
const Catalog = require("../src/modules/raze/runtime/catalog");
const Registry = require("../src/modules/registry");

test("Build-engine game data or a folder holding it selects that game", t => {
  const root = temporary(t), folder = path.join(root, "Duke"), data = write(path.join(folder, "DUKE3D.GRP"), grp());
  write(path.join(folder, "LICENSE.TXT"), "Shareware");
  for (const input of [folder, data]) {
    const detected = Module.detectGame(context(input));
    assert.equal(detected.moduleId, "raze"); assert.equal(detected.name, "Duke Nukem 3D");
    assert.equal(detected.contentRootDir, folder); assert.deepEqual(detected.moduleData, { gameFile: "DUKE3D.GRP" });
    assert.equal(Registry.explainDetection(input).selectedModuleId, "raze");
  }
  write(path.join(folder, "DUKEDC.GRP"), grp());
  assert.throws(() => Module.detectGame(context(folder)), error => error.code === "DETECTION_CONFLICT" && error.choices.length === 2);
  const blood = write(path.join(root, "Blood", "BLOOD.RFF"), Buffer.from("RFF\u001a\u0000\u0003"));
  assert.equal(Module.detectGame(context(blood)).name, "Blood");
  assert.equal(Module.detectGame(context(write(path.join(root, "STUFF.DAT"), grp()))).name, "PowerSlave");
  assert.equal(Module.detectGame(context(write(path.join(root, "other.grp"), "not a group"))), null);
  assert.equal(Module.detectGame(context(write(path.join(root, "Other", "STUFF.DAT"), "data"))), null);
});

test("Raze starts in the game folder and selects the main file by name", t => {
  // Raze matches -gamegrp as a name among the files it finds in its folders; a
  // full path never matches, and an add-on finds its base game in the same folder.
  const root = temporary(t), data = write(path.join(root, "DUKEDC.GRP"), grp());
  write(path.join(root, "DUKE3D.GRP"), grp());
  assert.deepEqual(Module.__test.launchArguments({ gamePath: data, contentRootDir: root, moduleData: { gameFile: "DUKEDC.GRP" } }),
    { args: ["-gamegrp", "DUKEDC.GRP"], cwd: root });
});

test("the Raze catalog lists releases with a Mac archive", () => {
  const asset = name => ({ name, browser_download_url: `https://github.com/ZDoom/Raze/releases/download/1.11.0/${name}`, size: 1 });
  const rows = Catalog.recognize({ tag_name: "1.11.0", assets: ["raze-macos-1.11.0.zip", "Raze-1.11.0b-windows.zip", "Raze-1.11.0-windows-pdb.7z"].map(asset) });
  assert.deepEqual(rows.map(row => [row.version, row.architecture, row.assets[0].name]), [["1.11.0", undefined, "raze-macos-1.11.0.zip"]]);
});
