const fs = require("node:fs");
const zlib = require("node:zlib");
const { readZipEntries } = require("../../shared/runtime/zip");

// The package identity lives in AndroidManifest.xml's binary resource XML.
// Reading this small root element does not require a game runtime or Java.
function parseManifestIdentity(buffer) {
  const limit = 4 * 1024 * 1024;
  if (!Buffer.isBuffer(buffer) || buffer.length < 8 || buffer.length > limit || buffer.readUInt16LE(0) !== 3) throw Error("Invalid Android manifest.");
  const size = buffer.readUInt32LE(4); if (size > buffer.length) throw Error("Incomplete Android manifest.");
  let strings = [];
  for (let cursor = buffer.readUInt16LE(2); cursor < size;) {
    if (cursor > size - 8) throw Error("Incomplete Android manifest.");
    const type = buffer.readUInt16LE(cursor), header = buffer.readUInt16LE(cursor + 2), bytes = buffer.readUInt32LE(cursor + 4), end = cursor + bytes;
    if (header < 8 || bytes < header || end > size) throw Error("Invalid Android manifest chunk.");
    if (type === 1) {
      if (header < 28) throw Error("Invalid Android string pool.");
      const count = buffer.readUInt32LE(cursor + 8), utf8 = !!(buffer.readUInt32LE(cursor + 16) & 256), start = cursor + buffer.readUInt32LE(cursor + 20);
      if (count > 100000 || cursor + header + count * 4 > end || start > end) throw Error("Invalid Android string pool.");
      strings = Array.from({ length: count }, (_, index) => {
        let offset = start + buffer.readUInt32LE(cursor + header + index * 4);
        const length = wide => { if (offset > end - (wide ? 2 : 1)) throw Error("Invalid Android string."); let value = wide ? buffer.readUInt16LE(offset) : buffer[offset]; offset += wide ? 2 : 1; if (value & (wide ? 32768 : 128)) { if (offset > end - (wide ? 2 : 1)) throw Error("Invalid Android string."); value = ((value & (wide ? 32767 : 127)) * (wide ? 65536 : 256)) + (wide ? buffer.readUInt16LE(offset) : buffer[offset]); offset += wide ? 2 : 1; } return value; };
        if (utf8) length(false);
        const count = length(!utf8), bytes = count * (utf8 ? 1 : 2); if (offset > end - bytes) throw Error("Invalid Android string.");
        return buffer.toString(utf8 ? "utf8" : "utf16le", offset, offset + bytes);
      });
    } else if (type === 258) {
      if (header < 16 || bytes < 36 || strings[buffer.readUInt32LE(cursor + 20)] !== "manifest") { cursor = end; continue; }
      const first = cursor + 16 + buffer.readUInt16LE(cursor + 24), stride = buffer.readUInt16LE(cursor + 26), count = buffer.readUInt16LE(cursor + 28);
      if (stride < 20 || count > 1000 || first + stride * count > end) throw Error("Invalid Android manifest attributes.");
      const result = {};
      for (let index = 0; index < count; index++) {
        const at = first + stride * index, name = strings[buffer.readUInt32LE(at + 4)], raw = buffer.readUInt32LE(at + 8), valueType = buffer[at + 15], value = buffer.readUInt32LE(at + 16);
        if (["package", "split", "versionName"].includes(name)) result[name] = raw !== 0xffffffff ? strings[raw] : valueType === 3 ? strings[value] : null;
        if (["versionCode", "versionCodeMajor"].includes(name)) { if ([16, 17].includes(valueType)) result[name] = value; else if (raw !== 0xffffffff && /^\d+$/.test(strings[raw] || "")) result[name] = Number(strings[raw]); }
      }
      if (!result.package || !Number.isSafeInteger(result.versionCode)) throw Error("Android package identity is missing.");
      return { packageName: result.package, versionCode: ((BigInt(result.versionCodeMajor || 0) << 32n) | BigInt(result.versionCode)).toString(), versionName: result.versionName || null, split: result.split || null };
    }
    cursor = end;
  }
  throw Error("Android manifest root is missing.");
}
function readApkIdentity(file) {
  const archive = readZipEntries(file), matches = archive?.entries?.filter(entry => entry.name === "AndroidManifest.xml") || [];
  if (matches.length !== 1) throw Error("Android manifest is missing or duplicated.");
  const entry = matches[0], limit = 4 * 1024 * 1024;
  if (entry.uncompressedSize > limit || entry.compressedSize > limit) throw Error("Android manifest is too large.");
  const fd = fs.openSync(file, "r");
  try {
    const header = Buffer.alloc(30); if (fs.readSync(fd, header, 0, 30, entry.absoluteLocalHeaderOffset) !== 30 || header.readUInt32LE(0) !== 0x04034b50) throw Error("Invalid Android archive.");
    const method = header.readUInt16LE(8), offset = entry.absoluteLocalHeaderOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28), compressed = Buffer.alloc(entry.compressedSize);
    if (fs.readSync(fd, compressed, 0, compressed.length, offset) !== compressed.length) throw Error("Incomplete Android manifest.");
    const buffer = method === 0 ? compressed : method === 8 ? zlib.inflateRawSync(compressed, { maxOutputLength: limit }) : null;
    if (!buffer || buffer.length !== entry.uncompressedSize) throw Error("Invalid Android manifest compression.");
    return parseManifestIdentity(buffer);
  } finally { fs.closeSync(fd); }
}
module.exports = { readApkIdentity, parseManifestIdentity };
