const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { watchFileChanges, watchDirectory } = require("../src/core/watch-files");
const { EventEmitter } = require("node:events");

const until = async (predicate, what) => {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`${what} was not observed.`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};
// A native stream that is not live yet: subscriptions exist but deliver nothing on their own.
function silentStream(t) {
  const subscriptions = [];
  t.mock.method(fs, "watch", (_directory, _options, changed) => {
    const handle = new EventEmitter();handle.close = () => {};
    subscriptions.push({ handle, changed });return handle;
  });
  return subscriptions;
}
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
// Mocked timers run one link of the window's timer chain per tick, so a whole window takes several.
const drain = t => { for (let step = 0; step < 8; step++) t.mock.timers.tick(2000); };

// These run first, so no reconciliation window from a real-timer test is pending.
test("an edit made before the native stream is live is reconciled once, within a bounded window", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "watch-reconcile-")), file = path.join(root, "cheats.json");
  fs.writeFileSync(file, "{}");fs.writeFileSync(path.join(root, "other.json"), "{}");
  t.mock.timers.enable({ apis: ["setTimeout"] });silentStream(t);
  let changes = 0;
  const watcher = watchFileChanges(file, () => changes++);
  try {
    await nextTurn();
    const armed = changes;
    fs.writeFileSync(file + ".new", "{\"a\":1}");fs.renameSync(file + ".new", file);
    t.mock.timers.tick(25);
    assert.equal(changes, armed + 1, "the replacement is reconciled");
    assert.equal(armed, 0, "an unchanged directory is not reported");
    fs.writeFileSync(path.join(root, "other.json"), "{\"unrelated\":1}");
    drain(t);
    assert.equal(changes, 1, "neither the reported replacement nor an unrelated entry is reported again");
    fs.writeFileSync(file, "{\"b\":2}");drain(t);
    assert.equal(changes, 1, "reconciliation ends after its window, so idle watchers do not poll");
  } finally { watcher.close();drain(t);fs.rmSync(root, { recursive: true, force: true }); }
});

test("arming another watcher reconciles an established watcher whose notification the replaced stream dropped", async t => {
  const first = fs.mkdtempSync(path.join(os.tmpdir(), "watch-established-")), second = fs.mkdtempSync(path.join(os.tmpdir(), "watch-added-"));
  const file = path.join(first, "settings.json");fs.writeFileSync(file, "{}");
  t.mock.timers.enable({ apis: ["setTimeout"] });const subscriptions = silentStream(t);
  let changes = 0, added = 0;
  const established = watchFileChanges(file, () => changes++);
  let other = null;
  try {
    await nextTurn();drain(t);
    const settled = changes;
    fs.writeFileSync(file, "{\"a\":1}");
    other = watchDirectory(second, () => added++);
    await nextTurn();
    t.mock.timers.tick(25);
    assert.equal(changes, settled + 1, "the established watcher reconciles its dropped edit");
    assert.equal(settled, 0);assert.equal(added, 0, "the unchanged new directory is not reported");
    // A native notification updates the snapshot, so the window does not repeat it.
    fs.writeFileSync(file, "{\"b\":2}");subscriptions[0].changed("change", "settings.json");
    assert.equal(changes, 2);
    drain(t);
    assert.equal(changes, 2);assert.equal(added, 0);
  } finally {
    other?.close();established.close();drain(t);
    for (const root of [first, second]) fs.rmSync(root, { recursive: true, force: true });
  }
});

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
