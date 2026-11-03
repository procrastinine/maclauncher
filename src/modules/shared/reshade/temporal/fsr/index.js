const fs = require('node:fs');
const path = require('node:path');
const Host = require('../../../runtime/host-capabilities');
const Requirements = require('../../../runtime/feature-requirements');
const Payload = require('../../../runtime/payload-files');
const source = require('./source.json');

function inspect(root) {
  if (typeof root !== 'string' || !root) return null;
  try {
    const directory = fs.realpathSync(path.join(root, 'temporal/fsr'));
    const methods = [], libraries = {}, minimumMacOSByMethod = {};
    for (const method of ['fsr2', 'fsr3']) {
      try {
        const metadata = JSON.parse(fs.readFileSync(path.join(directory, `${method}-build.json`), 'utf8'));
        const library = path.join(directory, `libmaclauncher-${method}.dylib`);
        if (metadata.commit !== source[method].commit || metadata.providerABI !== 1 || metadata.shaderVariants !== 16 || !fs.statSync(library).isFile()) continue;
        if (!Payload.exists(directory, method)) continue;
        methods.push(method); libraries[method] = library;
        minimumMacOSByMethod[method] = metadata.minimumMacOS && Requirements.versionAtLeast(metadata.minimumMacOS, source.minimumMacOS)
          ? metadata.minimumMacOS : source.minimumMacOS;
      } catch { /* An unavailable algorithm does not hide another installed one. */ }
    }
    return methods.length ? { directory, methods, libraries, minimumMacOS: source.minimumMacOS, minimumMacOSByMethod } : null;
  } catch { return null; }
}
function resolve(root, { platform = process.platform, macOSVersion } = {}) {
  const installed = inspect(root);
  if (!installed) return null;
  const actual = { platform, macOSVersion: macOSVersion === undefined ? Host.getHostCapabilities().macOSVersion : macOSVersion };
  const methods = installed.methods.filter(method => Requirements.requirementSupport({ platform: 'darwin',
    minimumMacOS: installed.minimumMacOSByMethod[method] }, actual).supported !== false);
  if (!methods.length) return null;
  const minimumMacOS = methods.reduce((floor, method) => Requirements.versionAtLeast(installed.minimumMacOSByMethod[method], floor)
    ? installed.minimumMacOSByMethod[method] : floor, source.minimumMacOS);
  return { ...installed, methods, minimumMacOS, libraries: Object.fromEntries(methods.map(method => [method, installed.libraries[method]])) };
}
function prepare(root, options) {
  const installed = resolve(root, options);
  if (!installed) return {};
  return {
    RESHADE_FSR_SHADER_DIRECTORY: installed.directory,
    ...Object.fromEntries(installed.methods.map(method => [`RESHADE_${method.toUpperCase()}_LIBRARY`, installed.libraries[method]])),
  };
}
module.exports = { inspect, resolve, prepare };
