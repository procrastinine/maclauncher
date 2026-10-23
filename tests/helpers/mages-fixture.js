const fs = require("node:fs");
const zlib = require("node:zlib");

function script({ empty = false, returns = [], includeStrings = true } = {}) {
  const auxiliary = includeStrings ? 24 : 20;
  const bytes = Buffer.alloc(empty ? 16 : (includeStrings ? 34 : 20) + returns.length * 4);
  bytes.write("SC3\0"); bytes.writeUInt32LE(empty ? 16 : 20, 4); bytes.writeUInt32LE(empty ? 16 : auxiliary, 8); bytes.writeUInt32LE(16, 12);
  if (!empty) {
    bytes.set([0, 0x29, 0, 0x2a], 16);
    if (includeStrings) bytes.writeUInt32LE(auxiliary + returns.length * 4, 20);
    returns.forEach((address, index) => bytes.writeUInt32LE(address, auxiliary + index * 4));
    if (includeStrings) bytes.write("Synthetic\0", auxiliary + returns.length * 4);
  }
  return bytes;
}

function archive(file, items, { padding = 0 } = {}) {
  const header = Buffer.alloc(64); header.write("MPK\0"); header.writeUInt16LE(2, 6); header.writeUInt32LE(items.length + padding, 8);
  const records = [], payloads = []; let offset = 64 + (items.length + padding) * 256;
  for (let i = 0; i < items.length; i++) {
    const { name, compressed = false, id = i } = items[i], decoded = Buffer.from(items[i].bytes), bytes = compressed ? zlib.deflateSync(decoded) : decoded;
    const record = Buffer.alloc(256); record.writeUInt32LE(compressed ? 1 : 0, 0); record.writeUInt32LE(id, 4);
    record.writeBigUInt64LE(BigInt(offset), 8); record.writeBigUInt64LE(BigInt(bytes.length), 16); record.writeBigUInt64LE(BigInt(decoded.length), 24); record.write(name, 32, 223, "utf8");
    records.push(record); payloads.push(bytes); offset += bytes.length;
  }
  records.push(Buffer.alloc(padding * 256)); fs.writeFileSync(file, Buffer.concat([header, ...records, ...payloads])); return file;
}

module.exports = { archive, script };
