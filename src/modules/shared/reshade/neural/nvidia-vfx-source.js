// Copyright (c) MacLauncher contributors. MIT license.
// Explicit-action acquisition of declared original NVIDIA wheel entries. The
// wheel is data; unrelated runtimes are neither installed nor executed.
const fs = require('node:fs');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const {Readable, Transform} = require('node:stream');
const {pipeline} = require('node:stream/promises');

const maximumCompressed = 64 * 1024 * 1024, maximumEntry = 128 * 1024 * 1024;
function declaration(row) {
  const archive = row?.archive, url = new URL(row?.url || '');
  if (row?.transport !== 'nvidia-vfx-entry' || url.protocol !== 'https:' || url.hostname !== 'pypi.nvidia.com' ||
      url.username || url.password || url.search || url.hash || !/^\/nvidia-vfx\/nvidia_vfx-[A-Za-z0-9_.-]+\.whl$/.test(url.pathname) ||
      !archive || !/^[a-f0-9]{64}$/.test(archive.sha256 || '') || !/^[a-f0-9]{64}$/.test(row.sha256 || '') ||
      typeof archive.entry !== 'string' || !archive.entry || archive.entry.length > 4096 ||
      ![0, 8].includes(archive.method) ||
      ![archive.bytes, archive.offset, archive.compressedBytes, row.bytes].every(Number.isSafeInteger) ||
      archive.bytes < 22 || archive.offset < 0 || archive.offset > archive.bytes - 30 ||
      archive.compressedBytes < 1 || archive.compressedBytes > maximumCompressed || row.bytes < 1 || row.bytes > maximumEntry)
    throw new Error('The original NVIDIA model source declaration is invalid.');
  return {archive, url: url.href};
}

async function range(url, offset, bytes, total, signal) {
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(offset) || offset < 0 || bytes < 1 || offset > total - bytes)
    throw new Error('The original model archive range is invalid.');
  const response = await fetch(url, {headers: {Range: `bytes=${offset}-${offset + bytes - 1}`, 'Accept-Encoding': 'identity'},
    redirect: 'error', signal});
  if (response.status !== 206 || response.headers.get('content-range') !== `bytes ${offset}-${offset + bytes - 1}/${total}` ||
      Number(response.headers.get('content-length')) !== bytes || !response.body) {
    await response.body?.cancel();
    throw new Error('The original model server did not supply the declared bounded archive range.');
  }
  return response;
}
async function bytes(response, size) {
  const chunks = [];let length = 0;
  for await (const chunk of Readable.fromWeb(response.body)) {
    length += chunk.length;
    if (length > size) throw new Error('The original model archive header exceeds its declaration.');
    chunks.push(chunk);
  }
  if (length !== size) throw new Error('The original model archive header is incomplete.');
  return Buffer.concat(chunks);
}

async function downloadEntry(row, target, {signal, onProgress} = {}) {
  const {archive, url} = declaration(row);
  const header = await bytes(await range(url, archive.offset, 30, archive.bytes, signal), 30);
  const flags = header.readUInt16LE(6), method = header.readUInt16LE(8), nameLength = header.readUInt16LE(26), extraLength = header.readUInt16LE(28);
  if (header.readUInt32LE(0) !== 0x04034b50 || flags & 1 || method !== archive.method || !nameLength || nameLength > 4096 || extraLength > 16384 ||
      !(flags & 8) && (header.readUInt32LE(18) !== archive.compressedBytes || header.readUInt32LE(22) !== row.bytes))
    throw new Error('The original model archive entry differs from its declared local header.');
  const name = await bytes(await range(url, archive.offset + 30, nameLength, archive.bytes, signal), nameLength);
  if (name.toString('utf8') !== archive.entry) throw new Error('The original model archive names a different entry.');
  const dataOffset = archive.offset + 30 + nameLength + extraLength;
  const response = await range(url, dataOffset, archive.compressedBytes, archive.bytes, signal);
  let handle;
  try { handle = await fs.promises.open(target, 'wx'); }
  catch (error) { await response.body.cancel(); throw error; }
  let downloaded = 0, expanded = 0, lastProgress = 0;
  const hash = crypto.createHash('sha256');
  const compressed = new Transform({transform(chunk, encoding, next) {
    downloaded += chunk.length;
    if (downloaded > archive.compressedBytes) { next(new Error('The original model transfer exceeds its declared range.'));return; }
    const now = Date.now();
    if (now - lastProgress >= 100) {
      lastProgress = now;onProgress?.({downloaded: Math.floor(downloaded / archive.compressedBytes * row.bytes), total: row.bytes,
        transferBytes: downloaded, transferTotal: archive.compressedBytes});
    }
    next(null, chunk);
  }});
  const output = new Transform({transform(chunk, encoding, next) {
    expanded += chunk.length;
    if (expanded > row.bytes) { next(new Error('The original model entry exceeds its declared size.'));return; }
    hash.update(chunk);next(null, chunk);
  }});
  try {
    const decode = method === 8 ? zlib.createInflateRaw() : new Transform({transform(chunk, encoding, next) { next(null, chunk); }});
    await pipeline(Readable.fromWeb(response.body), compressed, decode, output, handle.createWriteStream(), {signal});
    if (downloaded !== archive.compressedBytes || expanded !== row.bytes || hash.digest('hex') !== row.sha256)
      throw new Error('The original model entry differs from its declared size or checksum.');
    signal?.throwIfAborted();onProgress?.({downloaded: row.bytes, total: row.bytes, transferBytes: downloaded, transferTotal: archive.compressedBytes});
    return {file: target, sha256: row.sha256, bytes: expanded, sourceUrl: url, archiveEntry: archive.entry,
      archiveDeclaredSHA256: archive.sha256};
  } catch (error) {
    await handle.close().catch(() => {});await fs.promises.unlink(target).catch(() => {});throw error;
  }
}

module.exports = {downloadEntry};
