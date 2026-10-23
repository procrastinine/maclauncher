const path = require('node:path');

const extensionClass = 'com.maclauncher.android.ashmem';
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const regex = value => '#"' + value.replaceAll('"', '\\"') + '"';

/** An authenticated descriptor transfer delegates one anonymous memory file.
 * Neither its producer's directory nor neighboring files become readable. */
function capabilities(temporaryDirectories) {
  // Seatbelt's regex grammar does not implement counted repetitions.
  const suffix = '[A-Za-z0-9]'.repeat(6);
  const rules = [...new Set(temporaryDirectories.map(directory => path.resolve(directory)))].map(directory =>
    `(regex ${regex('^' + escape(directory) + '/(binder-memory-|aim-ashmem\\.|linux-abi-ashmem\\.)' + suffix + '$')})`);
  const recipient = `\n(allow file-read* file-write-data file-write-xattr file-map-executable (extension "${extensionClass}"))\n`;
  return recipient + (rules.length
    ? `(allow file-issue-extension (require-all (extension-class "${extensionClass}") (require-any ${rules.join(' ')})))\n`
    : '');
}

module.exports = {extensionClass, capabilities};
