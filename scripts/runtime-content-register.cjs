const { registerHooks } = require('node:module');
const { fileURLToPath } = require('node:url');
const path = require('node:path');
const fs = require('node:fs');
const { assertOwnedImport } = require('./runtime-content.cjs');

// Direct development entry points and Node worker preloads share this guard.
// Environment variables, including the user's NODE_OPTIONS, remain unchanged.
install(path.resolve(__dirname, '..'));
// Electron's worker defaults retain its startup flags, not later changes to
// process.execArgv. Supply the Node preload explicitly for backend workers;
// ordinary game/helper environments and the Electron startup flags stay intact.
const threads = require('node:worker_threads');
const Worker = threads.Worker;
threads.Worker = class DevelopmentWorker extends Worker {
  constructor(filename, options = {}) {
    const execArgv = [...(options.execArgv || process.execArgv)];
    if (!execArgv.includes(__filename)) execArgv.push('--require', __filename);
    super(filename, { ...options, execArgv });
  }
};
require('node:module').syncBuiltinESMExports();
function install(root) {
  if (typeof registerHooks !== 'function') throw new Error('Development runtime import checks require Node 22.15 or later.');
  root = fs.realpathSync(root);
  // Resolution hooks run for every require call, including cached modules, so
  // each resolved file is checked once per thread.
  const checked = new Set();
  return registerHooks({ resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    if (result.url.startsWith('file:') && !checked.has(result.url)) {
      assertOwnedImport(root, fileURLToPath(result.url));
      checked.add(result.url);
    }
    return result;
  } });
}
module.exports = { install };
