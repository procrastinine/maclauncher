const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { writeSaveWithBackup } = require("../src/modules/shared/save-files");
const Codec = require("../src/modules/shared/mvmz/rpgmaker-save");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-save-write-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, "save.rmmzsave");
}

test("save replacement backs up original bytes and preserves MZ's on-disk string convention", t => {
  const file = fixture(t);
  const original = Buffer.from([0, 255, 128, 1]);
  fs.writeFileSync(file, original);
  const json = JSON.stringify({ label: "日本語", gold: 9000 });
  const encoded = Codec.encodeSave("mz", json);
  writeSaveWithBackup(file, encoded);
  assert.deepEqual(fs.readFileSync(`${file}.maclauncher.bak`), original);
  assert.equal(Codec.decodeSave("mz", fs.readFileSync(file, "utf8")), json);
  assert.equal(fs.readdirSync(path.dirname(file)).length, 2);
});

test("failed backup aborts save replacement and cleans temporary data", t => {
  const file = fixture(t);
  fs.writeFileSync(file, "original");
  t.mock.method(fs, "copyFileSync", () => { throw new Error("Backup failed"); });
  assert.throws(() => writeSaveWithBackup(file, "new"), /Backup failed/);
  assert.equal(fs.readFileSync(file, "utf8"), "original");
  assert.deepEqual(fs.readdirSync(path.dirname(file)), [path.basename(file)]);
});

test("failed atomic replacement leaves original and backup intact", t => {
  const file = fixture(t);
  fs.writeFileSync(file, "original");
  t.mock.method(fs, "renameSync", () => { throw new Error("Rename failed"); });
  assert.throws(() => writeSaveWithBackup(file, "new"), /Rename failed/);
  assert.equal(fs.readFileSync(file, "utf8"), "original");
  assert.equal(fs.readFileSync(`${file}.maclauncher.bak`, "utf8"), "original");
  assert.equal(fs.readdirSync(path.dirname(file)).length, 2);
});

test("save backups cannot overwrite symlink targets", t => {
  const file = fixture(t);
  const other = `${file}.other`;
  fs.writeFileSync(file, "original");
  fs.writeFileSync(other, "other");
  fs.symlinkSync(other, `${file}.maclauncher.bak`);
  assert.throws(() => writeSaveWithBackup(file, "new"), /regular file/);
  assert.equal(fs.readFileSync(other, "utf8"), "other");
  assert.equal(fs.readFileSync(file, "utf8"), "original");
});
