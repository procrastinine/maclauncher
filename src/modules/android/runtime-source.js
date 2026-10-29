const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// Runtime implementations and producer inputs have one pinned source owner.
// Application packages retain only its small launcher-facing metadata closure.
function root() {
  return require('./included-files').file('runtime');
}
function file(relative, { sourceRoot = root() } = {}) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\') ||
      path.posix.isAbsolute(relative) || relative.split('/').some(part => !part || part === '.' || part === '..'))
    throw new Error('Invalid Android source member.');
  const selected = path.join(sourceRoot, 'src/modules/android', relative);
  if (!fs.statSync(selected).isFile()) throw new Error('The Android source member is unavailable: ' + relative);
  return selected;
}
function moduleUrl(relative, options) { return pathToFileURL(file(relative, options)).href; }
function json(relative, options) { return JSON.parse(fs.readFileSync(file(relative, options), 'utf8')); }

module.exports = { root, file, moduleUrl, json };
