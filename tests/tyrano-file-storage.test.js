const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const Storage = require("../src/modules/tyrano/file-storage");
const Tyrano = require("../src/modules/tyrano/main");

test("Tyrano file saves retain escaped JSON in managed storage without writing the runner folder", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tyrano-file-storage-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runner = path.join(root, "runner"), saves = path.join(root, "profile/saves"); fs.mkdirSync(runner);
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

test("Tyrano Electron declares its per-game save directory through module metadata", () => {
  const userDataDir = path.resolve(os.tmpdir(), "tyrano-profile"), entry = { gameId: "owned-game", runtimeId: "electron" };
  const result = Tyrano.resolveSaveLocations(entry, { userDataDir });
  assert.equal(result.primaryDirectory, path.join(userDataDir, "games/owned-game/modules/tyrano/saves"));
  assert.equal(Tyrano.manifest.runtime.hosted.saveDirectory, true);
  assert.equal(Tyrano.resolveSaveLocations({ ...entry, runtimeId: "nwjs" }, { userDataDir }).primaryDirectory, null);
});
