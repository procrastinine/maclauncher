// Authored archive metadata fixtures. Four data blocks ensure the traditional
// three-entry XOR inference has a later block to bound against.
function archiveFixture({ type = "arc", count = 4, names, payloads, nameBytes = 20, offsetFirst = false } = {}) {
  names ||= Array.from({ length: count }, (_, i) => i ? `FILE${i}.MES` : "START.MES");
  payloads ||= names.map(() => Buffer.alloc(256, 0x42));
  count = names.length;
  const stride = type === "kakyuusei" ? 20 : type === "dat" ? 28 : nameBytes + 8, index = type === "dat" ? 8 : 4;
  const table = index + count * stride, total = table + payloads.reduce((sum, bytes) => sum + bytes.length, 0);
  const bytes = Buffer.alloc(Math.max(total + 16, 4 + 0x318)), nameKey = 0x5a, offsetKey = 0x40abcd, sizeKey = type === "dat" ? offsetKey : 0x192d9;
  if (type === "dat") { bytes.writeUInt32LE((count ^ offsetKey) >>> 0); bytes.writeUInt32LE(offsetKey, 4); }
  else bytes.writeUInt32LE(count);
  const shuffle = [17, 2, 8, 19, 0, 5, 10, 13, 1, 15, 6, 4, 11, 16, 3, 9, 18, 12, 7, 14];
  let offset = table, key = count & 255;
  for (let i = 0; i < count; i++) {
    const entry = Buffer.alloc(stride), payload = payloads[i];
    if (type === "kakyuusei") {
      const decoded = Buffer.alloc(20); decoded.write(names[i], 0, 12, "latin1");
      decoded.writeUInt32LE(payload.length, 12); decoded.writeUInt32LE(offset, 16);
      for (let b = 0; b < 20; b++) { entry[b] = decoded[shuffle[b]] ^ key; key = (key * 3 + 1) & 255; }
    } else {
      const name = Buffer.alloc(type === "dat" ? 20 : nameBytes); name.write(names[i], "latin1");
      for (let b = 0; b < name.length; b++) name[b] ^= nameKey;
      name.copy(entry, type === "dat" ? 8 : 0);
      const offsetField = type === "dat" ? 4 : nameBytes + (offsetFirst ? 0 : 4), sizeField = type === "dat" ? 0 : nameBytes + (offsetFirst ? 4 : 0);
      entry.writeUInt32LE((offset ^ offsetKey) >>> 0, offsetField); entry.writeUInt32LE((payload.length ^ sizeKey) >>> 0, sizeField);
    }
    entry.copy(bytes, index + i * stride); payload.copy(bytes, offset); offset += payload.length;
  }
  return { bytes, table, stride, index, nameKey, offsetKey, sizeKey };
}

module.exports = { archiveFixture };
