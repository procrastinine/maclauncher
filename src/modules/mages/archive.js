const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { TextDecoder } = require("node:util");

// MPK v2: CommitteeOfZero/impacto ba51381fb65da70697be29e6a817dc4af5c98d19,
// src/io/mpkarchive.cpp. SC3 offsets: src/vm/vm.cpp ScriptGetLabelAddress /
// ScriptGetStrAddress / ScriptGetRetAddress. These structures do not identify
// the VM instruction set; the third header offset may precede return ids.
const LIMITS = Object.freeze({ entries: 65535, indexBytes: 16 * 1024 * 1024,
  memberBytes: 32 * 1024 * 1024, scriptLabels: 65536, scriptStrings: 262144 });
const decoder = new TextDecoder("utf-8", { fatal: true });

function boundedRead(fd, file, offset, length, detection) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) throw new Error("Invalid MPK read range.");
  const bytes = Buffer.alloc(length);
  if (detection?.readBytes) {
    for (let position = 0; position < length; position += 2 * 1024 * 1024) {
      const size = Math.min(length - position, 2 * 1024 * 1024), chunk = detection.readBytes(file, offset + position, size);
      if (!chunk || chunk.length !== size) throw new Error("Truncated MPK archive.");
      chunk.copy(bytes, position);
    }
  } else if (fs.readSync(fd, bytes, 0, length, offset) !== length) throw new Error("Truncated MPK archive.");
  return bytes;
}

function safeName(name) {
  if (!name || name.length > 223 || /^[\\/]/.test(name) || path.isAbsolute(name) || /[:\x00-\x1f\x7f]/.test(name)) return false;
  return name.split(/[\\/]/).every(part => part && ![".", ".."].includes(part) && !/[. ]$/.test(part) &&
    !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}

function safeInteger64(record, offset) {
  const value = record.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("MPK member range exceeds safe integer bounds.");
  return Number(value);
}

function identity(stat) { return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":"); }

function inspectArchive(file, { detection, maximumIndexBytes = LIMITS.indexBytes } = {}) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 64) throw new Error("MPK archives must be regular files with a complete header.");
  const fd = detection?.readBytes ? null : fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  let bytesRead = 0;
  try {
    const header = boundedRead(fd, file, 0, 64, detection); bytesRead += header.length;
    if (!header.subarray(0, 4).equals(Buffer.from("MPK\0"))) throw new Error("Unsupported MPK archive signature.");
    const minor = header.readUInt16LE(4), major = header.readUInt16LE(6), count = header.readUInt32LE(8);
    if (major !== 2 || minor !== 0) throw new Error(`Unsupported MPK archive version ${major}.${minor}.`);
    if (!Number.isSafeInteger(maximumIndexBytes) || maximumIndexBytes < 64 || maximumIndexBytes > LIMITS.indexBytes ||
      !count || count > LIMITS.entries || 64 + count * 256 > maximumIndexBytes || 64 + count * 256 > stat.size) throw new Error("MPK archive index exceeds its bounds.");
    const index = boundedRead(fd, file, 64, count * 256, detection); bytesRead += index.length;
    const payloadStart = 64 + index.length, members = new Map(), ids = new Set(), ranges = [];
    let paddingEntries = 0;
    for (let i = 0; i < count; i++) {
      const record = index.subarray(i * 256, (i + 1) * 256), compression = record.readUInt32LE(0), id = record.readUInt32LE(4);
      if (record.every(byte => byte === 0)) {
        if (!index.subarray(i * 256).every(byte => byte === 0)) throw new Error("MPK index contains an interior empty entry.");
        paddingEntries = count - i;
        break;
      }
      if (![0, 1].includes(compression)) throw new Error("Unsupported MPK member compression.");
      const raw = record.subarray(32), zero = raw.indexOf(0);
      if (zero < 0) throw new Error("Unterminated MPK member filename.");
      const name = decoder.decode(raw.subarray(0, zero));
      if (!safeName(name)) throw new Error("Unsafe MPK member filename.");
      const relativePath = name.replace(/\\/g, "/"), key = relativePath.toLowerCase();
      if (members.has(key) || ids.has(id)) throw new Error("Duplicate MPK member filename or id.");
      const offset = safeInteger64(record, 8), storedBytes = safeInteger64(record, 16), decodedBytes = safeInteger64(record, 24);
      if (offset < payloadStart || offset > stat.size || storedBytes > stat.size - offset ||
        compression === 0 && storedBytes !== decodedBytes) throw new Error("MPK member lies outside its archive or has an invalid size.");
      const member = Object.freeze({ name, relativePath, id, offset, storedBytes, decodedBytes, compression });
      members.set(key, member); ids.add(id);
      if (storedBytes) ranges.push([offset, offset + storedBytes]);
    }
    ranges.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < ranges.length; i++) if (ranges[i][0] < ranges[i - 1][1]) throw new Error("Overlapping MPK member payloads.");
    if (!members.size) throw new Error("MPK archive index is empty.");
    return { file: path.resolve(file), format: "MPK 2.0", major, minor, size: stat.size, identity: identity(stat), members, bytesRead, paddingEntries };
  } catch (error) { error.archiveBytesRead = bytesRead; throw error; }
  finally { if (fd !== null) fs.closeSync(fd); }
}

