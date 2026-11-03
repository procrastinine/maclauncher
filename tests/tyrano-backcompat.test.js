const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const Backcompat = require("../src/modules/tyrano/backcompat");
const Tyrano = require("../src/modules/tyrano/main");
const Storage = require("../src/modules/tyrano/file-storage");
const { runDataMigrations } = require("../src/core/backcompat/data-migrations");

test("released Tyrano file saves are read by the normal original-folder adapter and current fields persist", async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tyrano-released-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userDataDir = path.join(root, "profile"), gamePath = path.join(root, "original");
  fs.mkdirSync(gamePath);
  const old = path.join(userDataDir, "games/owned-game/modules/tyrano/saves"); fs.mkdirSync(old, { recursive: true });
  const entry = { moduleId: "tyrano", gameId: "owned-game", runtimeId: "electron", gamePath, defaultSaveDir: old,
    saveLocations: [{ directory: old }] };
  const released = { chapter: 3, text: "保存" };
  fs.writeFileSync(path.join(old, "game_sf.sav"), escape(JSON.stringify(released)));
  fs.writeFileSync(path.join(old, "conflict.sav"), escape(JSON.stringify({ private: true })));
  fs.writeFileSync(path.join(gamePath, "conflict.sav"), escape(JSON.stringify({ original: true })));
  let persisted;
  const result = await runDataMigrations({ settings: {}, games: [entry], registry: { getModule: () => Backcompat }, userDataDir,
    saveSettings() {}, saveEntry: working => { persisted = structuredClone(working); } });
  assert.deepEqual(result.pendingIds, []);
  assert.equal(persisted.defaultSaveDir, gamePath);
  assert.equal(persisted.saveLocations[0].directory, gamePath);
  const target = { $: { getStorageFile() {}, setStorageFile() {} } };
  Storage.install(target, Tyrano.resolveSaveLocations(persisted).primaryDirectory);
  assert.deepEqual(JSON.parse(target.$.getStorageFile("game_sf")), released);
  assert.deepEqual(JSON.parse(target.$.getStorageFile("conflict")), { original: true });
  const conflict = fs.readdirSync(gamePath).find(name => name.startsWith("conflict.sav.MacLauncher-conflict-"));
  assert.deepEqual(JSON.parse(unescape(fs.readFileSync(path.join(gamePath, conflict), "utf8"))), { private: true });
  fs.rmSync(userDataDir, { recursive: true });
  assert.deepEqual(JSON.parse(target.$.getStorageFile("game_sf")), released);
});

test("released Tyrano active private overrides remain live and descriptor collection has no writes", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tyrano-protected-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userDataDir = path.join(root, "profile"), gamePath = path.join(root, "original");
  const entry = { gameId: "owned-game", gamePath };
  const descriptors = Backcompat.legacyGameMirrors(entry, { userDataDir });
  assert.equal(descriptors.length, 1);
  assert.equal(fs.existsSync(userDataDir), false);
  assert.deepEqual(Backcompat.legacyGameMirrors({ ...entry, saveDirOverride: descriptors[0].mirrorRoot }, { userDataDir }), []);
});
