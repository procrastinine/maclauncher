// Backcompat: MacLauncher 0.6.1 and earlier gave hosted web games (RPG Maker
// MV and MZ and the other web engines) an HTTP disk cache in their storage
// partition. The host serves every asset from its local server, so that cache
// only held a second copy of game files. Game sessions now run without it, and
// launching a game removes a cache left by those versions. Saves and the V8
// code cache live in other partition folders and stay. Remove when profiles
// from those versions are no longer supported.
const fs = require('node:fs');
const path = require('node:path');

// Removes the former HTTP cache folder in one game's partition. Returns true
// when a folder was removed.
function removeFormerHttpCache(partitionDir, logger = console) {
  const cache = path.join(partitionDir, 'Cache');
  try {
    if (!fs.lstatSync(cache, { throwIfNoEntry: false })) return false;
    fs.rmSync(cache, { recursive: true, force: true });
    return true;
  } catch (error) {
    logger?.warn?.('[backcompat] The former web game cache could not be removed: ' + error.message);
    return false;
  }
}

module.exports = { removeFormerHttpCache };
