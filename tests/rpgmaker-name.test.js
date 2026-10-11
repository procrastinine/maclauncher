const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const Registry = require("../src/modules/registry");
const Detection = require("../src/modules/detection");
const Rpg = require("../src/modules/shared/mvmz/rpgmaker-detect");
const { createGameMetadataService } = require("../src/core/game-metadata");
const GameData = require("../src/modules/shared/game-data");

function fixture(t, engine = "mv", executable = "Game.exe") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rpgmaker-title-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const game = path.join(root, "Creator Title"), indexDir = engine === "mv" ? path.join(game, "www") : game;
  fs.mkdirSync(path.join(indexDir, "js"), { recursive: true });
  fs.mkdirSync(path.join(indexDir, "data"));
  fs.writeFileSync(path.join(indexDir, "index.html"), "<html></html>");
  fs.writeFileSync(path.join(indexDir, "js", engine === "mv" ? "rpg_core.js" : "rmmz_core.js"), "// authored engine marker");
  const input = path.join(game, executable), system = path.join(indexDir, "data/System.json");
  fs.writeFileSync(input, "authored non-running executable fixture");
  return { root, game, indexDir, input, system };
}

test("MV and MZ retain an authoritative title equal to the folder name", async t => {
  for (const engine of ["mv", "mz"]) {
    const f = fixture(t, engine, "Windows Edition.exe"), original = JSON.stringify({ gameTitle: "Creator Title" });
    fs.writeFileSync(f.system, original);
    for (const input of [f.game, f.input]) {
      for (const detected of [Registry.detectGame(input), await Registry.detectGameAsync(input)]) {
        assert.equal(detected.name, "Creator Title");
        assert.deepEqual(detected.nameSource, { type: "metadata", path: f.system, field: "gameTitle" });
      }
    }
    assert.equal(fs.readFileSync(f.system, "utf8"), original);
  }
});

test("generic bootstrap executable names preserve a useful folder fallback", t => {
  for (const name of ["Game.exe", "NW.exe", "NWJS.exe", "node-webkit.exe", "Electron.exe"]) {
    const f = fixture(t, "mv", name);
    assert.equal(Registry.detectGame(f.input).name, "Creator Title");
  }
});

test("title inspection rejects oversized, malformed and escaping metadata", t => {
  for (const contents of ["{", JSON.stringify({ gameTitle: "  " }), JSON.stringify({ gameTitle: "Bad\0title" }), "x".repeat(256 * 1024 + 1)]) {
    const f = fixture(t); fs.writeFileSync(f.system, contents);
    const session = Detection.createDetectionSession(f.input);
    const detected = Rpg.detectRpgmakerGame(session.context, session.helpers);
    assert.equal(detected.name, "Creator Title");
    assert.equal(detected.nameSource.type, "folder");
    if (contents.length > 256 * 1024) assert.ok(session.metrics.bytesRead < 65536);
  }
  const f = fixture(t), outside = path.join(f.root, "outside.json");
  fs.writeFileSync(outside, JSON.stringify({ gameTitle: "Outside title" })); fs.symlinkSync(outside, f.system);
  assert.equal(Registry.detectGame(f.input).name, "Creator Title");
  assert.equal(fs.readlinkSync(f.system), outside);
});

test("a missing or changed RPG title invalidates metadata cache while unchanged titles stay warm", async t => {
  const f = fixture(t), userDataDir = path.join(f.root, "profile");
  let detections = 0;
  const registry = { ...Registry, async detectGameAsync(...args) { detections++; return Registry.detectGameAsync(...args); } };
  const service = createGameMetadataService({ userDataDir, registry });
  let entry = await service.importEntry(f.input, {});
  assert.equal(entry.name, "Creator Title");
  const cachePath = path.join(GameData.resolveGameDir(userDataDir, entry.gameId), "metadata.json");
  let cache = JSON.parse(fs.readFileSync(cachePath, "utf8"));
  assert.ok(cache.files.some(([file, identity]) => file === f.system && identity[0] === "ENOENT"));
  entry = await service.refreshEntry(entry, {}); assert.equal(detections, 1);
  fs.writeFileSync(f.system, JSON.stringify({ gameTitle: "First authored title" }));
  entry = await service.refreshEntry(entry, {}); assert.equal(entry.name, "First authored title"); assert.equal(detections, 2);
  entry = await service.refreshEntry(entry, {}); assert.equal(detections, 2);
  const stat = fs.statSync(f.system);
  fs.writeFileSync(f.system, JSON.stringify({ gameTitle: "Other authored title" })); fs.utimesSync(f.system, stat.atime, stat.mtime);
  entry = await service.refreshEntry(entry, {}); assert.equal(entry.name, "Other authored title"); assert.equal(detections, 3);
  cache = JSON.parse(fs.readFileSync(cachePath, "utf8"));
  assert.ok(cache.files.some(([file]) => file === f.system));
});
