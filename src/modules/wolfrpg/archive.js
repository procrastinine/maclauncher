const fs = require("node:fs");
const path = require("node:path");
const { throwIfAborted } = require("../shared/runtime/download-utils");

// Legacy DX archive layouts and public WOLF keys are described by WolfDec
// 0.3.3 (974071dc0dd1c0046b95cbc0fc94ec24d6bbc904). This independently
// implemented reader has no native dependency.
const LEGACY_KEYS = [
  [0x0f, 0x53, 0xe1, 0x3e, 0x04, 0x37, 0x12, 0x17, 0x60, 0x0f, 0x53, 0xe1],
  [0x4c, 0xd9, 0x2a, 0xb7, 0x28, 0x9b, 0xac, 0x07, 0x3e, 0x77, 0xec, 0x4c],
  [0x38, 0x50, 0x40, 0x28, 0x72, 0x4f, 0x21, 0x70, 0x3b, 0x73, 0x35, 0x38]
];
function archiveKey(input) {
  const k = Buffer.from(input);
  k[0] ^= 255; k[1] = (k[1] >>> 4) | (k[1] << 4); k[2] ^= 0x8a;
  k[3] = ~((k[3] >>> 4) | (k[3] << 4)); k[4] ^= 255; k[5] ^= 0xac;
  k[6] ^= 255; k[7] = ~((k[7] >>> 3) | (k[7] << 5));
  k[8] = (k[8] >>> 5) | (k[8] << 3); k[9] ^= 0x7f;
  k[10] = ((k[10] >>> 4) | (k[10] << 4)) ^ 0xd6; k[11] ^= 0xcc;
  return k;
}
function xorBytes(buffer, key, offset = 0) {
  const out = Buffer.from(buffer);
  for (let index = 0; index < out.length; index++) out[index] ^= key[(offset + index) % key.length];
  return out;
}
function decodeLz(source, expectedSize, maximumSize = 256 * 1024 ** 2) {
  if (source.length < 9 || source.readUInt32LE(0) !== expectedSize || source.readUInt32LE(4) !== source.length || expectedSize > maximumSize) throw new Error("Invalid compressed WOLF archive entry.");
  const output = Buffer.alloc(expectedSize), marker = source[8];
  let read = 9, write = 0;
  const byte = () => { if (read >= source.length) throw new Error("Truncated WOLF archive entry."); return source[read++]; };
  while (read < source.length) {
    const value = byte();
    if (value !== marker) { if (write >= expectedSize) throw new Error("Oversized WOLF archive entry."); output[write++] = value; continue; }
    let code = byte();
    if (code === marker) { if (write >= expectedSize) throw new Error("Oversized WOLF archive entry."); output[write++] = marker; continue; }
    if (code > marker) code--;
    let count = code >>> 3;
    if (code & 4) count |= byte() << 5;
    count += 4;
    const width = (code & 3) + 1;
    if (width > 3) throw new Error("Invalid WOLF archive back-reference.");
    let distance = 0;
    for (let index = 0; index < width; index++) distance |= byte() << (index * 8);
    distance++;
    if (distance > write || write + count > expectedSize) throw new Error("Invalid WOLF archive back-reference.");
    for (let index = 0; index < count; index++) { output[write] = output[write - distance]; write++; }
  }
  if (write !== expectedSize) throw new Error("WOLF archive entry size does not match.");
  return output;
}
function openLegacyArchive(file) {
  const fd = fs.openSync(file, "r"), fileSize = fs.fstatSync(fd).size;
  function read(offset, size, key, keyOffset = offset) {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0 || offset + size > fileSize || size > 256 * 1024 ** 2) throw new Error("Invalid WOLF archive offset.");
    const buffer = Buffer.alloc(size);
    if (fs.readSync(fd, buffer, 0, size, offset) !== size) throw new Error("WOLF archive could not be read.");
    return key ? xorBytes(buffer, key, keyOffset) : buffer;
  }
  try {
    const first = read(0, Math.min(48, fileSize));
    let key, header;
    for (const candidate of [...LEGACY_KEYS.map(archiveKey), Buffer.alloc(12, 255), Buffer.alloc(12)]) {
      const decoded = xorBytes(first, candidate);
      const version = decoded.length >= 4 && decoded.readUInt16LE(2);
      if (decoded.toString("ascii", 0, 2) === "DX" && version >= 1 && version <= 6) { key = candidate; header = decoded; break; }
    }
    if (!header) { fs.closeSync(fd); return null; }
    const version = header.readUInt16LE(2), wide = version === 6;
    const integer = (buffer, offset, long = wide) => {
      const value = long ? buffer.readBigUInt64LE(offset) : BigInt(buffer.readUInt32LE(offset));
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("WOLF archive offset is too large.");
      return Number(value);
    };
    const headSize = header.readUInt32LE(4), dataStart = integer(header, 8), nameStart = integer(header, wide ? 16 : 12);
    const filesStart = integer(header, wide ? 24 : 16), directoriesStart = integer(header, wide ? 32 : 20);
    if (headSize > 64 * 1024 ** 2 || headSize < 16 || filesStart >= headSize || directoriesStart >= headSize || dataStart < (wide ? 48 : version >= 4 ? 28 : 24)) throw new Error("Invalid WOLF archive tables.");
    const tables = read(nameStart, headSize, key, version >= 5 ? 0 : nameStart);
    const entries = [], visited = new Set(), filenames = new Set(), unit = wide ? 8 : 4, recordSize = wide ? 64 : version >= 2 ? 44 : 40;
    const codePage = version >= 4 ? integer(header, wide ? 40 : 24) : 932;
    const decoder = new TextDecoder(codePage === 65001 ? "utf-8" : "shift_jis", { fatal: true });
    function checked(buffer, offset, size) { if (offset < 0 || offset + size > buffer.length) throw new Error("Invalid WOLF archive table entry."); }
    function nameAt(offset) {
      checked(tables, offset, 4);
      const start = offset + 4 + tables.readUInt16LE(offset) * 4;
      checked(tables, start, 1);
      const end = tables.indexOf(0, start);
      if (end < start || end - start > 1024) throw new Error("Invalid WOLF archive filename.");
      const name = decoder.decode(tables.subarray(start, end));
      if (!name || name === "." || name === ".." || /[\\/\0:]/.test(name)) throw new Error("Unsafe WOLF archive filename.");
      return name;
    }
    function visit(directoryOffset, parent = "", depth = 0) {
      if (depth > 32 || visited.has(directoryOffset)) throw new Error("Invalid WOLF archive directory tree.");
      visited.add(directoryOffset);
      if (visited.size > 100000) throw new Error("WOLF archive contains too many directories.");
      const directory = directoriesStart + directoryOffset;
      checked(tables, directory, unit * 4);
      const count = integer(tables, directory + unit * 2), firstFile = integer(tables, directory + unit * 3);
      if (count > 100000 || entries.length + count > 100000) throw new Error("WOLF archive contains too many files.");
      for (let index = 0; index < count; index++) {
        const record = filesStart + firstFile + index * recordSize;
        checked(tables, record, recordSize);
        const name = nameAt(integer(tables, record)), attributes = integer(tables, record + unit);
        const relative = parent ? parent + "/" + name : name;
        const identity = relative.toLowerCase();
        if (filenames.has(identity)) throw new Error("Ambiguous WOLF archive filename.");
        filenames.add(identity);
        const address = integer(tables, record + (wide ? 40 : 32)), size = integer(tables, record + (wide ? 48 : 36));
        if (attributes & 16) { visit(address, relative, depth + 1); continue; }
        const compressedValue = version >= 2 ? (wide ? tables.readBigUInt64LE(record + 56) : BigInt(tables.readUInt32LE(record + 40))) : 0xffffffffn;
        const compressed = compressedValue !== (wide ? 0xffffffffffffffffn : 0xffffffffn), storedSize = compressed ? Number(compressedValue) : size;
        if (size > 256 * 1024 ** 2 || !Number.isSafeInteger(storedSize) || dataStart + address + storedSize > nameStart) throw new Error("Invalid WOLF archive file size.");
        entries.push({ name: relative, size, storedSize, compressed, offset: dataStart + address });
      }
    }
    visit(0);
    return { entries, version, close: () => fs.closeSync(fd), readEntry: entry => {
      const bytes = read(entry.offset, entry.storedSize, key, version >= 5 ? entry.size : entry.offset);
      return entry.compressed ? decodeLz(bytes, entry.size) : bytes;
    } };
  } catch (error) { fs.closeSync(fd); throw error; }
}
function extractLegacyArchive(file, destination, { signal, maximumBytes = 8 * 1024 ** 3 } = {}) {
  const archive = openLegacyArchive(file);
  if (!archive) return null;
  let bytes = 0;
  try {
    if (archive.entries.reduce((sum, item) => sum + item.size, 0) > maximumBytes) throw new Error("WOLF archive exceeds the extraction limit.");
    for (const entry of archive.entries) {
      throwIfAborted(signal);
      const target = path.join(destination, ...entry.name.split("/"));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, archive.readEntry(entry)); bytes += entry.size;
    }
    return { version: archive.version, count: archive.entries.length, bytes };
  } finally { archive.close(); }
}
module.exports = { openLegacyArchive, extractLegacyArchive, decodeLz, __test: { archiveKey, xorBytes } };

