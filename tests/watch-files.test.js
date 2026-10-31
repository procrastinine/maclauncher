const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { watchFileChanges } = require("../src/core/watch-files");
const { EventEmitter } = require("node:events");

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

test("atomic replacement reported only under its temporary filename invalidates the watched file", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "watch-rename-"));
  const subscriptions = [];
  t.mock.method(fs, "watch", (_directory, _options, changed) => {
    const handle = new EventEmitter();handle.close = () => {};
    subscriptions.push({ handle, changed });return handle;
  });
  let changes = 0;
  const watcher = watchFileChanges(path.join(root, "settings.json"), () => changes++);
  t.after(() => { watcher.close();fs.rmSync(root, {recursive: true, force: true}); });
  subscriptions[0].changed("change", "unrelated.json");assert.equal(changes, 0);
  subscriptions[0].changed("rename", "settings.json.new");assert.equal(changes, 1);
  watcher.close();subscriptions[0].changed("rename", "settings.json.new");assert.equal(changes, 1);
});

test("a directory replacement rearms the new inode and retired watchers cannot close it", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "watch-inode-")), directory = path.join(root, "settings");
  fs.mkdirSync(directory);
  const subscriptions = [];
  t.mock.method(fs, "watch", (_directory, _options, changed) => {
    const handle = new EventEmitter();handle.closed = false;handle.close = () => { handle.closed = true; };
    subscriptions.push({ handle, changed });return handle;
  });
  let changes = 0;
  const watcher = watchFileChanges(path.join(directory, "settings.json"), () => changes++);
  t.after(() => { watcher.close();fs.rmSync(root, {recursive: true, force: true}); });
  fs.renameSync(directory, directory + ".old");fs.mkdirSync(directory);
  subscriptions[0].changed("rename", "settings");
  assert.equal(subscriptions.length, 2);assert.equal(subscriptions[0].handle.closed, true);assert.equal(changes, 1);
  subscriptions[0].handle.emit("error", new Error("Retired inode"));
  assert.equal(subscriptions[1].handle.closed, false);
  subscriptions[1].changed("change", "settings.json");assert.equal(changes, 2);
});

test("arming reconciles an immediate first edit even when no native notification arrives", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "watch-initial-"));
  t.mock.method(fs, "watch", () => { const handle = new EventEmitter();handle.close = () => {};return handle; });
  let observed;
  const file = path.join(root, "settings.json"), watcher = watchFileChanges(file, () => { observed = fs.readFileSync(file, "utf8"); });
  t.after(() => { watcher.close();fs.rmSync(root, {recursive: true, force: true}); });
  fs.writeFileSync(file, "immediate edit");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(observed, "immediate edit");
});
