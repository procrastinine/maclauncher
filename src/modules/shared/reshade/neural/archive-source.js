// Copyright (c) MacLauncher contributors. MIT license.
// Read model checkpoints from a verified publisher archive without installing
// or executing the other software carried in that archive.
const fs = require('node:fs'), path = require('node:path'), Zip = require('../../runtime/zip');
const safe = name => typeof name === 'string' && name.length <= 4096 && !/[\\\0]/.test(name) && !name.startsWith('/') &&
  name.split('/').every(part => part && part !== '.' && part !== '..');
const regular = entry => safe(entry.name) && !(entry.flags & 1) && [0, 8].includes(entry.compressionMethod) &&
  [0, 0o100000].includes(entry.externalAttributes >>> 16 & 0o170000);
async function extract(archive, destination, source, {signal} = {}) {
  const fd = fs.openSync(archive, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);let entries;
  try {
    const info = Zip.findZipEocd(fd);
    if (!info || info.cdSize > 16 * 1024 * 1024 || info.entries > 32768) throw Error('The model source archive exceeds its metadata limits.');
    entries = Zip.readCentralDirectory(fd, info, {metadata: true});
  } finally { fs.closeSync(fd); }
  const matches = entries.filter(entry => regular(entry) && (source.method === 'mlx-vsr'
    ? /^libnvidia-ngx-vsr\.so(?:\.[0-9.]+)?$/.test(path.posix.basename(entry.name)) : path.posix.basename(entry.name) === source.entry));
  if (matches.length !== 1 || matches[0].uncompressedSize < 1 || matches[0].uncompressedSize > 128 * 1024 * 1024)
    throw Error('The source archive has no unique compatible model entry.');
  const selected = matches[0], file = path.join(destination, path.posix.basename(selected.name));
  await Zip.extractZipEntry(archive, selected, file, {maxOutputBytes: selected.uncompressedSize, signal});
  // Notices remain data beside the imported checkpoint. Their absence does not
  // change whether its model API is compatible.
  let index = 0;
  for (const entry of entries.filter(entry => regular(entry) && /^(?:LICENSE|NOTICE|COPYING)/i.test(path.posix.basename(entry.name)))) {
    if (index >= 32 || entry.uncompressedSize > 4 * 1024 * 1024) continue;
    const name = 'NOTICE-' + index++ + '-' + path.posix.basename(entry.name);
    try {await Zip.extractZipEntry(archive, entry, path.join(destination, name), {maxOutputBytes: 4 * 1024 * 1024, signal});}
    catch {signal?.throwIfAborted();}
  }
  return file;
}
module.exports = {extract};
