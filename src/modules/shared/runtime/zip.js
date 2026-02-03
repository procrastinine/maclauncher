const fs = require("node:fs");

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIR_SIGNATURE = 0x02014b50;
const CENTRAL_DIR_HEADER_BYTES = 46;
const CENTRAL_DIR_CHUNK_BYTES = 64 * 1024;

function readFileSize(fd) {
  const stat = fs.fstatSync(fd);
  return stat.size;
}

function findZipEocd(fd) {
  const fileSize = readFileSize(fd);
  const maxComment = 0xffff;
  const readSize = Math.min(fileSize, 22 + maxComment);
  const buffer = Buffer.alloc(readSize);
  fs.readSync(fd, buffer, 0, readSize, fileSize - readSize);

  for (let i = buffer.length - 22; i >= 0; i -= 1) {
    if (buffer.readUInt32LE(i) !== EOCD_SIGNATURE) continue;
    const entries = buffer.readUInt16LE(i + 10);
    const cdSize = buffer.readUInt32LE(i + 12);
    const cdOffset = buffer.readUInt32LE(i + 16);
    const commentLength = buffer.readUInt16LE(i + 20);
    const eocdOffset = fileSize - readSize + i;
    const zipBase = eocdOffset - cdSize - cdOffset;
    return {
      entries,
      cdSize,
      cdOffset,
      commentLength,
      eocdOffset,
      zipBase,
      fileSize
    };
  }
  return null;
}

function readCentralDirectory(fd, info) {
  const entries = [];
  const cdStart = info.zipBase + info.cdOffset;
  const cdSize = info.cdSize;
  if (!Number.isFinite(cdSize) || cdSize <= 0) return entries;

  let remaining = cdSize;
  let fileOffset = cdStart;
  let buffer = Buffer.alloc(0);

  const readMore = () => {
    if (remaining <= 0) return false;
    const toRead = Math.min(CENTRAL_DIR_CHUNK_BYTES, remaining);
    const chunk = Buffer.alloc(toRead);
    const read = fs.readSync(fd, chunk, 0, toRead, fileOffset);
    if (!read) return false;
    fileOffset += read;
    remaining -= read;
    const slice = read === toRead ? chunk : chunk.subarray(0, read);
    buffer =
      buffer.length === 0
        ? slice
        : Buffer.concat([buffer, slice], buffer.length + slice.length);
    return true;
  };

  const expectedEntries = Number.isFinite(info.entries) ? info.entries : null;
  while ((expectedEntries == null || entries.length < expectedEntries) && (buffer.length || remaining > 0)) {
    if (buffer.length < CENTRAL_DIR_HEADER_BYTES) {
      if (!readMore()) break;
      if (buffer.length < CENTRAL_DIR_HEADER_BYTES && remaining === 0) break;
      continue;
    }

    if (buffer.readUInt32LE(0) !== CENTRAL_DIR_SIGNATURE) break;

    const compressedSize = buffer.readUInt32LE(20);
    const uncompressedSize = buffer.readUInt32LE(24);
    const nameLen = buffer.readUInt16LE(28);
    const extraLen = buffer.readUInt16LE(30);
    const commentLen = buffer.readUInt16LE(32);
    const localHeaderOffset = buffer.readUInt32LE(42);
    const entrySize = CENTRAL_DIR_HEADER_BYTES + nameLen + extraLen + commentLen;
    if (entrySize <= CENTRAL_DIR_HEADER_BYTES) break;

    if (buffer.length < entrySize) {
      if (!readMore()) break;
      continue;
    }

    const nameStart = CENTRAL_DIR_HEADER_BYTES;
    const nameEnd = nameStart + nameLen;
    const name = buffer.slice(nameStart, nameEnd).toString("utf8");
    entries.push({
      name,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      absoluteLocalHeaderOffset: info.zipBase + localHeaderOffset
    });

    buffer = buffer.subarray(entrySize);
  }

  return entries;
}

function readZipEntries(filePath) {
  const fd = fs.openSync(filePath, "r");
  try {
    const info = findZipEocd(fd);
    if (!info) return null;
    if (!Number.isFinite(info.fileSize) || info.fileSize <= 0) return null;
    if (!Number.isFinite(info.cdOffset) || info.cdOffset < 0) return null;
    if (!Number.isFinite(info.cdSize) || info.cdSize < 0) return null;
    if (!Number.isFinite(info.zipBase) || info.zipBase < 0) return null;
    const cdStart = info.zipBase + info.cdOffset;
    if (cdStart < 0 || cdStart > info.fileSize) return null;
    if (cdStart + info.cdSize > info.fileSize) return null;
    const entries = readCentralDirectory(fd, info);
    return { info, entries };
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = {
  readZipEntries,
  findZipEocd,
  readCentralDirectory
};
