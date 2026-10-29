const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { watchFileChanges } = require("../src/core/watch-files");

const until = async (predicate, what) => {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`${what} was not observed.`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};

test("a file watcher arms once its missing directory appears and follows a replaced directory", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "watch-files-")), directory = path.join(root, "settings"), file = path.join(directory, "cheats.json");
  let changes = 0;
  const watcher = watchFileChanges(file, () => changes++);
  t.after(() => { watcher.close();fs.rmSync(root, { recursive: true, force: true }); });
  // The directory does not exist yet: arming retries instead of failing.
  fs.mkdirSync(directory);fs.writeFileSync(file, "{}");
  await until(() => changes > 0, "The first change");
  // An atomic replacement of the file.
  let seen = changes;fs.writeFileSync(file + ".new", "{\"a\":1}");fs.renameSync(file + ".new", file);
  await until(() => changes > seen, "The replacement");
  // The directory is removed and created again; a later edit is still seen.
  fs.rmSync(directory, { recursive: true });fs.mkdirSync(directory);
  seen = changes;fs.writeFileSync(file, "{\"b\":2}");
  await until(() => changes > seen, "The edit in the new directory");
  // After close, no further change is reported.
  watcher.close();seen = changes;fs.writeFileSync(file, "{\"c\":3}");
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(changes, seen);
});
