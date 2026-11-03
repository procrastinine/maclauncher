// Backcompat: MacLauncher 0.5.1 and earlier private-game mirrors/save recovery.
// Runs only for module-declared roots during the one-time profile migration.
// Remove with the migration when those historical layouts are no longer supported.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { copyFileExclusive } = require('../../modules/shared/copy-file');

const inside = (root, value) => value === root || value.startsWith(root + path.sep);
function plainDirectory(directory) {
  const absolute = path.resolve(directory), parts = absolute.split(path.sep).filter(Boolean);
  let current = path.parse(absolute).root;
  for (const part of parts) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('One of the folders involved is a symbolic link or not a folder, so these files were left in place. Copy any needed files from this folder before removing the game.');
  }
  return absolute;
}
function regularBytes(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile()) throw Error('An item here is not an ordinary file, so these files were left in place. Copy any needed files from this folder before removing the game.');
    const hash = crypto.createHash('sha256'), buffer = Buffer.allocUnsafe(64 * 1024);
    let length = 0, count;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, count));length += count;
    }
    const after = fs.fstatSync(fd);
    if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || length !== after.size)
      throw Error('A file changed while it was being read, so these files were left in place. Copy any needed files from this folder before removing the game.');
    return { digest: hash.digest('hex'), stat: after };
  } finally { fs.closeSync(fd); }
}
function originalBytes(root, relative) {
  const file = path.join(root, relative);
  try { plainDirectory(path.dirname(file)); return regularBytes(file).digest; }
  catch { return null; }
}

