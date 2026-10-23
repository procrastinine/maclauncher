const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ENV = 'RESHADE_BROWSER_FRAME_STATE';
const TOKEN = 'RESHADE_BROWSER_FRAME_TOKEN';
// This runs only for a dedicated browser host, after ordinary graphics
// preparation has selected and verified its native payload. Older payloads
// retain their existing renderer hooks; there is no version allowlist.
function browserGraphicsEnvironment(environment, {platform = process.platform} = {}) {
  const result = {...environment};
  delete result[ENV];delete result[TOKEN];
  if (platform !== 'darwin' || !result.RESHADE_WINDOW_STATE || !result.RESHADE_CONTROL_FILE) return result;
  const libraries = (result.DYLD_INSERT_LIBRARIES || '').split(':').filter(Boolean);
  const library = libraries.find(file => path.basename(file) === 'libreshade-macos.dylib');
  if (!library) return result;
  try {
    const stat = fs.lstatSync(library);
    if (!stat.isFile() || stat.isSymbolicLink()) return result;
    const metadata = JSON.parse(fs.readFileSync(path.join(path.dirname(library), 'runtime.json'), 'utf8'));
    if (metadata.features?.graphics?.browserFrameAPI !== 1) return result;
    const launch = JSON.parse(fs.readFileSync(path.join(path.dirname(result.RESHADE_CONTROL_FILE), 'launch.json'), 'utf8'));
    if (!/^[a-f0-9-]{36}$/i.test(launch.launchId || '')) return result;
    const token = crypto.randomBytes(16), bytes = Buffer.alloc(64);
    bytes.write('MLBRSRC1');token.copy(bytes, 8);
    const file = path.join(path.dirname(result.RESHADE_CONTROL_FILE), `browser-source-${launch.launchId}.state`);
    fs.writeFileSync(file, bytes, {mode: 0o600, flag: 'wx'});
    return {...result, [ENV]: file, [TOKEN]: token.toString('hex')};
  } catch { return result; } // Original renderer remains available.
}
const adaptedContexts = new WeakSet();
// Browser capability belongs to this launch's prepared processor environment.
// The core can merge that environment again at a Steam/process adapter handoff;
// putting channels only in its base environment would deliberately strip them.
function installBrowserGraphicsContext(context) {
  if (!context || typeof context.getGameEffectsEnvironment !== 'function' || adaptedContexts.has(context)) return;
  const prepare = context.getGameEffectsEnvironment, prepared = new WeakMap();
  context.getGameEffectsEnvironment = async function(options) {
    const original = await prepare.call(context, options);
    if (!original || typeof original !== 'object') return original;
    if (!prepared.has(original)) prepared.set(original, browserGraphicsEnvironment(original));
    return prepared.get(original);
  };
  adaptedContexts.add(context);
}
async function prepareBrowserGraphicsEnvironment(context, environment, {needsRosetta} = {}) {
  installBrowserGraphicsContext(context);
  if (typeof context?.applyGameEnvironment === 'function')
    return context.applyGameEnvironment(environment, {needsRosetta});
  if (typeof context?.getGameEffectsEnvironment === 'function')
    return require('../../reshade').mergeEnvironment(environment || process.env,
      await context.getGameEffectsEnvironment({needsRosetta}));
  return browserGraphicsEnvironment(environment);
}
module.exports = {browserGraphicsEnvironment, installBrowserGraphicsContext, prepareBrowserGraphicsEnvironment, ENV, TOKEN};
