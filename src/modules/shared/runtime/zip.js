const fs = require("node:fs");
const zlib = require("node:zlib");

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIR_SIGNATURE = 0x02014b50;
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_DIR_HEADER_BYTES = 46;
const CENTRAL_DIR_CHUNK_BYTES = 64 * 1024;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;

function safeUint64(buffer, offset) {
  const value = buffer.readBigUInt64LE(offset);
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
}

function readZip64Directory(fd, eocdOffset) {
  const locatorOffset = eocdOffset - 20, locator = readFixedBuffer(fd, locatorOffset, 20);
  if (!locator || locator.readUInt32LE(0) !== ZIP64_LOCATOR_SIGNATURE ||
      locator.readUInt32LE(4) !== 0 || locator.readUInt32LE(16) !== 1) return null;
  const relativeOffset = safeUint64(locator, 8);
  if (relativeOffset === null || relativeOffset > locatorOffset - 56) return null;
  const recordAt = offset => {
    const record = readFixedBuffer(fd, offset, 56);
    if (!record || record.readUInt32LE(0) !== ZIP64_EOCD_SIGNATURE) return null;
    const size = safeUint64(record, 4);
    return size !== null && size >= 44 && size === locatorOffset - offset - 12 ? { record, offset } : null;
  };
  let found = recordAt(relativeOffset) || recordAt(locatorOffset - 56);
  // Executable prefixes shift ZIP-relative offsets. Locate an extensible ZIP64
  // record by its declared end, reading backwards in fixed-size chunks.
  const signature = Buffer.from([0x50, 0x4b, 0x06, 0x06]);
  for (let end = locatorOffset - 56; !found && end > relativeOffset;) {
    const start = Math.max(relativeOffset, end - CENTRAL_DIR_CHUNK_BYTES);
    const chunk = readFixedBuffer(fd, start, end - start + 3);
    if (!chunk) return null;
    for (let at = chunk.lastIndexOf(signature); at >= 0 && !found; at = chunk.lastIndexOf(signature, at - 1)) {
      found = recordAt(start + at);
      if (at === 0) break;
    }
    end = start;
  }
  if (!found) return null;
  const { record, offset } = found;
  if (record.readUInt32LE(16) !== 0 || record.readUInt32LE(20) !== 0) return null;
  const entries = safeUint64(record, 32), diskEntries = safeUint64(record, 24);
  const cdSize = safeUint64(record, 40), cdOffset = safeUint64(record, 48);
  const zipBase = offset - relativeOffset;
  if ([entries, diskEntries, cdSize, cdOffset].includes(null) || entries !== diskEntries ||
      cdOffset > offset - zipBase || cdSize > offset - zipBase - cdOffset ||
      entries > Math.floor(cdSize / CENTRAL_DIR_HEADER_BYTES)) return null;
  return { entries, cdSize, cdOffset, zipBase, zip64: true };
}

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
    // A signature can also occur in the comment; its declared length must
    // reach the end of the file before this is an actual footer candidate.
    if (i + 22 + commentLength !== buffer.length) continue;
    const eocdOffset = fileSize - readSize + i;
    if (buffer.readUInt16LE(i + 4) !== 0 || buffer.readUInt16LE(i + 6) !== 0) return null;
    const locator = readFixedBuffer(fd, eocdOffset - 20, 4);
    // Some classic writers use all 65,535 entries without a ZIP64 locator.
    // In that case the count is literal, while ZIP64 size/offset markers still
    // require their extended directory metadata.
    const zip64 = cdSize === 0xffffffff || cdOffset === 0xffffffff ||
      locator?.readUInt32LE(0) === ZIP64_LOCATOR_SIGNATURE;
    if (zip64) {
      const directory = readZip64Directory(fd, eocdOffset);
      return directory ? { ...directory, commentLength, eocdOffset, fileSize } : null;
    }
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

