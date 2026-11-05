const fs = require('node:fs'), path = require('node:path');
const Writable = require('../writable-input');
const { cloneOrCopy } = require('../copy-file');
const { fileDigest } = require('./verified-identity');
const warn = require('../graphics-warning');

const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative === '' || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
};
function stale() {
  return Object.assign(new Error('The prepared native library view changed.'), { code: 'NATIVE_LIBRARY_VIEW_STALE' });
}

/** Preserve a package's loader-relative neighborhood, replacing only supplied
 * file bindings. Binary selection and loadability remain with the caller. */
async function prepareNativeLibraryView(description, { root, files = description.files || [], bindings = [],
  pluginDirectories = description.pluginDirectories || [], excludedFiles = [], signal, logger = console } = {}) {
  const sourceRoot = path.resolve(description.root), sourceReal = fs.realpathSync(sourceRoot);
  root = path.resolve(root);
  let ancestor = root, suffix = [];
  while (!fs.existsSync(ancestor)) { suffix.unshift(path.basename(ancestor)); ancestor = path.dirname(ancestor); }
  const destinationReal = path.join(fs.realpathSync(ancestor), ...suffix);
  if (inside(sourceReal, destinationReal) || inside(destinationReal, sourceReal)) throw new Error('The native library view overlaps its source.');
  Writable.assertOwnDirectory(root, root);
  const slots = new Map(), ancestors = new Set(['']), identityInputs = [];
  function sourcePath(file, { directory = false, optional = false } = {}) {
    const source = path.resolve(sourceRoot, file);
    if (source === sourceRoot && !directory || !inside(sourceRoot, source)) throw new Error('The native library source escapes its component.');
    let real;
    try { real = fs.realpathSync(source); }
    catch (error) { if (!optional || error.code !== 'ENOENT') throw error; }
    if (real && !inside(sourceReal, real)) throw new Error('The native library source link escapes its component.');
    if (real && (directory ? !fs.statSync(real).isDirectory() : !fs.statSync(real).isFile()))
      throw new Error('The native library source has an unexpected file type.');
    return { source, real, relative: path.relative(sourceRoot, source) };
  }
  function add(slot) {
    const existing = slots.get(slot.relative);
    if (existing && existing.kind !== 'omit' && slot.kind !== 'omit' &&
        (existing.kind !== slot.kind || existing.real !== slot.real)) throw new Error('The native library view has conflicting file bindings.');
    if (existing?.kind === 'omit') return;
    slots.set(slot.relative, slot);
    let parent = path.dirname(slot.relative);
    while (parent !== '.') { ancestors.add(parent); parent = path.dirname(parent); }
  }
  for (const file of excludedFiles) add({ ...sourcePath(file, { optional: true }), kind: 'omit' });
  for (const file of files) if (file.relocate) {
    const slot = sourcePath(file.path);
    if (slots.get(slot.relative)?.kind !== 'omit') add({ ...slot, kind: 'copy' });
  }
  for (const binding of bindings) {
    const slot = sourcePath(binding.source), real = fs.realpathSync(binding.target);
    if (!fs.statSync(real).isFile()) throw new Error('The native library host binding is not a regular file.');
    if (slots.get(slot.relative)?.kind === 'omit') continue;
    add({ ...slot, real, kind: 'link' });
    identityInputs.push({ source: slot.source, target: real, ...fileDigest(real) });
  }
  const directories = pluginDirectories.map(directory => sourcePath(directory, { directory: true }));
  function ownDirectory(relative) {
    const target = path.join(root, relative), current = fs.lstatSync(target, { throwIfNoEntry: false });
    if (current && (!current.isDirectory() || current.isSymbolicLink())) throw stale();
    Writable.assertOwnDirectory(root, target);
    return target;
  }
  async function link(real, target) {
    const valid = () => {
      const current = fs.lstatSync(target, { throwIfNoEntry: false });
      if (!current) return false;
      try { if (current.isSymbolicLink() && fs.realpathSync(target) === real) return true; } catch {}
      throw stale();
    };
    if (valid()) return;
    try { await fs.promises.symlink(real, target); }
    catch (error) { if (error.code !== 'EEXIST' || !valid()) throw error; }
  }
  async function copy(real, target) {
    const valid = () => {
      const current = fs.lstatSync(target, { throwIfNoEntry: false });
      if (!current) return false;
      if (!current.isFile() || current.isSymbolicLink() || fileDigest(real).sha256 !== fileDigest(target).sha256) throw stale();
      return true;
    };
    if (valid()) return;
    try { await cloneOrCopy(real, target, { signal, exclusive: true }); }
    catch (error) { if (error.code !== 'EEXIST' || !valid()) throw error; }
    valid();
  }
  async function mirror(relative = '') {
    signal?.throwIfAborted();
    const destination = ownDirectory(relative), source = path.join(sourceRoot, relative), expected = new Set();
    for (const name of fs.readdirSync(source)) {
      signal?.throwIfAborted();
      const child = path.join(relative, name), slot = slots.get(child), target = path.join(destination, name);
      if (slot?.kind === 'omit') {
        if (fs.lstatSync(target, { throwIfNoEntry: false })) throw stale();
        continue;
      }
      if (slot) { await (slot.kind === 'copy' ? copy(slot.real, target) : link(slot.real, target)); expected.add(name); continue; }
      if (ancestors.has(child)) { await mirror(child); expected.add(name); continue; }
      let real;
      try {
        real = fs.realpathSync(path.join(source, name));
        const stat = fs.statSync(real);
        if (!inside(sourceReal, real) || !stat.isFile() && !stat.isDirectory()) throw new Error('An unused package entry is outside its component or is not a file.');
      } catch (error) {
        warn(logger, `[native libraries] Skipping an unused package entry: ${error.message}`);
        continue;
      }
      await link(real, target);
      expected.add(name);
    }
    if (fs.readdirSync(destination).some(name => !expected.has(name))) throw stale();
  }
  await mirror();
  return { pluginDirectories: directories.map(directory => path.join(root, directory.relative)), identityInputs };
}

module.exports = { prepareNativeLibraryView };
