'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// The separate MacLauncher Builds project is checked out as maclauncher-builds beside the app
// repository. A linked worktree of the app finds it beside the primary checkout.
const root = path.resolve(__dirname, '../..');

function candidates() {
  const found = [path.resolve(root, '../maclauncher-builds')];
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 }).trim();
    found.push(path.resolve(common, '../../maclauncher-builds'));
  } catch {}
  return [...new Set(found)];
}

// Returns { root, skip }: the checkout holding every relative file, or a skip reason naming the
// files and the directories searched.
function buildsCheckout(...files) {
  const searched = candidates();
  const checkout = searched.find(directory => files.every(file => fs.existsSync(path.join(directory, file))));
  return checkout ? { root: checkout, skip: false } : { root: searched[0],
    skip: 'Optional Builds integration; needs ' + files.join(' and ') + ' in a maclauncher-builds checkout at ' + searched.join(' or ') + '.' };
}

module.exports = { buildsCheckout };
