const fs = require("node:fs");

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIR_SIGNATURE = 0x02014b50;

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
  const buffer = Buffer.alloc(info.cdSize);
  fs.readSync(fd, buffer, 0, info.cdSize, cdStart);
  let offset = 0;

  for (let i = 0; i < info.entries && offset + 46 <= buffer.length; i += 1) {
    if (buffer.readUInt32LE(offset) !== CENTRAL_DIR_SIGNATURE) break;
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLen;
    const name = buffer.slice(nameStart, nameEnd).toString("utf8");
    entries.push({
      name,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      absoluteLocalHeaderOffset: info.zipBase + localHeaderOffset
    });
    offset = nameEnd + extraLen + commentLen;
  }

  return entries;
}

function readZipEntries(filePath) {
  const fd = fs.openSync(filePath, "r");
  try {
    const info = findZipEocd(fd);
    if (!info) return null;
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
