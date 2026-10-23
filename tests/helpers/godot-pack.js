const crypto = require("node:crypto");
function settings(values) {
  const entries = Object.entries(values).map(([key, text]) => {
    const name = Buffer.from(key), value = Buffer.from(text), variant = Buffer.alloc(8 + Math.ceil(value.length / 4) * 4);
    variant.writeUInt32LE(4);variant.writeUInt32LE(value.length, 4);value.copy(variant, 8);
    const sizes = Buffer.alloc(8);sizes.writeUInt32LE(name.length);sizes.writeUInt32LE(variant.length, 4);
    return Buffer.concat([sizes.subarray(0, 4), name, sizes.subarray(4), variant]);
  });
  const header = Buffer.alloc(8);header.write("ECFG");header.writeUInt32LE(entries.length, 4);return Buffer.concat([header, ...entries]);
}
function pack(files, {version = 1, offset = 32, trailer = true, flags = 0, fileBase = 0} = {}) {
  const headerSize = version === 1 ? 84 : version === 2 ? 96 : 40;
  const rows = Object.entries(files).map(([name, bytes]) => {
    const path = Buffer.from("res://" + name), padded = Buffer.alloc(Math.ceil(path.length / 4) * 4);path.copy(padded);
    const row = Buffer.alloc(4 + padded.length + 32 + (version >= 2 ? 4 : 0));row.writeUInt32LE(padded.length);padded.copy(row, 4);
    return {bytes, row, pointer: 4 + padded.length};
  });
  let size = headerSize + 4 + rows.reduce((sum, row) => sum + row.row.length, 0);
  const header = Buffer.alloc(headerSize + 4);header.write("GDPC");header.writeUInt32LE(version, 4);header.writeUInt32LE(version === 1 ? 3 : 4, 8);header.writeUInt32LE(5, 12);
  if (version >= 2) {header.writeUInt32LE(flags, 20);header.writeBigUInt64LE(BigInt(fileBase), 24);if (version === 3) header.writeBigUInt64LE(40n, 32);}
  header.writeUInt32LE(rows.length, headerSize);
  for (const row of rows) {
    const base = version >= 2 ? fileBase + (version === 3 || flags & 2 ? offset : 0) : 0;
    row.row.writeBigUInt64LE(BigInt(offset + size - base), row.pointer);row.row.writeBigUInt64LE(BigInt(row.bytes.length), row.pointer + 8);
    crypto.createHash("md5").update(row.bytes).digest().copy(row.row, row.pointer + 16);size += row.bytes.length;
  }
  const prefix = Buffer.alloc(offset);if (offset >= 2) prefix.write("MZ");
  const tail = Buffer.alloc(trailer ? 12 : 0);if (trailer) {tail.writeBigUInt64LE(BigInt(size));tail.write("GDPC", 8);}
  return {buffer: Buffer.concat([prefix, header, ...rows.map(row => row.row), ...rows.map(row => row.bytes), tail]), offset, size};
}
module.exports = {pack, settings};
