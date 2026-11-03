const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const GameData = require("../src/modules/shared/game-data");
const { runDataMigrations } = require("../src/core/backcompat/data-migrations");

for (const id of ["web", "tyrano", "nscripter"]) {
  test(`${id} recovers its released writable input once and leaves deferred NW profiles untouched`, async t => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "original-web-migration-")));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const userDataDir = path.join(root, "profile"), original = path.join(root, "original"), mod = require(`../src/modules/${id}/backcompat`);
    const legacy = path.join(GameData.resolveGameModuleDir(userDataDir, "owned-game", id), "writable-input/files");
    const entry = { moduleId: id, gameId: "owned-game", gamePath: original, contentRootDir: legacy,
      moduleData: { writableInput: { schemaVersion: 1, root: legacy, sourceRoot: original } } };
    fs.mkdirSync(original); fs.mkdirSync(userDataDir);
    fs.writeFileSync(path.join(original, "asset.bin"), "original asset");
    fs.writeFileSync(path.join(original, "existing.sav"), "original save");
    const wrapperRoot = path.join(GameData.resolveGameRuntimeDir(userDataDir, entry.gameId, "nwjs"), "wrappers");
    const current = path.join(wrapperRoot, "owned-game-legacy");
    fs.mkdirSync(legacy, { recursive: true }); fs.mkdirSync(current, { recursive: true });
    fs.writeFileSync(path.join(legacy, ".maclauncher-wrapper.json"), JSON.stringify({ source: original }, null, 2));
    fs.symlinkSync(path.join(original, "asset.bin"), path.join(legacy, "asset.bin"));
    fs.writeFileSync(path.join(legacy, "new.sav"), "only private copy");
    fs.writeFileSync(path.join(legacy, "existing.sav"), "private conflicting save");
    fs.writeFileSync(path.join(current, "keep.json"), "active helper");
    const descriptors = mod.legacyGameMirrors(entry, { userDataDir });
    assert.equal(descriptors.some(row => row.mirrorRoot === legacy && row.sourceRoot === original), true);
    assert.equal(descriptors.some(row => row.mirrorRoot === current), false);
    let settings = {};
    const result = await runDataMigrations({ settings, games: [entry], registry: { getModule: () => mod }, userDataDir,
      saveSettings: next => { settings = next; }, saveEntry() {} });
    assert.equal(result.complete, true);
    assert.deepEqual(result.pendingIds, []);
    assert.equal(fs.existsSync(legacy), false);
    assert.equal(entry.contentRootDir, original, "the stored current route is the recovered original input");
    assert.equal(fs.readFileSync(path.join(original, "existing.sav"), "utf8"), "original save");
    assert.equal(fs.readFileSync(path.join(original, "new.sav"), "utf8"), "only private copy");
    const conflict = fs.readdirSync(original).find(name => name.startsWith("existing.sav.MacLauncher-conflict-"));
    assert.ok(conflict);
    assert.equal(fs.readFileSync(path.join(original, conflict), "utf8"), "private conflicting save");
    assert.equal(fs.readFileSync(path.join(current, "keep.json"), "utf8"), "active helper");
    await runDataMigrations({ settings, games: [entry], userDataDir,
      registry: { getModule: () => assert.fail("completed migration must not inspect modules") },
      saveSettings: () => assert.fail("completed migration must not write settings") });
    fs.rmSync(userDataDir, { recursive: true });
    assert.equal(fs.readFileSync(path.join(original, "new.sav"), "utf8"), "only private copy");
  });
}
