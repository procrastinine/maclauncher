const fs = require("node:fs");
const path = require("node:path");
const { TextDecoder } = require("node:util");

// Format evidence: read-only OpenBGI e2500e0badd04aab472e4620477747973e5e5544
// (tools/unarc/src/dsc.c), and GARbro's documented ARC20 record layout.
const LIMITS = Object.freeze({ entries: 65536, indexBytes: 8 * 1024 * 1024, memberBytes: 32 * 1024 * 1024, outputBytes: 32 * 1024 * 1024 });
const DSC_MAGIC = Buffer.from("DSC FORMAT 1.00", "ascii");

function read(fd, size, at, file, detection) {
  if (!Number.isSafeInteger(at) || at < 0 || !Number.isSafeInteger(size) || size < 0) throw new Error("Invalid BGI read range.");
  if (detection?.readBytes) {
    const data = detection.readBytes(file, at, size);
    if (data.length !== size) throw new Error("Truncated BGI archive.");
    return data;
  }
  const data = Buffer.alloc(size);
  if (fs.readSync(fd, data, 0, size, at) !== size) throw new Error("Truncated BGI archive.");
  return data;
}

function inspectArchive(file, { detection, maximumIndexBytes = LIMITS.indexBytes } = {}) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 16) throw new Error("BGI archives must be regular files with a complete header.");
  const fd = detection?.readBytes ? null : fs.openSync(file, "r");
  let bytesRead = 16;
  try {
    const header = read(fd, 16, 0, file, detection), signature = header.subarray(0, 12).toString("ascii");
    const format = signature === "BURIKO ARC20" ? "ARC20" : signature === "PackFile    " ? "PackFile" : null;
    if (!format) throw new Error("Unsupported BGI archive signature.");
    const count = header.readUInt32LE(12), stride = format === "ARC20" ? 128 : 32, nameBytes = format === "ARC20" ? 96 : 16;
    if (!Number.isSafeInteger(maximumIndexBytes) || maximumIndexBytes < 16 || maximumIndexBytes > LIMITS.indexBytes ||
      !count || count > LIMITS.entries || 16 + count * stride > maximumIndexBytes || 16 + count * stride > stat.size) throw new Error("BGI archive index exceeds its bounds.");
    bytesRead += count * stride;
    const index = read(fd, count * stride, 16, file, detection), base = 16 + index.length, members = new Map();
    for (let i = 0; i < count; i++) {
      const record = index.subarray(i * stride, (i + 1) * stride), raw = record.subarray(0, nameBytes), zero = raw.indexOf(0);
      const name = new TextDecoder("shift_jis", { fatal: true }).decode(zero < 0 ? raw : raw.subarray(0, zero));
      if (!name || path.isAbsolute(name) || /[\\/:\x00-\x1f]/.test(name) || [".", ".."].includes(name)) throw new Error("Unsafe BGI member filename.");
      const key = name.toLowerCase(), offset = base + record.readUInt32LE(nameBytes), size = record.readUInt32LE(nameBytes + 4);
      if (members.has(key)) throw new Error("Duplicate BGI member filename.");
      if (offset > stat.size || size > stat.size - offset) throw new Error("BGI member lies outside its archive.");
      members.set(key, { name, offset, size });
    }
    return { file: path.resolve(file), format, size: stat.size, members, bytesRead };
  } catch (error) {
    error.archiveBytesRead = bytesRead;
    throw error;
  } finally { if (fd !== null) fs.closeSync(fd); }
}

