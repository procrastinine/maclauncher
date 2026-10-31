const fs = require("node:fs");
const path = require("node:path");

// Watches a directory for entry changes. A watcher that cannot be created,
// because the directory is missing, or that fails later, is armed again after
// a bounded backoff (100 ms doubling to 2 s). A re-armed watcher reports one
// change, so edits made while it was down are not lost. Rename notifications
// invalidate the directory: native backends may report only an atomic write's
// temporary name. Returns {close()}.
function watchDirectory(directory, onChange, { persistent = true } = {}) {
  let watcher = null, timer = null, initial = null, delay = 0, closed = false;
  const identity = () => {
    const stat = fs.statSync(directory, {bigint: true});
    if (!stat.isDirectory()) throw new Error("The watched directory is unavailable.");
    return `${stat.dev}:${stat.ino}`;
  };
  const drop = () => {
    const current = watcher;watcher = null;
    clearImmediate(initial);initial = null;
    try { current?.close(); } catch {}
  };
  const retry = () => {
    if (closed || timer) return;
    delay = delay ? Math.min(delay * 2, 2000) : 100;
    timer = setTimeout(() => { timer = null;arm(true); }, delay);
    if (!persistent) timer.unref?.();
  };
  function arm(rearmed) {
    if (closed || watcher) return;
    let current, inode;
    try {
      inode = identity();
      current = fs.watch(directory, {persistent}, (event, changed) => {
        if (closed || watcher !== current) return;
        let same = false;
        try { same = identity() === inode; } catch {}
        if (!same) { drop();arm(true);return; }
        onChange(event === "rename" || changed == null ? null : String(changed));
      });
      watcher = current;
      if (identity() !== inode) { drop();retry();return; }
    }
    catch { if (watcher === current) drop();retry();return; }
    watcher.on("error", () => { if (watcher === current) { drop();retry(); } });
    delay = 0;
    // Reconcile once after the poll phase as native watcher registration can
    // finish after fs.watch returns. This also covers an immediate first edit.
    initial = setImmediate(() => { initial = null;if (!closed && watcher === current) onChange(null); });
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
