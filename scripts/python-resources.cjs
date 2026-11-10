const fs = require('node:fs');
const path = require('node:path');
const profile = require('../src/modules/shared/runtime/embedded-python.json');
const { embeddedPythonProfile } = require('../src/modules/shared/runtime/python');

const policy = profile.appPayload;
function relative(value) {
  if (typeof value !== 'string' || !value || path.posix.normalize(value) !== value ||
      value.startsWith('/') || value.split('/').some(part => part === '..' || part === '.') || /[\\\0\r\n]/.test(value))
    throw new Error('Embedded Python payload paths must stay within its resource directory.');
  return value;
}
function configuration() {
  if (!policy || policy.interpreter !== 'bin/python3' || !Array.isArray(policy.exclude) ||
      !policy.aliases || Object.keys(policy.aliases).length !== 2) throw new Error('The embedded Python app payload is not configured.');
  for (const [alias, target] of Object.entries(policy.aliases)) {
    relative(alias);
    if (path.posix.dirname(alias) !== 'bin' || target !== 'python3' || alias === policy.interpreter)
      throw new Error('Embedded Python aliases must resolve to its canonical interpreter.');
  }
  policy.exclude.forEach(relative);
  return policy;
}
// Documentation that the interpreter never reads: README files and reStructuredText.
// Licence and notice files are not documentation and stay in the app.
const DOCUMENTATION = ['**/README*', '**/*.rst'];
function documentation(file) {
  return /(?:^|\/)README[^/]*$/.test(file) || /\.rst$/.test(file);
}
function excluded(file) {
  return documentation(file) || configuration().exclude.some(pattern => {
    const expression = pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*');
    return new RegExp('^' + expression + '(?:/|$)').test(file);
  });
}
function resourceExclusions() {
  const selected = configuration();
  return [...[...selected.exclude, ...Object.keys(selected.aliases)].flatMap(file => ['!python/' + file, '!python/' + file + '/**']),
    ...DOCUMENTATION.map(pattern => '!python/' + pattern)];
}
function directory(root) {
  if (!fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink()) throw new Error('Embedded Python needs a real resource directory.');
  return fs.realpathSync(root);
}
// The installed tree must be the publisher build for the app's CPU.
function assertProfile(metadata, arch) {
  const expected = embeddedPythonProfile(arch);
  for (const key of ['version', 'abi', 'architecture', 'publisher', 'release', 'url', 'sha256', 'packages'])
    if (JSON.stringify(metadata[key]) !== JSON.stringify(expected[key]))
      throw new Error(`The embedded Python is not the ${arch} build of its pinned profile. Run node scripts/setup-python-runtime.mjs --arch ${arch}.`);
  return expected;
}
function projectPackagedPython({ sourceRoot, resourceRoot }) {
  const source = directory(sourceRoot), target = directory(resourceRoot);
  if (source === target || source.startsWith(target + path.sep) || target.startsWith(source + path.sep))
    throw new Error('Python app projection must be separate from its producer files.');
  directory(path.join(target, 'bin'));
  directory(path.join(source, 'bin'));
  const selected = configuration(), canonical = fs.lstatSync(path.join(source, selected.interpreter));
  if (!canonical.isFile() || canonical.isSymbolicLink()) throw new Error('Embedded Python needs regular producer files.');
  // Replace only generated bundle aliases. Producer files stay unchanged.
  for (const [alias, link] of Object.entries(selected.aliases)) {
    const file = path.join(target, alias), stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink() && fs.readlinkSync(file) === link) continue;
    if (stat) fs.unlinkSync(file);
    fs.symlinkSync(link, file);
  }
  return { version: profile.version, interpreter: selected.interpreter, aliases: selected.aliases };
}

module.exports = { configuration, excluded, resourceExclusions, assertProfile, projectPackagedPython };
