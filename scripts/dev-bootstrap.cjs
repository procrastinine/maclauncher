// Development Electron can have a branded, packaged identity. Its main process
// loads the content boundary directly, without adding unsupported NODE_OPTIONS.
require('./runtime-content-register.cjs');

const path = require('node:path');
const { app } = require('electron');
const root = path.resolve(__dirname, '..');
const entry = path.resolve(root, process.argv[2] || '.');
// Preserve the original application entry and document arguments. These are
// the same application metadata setters used by Electron's default app loader.
process.argv.splice(1, 1);
app.setAppPath(root);
app.setVersion(require('../package.json').version);
require(entry);
