const fs = require("node:fs");
const path = require("node:path");

// macOS delivers directory events through one native stream per event loop and
// replaces that stream whenever a watcher is added or closed. Edits made before
// the new stream is live are never reported, for the watcher being armed and for
// every existing one. Each replacement therefore starts one bounded
// reconciliation window: armed watchers compare a small directory snapshot after
// 25 ms, then at doubling intervals up to 1.6 s (3.2 s in all), and report only
// entries that differ. Outside these windows nothing polls.
const RECONCILE_DELAYS = [25, 50, 100, 200, 400, 800, 1600], SNAPSHOT_ENTRIES = 1024;
const reconcilers = new Set();
let reconcileTimer = null, reconcileStep = 0;
function reconcileAll() {
  reconcileTimer = null;
  for (const reconcile of [...reconcilers]) reconcile();
  if (++reconcileStep < RECONCILE_DELAYS.length) {
    reconcileTimer = setTimeout(reconcileAll, RECONCILE_DELAYS[reconcileStep]);reconcileTimer.unref?.();
  }
}
function streamChanged() {
  clearTimeout(reconcileTimer);reconcileStep = 0;
  reconcileTimer = setTimeout(reconcileAll, RECONCILE_DELAYS[0]);reconcileTimer.unref?.();
}

function entryState(directory, name) {
  try { const stat = fs.lstatSync(path.join(directory, name), {bigint: true});return `${stat.ino}:${stat.size}:${stat.mtimeNs}`; }
  catch { return null; }
}
// Directory identity plus each entry's inode, size and modification time. A
// directory above the entry bound is compared by its own modification time.
function snapshot(directory) {
  const stat = fs.statSync(directory, {bigint: true});
  if (!stat.isDirectory()) throw new Error("The watched directory is unavailable.");
  const names = fs.readdirSync(directory), entries = names.length > SNAPSHOT_ENTRIES ? null : new Map();
  for (const name of entries ? names : []) { const state = entryState(directory, name);if (state !== null) entries.set(name, state); }
  return { identity: `${stat.dev}:${stat.ino}`, modified: stat.mtimeNs, entries };
}
function changedEntries(before, after) {
  if (!before.entries || !after.entries) return before.modified === after.modified ? [] : [null];
  const changed = [...after.entries].filter(([name, state]) => before.entries.get(name) !== state).map(([name]) => name);
  for (const name of before.entries.keys()) if (!after.entries.has(name)) changed.push(name);
  return changed;
}

// Watches a directory for entry changes. A watcher that cannot be created,
// because the directory is missing, or that fails later, is armed again after
// a bounded backoff (100 ms doubling to 2 s). A re-armed watcher reports one
// change, so edits made while it was down are not lost. Rename notifications
// invalidate the directory: native backends may report only an atomic write's
// temporary name. Returns {close()}.
function watchDirectory(directory, onChange, { persistent = true } = {}) {
  let watcher = null, timer = null, initial = null, delay = 0, closed = false, inode = null, baseline = null;
  const identity = () => {
    const stat = fs.statSync(directory, {bigint: true});
    if (!stat.isDirectory()) throw new Error("The watched directory is unavailable.");
    return `${stat.dev}:${stat.ino}`;
  };
  const drop = () => {
    const current = watcher;watcher = null;
    clearImmediate(initial);initial = null;
    reconcilers.delete(reconcile);
    try { current?.close(); } catch {}
    if (current && reconcilers.size) streamChanged();
  };
  const retry = () => {
    if (closed || timer) return;
    delay = delay ? Math.min(delay * 2, 2000) : 100;
    timer = setTimeout(() => { timer = null;arm(true); }, delay);
    if (!persistent) timer.unref?.();
  };
  // Reports entries that differ from the last snapshot, which notifications
  // the native stream delivers keep current.
  function reconcile() {
    const current = watcher;
    if (closed || !current) return;
    let next = null;
    try { next = snapshot(directory); } catch {}
    if (next?.identity !== inode) { drop();arm(true);return; }
    const changed = changedEntries(baseline, next);baseline = next;
    for (const name of changed) { if (closed || watcher !== current) return;onChange(name); }
  }
  function arm(rearmed) {
    if (closed || watcher) return;
    let current;
    try {
      const before = snapshot(directory);
      current = fs.watch(directory, {persistent}, (event, changed) => {
        if (closed || watcher !== current) return;
        let same = false;
        try { same = identity() === inode; } catch {}
        if (!same) { drop();arm(true);return; }
        const name = event === "rename" || changed == null ? null : String(changed);
        if (name === null) { try { baseline = snapshot(directory); } catch {} }
        else if (baseline.entries) { const state = entryState(directory, name);if (state === null) baseline.entries.delete(name);else baseline.entries.set(name, state); }
        onChange(name);
      });
      watcher = current;inode = before.identity;baseline = before;
      reconcilers.add(reconcile);streamChanged();
      if (identity() !== inode) { drop();retry();return; }
    }
    catch { if (watcher === current) drop();retry();return; }
    watcher.on("error", () => { if (watcher === current) { drop();retry(); } });
    delay = 0;
    // The first comparison runs after the poll phase and covers an immediate first edit.
    initial = setImmediate(() => { initial = null;reconcile(); });
    if (!persistent) initial.unref?.();
    if (rearmed) onChange(null);
  }
  arm(false);
  return { close() { closed = true;clearTimeout(timer);timer = null;drop(); } };
}

// Watch the containing directory so atomic replacements do not leave a watcher
// attached to an obsolete inode. The caller owns debouncing and watcher cleanup.
function watchFileChanges(filePath, onChange) {
  const filename = path.basename(filePath);
  return watchDirectory(path.dirname(filePath), changed => {
    if (changed == null || changed === filename) onChange();
  });
}

module.exports = { watchDirectory, watchFileChanges };