function decodeDsc(bytes, { maximumOutput = LIMITS.outputBytes } = {}) {
  if (bytes.length < 0x220 || !bytes.subarray(0, 15).equals(DSC_MAGIC)) throw new Error("Incomplete DSC1 compressed header.");
  const size = bytes.readUInt32LE(20), symbolCount = bytes.readUInt32LE(24);
  if (!Number.isSafeInteger(maximumOutput) || maximumOutput < 0 || maximumOutput > LIMITS.outputBytes || size > maximumOutput || symbolCount > size) throw new Error("DSC1 output exceeds its bounds.");
  if (!size && !symbolCount) return Buffer.alloc(0);
  let key = bytes.readUInt32LE(16);
  const leaves = [];
  for (let symbol = 0; symbol < 512; symbol++) {
    const low = Math.imul(key & 0xffff, 20021) >>> 0;
    const high = (Math.imul(key >>> 16, 20021) + Math.imul(key, 346) + (low >>> 16)) >>> 0;
    key = ((high << 16) + (low & 0xffff) + 1) >>> 0;
    const depth = (bytes[32 + symbol] - (high & 0xff)) & 0xff;
    if (depth > 32) throw new Error("DSC1 Huffman depth exceeds its bounds.");
    if (depth) leaves.push({ depth, symbol });
  }
  if (!leaves.length || !symbolCount) throw new Error("DSC1 Huffman table is empty.");
  leaves.sort((a, b) => a.depth - b.depth || a.symbol - b.symbol);
  const nodes = [{}]; let current = [0], cursor = 0;
  for (let depth = 0; cursor < leaves.length; depth++) {
    if (depth > 32 || !current.length) throw new Error("Invalid DSC1 Huffman table.");
    const next = []; let used = 0;
    while (cursor < leaves.length && leaves[cursor].depth === depth) {
      if (used >= current.length) throw new Error("Oversubscribed DSC1 Huffman table.");
      nodes[current[used++]].symbol = leaves[cursor++].symbol;
    }
    for (let i = used; i < current.length; i++) {
      if (nodes.length + 2 > 1023) throw new Error("DSC1 Huffman tree exceeds its bounds.");
      nodes[current[i]].children = [nodes.length, nodes.length + 1];
      next.push(nodes.length, nodes.length + 1); nodes.push({}, {});
    }
    current = next;
  }
  let bit = 0x220 * 8, written = 0;
  function bits(count) {
    if (bit + count > bytes.length * 8) throw new Error("Truncated DSC1 bitstream.");
    let value = 0;
    while (count--) { value = (value << 1) | ((bytes[bit >>> 3] >>> (7 - (bit & 7))) & 1); bit++; }
    return value;
  }
  const output = Buffer.alloc(size);
  for (let i = 0; i < symbolCount; i++) {
    let node = nodes[0], steps = 0;
    while (node.symbol === undefined) {
      if (!node.children || steps++ > 32) throw new Error("Invalid DSC1 symbol path.");
      node = nodes[node.children[bits(1)]];
    }
    if (node.symbol < 256) {
      if (written >= size) throw new Error("DSC1 literal exceeds its output size.");
      output[written++] = node.symbol;
    } else {
      const length = (node.symbol & 0xff) + 2, distance = bits(12) + 2;
      let source = written - distance;
      if (source < 0 || length > size - written) throw new Error("DSC1 match exceeds its output window.");
      for (let j = 0; j < length; j++) output[written++] = output[source++];
    }
  }
  if (written !== size) throw new Error("DSC1 decoded size differs from its header.");
  return output;
}

function readMember(archive, member, { maximumBytes = LIMITS.memberBytes, maximumOutput = LIMITS.outputBytes, detection } = {}) {
  if (!member || archive.members.get(member.name?.toLowerCase()) !== member || !Number.isSafeInteger(maximumBytes) || maximumBytes < 0 || maximumBytes > LIMITS.memberBytes || member.size > maximumBytes ||
      !Number.isSafeInteger(maximumOutput) || maximumOutput < 0 || maximumOutput > LIMITS.outputBytes) throw new Error("BGI member exceeds its extraction bounds.");
  const fd = detection?.readBytes ? null : fs.openSync(archive.file, "r");
  try {
    const data = read(fd, member.size, member.offset, archive.file, detection);
    if (data.subarray(0, 15).equals(DSC_MAGIC)) return decodeDsc(data, { maximumOutput });
    if (data.length > maximumOutput) throw new Error("BGI plain member exceeds its output bounds.");
    return data;
  } finally { if (fd !== null) fs.closeSync(fd); }
}

function inspectProgram(bytes) {
  if (bytes.length < 8) throw new Error("Truncated Buriko program header.");
  const offset = bytes.readUInt32LE(0), size = bytes.readUInt32LE(4);
  if (offset < 8 || offset > bytes.length || !size || size > bytes.length - offset) throw new Error("Invalid Buriko program code range.");
  return { codeOffset: offset, codeBytes: size, firstOpcode: bytes[offset], headerWords: Array.from({ length: Math.min(4, offset >>> 2) }, (_, i) => bytes.readUInt32LE(i * 4)) };
}

module.exports = { LIMITS, inspectArchive, readMember, decodeDsc, inspectProgram };
