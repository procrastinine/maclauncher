// Restore source modes and aliases on the files Builder actually copied.
const fs = require('node:fs');
const path = require('node:path');
const B = require('../src/modules/shared/runtime/bundled-native');

function restoreCopiedNativePayload({ sourceRoot, resourceRoot } = {}) {
  const source = path.resolve(sourceRoot), destination = path.resolve(resourceRoot);
  if (source === destination || source.startsWith(destination + path.sep) || destination.startsWith(source + path.sep)) throw new Error('Native source and copied app resources must be separate directories.');
  B.realDirectory(source);
  B.realDirectory(destination, { create: true });
  let files = 0, restoredFiles = 0, restoredModes = 0;
  function walk(relative) {
    const directory = path.join(destination, relative); B.realDirectory(directory);
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const name = relative ? path.join(relative, item.name) : item.name;
      const original = path.join(source, name), target = path.join(destination, name), stat = fs.lstatSync(original, { throwIfNoEntry: false });
      if (!stat) continue;
      if (stat.isSymbolicLink()) {
        const link = fs.readlinkSync(original), resolved = path.resolve(path.dirname(original), link);
        if (path.isAbsolute(link) || !resolved.startsWith(source + path.sep) || !fs.realpathSync(original).startsWith(source + path.sep)) throw new Error('Native source aliases must stay within their resource directory.');
        if (item.isSymbolicLink() && fs.readlinkSync(target) === link) continue;
        if (item.isFile() || item.isSymbolicLink()) { fs.unlinkSync(target); fs.symlinkSync(link, target); restoredFiles++; }
      } else if (item.isDirectory() && stat.isDirectory()) walk(name);
      else if (item.isFile() && stat.isFile()) {
        files++;
        const mode = stat.mode & 0o777;
        if ((fs.lstatSync(target).mode & 0o777) !== mode) { fs.chmodSync(target, mode); restoredModes++; }
      }
    }
  }
  walk('');
  return { files, restoredFiles, restoredModes };
}

module.exports = { restoreCopiedNativePayload };