function sourceDirectory(root, directory) {
  const relative = path.relative(root, directory);
  if (path.isAbsolute(relative) || relative.split(path.sep).includes('..')) throw Error('A file would have been restored outside its game folder, so these files were left in place. Copy any needed files from this folder before removing the game.');
  let current = plainDirectory(root);
  for (const part of relative.split(path.sep).filter(part => part && part !== '.')) {
    current = path.join(current, part);
    try { fs.mkdirSync(current); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    plainDirectory(current);
  }
}
const sourceParent = (root, relative) => sourceDirectory(root, path.dirname(path.join(root, relative)));

// Only module-declared obsolete roots are visited. Missing files return to the
// actual game tree; conflicts remain independent sibling files. The shared
// exclusive copy publishes verified staging bytes without replacing a racer.
async function retireLegacyGameMirror({ mirrorRoot, sourceRoot, generated = [], retainMirror = false, createSourceWithin } = {}, { userDataDir } = {}) {
  const recoveredFiles = [];
  try {
    if (![mirrorRoot, userDataDir].every(value => typeof value === 'string' && path.isAbsolute(value)))
      throw Error('The location of these files was not recorded, so they were left in place. Copy any needed files from this folder before removing the game.');
    const profile = path.resolve(userDataDir), mirror = path.resolve(mirrorRoot);
    if (!inside(profile, mirror) || mirror === profile) throw Error('This folder is outside the MacLauncher data folder, so it was left in place. Copy any needed files from this folder before removing the game.');
    plainDirectory(profile);
    // Validate existing parents before deciding a declared mirror is absent.
    let current = profile;
    for (const part of path.relative(profile, mirror).split(path.sep)) {
      current = path.join(current, part);
      try {
        const stat = fs.lstatSync(current);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('The path to this folder contains a symbolic link, so it was left in place. Copy any needed files from this folder before removing the game.');
      } catch (error) { if (error.code === 'ENOENT') return { complete: true }; throw error; }
    }
    if (typeof sourceRoot !== 'string' || !path.isAbsolute(sourceRoot)) throw Error('The original game folder for these files is unknown, so they were left in place. Copy any needed files from this folder before removing the game.');
    const source = path.resolve(sourceRoot);
    if (source === mirror || inside(mirror, source)) throw Error('This folder and the original game folder overlap, so it was left in place. Copy any needed files from this folder before removing the game.');
    const nested = inside(source, mirror);
    if (!Array.isArray(generated) || generated.some(file => typeof file !== 'string' || !file || path.isAbsolute(file) || file.split(/[\\/]/).some(part => !part || part === '.' || part === '..')))
      throw Error('MacLauncher could not tell which files here it created, so these files were left in place. Copy any needed files from this folder before removing the game.');
    if (createSourceWithin !== undefined) {
      if (typeof createSourceWithin !== 'string' || !path.isAbsolute(createSourceWithin)) throw Error('The destination folder for these files is unknown, so they were left in place. Copy any needed files from this folder before removing the game.');
      const anchor = path.resolve(createSourceWithin);
      if (source === anchor || !inside(anchor, source)) throw Error('The destination for these files is outside the game folder, so they were left in place. Copy any needed files from this folder before removing the game.');
      sourceDirectory(anchor, source);
    }
    plainDirectory(source);
    const owned = new Set(generated.map(file => file.split('/').join(path.sep))), files = [], directories = [];
    function visit(directory, relative = '') {
      directories.push(directory);
      for (const name of fs.readdirSync(directory)) {
        const rel = path.join(relative, name), file = path.join(directory, name), stat = fs.lstatSync(file);
        // Only private inputs are enumerated. A projected file must remain
        // disjoint from that private tree, including its ancestor folders.
        const target = path.join(source, rel);
        if (nested && (inside(mirror, target) || !stat.isDirectory() && inside(target, mirror)))
          throw Error('A recovered file would land inside the folder it came from, so these files were left in place. Copy any needed files from this folder before removing the game.');
        if (stat.isSymbolicLink()) {
          if (nested) throw Error('This folder contains a symbolic link, so these files were left in place. Copy any needed files from this folder before removing the game.');
          const target = fs.readlinkSync(file);
          if (path.resolve(path.dirname(file), target) !== path.join(source, rel)) throw Error('This folder contains a symbolic link that does not point to the matching file in the original game, so it was left in place. Copy any needed files from this folder before removing the game.');
          files.push({ file, rel, link: target, stat });
        } else if (stat.isDirectory()) visit(file, rel);
        else if (stat.isFile()) {
          const snapshot = regularBytes(file), original = owned.has(rel) ? null : originalBytes(source, rel);
          files.push({ file, rel, ...snapshot, duplicate: !owned.has(rel) && original && snapshot.digest === original,
            recover: !owned.has(rel) && (!original || snapshot.digest !== original) });
        } else throw Error('This folder contains an item that is not a file, folder or symbolic link, so it was left in place. Copy any needed files from this folder before removing the game.');
      }
    }
    visit(mirror);
    const unique = files.filter(file => file.recover);
    for (const item of unique) {
      sourceParent(source, item.rel);
      const original = path.join(source, item.rel);
      let destination = original;
      try {
        fs.lstatSync(original);
        destination = original + '.MacLauncher-conflict-' + crypto.randomUUID();
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await copyFileExclusive(item.file, destination, { validate: staged => {
        plainDirectory(path.dirname(item.file));plainDirectory(path.dirname(destination));
        const current = fs.lstatSync(item.file);
        if (current.dev !== item.stat.dev || current.ino !== item.stat.ino ||
          regularBytes(item.file).digest !== item.digest || regularBytes(staged).digest !== item.digest)
          throw Error('A file changed while it was being copied back to the game, so these files were left in place. Copy any needed files from this folder before removing the game.');
        const fd = fs.openSync(staged, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      } });
      item.destination = destination;
      recoveredFiles.push(destination);
    }
    // Recheck all inputs before removing any file. A new/changed entry keeps
    // the remaining root pending; rmdir never recursively discards new bytes.
    for (const item of files) {
      plainDirectory(path.dirname(item.file));
      const stat = fs.lstatSync(item.file);
      if (stat.ino !== item.stat.ino || stat.dev !== item.stat.dev) throw Error('A file in this folder was replaced during recovery, so these files were left in place. Copy any needed files from this folder before removing the game.');
      if (item.link !== undefined) {
        if (!stat.isSymbolicLink() || fs.readlinkSync(item.file) !== item.link) throw Error('A symbolic link in this folder changed during recovery, so these files were left in place. Copy any needed files from this folder before removing the game.');
      } else {
        if (regularBytes(item.file).digest !== item.digest) throw Error('A file in this folder changed during recovery, so these files were left in place. Copy any needed files from this folder before removing the game.');
        if (item.destination) {
          plainDirectory(path.dirname(item.destination));
          if (regularBytes(item.destination).digest !== item.digest) throw Error('A restored file in the game folder changed during recovery, so these files were left in place. Copy any needed files from this folder before removing the game.');
        }
        if (item.duplicate && originalBytes(source, item.rel) !== item.digest) throw Error('A file in the original game folder changed during recovery, so these files were left in place. Copy any needed files from this folder before removing the game.');
      }
    }
    if (!nested) {
      for (const item of files) if (!retainMirror || owned.has(item.rel) && item.link === undefined) fs.unlinkSync(item.file);
      if (!retainMirror) for (const directory of directories.reverse()) fs.rmdirSync(directory);
    }
    return { complete: true, ...(recoveredFiles.length ? { recoveredFiles } : {}) };
  } catch (error) {
    return { complete: false, reason: error.message, ...(recoveredFiles.length ? { recoveredFiles } : {}) };
  }
}

module.exports = { retireLegacyGameMirror, plainDirectory };
