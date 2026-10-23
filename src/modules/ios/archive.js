const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const Zip = require("../shared/runtime/zip");
const { Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const LIMITS = { entries: 65534, directory: 16 * 1024 * 1024, file: 1024 ** 3, total: 8 * 1024 ** 3 };
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => { for (let i = 0; i < 8; i++) n = (n >>> 1) ^ ((n & 1) ? 0xedb88320 : 0); return n >>> 0; });
function crc32(bytes, initial = 0xffffffff) { let crc = initial; for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8); return crc >>> 0; }
function open(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd), info = Zip.findZipEocd(fd);
    if (!stat.isFile() || !info || info.zipBase !== 0 || !info.entries || info.entries > LIMITS.entries || info.cdSize > LIMITS.directory || info.cdOffset < 0 || info.cdOffset + info.cdSize !== info.eocdOffset) throw new Error("Unsupported or malformed IPA ZIP directory.");
    const entries = Zip.readCentralDirectory(fd, info, { metadata: true });
    if (entries.length !== info.entries) throw new Error("Truncated IPA ZIP directory.");
    let total = 0; const names = new Map();
    for (const entry of entries) {
      const name = entry.name, parts = name.replace(/\/$/, "").split("/");
      if (!name || name.length > 4096 || /[\\\x00-\x1f\x7f:]/.test(name) || parts.some(p => !p || p === "." || p === "..") || name.includes("\ufffd")) throw new Error("IPA contains an unsafe archive path.");
      const mode = entry.externalAttributes >>> 16;
      if ((mode & 0xf000) && ![0x8000, 0x4000].includes(mode & 0xf000)) throw new Error("IPA symbolic links and special files are unsupported.");
      const key = parts.join("/").normalize("NFD").toLowerCase();
      if (names.has(key)) throw new Error("IPA contains duplicate or case-alias paths.");
      names.set(key, name.endsWith("/"));
      if ((entry.flags & (1 | 64)) || ![0, 8].includes(entry.compressionMethod) || entry.uncompressedSize > LIMITS.file || entry.compressedSize > LIMITS.file || (total += entry.uncompressedSize) > LIMITS.total) throw new Error("IPA compression or expanded size is unsupported.");
      const header = Buffer.alloc(30);
      if (fs.readSync(fd, header, 0, 30, entry.absoluteLocalHeaderOffset) !== 30 || header.readUInt32LE(0) !== 0x04034b50 || header.readUInt16LE(6) !== entry.flags || header.readUInt16LE(8) !== entry.compressionMethod) throw new Error("IPA local ZIP header disagrees with its directory.");
      const nameLength = header.readUInt16LE(26), rawName = Buffer.alloc(nameLength);
      fs.readSync(fd, rawName, 0, nameLength, entry.absoluteLocalHeaderOffset + 30);
      if (rawName.toString("utf8") !== name) throw new Error("IPA local ZIP filename disagrees with its directory.");
      entry.offset = entry.absoluteLocalHeaderOffset + 30 + nameLength + header.readUInt16LE(28);
      if (entry.offset + entry.compressedSize > info.cdOffset) throw new Error("IPA entry extends beyond its data area.");
    }
    for (const [name] of names) {
      const parts = name.split("/"); parts.pop();
      while (parts.length) { if (names.get(parts.join("/")) === false) throw new Error("IPA file shadows an archive directory."); parts.pop(); }
    }
    function read(name, limit = 1024 * 1024) {
      const entry = entries.find(e => e.name === name);
      if (!entry || entry.name.endsWith("/") || entry.uncompressedSize > limit || entry.compressedSize > limit) throw new Error("IPA entry is missing or exceeds its read limit: " + name);
      const compressed = Buffer.alloc(entry.compressedSize);
      if (fs.readSync(fd, compressed, 0, compressed.length, entry.offset) !== compressed.length) throw new Error("IPA entry is truncated.");
      const data = entry.compressionMethod === 0 ? compressed : zlib.inflateRawSync(compressed, { maxOutputLength: Math.max(1, limit) });
      if (data.length !== entry.uncompressedSize || ((crc32(data) ^ 0xffffffff) >>> 0) !== entry.crc32) throw new Error("IPA entry failed its size or checksum validation.");
      return data;
    }
    async function extract(destination, { prefix = "", signal } = {}) {
      for (const entry of entries) {
        signal?.throwIfAborted();
        if (!entry.name.startsWith(prefix)) continue;
        const relative = entry.name.slice(prefix.length); if (!relative) continue;
        const target = path.join(destination, relative);
        if (entry.name.endsWith("/")) { fs.mkdirSync(target, { recursive: true }); continue; }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        let count = 0, crc = 0xffffffff;
        const check = new Transform({ transform(chunk, _encoding, done) {
          count += chunk.length; if (count > entry.uncompressedSize) return done(new Error("IPA entry exceeds its declared size."));
          crc = crc32(chunk, crc); done(null, chunk);
        } });
        if (!entry.compressedSize) {
          if (entry.uncompressedSize || entry.crc32) throw new Error("Invalid empty IPA entry.");
          fs.writeFileSync(target, "", { flag: "wx", mode: 0o600 }); continue;
        }
        const source = fs.createReadStream(null, { fd, autoClose: false, start: entry.offset, end: entry.offset + entry.compressedSize - 1 });
        const streams = [source]; if (entry.compressionMethod === 8) streams.push(zlib.createInflateRaw());
        streams.push(check, fs.createWriteStream(target, { flags: "wx", mode: 0o600 }));
        await pipeline(streams, { signal });
        if (count !== entry.uncompressedSize || ((crc ^ 0xffffffff) >>> 0) !== entry.crc32) throw new Error("IPA entry failed its size or checksum validation.");
      }
    }
    return { entries, stat, read, extract, close: () => fs.closeSync(fd) };
  } catch (error) { fs.closeSync(fd); throw error; }
}
module.exports = { open, LIMITS, crc32 };