// Emit an uncompressed, unencrypted DX8 archive. Legacy game contents retain
// their bytes; only the container changes, with the runtime's required marker.
function writeModernArchive(entries, readEntry, destination, { signal } = {}) {
  const names = [Buffer.alloc(4)], records = [], directories = [], assets = [];
  let nameBytes = 4, dataBytes = 0;
  const tree = { name: "", children: new Map() };
  if (entries.length > 100000 || entries.reduce((sum, entry) => sum + entry.size, 0) > 8 * 1024 ** 3) throw new Error("WOLF archive exceeds the storage limit.");
  for (const entry of entries) {
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > 256 * 1024 ** 2) throw new Error("Invalid WOLF archive file size.");
    const parts = entry.name.replace(/\\/g, "/").split("/");
    if (parts.length > 32 || parts.some(name => !name || name === "." || name === ".." || /[\0:]/.test(name))) throw new Error("Unsafe WOLF archive filename.");
    let current = tree;
    for (const part of parts.slice(0, -1)) {
      if (!current.children.has(part)) {
        if ([...current.children.keys()].some(name => name.toLowerCase() === part.toLowerCase())) throw new Error("Ambiguous WOLF archive directory name.");
        current.children.set(part, { name: part, children: new Map() });
      }
      current = current.children.get(part);
      if (!current.children) throw new Error("Conflicting WOLF archive filenames.");
    }
    const leaf = parts.at(-1);
    if ([...current.children.keys()].some(name => name.toLowerCase() === leaf.toLowerCase())) throw new Error("Duplicate WOLF archive filename.");
    current.children.set(leaf, { name: leaf, entry });
  }
  function addName(name) {
    if (!name) return 0;
    const original = Buffer.from(name, "utf8"), upper = Buffer.from(name.replace(/[a-z]/g, value => value.toUpperCase()), "utf8");
    const padded = Math.ceil((Math.max(original.length, upper.length) + 1) / 4) * 4;
    if (padded > 0xffff * 4) throw new Error("WOLF archive filename is too long.");
    const value = Buffer.alloc(4 + padded * 2);
    value.writeUInt16LE(padded / 4); value.writeUInt16LE(upper.reduce((sum, byte) => sum + byte, 0) & 0xffff, 2);
    upper.copy(value, 4); original.copy(value, 4 + padded);
    const offset = nameBytes; names.push(value); nameBytes += value.length; return offset;
  }
  function addRecord(node) {
    const record = Buffer.alloc(72), index = records.length;
    record.writeBigUInt64LE(BigInt(addName(node.name)), 0);
    record.writeBigUInt64LE(node.children ? 16n : 32n, 8);
    record.writeBigUInt64LE(0xffffffffffffffffn, 56); record.writeBigUInt64LE(0xffffffffffffffffn, 64);
    records.push(record);
    if (!node.children) {
      record.writeBigUInt64LE(BigInt(dataBytes), 40); record.writeBigUInt64LE(BigInt(node.entry.size), 48);
      assets.push(node.entry); dataBytes += Math.ceil(node.entry.size / 4) * 4;
    }
    return index;
  }
  const rootRecord = addRecord(tree);
  function addDirectory(node, recordIndex, parentIndex = null) {
    const index = directories.length, directory = Buffer.alloc(32); directories.push(directory);
    records[recordIndex].writeBigUInt64LE(BigInt(index * 32), 40);
    directory.writeBigUInt64LE(BigInt(recordIndex * 72), 0);
    directory.writeBigUInt64LE(parentIndex == null ? 0xffffffffffffffffn : BigInt(parentIndex * 32), 8);
    const children = [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name));
    directory.writeBigUInt64LE(BigInt(children.length), 16); directory.writeBigUInt64LE(BigInt(records.length * 72), 24);
    const indices = children.map(addRecord);
    for (let child = 0; child < children.length; child++) if (children[child].children) addDirectory(children[child], indices[child], index);
  }
  addDirectory(tree, rootRecord);
  const headSize = nameBytes + records.length * 72 + directories.length * 32;
  const header = Buffer.alloc(64); header.write("DX"); header.writeUInt16LE(8, 2); header.writeUInt32LE(headSize, 4);
  header.writeBigUInt64LE(64n, 8); header.writeBigUInt64LE(BigInt(64 + dataBytes), 16);
  header.writeBigUInt64LE(BigInt(nameBytes), 24); header.writeBigUInt64LE(BigInt(nameBytes + records.length * 72), 32);
  header.writeUInt32LE(65001, 40); header.writeUInt32LE(3, 44);
  const fd = fs.openSync(destination, "wx");
  try {
    fs.writeSync(fd, header);
    for (const asset of assets) {
      throwIfAborted(signal); const content = readEntry(asset);
      if (content.length !== asset.size) throw new Error("WOLF archive entry size does not match.");
      fs.writeSync(fd, content);
      const padding = (4 - content.length % 4) % 4; if (padding) fs.writeSync(fd, Buffer.alloc(padding));
    }
    for (const table of [...names, ...records, ...directories]) fs.writeSync(fd, table);
  } catch (error) { fs.closeSync(fd); fs.rmSync(destination, { force: true }); throw error; }
  fs.closeSync(fd);
  return { count: entries.length, bytes: 64 + dataBytes + headSize };
}
module.exports.writeModernArchive = writeModernArchive;
module.exports.openArchive = file => openLegacyArchive(file) || require("./archive-modern").openModernArchive(file);
