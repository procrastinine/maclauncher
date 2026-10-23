const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");

test("import hints include current standalone mobile packages without listing internal data files", async () => {
  const { dropGameTargets } = await import("../src/renderer/src/ui/drop-game-targets.mjs");
  const root = path.join(__dirname, "../src/modules");
  const modules = fs.readdirSync(root).flatMap(id => {
    const file = path.join(root, id, "manifest.json");
    return fs.existsSync(file) ? [JSON.parse(fs.readFileSync(file, "utf8"))] : [];
  });
  const labels = dropGameTargets(modules).map(item => item.label);
  for (const label of ["Game folder", "Game.app", "Game.apk", "Game.xapk", "Game.apkm", "Game.apks", "Game.ipa", "Game.exe", "Game.x86_64", "Game.AppImage", "Game.jar", "Game.love", "Game.swf"]) assert.ok(labels.includes(label), label);
  assert.ok(!labels.includes("Game.ini"));
  assert.equal(new Set(labels).size, labels.length);
});

test("import hints follow generic metadata and ignore unsafe or nonexclusive extensions", async () => {
  const { dropGameTargets } = await import("../src/renderer/src/ui/drop-game-targets.mjs");
  assert.deepEqual(dropGameTargets([{ id: "renamed-provider", detection: {
    inputKinds: ["file"], extensions: [
      { extension: ".CUSTOM", exclusive: true }, { extension: ".custom", exclusive: true },
      { extension: ".dat" }, { extension: "../bad", exclusive: true }
    ]
  } }]), [{ label: "Game.custom", mono: true }]);
  assert.deepEqual(dropGameTargets([]), [{ label: "Game folder" }]);
});
