const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const source = require('./source.json');

function resolve(root, { platform = process.platform, macOSVersion } = {}) {
  if (platform !== 'darwin' || typeof root !== 'string' || !root) return null;
  const major = macOSVersion === undefined ? Number(os.release().split('.')[0]) - 9 : Number(String(macOSVersion).split('.')[0]);
  if (!Number.isFinite(major) || major < 13) return null;
  try {
    const directory = fs.realpathSync(path.join(root, 'temporal/fsr'));
    const methods = [], libraries = {};
    for (const method of ['fsr2', 'fsr3']) {
      try {
        const metadata = JSON.parse(fs.readFileSync(path.join(directory, `${method}-build.json`), 'utf8'));
        const library = path.join(directory, `libmaclauncher-${method}.dylib`);
        if (metadata.commit !== source[method].commit || metadata.providerABI !== 1 || metadata.shaderVariants !== 16 || !fs.statSync(library).isFile()) continue;
        if (!fs.statSync(path.join(directory, method)).isDirectory()) continue;
        methods.push(method); libraries[method] = library;
      } catch { /* An unavailable algorithm does not hide another installed one. */ }
    }
    return methods.length ? { directory, methods, libraries, minimumMacOS: source.minimumMacOS } : null;
  } catch { return null; }
}
function prepare(root, options) {
  const installed = resolve(root, options);
  if (!installed) return {};
  return {
    RESHADE_FSR_SHADER_DIRECTORY: installed.directory,
    ...Object.fromEntries(installed.methods.map(method => [`RESHADE_${method.toUpperCase()}_LIBRARY`, installed.libraries[method]])),
  };
}
module.exports = { resolve, prepare };
