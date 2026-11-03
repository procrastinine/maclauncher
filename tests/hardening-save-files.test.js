const assert = require("node:assert/strict");
const ChildProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { writeSaveWithBackup } = require("../src/modules/shared/save-files");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-hardening-save-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, "save.dat");
}

test("a backup copy failure preserves the previous recovery backup", t => {
  const file = fixture(t);
  const backup = `${file}.maclauncher.bak`;
  fs.writeFileSync(file, "current save");
  fs.writeFileSync(backup, "previous recovery save");
  const failure = Object.assign(new Error("No space left"), { code: "ENOSPC" });
  let copies = 0;
  const partialCopy = (source, destination) => {
    assert.equal(source, file);
    copies++;
    fs.writeFileSync(destination, "partial copy");
    return failure;
  };
  t.mock.method(fs, "copyFileSync", (source, destination) => { throw partialCopy(source, destination); });
  // Darwin preserves metadata through cp; other platforms use Node's copy.
  const spawnSync = ChildProcess.spawnSync;
  t.mock.method(ChildProcess, "spawnSync", (command, args, options) =>
    command === "/bin/cp" && args[0] === "-p"
      ? { error: partialCopy(args[1], args[2]) }
      : spawnSync(command, args, options));
  assert.throws(() => writeSaveWithBackup(file, "edited save"), error => error === failure && /No space left/.test(error.message));
  assert.equal(copies, 1);
  assert.equal(fs.readFileSync(file, "utf8"), "current save");
  assert.equal(fs.readFileSync(backup, "utf8"), "previous recovery save");
  assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), ["save.dat", "save.dat.maclauncher.bak"]);
});

test("replacing a hard-linked backup cannot overwrite another save file", t => {
  const file = fixture(t);
  const other = path.join(path.dirname(file), "other.dat");
  const backup = `${file}.maclauncher.bak`;
  fs.writeFileSync(file, "current save");
  fs.writeFileSync(other, "other save");
  fs.linkSync(other, backup);
  writeSaveWithBackup(file, "edited save");
  assert.equal(fs.readFileSync(other, "utf8"), "other save");
  assert.equal(fs.readFileSync(backup, "utf8"), "current save");
  assert.equal(fs.readFileSync(file, "utf8"), "edited save");
});

test("failed publication of a backup leaves both previous files intact", t => {
  const file = fixture(t);
  const backup = `${file}.maclauncher.bak`;
  fs.writeFileSync(file, "current save");
  fs.writeFileSync(backup, "previous recovery save");
  t.mock.method(fs, "renameSync", () => { throw new Error("Rename failed"); });
  assert.throws(() => writeSaveWithBackup(file, "edited save"), /Rename failed/);
  assert.equal(fs.readFileSync(file, "utf8"), "current save");
  assert.equal(fs.readFileSync(backup, "utf8"), "previous recovery save");
  assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), ["save.dat", "save.dat.maclauncher.bak"]);
});

test("successful repeated edits back up the latest original bytes and preserve backup permissions", t => {
  const file = fixture(t);
  fs.writeFileSync(file, Buffer.from([0, 128, 255]), { mode: 0o600 });
  writeSaveWithBackup(file, Buffer.from([1, 129, 254]));
  fs.chmodSync(`${file}.maclauncher.bak`, 0o400);
  writeSaveWithBackup(file, Buffer.from([2, 130, 253]));
  assert.deepEqual(fs.readFileSync(`${file}.maclauncher.bak`), Buffer.from([1, 129, 254]));
  assert.deepEqual(fs.readFileSync(file), Buffer.from([2, 130, 253]));
  assert.equal(fs.statSync(`${file}.maclauncher.bak`).mode & 0o777, 0o400);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("valid long save filenames do not make temporary filenames exceed filesystem limits", t => {
  const file = path.join(path.dirname(fixture(t)), `${"a".repeat(220)}.dat`);
  fs.writeFileSync(file, "current save");
  writeSaveWithBackup(file, "edited save");
  assert.equal(fs.readFileSync(file, "utf8"), "edited save");
  assert.equal(fs.readFileSync(`${file}.maclauncher.bak`, "utf8"), "current save");
});
