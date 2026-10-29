const fs = require("node:fs");
const path = require("node:path");

// Watches a directory for entry changes. A watcher that cannot be created,
// because the directory is missing, or that fails later, is armed again after
// a bounded backoff (100 ms doubling to 2 s). A re-armed watcher reports one
// change, so edits made while it was down are not lost. Returns {close()}.
function watchDirectory(directory, onChange, { persistent = true } = {}) {
  let watcher = null, timer = null, delay = 0, closed = false;
  const drop = () => {
    const current = watcher;watcher = null;
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
    try { watcher = fs.watch(directory, {persistent}, (_event, changed) => onChange(changed == null ? null : String(changed))); }
    catch { retry();return; }
    watcher.on("error", () => { drop();retry(); });
    delay = 0;
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