function readCentralDirectory(fd, info, { metadata = false } = {}) {
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

    let compressedSize = buffer.readUInt32LE(20);
    let uncompressedSize = buffer.readUInt32LE(24);
    const nameLen = buffer.readUInt16LE(28);
    const extraLen = buffer.readUInt16LE(30);
    const commentLen = buffer.readUInt16LE(32);
    let localHeaderOffset = buffer.readUInt32LE(42), disk = buffer.readUInt16LE(34);
    const entrySize = CENTRAL_DIR_HEADER_BYTES + nameLen + extraLen + commentLen;
    if (entrySize <= CENTRAL_DIR_HEADER_BYTES) break;

    if (buffer.length < entrySize) {
      if (!readMore()) break;
      continue;
    }

    const nameStart = CENTRAL_DIR_HEADER_BYTES;
    const nameEnd = nameStart + nameLen;
    const name = buffer.slice(nameStart, nameEnd).toString("utf8");
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff ||
        localHeaderOffset === 0xffffffff || disk === 0xffff) {
      let extended;
      for (let at = nameEnd; at + 4 <= nameEnd + extraLen;) {
        const id = buffer.readUInt16LE(at), size = buffer.readUInt16LE(at + 2);
        if (size > nameEnd + extraLen - at - 4) return [];
        if (id === 1) { extended = buffer.subarray(at + 4, at + 4 + size); break; }
        at += 4 + size;
      }
      if (!extended) return [];
      let cursor = 0;
      const take = (value, marker, width) => {
        if (value !== marker) return value;
        if (cursor + width > extended.length) return null;
        const result = width === 8 ? safeUint64(extended, cursor) : extended.readUInt32LE(cursor);
        cursor += width;
        return result;
      };
      uncompressedSize = take(uncompressedSize, 0xffffffff, 8);
      compressedSize = take(compressedSize, 0xffffffff, 8);
      localHeaderOffset = take(localHeaderOffset, 0xffffffff, 8);
      disk = take(disk, 0xffff, 4);
      if ([uncompressedSize, compressedSize, localHeaderOffset, disk].includes(null)) return [];
    }
    if (disk !== 0 || localHeaderOffset > info.fileSize - info.zipBase) return [];
    entries.push({
      name,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      absoluteLocalHeaderOffset: info.zipBase + localHeaderOffset,
      ...(metadata ? { flags: buffer.readUInt16LE(8), compressionMethod: buffer.readUInt16LE(10),
        crc32: buffer.readUInt32LE(16), externalAttributes: buffer.readUInt32LE(38) } : {})
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

function readFixedBuffer(fd, offset, length) {
  if (!Number.isSafeInteger(offset) || offset < 0) return null;
  if (!Number.isSafeInteger(length) || length < 0) return null;
  if (offset + length > fs.fstatSync(fd).size) return null;
  const buf = Buffer.alloc(length);
  const read = fs.readSync(fd, buf, 0, length, offset);
  if (read !== length) return null;
  return buf;
}

function normalizeEntryName(name) {
  return String(name || "").replace(/\\/g, "/").toLowerCase();
}

function findZipEntry(entries, entryName) {
  const needle = normalizeEntryName(entryName);
  if (!needle) return null;
  return (Array.isArray(entries) ? entries : []).find(entry => normalizeEntryName(entry?.name) === needle) || null;
}

function inflateZipEntry(buffer, compressionMethod, maxOutputBytes) {
  if (compressionMethod === 0) {
    if (maxOutputBytes !== undefined && buffer.length > maxOutputBytes) throw new Error("ZIP entry exceeds its expanded size limit.");
    return buffer;
  }
  if (compressionMethod === 8) return zlib.inflateRawSync(buffer, maxOutputBytes === undefined ? {} : {maxOutputLength: Math.max(1, maxOutputBytes)});
  throw new Error(`Unsupported ZIP compression method: ${compressionMethod}`);
}

function readZipEntryBuffer(filePath, entryName) {
  const archive = readZipEntries(filePath);
  if (!archive?.entries?.length) return null;
  const entry = findZipEntry(archive.entries, entryName);
  if (!entry) return null;
  return readZipEntry(filePath, entry);
}

// Read an exact central-directory record without another name lookup. This
// preserves distinct case-sensitive names and avoids rescanning large archives.
function readZipEntry(filePath, entry, {maxOutputBytes} = {}) {
  if (!entry || typeof entry.name !== "string") return null;
  if (maxOutputBytes !== undefined && (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 0)) throw new Error("Invalid ZIP entry size limit.");
  const declared = entry.uncompressedSize;
  if (declared !== undefined && (!Number.isSafeInteger(declared) || declared < 0)) return null;
  if (maxOutputBytes !== undefined && declared > maxOutputBytes) throw new Error("ZIP entry exceeds its expanded size limit.");
  const limit = declared === undefined ? maxOutputBytes : maxOutputBytes === undefined ? declared : Math.min(declared, maxOutputBytes);
  const fd = fs.openSync(filePath, "r");
  try {
    const header = readFixedBuffer(fd, entry.absoluteLocalHeaderOffset, 30);
    if (!header) return null;
    if (header.readUInt32LE(0) !== LOCAL_FILE_HEADER_SIGNATURE) return null;
    const compressionMethod = header.readUInt16LE(8);
    const nameLen = header.readUInt16LE(26);
    const extraLen = header.readUInt16LE(28);
    const name = readFixedBuffer(fd, entry.absoluteLocalHeaderOffset + 30, nameLen);
    if (!name || name.toString("utf8") !== entry.name) return null;
    if (entry.compressionMethod !== undefined && entry.compressionMethod !== compressionMethod) return null;
    const dataOffset = entry.absoluteLocalHeaderOffset + 30 + nameLen + extraLen;
    const compressedSize = Number(entry.compressedSize || 0);
    if (!Number.isFinite(compressedSize) || compressedSize < 0) return null;
    const compressed = readFixedBuffer(fd, dataOffset, compressedSize);
    if (!compressed) return null;
    const expanded = inflateZipEntry(compressed, compressionMethod, limit);
    if (declared !== undefined && expanded.length !== declared) throw new Error("ZIP entry has an invalid expanded size.");
    return expanded;
  } finally {
    fs.closeSync(fd);
  }
}

// Stream one selected regular entry. Limits apply to actual inflated bytes,
// so large model resources never need a whole-file Buffer allocation.
async function extractZipEntry(filePath, entry, destination, {maxOutputBytes, signal, onProgress} = {}) {
  signal?.throwIfAborted();
  if (!entry || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 0 ||
      !Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0 || entry.uncompressedSize > maxOutputBytes ||
      !Number.isSafeInteger(entry.compressedSize) || entry.compressedSize < 0 || entry.flags & 1 ||
      ![0, 0o100000].includes(entry.externalAttributes >>> 16 & 0o170000))
    throw new Error("The ZIP entry is unsafe or exceeds its size limit.");
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);let start;
  try {
    const header = readFixedBuffer(fd, entry.absoluteLocalHeaderOffset, 30);
    if (!header || header.readUInt32LE(0) !== LOCAL_FILE_HEADER_SIGNATURE || header.readUInt16LE(6) & 1 ||
        ![0, 8].includes(header.readUInt16LE(8)) || header.readUInt16LE(8) !== entry.compressionMethod)
      throw new Error("The ZIP entry header is invalid.");
    const name = readFixedBuffer(fd, entry.absoluteLocalHeaderOffset + 30, header.readUInt16LE(26));
    start = entry.absoluteLocalHeaderOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
    if (!name || name.toString("utf8") !== entry.name || start + entry.compressedSize > fs.fstatSync(fd).size)
      throw new Error("The ZIP entry range is invalid.");
  } finally { fs.closeSync(fd); }
  const {Transform, Readable} = require("node:stream"), {pipeline} = require("node:stream/promises");
  const input = entry.compressedSize ? fs.createReadStream(filePath, {start, end: start + entry.compressedSize - 1,
    flags: fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW}) : Readable.from([]);
  let bytes = 0, crc = 0, created = false;
  const output = fs.createWriteStream(destination, {flags: "wx", mode: 0o600});
  output.once("open", () => { created = true; });
  const bounded = new Transform({transform(chunk, _encoding, callback) {
    bytes += chunk.length;
    if (bytes > maxOutputBytes || bytes > entry.uncompressedSize) return callback(new Error("ZIP entry exceeds its expanded size limit."));
    if (typeof zlib.crc32 === "function") crc = zlib.crc32(chunk, crc);
    try { onProgress?.(bytes);callback(null, chunk); } catch (error) { callback(error); }
  }});
  try {
    await pipeline(...(entry.compressionMethod === 8 ? [input, zlib.createInflateRaw(), bounded, output] : [input, bounded, output]), {signal});
    if (bytes !== entry.uncompressedSize || typeof zlib.crc32 === "function" && entry.crc32 !== undefined && crc !== entry.crc32)
      throw new Error("The ZIP entry has an invalid size or checksum.");
    return bytes;
  } catch (error) { if (created) await fs.promises.rm(destination, {force: true});throw error; }
}

module.exports = {
  readZipEntries,
  readZipEntryBuffer,
  readZipEntry,
  extractZipEntry,
  findZipEntry,
  findZipEocd,
  readCentralDirectory
};
