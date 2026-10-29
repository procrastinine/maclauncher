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

test("the shared document read keeps a damaged file beside it, salvages its readable members and refuses unreadable reads", t => {
  const { readJsonDocument, onUnreadablePreserved } = require("../src/core/json-files");
  const root = fixture(t), file = path.join(root, "store.json"), list = path.join(root, "list.json"), copies = [], notices = [];
  t.after(onUnreadablePreserved(notice => notices.push(notice)));
  assert.equal(readJsonDocument(file), null, "a missing document is empty");
  const damaged = '{"keep": {"a": 1}, "also": [1, 2], "lost": {"b"';
  fs.writeFileSync(file, damaged);
  assert.deepEqual(readJsonDocument(file, { onPreserved: copy => copies.push(copy) }), { keep: { a: 1 }, also: [1, 2] });
  assert.deepEqual(readJsonDocument(file, { onPreserved: copy => copies.push(copy) }), { keep: { a: 1 }, also: [1, 2] });
  assert.equal(new Set(copies).size, 1, "identical damaged bytes are copied once");
  assert.match(path.basename(copies[0]), /^store\.unreadable-.+\.json$/);
  assert.deepEqual(notices, [{ file, copy: copies[0] }], "one notice names each new copy");
  assert.equal(fs.readFileSync(copies[0], "utf8"), damaged);assert.equal(fs.readFileSync(file, "utf8"), damaged, "the read never changes the document");
  fs.writeFileSync(list, JSON.stringify([{ path: "/a" }]));
  assert.deepEqual(readJsonDocument(list, { array: true }), [{ path: "/a" }]);
  assert.equal(fs.readdirSync(root).filter(name => name.startsWith("list.unreadable-")).length, 0, "a valid array index is not copied");
  const read = fs.readFileSync;let reads = 0;
  t.mock.method(fs, "readFileSync", (target, ...args) => {
    if (target === list) {reads++;throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });}
    return read(target, ...args);
  });
  assert.throws(() => readJsonDocument(list, { array: true }), { code: "EIO" });
  assert.equal(reads, 3, "a read error is retried in place before it is reported");
});
