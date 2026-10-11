const fs = require("node:fs");
const path = require("node:path");

// Watch the containing directory so atomic replacements do not leave a watcher
// attached to an obsolete inode. The caller owns debouncing and watcher cleanup.
function watchFileChanges(filePath, onChange) {
  const filename = path.basename(filePath);
  return fs.watch(path.dirname(filePath), (_event, changed) => {
    if (changed == null || String(changed) === filename) onChange();
  });
}

module.exports = { watchFileChanges };
