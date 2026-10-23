const { registerHooks } = require('node:module');
const { fileURLToPath } = require('node:url');
const path = require('node:path');
const fs = require('node:fs');
const { assertOwnedImport } = require('./runtime-content.cjs');

// Remove only this launch's injected option before any game/helper can inherit
// the environment. Existing user NODE_OPTIONS remain exactly as supplied.
if (process.env.MACLAUNCHER_DEV_CONTENT_GUARD === '1') {
  if (process.env.MACLAUNCHER_DEV_ORIGINAL_NODE_OPTIONS_PRESENT === '1') process.env.NODE_OPTIONS = process.env.MACLAUNCHER_DEV_ORIGINAL_NODE_OPTIONS || '';
  else delete process.env.NODE_OPTIONS;
  delete process.env.MACLAUNCHER_DEV_CONTENT_GUARD;
  delete process.env.MACLAUNCHER_DEV_ORIGINAL_NODE_OPTIONS;
  delete process.env.MACLAUNCHER_DEV_ORIGINAL_NODE_OPTIONS_PRESENT;
}
// Node also preloads this module in launcher Worker threads. Their inherited
// environment has already been sanitized, so installation cannot depend on the
// one-use cleanup marker. Third-party child processes receive no preload option.
install(path.resolve(__dirname, '..'));
function install(root) {
  if (typeof registerHooks !== 'function') throw new Error('Development runtime import checks require Node 22.15 or later.');
  root = fs.realpathSync(root);
  return registerHooks({ resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    if (result.url.startsWith('file:')) assertOwnedImport(root, fileURLToPath(result.url));
    return result;
  } });
}
module.exports = { install };
