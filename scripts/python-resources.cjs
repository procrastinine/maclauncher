const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const profile = require('../src/modules/shared/runtime/embedded-python.json');

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
function excluded(file) {
  return configuration().exclude.some(pattern => {
    const expression = pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*');
    return new RegExp('^' + expression + '(?:/|$)').test(file);
  });
}
function resourceExclusions() {
  const selected = configuration();
  return [...selected.exclude, ...Object.keys(selected.aliases)].flatMap(file => ['!python/' + file, '!python/' + file + '/**']);
}
function directory(root) {
  if (!fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink()) throw new Error('Embedded Python needs a real resource directory.');
  return fs.realpathSync(root);
}
function regular(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Embedded Python needs regular producer files.');
  return { stat, bytes: fs.readFileSync(file) };
}
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function verifySourcePython({ sourceRoot }) {
  const root = directory(sourceRoot), selected = configuration();
  directory(path.join(root, 'bin'));
  const canonical = regular(path.join(root, selected.interpreter));
  if (!(canonical.stat.mode & 0o111)) throw new Error('The embedded Python interpreter is not executable.');
  const sha256 = digest(canonical.bytes);
  for (const alias of Object.keys(selected.aliases)) {
    const file = regular(path.join(root, alias));
    if (digest(file.bytes) !== sha256) throw new Error('Embedded Python aliases differ from the canonical producer executable.');
  }
  return { interpreter: selected.interpreter, bytes: canonical.stat.size, sha256 };
}
function assertPackagedPython({ resourceRoot }) {
  const root = directory(resourceRoot), selected = configuration(), canonicalPath = path.join(root, selected.interpreter);
  directory(path.join(root, 'bin'));
  const canonical = regular(canonicalPath);
  if (!(canonical.stat.mode & 0o111)) throw new Error('The embedded Python interpreter is not executable.');
  const metadata = JSON.parse(regular(path.join(root, 'runtime.json')).bytes);
  for (const key of ['version', 'abi', 'architecture', 'publisher', 'release', 'sha256'])
    if (metadata[key] !== profile[key]) throw new Error('Packaged Python differs from its pinned profile.');
  for (const [alias, target] of Object.entries(selected.aliases)) {
    const file = path.join(root, alias);
    if (!fs.lstatSync(file).isSymbolicLink() || fs.readlinkSync(file) !== target || fs.realpathSync(file) !== canonicalPath)
      throw new Error('A packaged Python alias escapes or duplicates its canonical interpreter.');
  }
  for (const file of requiredFiles) regular(path.join(root, file));
  let files = 0;
  function walk(parent, prefix = '') {
    for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
      const name = prefix ? prefix + '/' + entry.name : entry.name, file = path.join(parent, entry.name);
      if (excluded(name)) throw new Error('Packaged Python contains a build, installation or demonstration resource: ' + name);
      if (entry.isDirectory()) walk(file, name);
      else if (entry.isSymbolicLink()) {
        if (!Object.hasOwn(selected.aliases, name)) throw new Error('Packaged Python contains an unregistered symbolic link.');
      } else if (!entry.isFile()) throw new Error('Packaged Python contains a special file.');
      else files++;
    }
  }
  walk(root);
  return { version: profile.version, interpreter: selected.interpreter, aliases: selected.aliases, files };
}
function projectPackagedPython({ sourceRoot, resourceRoot }) {
  const source = directory(sourceRoot), target = directory(resourceRoot);
  if (source === target || source.startsWith(target + path.sep) || target.startsWith(source + path.sep))
    throw new Error('Python app projection must be separate from its producer files.');
  directory(path.join(target, 'bin'));
  const original = verifySourcePython({ sourceRoot: source }), selected = configuration();
  const canonical = regular(path.join(target, selected.interpreter));
  if (digest(canonical.bytes) !== original.sha256) throw new Error('The copied Python interpreter changed before signing.');
  const aliases = [];
  for (const [alias, link] of Object.entries(selected.aliases)) {
    const file = path.join(target, alias);
    let stat;
    try { stat = fs.lstatSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (stat?.isSymbolicLink()) {
      if (fs.readlinkSync(file) !== link || fs.realpathSync(file) !== path.join(target, selected.interpreter))
        throw new Error('An existing Python resource alias changed.');
    } else if (stat && (!stat.isFile() || digest(fs.readFileSync(file)) !== original.sha256))
      throw new Error('An existing Python resource differs from its producer.');
    aliases.push({ file, link, replace: stat?.isFile() === true, present: Boolean(stat) });
  }
  // Only generated app copies are replaced. Producer files stay unchanged.
  for (const alias of aliases) {
    if (alias.replace) fs.unlinkSync(alias.file);
    if (!alias.present || alias.replace) fs.symlinkSync(alias.link, alias.file);
  }
  return assertPackagedPython({ resourceRoot: target });
}

const requiredFiles = Object.freeze(['lib/python3.12/encodings/__init__.py', 'lib/python3.12/ctypes/__init__.py',
  'lib/python3.12/site-packages/pefile.py', 'lib/python3.12/site-packages/aplib.py',
  'lib/python3.12/site-packages/corrupy/__init__.py', 'lib/python3.12/site-packages/packaging/__init__.py']);

module.exports = { configuration, excluded, resourceExclusions, requiredFiles, verifySourcePython, assertPackagedPython, projectPackagedPython };
