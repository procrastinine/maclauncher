const fs = require("node:fs");
const { decodeLz, __test: { xorBytes } } = require("./archive");

// DX8 container facts and standard WOLF key strings are documented in the
// reference-only WolfDec source. No native library or upstream code is used.
const KEYS = [
  Buffer.from("WLFRPrO!p(;s5((8P@((UFWlu$#5(="),
  Buffer.from([0x0f,0x53,0xe1,0x3e,0x8e,0xb5,0x41,0x91,0x52,0x16,0x55,0xae,0x34,0xc9,0x8f,0x79,0x59,0x2f,0x59,0x6b,0x95,0x19,0x9b,0x1b,0x35,0x9a,0x2f,0xde,0xc9,0x7c,0x12,0x96,0xc3,0x14,0xb5,0x0f,0x53,0xe1,0x3e,0x8e]),
  Buffer.from([0x31,0xf9,0x01,0x36,0xa3,0xe3,0x8d,0x3c,0x7b,0xc3,0x7d,0x25,0xad,0x63,0x28,0x19,0x1b,0xf7,0x8e,0x6c,0xc4,0xe5,0xe2,0x76,0x82,0xea,0x4f,0xed,0x61,0xda,0xe0,0x44,0x5b,0xb6,0x46,0x3b,0x06,0xd5,0xce,0xb6,0x78,0x58,0xd0,0x7c,0x82]),
  Buffer.from("DXLIBARC"), Buffer.from("nGui9('&1=@3#a"), Buffer.from("Ph=X3^]o2A(,1=@3#a")
];
const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value >>> 1 ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});
function modernKey(source) {
  if (source.length < 4) source = Buffer.concat([source, Buffer.from("DXLIBARC")]);
  const crc = parity => {
    let value = 0xffffffff;
    for (let index = parity; index < source.length; index += 2) value = value >>> 8 ^ CRC_TABLE[(value ^ source[index]) & 255];
    return (value ^ 0xffffffff) >>> 0;
  };
  const key = Buffer.alloc(7); key.writeUInt32LE(crc(0)); key.writeUIntLE(crc(1) & 0xffffff, 4, 3); return key;
}
function decodeHuffman(source, maximumSize = 256 * 1024 ** 2, expectedSize) {
  let cursor = 0;
  function bits(count) {
    if (cursor + count > source.length * 8) throw new Error("Truncated WOLF Huffman data.");
    let value = 0n;
    for (let index = 0; index < count; index++, cursor++) value = value * 2n + BigInt(source[cursor >>> 3] >>> (7 - cursor % 8) & 1);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("WOLF Huffman size is too large.");
    return Number(value);
  }
  const size = bits(bits(6) + 1), stored = bits(bits(6) + 1), weights = [];
  if (size > maximumSize || expectedSize !== undefined && size !== expectedSize) throw new Error("Invalid WOLF Huffman output size.");
  for (let index = 0; index < 256; index++) {
    const width = (bits(3) + 1) * 2, negative = bits(1), delta = bits(width);
    const value = index === 0 ? delta : weights[index - 1] + (negative ? -delta : delta);
    if (value < 0 || value > 65535) throw new Error("Invalid WOLF Huffman frequencies.");
    weights.push(value);
  }
  const start = Math.ceil(cursor / 8);
  if (stored !== source.length - start) throw new Error("Invalid WOLF Huffman stored size.");
  const nodes = weights.map((weight, index) => ({ weight, index }));
  let available = [...nodes];
  while (available.length > 1) {
    available.sort((a, b) => a.weight - b.weight || a.index - b.index);
    const left = available.shift(), right = available.shift(), node = { weight: left.weight + right.weight, index: nodes.length, left, right };
    nodes.push(node); available.push(node);
  }
  const root = available[0], output = Buffer.alloc(size);
  let payloadBit = start * 8;
  // A short prefix table keeps large images/audio linear without following
  // every tree edge separately. Tail decoding never reads past the input.
  const lookup = Array.from({ length: 512 }, (_, code) => {
    let node = root, used = 0;
    while (node.left && used < 9) node = code >>> used++ & 1 ? node.right : node.left;
    return { node, used };
  });
  for (let index = 0; index < size; index++) {
    let node = root;
    if (payloadBit + 9 <= source.length * 8) {
      const offset = payloadBit >>> 3, shift = payloadBit % 8, code = (source[offset] | source[offset + 1] << 8 | source[offset + 2] << 16) >>> shift & 511;
      const prefix = lookup[code]; node = prefix.node; payloadBit += prefix.used;
    }
    while (node.left) {
      if (payloadBit >= source.length * 8) throw new Error("Truncated WOLF Huffman payload.");
      node = source[payloadBit >>> 3] >>> (payloadBit++ % 8) & 1 ? node.right : node.left;
    }
    output[index] = node.index;
  }
  return output;
}
function openModernArchive(file) {
  const fd = fs.openSync(file, "r"), fileSize = fs.fstatSync(fd).size;
  const read = (offset, size, key, keyOffset = 0) => {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0 || offset + size > fileSize || size > 256 * 1024 ** 2) throw new Error("Invalid WOLF archive offset.");
    const bytes = Buffer.alloc(size);
    if (fs.readSync(fd, bytes, 0, size, offset) !== size) throw new Error("WOLF archive could not be read.");
    return key ? xorBytes(bytes, key, keyOffset) : bytes;
  };
  const integer = (buffer, offset) => {
    const value = buffer.readBigUInt64LE(offset);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("WOLF archive offset is too large.");
    return Number(value);
  };
  try {
    if (fileSize < 64) { fs.closeSync(fd); return null; }
    const header = read(0, 64);
    if (header.toString("ascii", 0, 2) !== "DX" || header.readUInt16LE(2) !== 8) { fs.closeSync(fd); return null; }
    const headSize = header.readUInt32LE(4), dataStart = integer(header, 8), nameStart = integer(header, 16), filesStart = integer(header, 24), dirsStart = integer(header, 32);
    const flags = header.readUInt32LE(44), huffmanKB = header[48];
    if (headSize < 16 || headSize > 64 * 1024 ** 2 || dataStart < 64 || nameStart < dataStart || nameStart > fileSize || filesStart >= headSize || dirsStart >= headSize || flags & ~3) throw new Error("Invalid WOLF archive tables.");
    const decoder = new TextDecoder(header.readUInt32LE(40) === 65001 ? "utf-8" : "shift_jis", { fatal: true });
    let chosen;
    for (const sourceKey of flags & 1 ? [null] : KEYS) {
      try {
        const tableKey = sourceKey && modernKey(sourceKey), stored = read(nameStart, flags & 2 ? headSize : fileSize - nameStart, tableKey);
        const tables = flags & 2 ? stored : decodeLz(decodeHuffman(stored, 64 * 1024 ** 2), headSize, 64 * 1024 ** 2);
        const entries = [], visited = new Set(), names = new Set();
        const check = (offset, size) => { if (!Number.isSafeInteger(offset) || offset < 0 || offset + size > tables.length) throw new Error("Invalid WOLF archive table entry."); };
        function nameAt(offset) {
          check(offset, 4); const padded = tables.readUInt16LE(offset) * 4, upperStart = offset + 4, start = upperStart + padded;
          check(upperStart, padded * 2);
          const end = tables.indexOf(0, start), upperEnd = tables.indexOf(0, upperStart);
          if (padded < 4 || end < start || end >= start + padded || upperEnd < upperStart || upperEnd >= start || end - start > 1024) throw new Error("Invalid WOLF archive filename.");
          const name = decoder.decode(tables.subarray(start, end));
          if (!name || name === "." || name === ".." || /[\\/\0:]/.test(name)) throw new Error("Unsafe WOLF archive filename.");
          return { name, upper: tables.subarray(upperStart, upperEnd) };
        }
        function visit(offset, parent = "", parentNames = [], depth = 0) {
          if (depth > 32 || visited.has(offset)) throw new Error("Invalid WOLF archive directory tree.");
          visited.add(offset); if (visited.size > 100000) throw new Error("WOLF archive contains too many directories.");
          const directory = dirsStart + offset; check(directory, 32);
          const count = integer(tables, directory + 16), first = integer(tables, directory + 24);
          if (count > 100000 || names.size + count > 100000) throw new Error("WOLF archive contains too many files.");
          for (let index = 0; index < count; index++) {
            const record = filesStart + first + index * 72; check(record, 72);
            const item = nameAt(integer(tables, record)), name = parent ? parent + "/" + item.name : item.name, identity = name.toLowerCase();
            if (names.has(identity)) throw new Error("Ambiguous WOLF archive filename."); names.add(identity);
            const attributes = integer(tables, record + 8), address = integer(tables, record + 40);
            if (attributes & 16) { visit(address, name, [item.upper, ...parentNames], depth + 1); continue; }
            const size = integer(tables, record + 48), pressValue = tables.readBigUInt64LE(record + 56), huffValue = tables.readBigUInt64LE(record + 64);
            const lz = pressValue !== 0xffffffffffffffffn, huffman = huffValue !== 0xffffffffffffffffn;
            const intermediate = lz ? Number(pressValue) : size, huffSize = huffman ? Number(huffValue) : 0;
            const partial = huffman && huffmanKB !== 255 && intermediate > huffmanKB * 2048;
            const storedSize = huffman ? huffSize + (partial ? intermediate - huffmanKB * 2048 : 0) : intermediate;
            if (size > 256 * 1024 ** 2 || !Number.isSafeInteger(intermediate) || intermediate > 256 * 1024 ** 2 || !Number.isSafeInteger(storedSize) || storedSize > 256 * 1024 ** 2 || huffman && (!huffmanKB || huffSize < 1) || dataStart + address + storedSize > nameStart) throw new Error("Invalid WOLF archive file size.");
            const keyString = sourceKey && Buffer.concat([sourceKey, item.upper, ...parentNames]).subarray(0, 2040);
            entries.push({ name, size, storedSize, offset: dataStart + address, lz, huffman, huffSize, partial, intermediate, key: keyString && modernKey(keyString) });
          }
        }
        visit(0); chosen = entries; break;
      } catch (error) { if (flags & 1) throw error; }
    }
    if (!chosen) throw new Error("This WOLF archive uses an unsupported encryption key or damaged tables.");
    return { entries: chosen, version: 8, close: () => fs.closeSync(fd), readEntry(entry) {
      let content = read(entry.offset, entry.storedSize, entry.key, entry.size);
      if (entry.huffman) {
        const size = entry.partial ? huffmanKB * 2048 : entry.intermediate;
        const decoded = decodeHuffman(content.subarray(0, entry.huffSize), 256 * 1024 ** 2, size);
        content = entry.partial ? Buffer.concat([decoded.subarray(0, huffmanKB * 1024), content.subarray(entry.huffSize), decoded.subarray(huffmanKB * 1024)]) : decoded;
      }
      return entry.lz ? decodeLz(content, entry.size) : content;
    } };
  } catch (error) { fs.closeSync(fd); throw error; }
}
module.exports = { openModernArchive, decodeHuffman, modernKey, __test: { KEYS } };
