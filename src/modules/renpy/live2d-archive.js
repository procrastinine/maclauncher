const fs = require("node:fs");
const zlib = require("node:zlib");
const Native = require("../shared/runtime/local-native");

const LIMITS = { archive: 128 * 1024 * 1024, directory: 8 * 1024 * 1024, member: 16 * 1024 * 1024, entries: 10000 };
const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index; for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }
function read(fd, size, offset) { const data = Buffer.alloc(size); if (fs.readSync(fd, data, 0, size, offset) !== size) throw new Error("Truncated Cubism ZIP."); return data; }

function readCubismArchive(archivePath) {
  const stat = fs.statSync(archivePath);
  if (!stat.isFile() || stat.size < 22 || stat.size > LIMITS.archive) throw new Error("Cubism ZIP must be a regular file smaller than 128 MiB.");
  const fd = fs.openSync(archivePath, "r");
  try {
    const tailStart = Math.max(0, stat.size - 65557), tail = read(fd, stat.size - tailStart, tailStart);
    let end = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) { end = i; break; }
    if (end < 0 || tail.readUInt16LE(end + 4) || tail.readUInt16LE(end + 6)) throw new Error("Unsupported Cubism ZIP directory.");
    const count = tail.readUInt16LE(end + 10), length = tail.readUInt32LE(end + 12), offset = tail.readUInt32LE(end + 16);
    if (!count || count > LIMITS.entries || length > LIMITS.directory || offset + length > tailStart + end || count !== tail.readUInt16LE(end + 8)) throw new Error("Cubism ZIP directory exceeds supported bounds.");
    const central = read(fd, length, offset), entries = [], names = new Set(); let cursor = 0;
    for (let i = 0; i < count; i++) {
      if (cursor + 46 > central.length || central.readUInt32LE(cursor) !== 0x02014b50) throw new Error("Invalid Cubism ZIP member.");
      const nameSize = central.readUInt16LE(cursor + 28), extraSize = central.readUInt16LE(cursor + 30), commentSize = central.readUInt16LE(cursor + 32);
      if (cursor + 46 + nameSize + extraSize + commentSize > central.length) throw new Error("Truncated Cubism ZIP member name.");
      const name = central.subarray(cursor + 46, cursor + 46 + nameSize).toString("utf8").replace(/\\/g, "/");
      const mode = central.readUInt32LE(cursor + 38) >>> 16;
      if (name.includes("\0") || name.startsWith("/") || /^[a-z]:/i.test(name) || name.split("/").includes("..") || (mode & 0xf000) === 0xa000) throw new Error("Unsafe path or symlink in Cubism ZIP.");
      if (names.has(name)) throw new Error("Duplicate member path in Cubism ZIP.");
      names.add(name);
      entries.push({ name, flags: central.readUInt16LE(cursor + 8), method: central.readUInt16LE(cursor + 10), crc: central.readUInt32LE(cursor + 16), compressed: central.readUInt32LE(cursor + 20), size: central.readUInt32LE(cursor + 24), local: central.readUInt32LE(cursor + 42) });
      cursor += 46 + nameSize + extraSize + commentSize;
    }
    if (cursor !== central.length) throw new Error("Cubism ZIP directory contains unexpected data.");
    function member(entry) {
      if (entry.flags & 1 || ![0, 8].includes(entry.method) || entry.size > LIMITS.member || entry.compressed > LIMITS.member || entry.local > offset - 30) throw new Error("Unsupported, encrypted or oversized Cubism ZIP payload.");
      const header = read(fd, 30, entry.local);
      if (header.readUInt32LE(0) !== 0x04034b50 || header.readUInt16LE(8) !== entry.method) throw new Error("Cubism ZIP local header differs from its directory.");
      const nameSize = header.readUInt16LE(26), extraSize = header.readUInt16LE(28), start = entry.local + 30 + nameSize + extraSize;
      if (start + entry.compressed > offset) throw new Error("Cubism ZIP payload overlaps its directory.");
      const localName = read(fd, nameSize, entry.local + 30).toString("utf8").replace(/\\/g, "/");
      if (localName !== entry.name) throw new Error("Cubism ZIP local member name differs from its directory.");
      const raw = read(fd, entry.compressed, start);
      const bytes = entry.method === 8 ? zlib.inflateRawSync(raw, { maxOutputLength: LIMITS.member }) : raw;
      if (bytes.length !== entry.size || crc32(bytes) !== entry.crc) throw new Error("Cubism ZIP payload checksum or size differs.");
      return bytes;
    }
    const candidates = entries.filter(entry => /\/Core\/dll\/macos\/libLive2DCubismCore\.dylib$/i.test(entry.name));
    if (candidates.length !== 1) throw new Error("Choose a Cubism SDK for Native ZIP with exactly one macOS Core dylib.");
    const selected = candidates[0], version = selected.name.split("/")[0].match(/^CubismSdkForNative-([45]-r\.\d+(?:[.-][A-Za-z0-9]+)*)$/)?.[1];
    if (!version) throw new Error("Cubism ZIP does not declare an explicit supported Native SDK version.");
    const license = entries.find(entry => entry.name === `${selected.name.split("/")[0]}/Core/LICENSE.md`);
    if (!license) throw new Error("Cubism Native ZIP is missing its Core license notice.");
    return { bytes: member(selected), license: member(license), version, memberPath: selected.name, archiveSha256: Native.hashFile(archivePath) };
  } finally { fs.closeSync(fd); }
}

module.exports = { readCubismArchive, crc32, LIMITS };
