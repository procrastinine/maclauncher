const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { readJsonObject, writeJsonAtomic } = require("../src/core/json-files");
const GameStore = require("../src/core/game-store");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-json-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("atomic metadata replacement preserves permissions and leaves only complete JSON", t => {
  const root = fixture(t);
  const file = path.join(root, "settings.json");
  fs.writeFileSync(file, '{"old":true}', { mode: 0o640 });
  writeJsonAtomic(file, { next: [1, 2] });
  assert.deepEqual(readJsonObject(file), { next: [1, 2] });
  assert.equal(fs.statSync(file).mode & 0o777, 0o640);
  assert.deepEqual(fs.readdirSync(root), ["settings.json"]);
});

test("failed metadata rename preserves the previous file and removes the temporary file", t => {
  const root = fixture(t);
  const file = path.join(root, "settings.json");
  fs.writeFileSync(file, '{"old":true}');
  const rename = t.mock.method(fs, "renameSync", () => { throw Object.assign(new Error("rename failure"), { code: "EACCES" }); });
  assert.throws(() => writeJsonAtomic(file, { next: true }), /rename failure/);
  rename.mock.restore();
  assert.deepEqual(readJsonObject(file), { old: true });
  assert.deepEqual(fs.readdirSync(root), ["settings.json"]);
});

test("metadata writes reject existing links and non-files without modifying their targets", t => {
  const root = fixture(t);
  const target = path.join(root, "target.json");
  const link = path.join(root, "link.json");
  fs.writeFileSync(target, '{"original":true}');
  fs.symlinkSync(target, link);
  assert.throws(() => writeJsonAtomic(link, { bad: true }), /not a regular file/);
  assert.deepEqual(readJsonObject(target), { original: true });
  assert.throws(() => writeJsonAtomic(root, {}), /not a regular file/);
});

test("game records reject traversal IDs and malformed array records", t => {
  const root = fixture(t);
  const outside = path.join(root, "outside");
  for (const gameId of ["../../outside", "a/b", "..", "a\\b"]) {
    assert.throws(() => GameStore.writeGameRecord(root, { gameId }), /Invalid gameId/);
    assert.throws(() => GameStore.deleteGameData(root, gameId), /Invalid gameId/);
  }
  assert.equal(fs.existsSync(outside), false);
  fs.mkdirSync(path.join(root, "games", "array"), { recursive: true });
  fs.writeFileSync(path.join(root, "games", "array", "game.json"), "[]");
  assert.equal(GameStore.readGameRecord(root, "array"), null);
  fs.mkdirSync(path.join(root, "games", "unexpected.directory"));
  assert.deepEqual(GameStore.listGameIds(root), ["array"]);
});
