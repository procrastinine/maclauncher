const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const SOURCE = require('./source.json');

function resolve(root, { platform = process.platform, macOSVersion } = {}) {
  if (platform !== 'darwin' || typeof root !== 'string' || !root) return null;
  // Darwin 25 corresponds to macOS 26. Injected versions are macOS versions.
  const major = macOSVersion === undefined ? Number(os.release().split('.')[0]) + 1 : Number(String(macOSVersion).split('.')[0]);
  if (!Number.isFinite(major) || major < 26) return null;
  try {
    const directory = fs.realpathSync(path.join(root, 'temporal/fsr4'));
    const metadata = JSON.parse(fs.readFileSync(path.join(directory, 'provider.json'), 'utf8'));
    if (metadata.providerABI !== 1 || metadata.complete !== true || metadata.commit !== SOURCE.commit ||
        metadata.library !== 'libmaclauncher-fsr4.dylib') return null;
    const library = path.join(directory, metadata.library);
    const build = path.join(directory, 'build');
    if (!fs.statSync(library).isFile() || !fs.statSync(build).isDirectory() ||
        !fs.statSync(path.join(directory, 'third_party/fsr411/initializers.bin')).isFile()) return null;
    return { directory, library, build, version: metadata.model, minimumMacOS: SOURCE.minimumMacOS };
  } catch { return null; }
}
function prepare(root, options) {
  const installed = resolve(root, options);
  if (!installed) return {};
  return { RESHADE_FSR4_LIBRARY: installed.library, FSR4_ROOT: installed.directory, FSR4_BUILD_DIR: installed.build };
}
module.exports = { resolve, prepare };
