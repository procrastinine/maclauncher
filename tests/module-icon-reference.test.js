const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const GameData = require("../src/modules/shared/game-data");
const GameStore = require("../src/core/game-store");
const { selectIconForEntry } = require("../src/core/game-icons");

// This checkout is "B"; the records name module icons inside other app locations.
const vndsIcon = path.resolve(__dirname, "../src/modules/vnds/resources/icon.png");
function profile(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "module-icon-reference-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function storeRaw(root, record) {
  const file = GameData.resolveGameDataPath(root, record.gameId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(record));
  return file;
}

test("a record written under another checkout reads this checkout's module icon without a write", async t => {
  const root = profile(t);
  for (const checkoutA of ["/Users/someone/maclauncher/.worktrees/lane", "/Applications/MacLauncher.app/Contents/Resources/app.asar"]) {
    const file = storeRaw(root, { gameId: "vn", schemaVersion: 2, moduleId: "vnds", gamePath: "/Games/VN",
      iconPath: path.join(checkoutA, "src/modules/vnds/resources/icon.png"), iconSource: "module-default", updatedAt: 1 });
    const before = fs.readFileSync(file, "utf8"), modified = fs.statSync(file).mtimeMs;
    const record = GameStore.readGameRecord(root, "vn");
    assert.equal(record.iconPath, vndsIcon);
    assert.equal(record.iconSource, "module-default");
    // The icon refresh selects the same icon, so it has nothing to save.
    const selected = await selectIconForEntry({ entry: record, moduleIconPath: null, moduleDefaultIconPath: vndsIcon,
      canRenderPath: value => fs.existsSync(value), extractCandidate: async () => null });
    assert.deepEqual(selected, { path: record.iconPath, source: record.iconSource });
    assert.equal(GameStore.loadGames(root)[0].iconPath, vndsIcon);
    assert.equal(fs.readFileSync(file, "utf8"), before);
    assert.equal(fs.statSync(file).mtimeMs, modified);
  }
});

test("module default icons are stored as a reference and other icons keep their paths", t => {
  const root = profile(t);
  const file = GameStore.writeGameRecord(root, { gameId: "vn", moduleId: "vnds", iconPath: vndsIcon, iconSource: "module-default" });
  const stored = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(stored.iconPath, null);
  assert.equal(stored.iconSource, "module-default");
  assert.equal(GameStore.readGameRecord(root, "vn").iconPath, vndsIcon);
  // A former absolute path is never written back, whatever produced it.
  GameStore.writeGameRecord(root, { gameId: "vn", moduleId: "vnds", iconPath: "/Old/App/src/modules/vnds/resources/icon.png", iconSource: "module" });
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).iconPath, null);
  const extracted = path.join(root, "games", "exe", "icons", "icon.png");
  GameStore.writeGameRecord(root, { gameId: "exe", iconPath: extracted, iconSource: "exe" });
  assert.equal(GameStore.readGameRecord(root, "exe").iconPath, extracted);
  assert.equal(JSON.parse(fs.readFileSync(GameData.resolveGameDataPath(root, "exe"), "utf8")).iconPath, extracted);
});