function readMember(archive, member, { detection, maximumBytes = LIMITS.memberBytes, maximumOutput = LIMITS.memberBytes } = {}) {
  if (!member || archive.members.get(member.relativePath?.toLowerCase()) !== member ||
    !Number.isSafeInteger(maximumBytes) || maximumBytes < 0 || maximumBytes > LIMITS.memberBytes || member.storedBytes > maximumBytes ||
    !Number.isSafeInteger(maximumOutput) || maximumOutput < 0 || maximumOutput > LIMITS.memberBytes || member.decodedBytes > maximumOutput) throw new Error("MPK member exceeds its extraction bounds.");
  const current = fs.lstatSync(archive.file);
  if (!current.isFile() || current.isSymbolicLink() || identity(current) !== archive.identity) throw new Error("MPK archive changed during inspection.");
  const fd = detection?.readBytes ? null : fs.openSync(archive.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    if (fd !== null && identity(fs.fstatSync(fd)) !== archive.identity) throw new Error("MPK archive changed during inspection.");
    const bytes = boundedRead(fd, archive.file, member.offset, member.storedBytes, detection);
    const output = member.compression === 1 ? zlib.inflateSync(bytes, { maxOutputLength: Math.max(1, member.decodedBytes) }) : bytes;
    if (output.length !== member.decodedBytes) throw new Error("MPK decoded size differs from its index.");
    return output;
  } finally { if (fd !== null) fs.closeSync(fd); }
}

function inspectScript(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 16 || !bytes.subarray(0, 4).equals(Buffer.from("SC3\0"))) throw new Error("Unsupported or truncated SC3 script header.");
  const stringTableOffset = bytes.readUInt32LE(4), auxiliaryTableOffset = bytes.readUInt32LE(8), codeOffset = bytes.readUInt32LE(12);
  const labelCount = (codeOffset - 12) / 4, stringCount = (auxiliaryTableOffset - stringTableOffset) / 4;
  if (codeOffset < 16 || codeOffset > stringTableOffset || stringTableOffset > auxiliaryTableOffset || auxiliaryTableOffset > bytes.length ||
    !Number.isInteger(labelCount) || labelCount > LIMITS.scriptLabels || !Number.isInteger(stringCount) || stringCount > LIMITS.scriptStrings) throw new Error("SC3 script tables exceed their bounds.");
  for (let i = 0; i < labelCount; i++) {
    const address = bytes.readUInt32LE(12 + i * 4);
    if (address < codeOffset || address > stringTableOffset || address === stringTableOffset && codeOffset !== stringTableOffset) throw new Error("SC3 label lies outside its code range.");
  }
  let stringDataOffset = bytes.length;
  for (let i = 0; i < stringCount; i++) {
    const address = bytes.readUInt32LE(stringTableOffset + i * 4);
    if (address < auxiliaryTableOffset || address >= bytes.length) throw new Error("SC3 string lies outside its data range.");
    stringDataOffset = Math.min(stringDataOffset, address);
  }
  let returnCount = (stringDataOffset - auxiliaryTableOffset) / 4;
  if (!Number.isInteger(returnCount) || returnCount > LIMITS.scriptLabels) returnCount = null;
  if (returnCount) for (let i = 0; i < returnCount; i++) {
    const address = bytes.readUInt32LE(auxiliaryTableOffset + i * 4);
    if (address < codeOffset || address >= stringTableOffset) { returnCount = null; break; }
  }
  return { format: "SC3", codeOffset, codeBytes: stringTableOffset - codeOffset, empty: codeOffset === stringTableOffset, labelCount,
    stringTableOffset, auxiliaryTableOffset, stringDataOffset, stringCount,
    returnTableOffset: returnCount === null ? null : auxiliaryTableOffset, returnCount,
    firstOpcode: bytes.subarray(codeOffset, Math.min(codeOffset + 2, stringTableOffset)).toString("hex") };
}

module.exports = { LIMITS, inspectArchive, readMember, inspectScript, safeName };
