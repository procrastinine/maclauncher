const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const Storage = require("../src/modules/tyrano/file-storage");
const Tyrano = require("../src/modules/tyrano/main");

test("Tyrano file saves retain escaped JSON in the original game without writing the shared runner folder", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tyrano-file-storage-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runner = path.join(root, "runner"), saves = path.join(root, "original-game"); fs.mkdirSync(runner);
  const handlers = {}, target = { document: { addEventListener: (name, listener) => { handlers[name] = listener; } } };
  assert.equal(Storage.install(target, saves), true);
  // The author's functions arrive later when tyrano/libs.js finishes loading.
  target.$ = { setStorageFile: (key, value) => fs.writeFileSync(path.join(runner, key + ".sav"), JSON.stringify(value)), getStorageFile: () => "runner", getProcessPath: () => runner, localFilePath: () => runner };
  handlers.load();
  const value = { unicode: "こんにちは", chapter: 3 };
  target.$.setStorageFile("authored_game_sf", value);
  assert.equal(fs.readFileSync(path.join(saves, "authored_game_sf.sav"), "utf8"), escape(JSON.stringify(value)));
  assert.deepEqual(JSON.parse(target.$.getStorageFile("authored_game_sf")), value);
  assert.equal(target.$.getStorageFile("missing"), null);
  assert.equal(target.$.getProcessPath(), saves);
  assert.equal(target.$.localFilePath(), saves);
  assert.deepEqual(fs.readdirSync(runner), []);
  for (const key of ["../original", "/absolute", "nested/file", "nested\\file", "bad\0file"]) assert.throws(() => target.$.setStorageFile(key, value), /Invalid Tyrano save key/);
  assert.deepEqual(fs.readdirSync(saves), ["authored_game_sf.sav"]);
});

test("Tyrano declares original file saves while browser storage and explicit overrides stay separate", () => {
  const userDataDir = path.resolve(os.tmpdir(), "tyrano-profile"), game = path.resolve(os.tmpdir(), "tyrano-original"),
    entry = { gameId: "owned-game", gamePath: game, contentRootDir: path.join(userDataDir, "required-extraction"), runtimeId: "electron" };
  const result = Tyrano.resolveSaveLocations(entry, { userDataDir });
  assert.equal(result.primaryDirectory, game, "required extraction is not the save root");
  assert.equal(Tyrano.manifest.runtime.hosted.saveDirectory, true);
  assert.equal(Tyrano.resolveSaveLocations({ ...entry, runtimeId: "nwjs" }, { userDataDir }).primaryDirectory, game);
  const explicit = path.join(userDataDir, "games/owned-game/modules/tyrano/saves");
  assert.equal(Storage.resolveDirectory({ gameDir: game, contentRootDir: entry.contentRootDir }), game);
  assert.equal(Storage.resolveDirectory({ gameDir: game, saveDir: explicit }), explicit, "an intentional private override remains usable");
  const saves = require("../src/core/save-locations");
  const hydrated = saves.hydrateGameSaveLocations({ ...entry, moduleId: "tyrano", defaultSaveDir: explicit }, { getModule: () => Tyrano });
  assert.equal(hydrated.defaultSaveDir, game, "the actual pre-launch hydration replaces stale default metadata");
  assert.equal(Storage.resolveDirectory({ saveDir: hydrated.defaultSaveDir, gameDir: game }), game);
});
