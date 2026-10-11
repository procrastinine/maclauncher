const fs = require("node:fs");
const zlib = require("node:zlib");
const MAGIC = Buffer.from([0x58, 0x50, 0x33, 0x0d, 0x0a, 0x20, 0x0a, 0x1a, 0x8b, 0x67, 0x01]);
const LIMITS = { index: 16 * 1024 * 1024, indexes: 32, entries: 20000, headerSearch: 16 * 1024 * 1024, script: 4 * 1024 * 1024, scriptsTotal: 32 * 1024 * 1024 };
function number(value) { const n = Number(value); if (!Number.isSafeInteger(n) || n < 0) throw new Error("XP3 integer exceeds supported bounds."); return n; }
function read(fd, size, offset, total) {
  if (offset < 0 || size < 0 || offset > total - size) throw new Error("XP3 data lies outside its archive.");
  const bytes = Buffer.alloc(size); if (fs.readSync(fd, bytes, 0, size, offset) !== size) throw new Error("Truncated XP3 archive."); return bytes;
}
function chunks(data, visit) {
  for (let cursor = 0; cursor < data.length;) {
    if (cursor + 12 > data.length) throw new Error("Truncated XP3 chunk.");
    const size = number(data.readBigUInt64LE(cursor + 4));
    if (size > data.length - cursor - 12) throw new Error("XP3 chunk exceeds its index.");
    visit(data.toString("ascii", cursor, cursor + 4), data.subarray(cursor + 12, cursor + 12 + size)); cursor += 12 + size;
  }
}
function findBase(fd, size) {
  let cursor = 0, previous = Buffer.alloc(0);
  while (cursor < Math.min(size, LIMITS.headerSearch)) {
    const part = read(fd, Math.min(65536, size - cursor, LIMITS.headerSearch - cursor), cursor, size), data = Buffer.concat([previous, part]), at = data.indexOf(MAGIC);
    if (at >= 0) return cursor - previous.length + at;
    previous = data.subarray(Math.max(0, data.length - MAGIC.length + 1)); cursor += part.length;
  }
  throw new Error("No bounded XP3 header was found in this file.");
}
function safeName(raw) {
  const name = raw.replace(/\\/g, "/");
  if (!name || name.includes("\0") || name.startsWith("/") || /^[a-z]:/i.test(name) || name.split("/").some(part => !part || part === "." || part === "..")) throw new Error("Unsafe XP3 member path.");
  return name;
}
function inspectArchive(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 19) throw new Error("XP3 input must be a regular archive or fused executable.");
  const fd = fs.openSync(file, "r");
  try {
    const base = findBase(fd, stat.size), header = read(fd, 19, base, stat.size), seen = new Set(), members = new Map();
    let offset = number(header.readBigUInt64LE(11)), indexBytes = 0, protectedEntries = 0;
    while (offset) {
      if (seen.has(offset) || seen.size >= LIMITS.indexes || offset < 19) throw new Error("Invalid, looping or excessive XP3 index chain.");
      seen.add(offset);
      const block = read(fd, 9, base + offset, stat.size), flags = block[0], compressed = !!(flags & 1);
      if (flags & ~0x81) throw new Error("Unsupported XP3 index compression flags.");
      const size = number(block.readBigUInt64LE(1)), prefix = compressed ? 17 : 9;
      if (size > LIMITS.index) throw new Error("XP3 index exceeds its inspection limit.");
      let data = read(fd, size, base + offset + prefix, stat.size);
      if (compressed) {
        const declared = number(read(fd, 8, base + offset + 9, stat.size).readBigUInt64LE(0));
        if (declared > LIMITS.index) throw new Error("XP3 index expansion exceeds its limit.");
        data = zlib.inflateSync(data, { maxOutputLength: LIMITS.index });
        if (data.length !== declared) throw new Error("XP3 inflated index size differs.");
      }
      indexBytes += data.length; if (indexBytes > LIMITS.index) throw new Error("XP3 chained index exceeds its total limit.");
      chunks(data, (tag, payload) => {
        if (tag !== "File") return;
        let info, segments, checksum;
        chunks(payload, (kind, bytes) => { if (kind === "info") info = bytes; if (kind === "segm") segments = bytes; if (kind === "adlr") checksum = bytes; });
        if (!info || info.length < 22 || info.length !== 22 + info.readUInt16LE(20) * 2 || !segments || segments.length % 28) throw new Error("Invalid XP3 file metadata.");
        const name = safeName(info.subarray(22).toString("utf16le")), flags = info.readUInt32LE(0), originalSize = number(info.readBigUInt64LE(4)), packedSize = number(info.readBigUInt64LE(12));
        const parts = []; let total = 0, packed = 0;
        for (let i = 0; i < segments.length; i += 28) {
          const flags = segments.readUInt32LE(i), offset = number(segments.readBigUInt64LE(i + 4)), size = number(segments.readBigUInt64LE(i + 12)), storedSize = number(segments.readBigUInt64LE(i + 20));
          if (flags & ~1 || base + offset > stat.size - storedSize) throw new Error("Unsupported or out-of-bounds XP3 segment.");
          parts.push({ compressed: !!flags, offset: base + offset, size, storedSize }); total += size; packed += storedSize;
        }
        if (total !== originalSize || packed !== packedSize || members.has(name.toLowerCase())) throw new Error("XP3 member size or duplicate path differs.");
        const protectedEntry = flags !== 0; if (protectedEntry) protectedEntries++;
        members.set(name.toLowerCase(), { name, size: originalSize, segments: parts, protectedEntry, checksum: checksum?.length === 4 ? checksum.readUInt32LE(0) : null });
        if (members.size > LIMITS.entries) throw new Error("XP3 file count exceeds supported bounds.");
      });
      offset = flags & 0x80 ? number(read(fd, 8, base + offset + prefix + size, stat.size).readBigUInt64LE(0)) : 0;
    }
    return { file, base, members, protectedEntries, size: stat.size };
  } finally { fs.closeSync(fd); }
}
function adler32(bytes) { let a = 1, b = 0; for (const value of bytes) { a = (a + value) % 65521; b = (b + a) % 65521; } return ((b << 16) | a) >>> 0; }
function readScript(archive, member, { allowPlainProtected = false } = {}) {
  if (member.protectedEntry && (!allowPlainProtected || member.checksum == null)) throw new Error("Protected XP3 data requires an unsupported game-specific filter.");
  if (member.size > LIMITS.script) throw new Error("XP3 script exceeds the extraction limit.");
  const fd = fs.openSync(archive.file, "r");
  try {
    const parts = member.segments.map(part => {
      if (part.storedSize > LIMITS.script || part.size > LIMITS.script) throw new Error("XP3 script segment exceeds its limit.");
      let bytes = read(fd, part.storedSize, part.offset, archive.size);
      if (part.compressed) bytes = zlib.inflateSync(bytes, { maxOutputLength: LIMITS.script });
      if (bytes.length !== part.size) throw new Error("XP3 script segment size differs.");
      return bytes;
    });
    const bytes = Buffer.concat(parts);
    if (bytes.length !== member.size || member.checksum != null && adler32(bytes) !== member.checksum) {
      if (member.protectedEntry) throw new Error("Protected XP3 data requires an unsupported game-specific filter; its plaintext checksum differs.");
      throw new Error("XP3 script checksum or size differs.");
    }
    return bytes;
  } finally { fs.closeSync(fd); }
}
module.exports = { MAGIC, LIMITS, inspectArchive, readScript, adler32 };
