const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { TextDecoder } = require("node:util");

// Ren'Py's ZIP `log` is a pickle of store roots and rollback state. This module
// only reads small, public metadata members; it never reads or decodes `log`.
const LIMITS = Object.freeze({ archiveBytes: 512 * 1024 * 1024, directoryBytes: 1024 * 1024,
  entries: 128, metadataBytes: 256 * 1024, textBytes: 32 * 1024, versionBytes: 4096 });
const utf8 = new TextDecoder("utf-8", { fatal: true });
const crcTable = Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = (n >>> 1) ^ ((n & 1) ? 0xedb88320 : 0);
  return n >>> 0;
});
function crc32(data) {
  let crc = 0xffffffff;
  for (const value of data) crc = crcTable[(crc ^ value) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function readAt(fd, size, offset, length) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > size) {
    throw new Error("Ren'Py save contains an out-of-bounds ZIP member.");
  }
  const data = Buffer.alloc(length);
  if (fs.readSync(fd, data, 0, length, offset) !== length) throw new Error("Ren'Py save is truncated.");
  return data;
}
function readDirectory(fd, size) {
  const tail = readAt(fd, size, Math.max(0, size - 65557), Math.min(size, 65557));
  let end = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) { end = i; break; }
  }
  if (end < 0) throw new Error("Unsupported Ren'Py save: expected a standard ZIP slot, not persistent data or a pickle.");
  const count = tail.readUInt16LE(end + 10);
  const cdSize = tail.readUInt32LE(end + 12);
  const cdOffset = tail.readUInt32LE(end + 16);
  const absoluteEnd = size - tail.length + end;
  if (tail.readUInt16LE(end + 4) || tail.readUInt16LE(end + 6) || tail.readUInt16LE(end + 8) !== count ||
      count === 65535 || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new Error("Split and ZIP64 Ren'Py saves are unsupported.");
  }
  if (!count || count > LIMITS.entries || cdSize > LIMITS.directoryBytes) throw new Error("Ren'Py save ZIP directory exceeds inspection limits.");
  if (cdOffset + cdSize !== absoluteEnd) throw new Error("Ren'Py save has an invalid ZIP directory offset.");
  const directory = readAt(fd, size, cdOffset, cdSize);
  const entries = [];
  const names = new Set();
  let pos = 0;
  for (let i = 0; i < count; i++) {
    if (pos + 46 > directory.length || directory.readUInt32LE(pos) !== 0x02014b50) throw new Error("Ren'Py save ZIP directory is truncated.");
    const flags = directory.readUInt16LE(pos + 8);
    const method = directory.readUInt16LE(pos + 10);
    const crc = directory.readUInt32LE(pos + 16);
    const compressedSize = directory.readUInt32LE(pos + 20);
    const uncompressedSize = directory.readUInt32LE(pos + 24);
    const nameLength = directory.readUInt16LE(pos + 28);
    const extraLength = directory.readUInt16LE(pos + 30);
    const commentLength = directory.readUInt16LE(pos + 32);
    const offset = directory.readUInt32LE(pos + 42);
    const next = pos + 46 + nameLength + extraLength + commentLength;
    if (next > directory.length || !nameLength) throw new Error("Ren'Py save ZIP member name is invalid.");
    const nameBytes = directory.subarray(pos + 46, pos + 46 + nameLength);
    const name = utf8.decode(nameBytes);
    if (name.includes("\\") || name.startsWith("/") || name.includes("\0") || name.split("/").some(p => p === ".." || p === ".") || /^[A-Za-z]:/.test(name)) {
      throw new Error("Ren'Py save contains an unsafe ZIP member name.");
    }
    if (names.has(name)) throw new Error(`Ren'Py save contains duplicate ZIP member: ${name}`);
    names.add(name);
    if (flags & 1) throw new Error("Encrypted Ren'Py saves are unsupported.");
    if (directory.readUInt16LE(pos + 34) || [offset, compressedSize, uncompressedSize].includes(0xffffffff)) {
      throw new Error("Split and ZIP64 Ren'Py saves are unsupported.");
    }
    const header = readAt(fd, size, offset, 30);
    if (header.readUInt32LE(0) !== 0x04034b50 || header.readUInt16LE(6) !== flags || header.readUInt16LE(8) !== method) {
      throw new Error("Ren'Py save has mismatched ZIP headers.");
    }
    const localNameLength = header.readUInt16LE(26);
    const localExtraLength = header.readUInt16LE(28);
    const localName = readAt(fd, size, offset + 30, localNameLength);
    if (!localName.equals(nameBytes)) throw new Error("Ren'Py save has mismatched ZIP member names.");
    const dataOffset = offset + 30 + localNameLength + localExtraLength;
    if (dataOffset + compressedSize > cdOffset) throw new Error("Ren'Py save ZIP member overlaps its directory.");
    if (!(flags & 8) && (header.readUInt32LE(14) !== crc || header.readUInt32LE(18) !== compressedSize || header.readUInt32LE(22) !== uncompressedSize)) {
      throw new Error("Ren'Py save has mismatched ZIP member sizes or CRC.");
    }
    entries.push({ name, method, crc, compressedSize, uncompressedSize, dataOffset, offset });
    pos = next;
  }
  if (pos !== directory.length) throw new Error("Ren'Py save ZIP directory has unexpected trailing data.");
  const ordered = [...entries].sort((a, b) => a.offset - b.offset);
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i].offset < ordered[i - 1].dataOffset + ordered[i - 1].compressedSize) throw new Error("Ren'Py save has overlapping ZIP members.");
  }
  return entries;
}
function readMetadataMember(fd, size, entries, name, limit) {
  const entry = entries.find(e => e.name === name);
  if (!entry) return null;
  if (entry.compressedSize > limit || entry.uncompressedSize > limit) throw new Error(`Ren'Py save ${name} exceeds inspection limits.`);
  const compressed = readAt(fd, size, entry.dataOffset, entry.compressedSize);
  let decoded;
  if (entry.method === 0) decoded = compressed;
  else if (entry.method === 8) decoded = zlib.inflateRawSync(compressed, { maxOutputLength: limit });
  else throw new Error(`Unsupported ZIP compression method for Ren'Py save ${name}: ${entry.method}`);
  if (decoded.length !== entry.uncompressedSize || crc32(decoded) !== entry.crc) throw new Error(`Ren'Py save ${name} failed its ZIP integrity check.`);
  return utf8.decode(decoded);
}
function validateMetadata(metadata) {
  if (metadata === null) return;
  if (typeof metadata !== "object" || Array.isArray(metadata)) throw new Error("Ren'Py save JSON metadata must be an object.");
  const pending = [{ value: metadata, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const { value, depth } = pending.pop();
    if (++nodes > 16384 || depth > 32) throw new Error("Ren'Py save JSON metadata exceeds structural limits.");
    if (value && typeof value === "object") {
      for (const item of Object.values(value)) pending.push({ value: item, depth: depth + 1 });
    }
  }
}
function inspectRenpySave(filePath) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile()) throw new Error("Ren'Py save inspection requires a regular file.");
  if (stat.size > LIMITS.archiveBytes) throw new Error("Ren'Py save exceeds inspection size limits.");
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const size = fs.fstatSync(fd).size;
    if (size > LIMITS.archiveBytes) throw new Error("Ren'Py save exceeds inspection size limits.");
    const entries = readDirectory(fd, size);
    const log = entries.find(e => e.name === "log");
    if (!log) throw new Error("Unsupported Ren'Py save: no game-state log member.");
    const json = readMetadataMember(fd, size, entries, "json", LIMITS.metadataBytes);
    const metadata = json === null ? null : JSON.parse(json);
    validateMetadata(metadata);
    const extraInfo = readMetadataMember(fd, size, entries, "extra_info", LIMITS.textBytes);
    const renpyVersion = readMetadataMember(fd, size, entries, "renpy_version", LIMITS.versionBytes);
    const signature = entries.find(e => e.name === "signatures");
    const screenshot = entries.find(e => e.name === "screenshot.png");
    const version = typeof renpyVersion === "string" ? renpyVersion.match(/(?:Ren'Py\s+)?(\d+)\.(\d+)(?:\.(\d+))?/) : null;
    return {
      format: "renpy-zip", filePath: path.resolve(filePath), fileName: path.basename(filePath), size,
      modifiedAt: stat.mtimeMs, metadata, extraInfo, renpyVersion,
      pythonMajor: version ? (Number(version[1]) >= 8 ? 3 : 2) : null,
      members: entries.map(({ name, compressedSize, uncompressedSize }) => ({ name, compressedSize, uncompressedSize })),
      state: { present: true, inspected: false, uncompressedSize: log.uncompressedSize },
      signatures: { present: Boolean(signature), verified: false },
      screenshot: { present: Boolean(screenshot), uncompressedSize: screenshot?.uncompressedSize || 0 },
      metadataIntegrity: "crc32-checked", saveEditing: false
    };
  } finally { fs.closeSync(fd); }
}
function listRenpySaves(directories) {
  const files = [];
  const errors = [];
  const seen = new Set();
  for (const directory of directories) {
    if (!directory) continue;
    const root = path.resolve(directory);
    if (seen.has(root)) continue;
    seen.add(root);
    let names;
    try { names = fs.readdirSync(root, { withFileTypes: true }); }
    catch (error) { if (error.code !== "ENOENT") errors.push({ directory: root, error: error.message }); continue; }
    for (const name of names.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!name.isFile() || !name.name.endsWith(".save")) continue;
      if (files.length >= 1024) { errors.push({ directory: root, error: "Save listing exceeds 1024 files." }); break; }
      const filePath = path.join(root, name.name);
      try { files.push({ ok: true, ...inspectRenpySave(filePath) }); }
      catch (error) { files.push({ ok: false, filePath, fileName: name.name, error: error.message }); }
    }
  }
  return { files, errors, count: files.length, validCount: files.filter(f => f.ok).length, saveEditing: false };
}
module.exports = { LIMITS, crc32, inspectRenpySave, listRenpySaves };
