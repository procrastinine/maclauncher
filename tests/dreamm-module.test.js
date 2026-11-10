// Required first: it replaces the network before modules load.
require("./helpers/future-upstream.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { temporary, write, gob, mz, context } = require("./helpers/engine-port-fixtures.cjs");
const Module = require("../src/modules/dreamm/main");
const Catalog = require("../src/modules/dreamm/runtime/catalog");
const Registry = require("../src/modules/registry");

test("a LucasArts title's main data file selects the game in its folder", t => {
  const root = temporary(t), folder = path.join(root, "Dark Forces Demo"), data = write(path.join(folder, "DARK.GOB"), gob());
  write(path.join(folder, "SOUNDS.GOB"), gob());
  const detected = Module.detectGame(context(data));
  assert.equal(detected.moduleId, "dreamm"); assert.equal(detected.name, "Star Wars: Dark Forces");
  assert.equal(detected.gamePath, folder); assert.deepEqual(detected.moduleData, { gameFile: "DARK.GOB" });
  assert.equal(Module.detectGame(context(folder)).name, "Star Wars: Dark Forces", "A folder without programs selects it too");
  assert.equal(Registry.explainDetection(data).selectedModuleId, "dreamm");
  assert.equal(Module.detectGame(context(write(path.join(root, "Other", "DARK.GOB"), "data"))), null, "The GOB magic is required");
  assert.equal(Module.detectGame(context(write(path.join(root, "Yoda", "YODESK.DTA"), "VERS"))).name, "Star Wars: Yoda Stories");
  // The release as distributed holds DOS programs, which keep the DOS route.
  write(path.join(folder, "DF.EXE"), mz());
  assert.equal(Registry.explainDetection(folder).selectedModuleId, "dosbox");
  assert.equal(Registry.explainDetection(data).selectedModuleId, "dreamm");
});

test("DREAMM runs the game folder directly", t => {
  const root = temporary(t);
  assert.deepEqual(Module.__test.launchArguments({ gamePath: root, contentRootDir: root, moduleData: { gameFile: "DARK.GOB" } }),
    { args: ["-run", root], cwd: root });
});

test("the DREAMM download page and update feed give the Mac disk images", () => {
  const links = Catalog.linkedFiles("<a href='releases\\dreamm-4.0-macos.dmg'>Mac</a><a href='releases\\dreamm-4.0-linux-x64.tgz'>Linux</a><a href='https://other.example/x.dmg'>x</a>");
  assert.deepEqual(links, [{ url: "https://dreamm.aarongiles.com/releases/dreamm-4.0-macos.dmg", name: "dreamm-4.0-macos.dmg" },
    { url: "https://dreamm.aarongiles.com/releases/dreamm-4.0-linux-x64.tgz", name: "dreamm-4.0-linux-x64.tgz" }]);
  assert.deepEqual(Catalog.feedVersions("<feed><title>DREAMM Version Updates</title><entry><title>DREAMM 4.0</title></entry><entry><title>DREAMM 3.0.3</title></entry></feed>"), ["4.0", "3.0.3"]);
});
