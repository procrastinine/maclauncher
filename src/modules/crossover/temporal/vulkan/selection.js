const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const Writable = require('../../../shared/writable-input');
const { readPeExports } = require('../../../shared/runtime/pe-exports');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const stat = file => fs.lstatSync(file, { throwIfNoEntry: false });

function checked(input) {
  if (!path.isAbsolute(input?.file || '') || !/^[a-f0-9]{64}$/.test(input.sha256 || '')) throw Error('WineVulkan input metadata is incomplete.');
  const file = fs.realpathSync(input.file), info = fs.statSync(file);
  if (!info.isFile() || info.size > 64 * 1024 * 1024) throw Error('WineVulkan input is unavailable.');
  const bytes = fs.readFileSync(file);
  if (sha(bytes) !== input.sha256) throw Error('WineVulkan input changed.');
  return { file, bytes, sha256: input.sha256 };
}

// Wine's builtin lookup uses IMAGE_EXPORT_DIRECTORY.Name, including for a
// builtin found in the prefix. The complete client uses an owned module name.
function clientName(input) {
  const pe = readPeExports(input.file), bytes = input.bytes;
  if (!pe?.isDll || pe.form !== 'builtin') throw Error('WineVulkan requires a complete Wine builtin client.');
  const at = bytes.readUInt32LE(60) + 24, magic = bytes.readUInt16LE(at);
  const directory = at + (magic === 0x20b ? 112 : 96), rva = bytes.readUInt32LE(directory);
  const offset = address => {
    const section = pe.sections.find(s => address >= s.rva && address < s.rva + s.size);
    if (!section) throw Error('WineVulkan client export name is unavailable.');
    return section.offset + address - section.rva;
  };
  const nameAt = offset(bytes.readUInt32LE(offset(rva) + 12));
  const end = bytes.indexOf(0, nameAt), name = bytes.toString('ascii', nameAt, end);
  if (end < nameAt || end - nameAt > 128 || !/^[a-z][a-z0-9-]*\.dll$/.test(name) || name === 'winevulkan.dll')
    throw Error('WineVulkan client needs a distinct builtin export name.');
  if (!pe.exports.get('vkCreateInstance')?.executable || !pe.exports.get('vkGetInstanceProcAddr')?.executable)
    throw Error('WineVulkan client Vulkan exports are unavailable.');
  return name;
}

async function prepareSelection({ prefixPath, dllRoot, windows, unixName, client, native, signal }) {
  signal?.throwIfAborted();
  if (!/^[a-z0-9_]+-windows$/.test(windows || '') || !/^[a-z0-9_]+-unix$/.test(unixName || ''))
    throw Error('WineVulkan view directories are unavailable.');
  if (!path.isAbsolute(prefixPath || '') || !path.isAbsolute(dllRoot || '')) throw Error('WineVulkan needs a prepared Wine prefix and view.');
  const selected = checked(client), library = checked(native), original = checked(client.original);
  const name = clientName(selected), stem = name.slice(0, -4);
  if (readPeExports(original.file)?.form !== 'builtin') throw Error('The original WineVulkan client is not a Wine builtin.');
  const directory = path.join(prefixPath, 'drive_c/windows', windows === 'i386-windows' ? 'syswow64' : 'system32');
  Writable.assertOwnDirectory(prefixPath, directory, { create: false });
  const destination = path.join(directory, 'winevulkan.dll'), token = crypto.randomUUID();
  const backup = path.join(directory, '.maclauncher-winevulkan-' + token);
  const aliases = [], linkMatches = (file, target) => stat(file)?.isSymbolicLink() && fs.readlinkSync(file) === target;
  let moved = false, applied = false, restored = false, abortFailure;
  function restoreSync() {
    if (restored) return;
    if (applied) {
      if (!linkMatches(destination, selected.file)) throw Error('WineVulkan selection changed; its original is preserved at ' + backup);
      if (sha(fs.readFileSync(backup)) !== original.sha256) throw Error('WineVulkan original changed; both files were preserved.');
      fs.unlinkSync(destination); applied = false;
    }
    if (moved) {
      if (stat(destination)) throw Error('WineVulkan destination changed; its original is preserved at ' + backup);
      fs.renameSync(backup, destination); moved = false;
    }
    for (const [file, target] of aliases) if (linkMatches(file, target)) fs.unlinkSync(file);
    signal?.removeEventListener('abort', onAbort);
    restored = true;
  }
  function onAbort() { try { restoreSync(); } catch (error) { abortFailure = error; } }
  function checkpoint() { if (abortFailure) throw abortFailure; signal?.throwIfAborted(); }
  function alias(folder, file, target) {
    const parent = path.join(dllRoot, folder); Writable.assertOwnDirectory(dllRoot, parent);
    const destination = path.join(parent, file), current = stat(destination);
    if (current && !linkMatches(destination, target)) throw Error('WineVulkan view entry is already owned by another input.');
    if (!current) { fs.symlinkSync(target, destination); aliases.push([destination, target]); }
    checkpoint();
  }
  try {
    alias(windows, name, selected.file);
    alias(unixName, stem + '.so', library.file);
    checkpoint(); signal?.addEventListener('abort', onAbort, { once: true }); checkpoint();
  } catch (error) { restoreSync(); throw error; }
  return {
    env: { WINEDLLPATH: dllRoot, WINEDLLOVERRIDES: 'winevulkan=b' },
    async applyPrefix() {
      try {
        checkpoint();
        if (restored) throw Error('WineVulkan selection has already been restored.');
        if (applied) return;
        const current = stat(destination);
        if (!current?.isFile() || current.isSymbolicLink() || sha(fs.readFileSync(destination)) !== original.sha256)
          throw Error('The prefix WineVulkan file differs from the selected Wine original; it was preserved.');
        fs.renameSync(destination, backup); moved = true; checkpoint();
        fs.symlinkSync(selected.file, destination); applied = true; checkpoint();
      } catch (error) { restoreSync(); throw error; }
    },
    async restore() { restoreSync(); },
  };
}

module.exports = { prepareSelection };
