// Studio 1.4's public Mac update is a filename-keyed ZipCrypto container.
// Decode that transport format only; this never runs the IDE or touches a licence.
const fs = require("node:fs");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { readZipEntries } = require("../../shared/runtime/zip");

const SHIFTS = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
const CONSTANTS = Array.from({ length: 64 }, (_, index) => Math.floor(Math.abs(Math.sin(index + 1)) * 2 ** 32) >>> 0);
const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});
const crcStep = (state, byte) => ((state >>> 8) ^ CRC_TABLE[(state ^ byte) & 255]) >>> 0;
function crc32(bytes) {
  let state = 0xffffffff;
  for (const byte of bytes) state = crcStep(state, byte);
  return (state ^ 0xffffffff) >>> 0;
}

function compressMd5(state, block) {
  let [a, b, c, d] = state;
  for (let round = 0; round < 64; round++) {
    let f, word, group = round >>> 4;
    if (group === 0) { f = (b & c) | (~b & d); word = round; }
    else if (group === 1) { f = (d & b) | (~d & c); word = (5 * round + 1) % 16; }
    else if (group === 2) { f = b ^ c ^ d; word = (3 * round + 5) % 16; }
    else { f = c ^ (b | ~d); word = (7 * round) % 16; }
    const sum = (a + f + CONSTANTS[round] + block.readUInt32LE(word * 4)) >>> 0;
    const shift = SHIFTS[group * 4 + round % 4];
    [a, b, c, d] = [d, (b + ((sum << shift) | (sum >>> (32 - shift)))) >>> 0, b, c];
  }
  return state.map((value, index) => (value + [a, b, c, d][index]) >>> 0);
}

function packageKey(filename) {
  if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\.zip$/i.test(filename || "")) {
    throw new Error("Legacy official package needs its published UUID filename.");
  }
  const message = Buffer.from("MRJA" + filename + "PHMD", "utf8");
  const first = crypto.createHash("md5").update(message).digest();
  // The historical updater calls Finish twice. BouncyCastle counts bytes only
  // through the next four-byte boundary when filling its first padding block.
  const second = Buffer.alloc(64); second[0] = 0x80;
  second.writeBigUInt64LE(BigInt(Math.ceil((message.length + 1) / 4) * 4 * 8), 56);
  const result = compressMd5(Array.from({ length: 4 }, (_, index) => first.readUInt32LE(index * 4)), second);
  const digest = Buffer.alloc(16); result.forEach((value, index) => digest.writeUInt32LE(value, index * 4));
  return Buffer.from(digest.toString("base64"), "ascii");
}

function decrypt(bytes, key, checkByte) {
  let first = 0x12345678, second = 0x23456789, third = 0x34567890;
  const update = byte => {
    first = crcStep(first, byte);
    second = (Math.imul((second + (first & 255)) >>> 0, 134775813) + 1) >>> 0;
    third = crcStep(third, second >>> 24);
  };
  for (const byte of key) update(byte);
  const output = Buffer.alloc(bytes.length);
  for (let index = 0; index < bytes.length; index++) {
    const temp = third | 2;
    const byte = bytes[index] ^ ((Math.imul(temp, temp ^ 1) >>> 8) & 255);
    update(byte); output[index] = byte;
  }
  if (bytes.length < 12 || output[11] !== checkByte) throw new Error("Legacy official package header failed its transport check.");
  return output.subarray(12);
}

function readPackageMember(filePath, publishedFilename, member, { maxBytes = 32 * 1024 ** 2 } = {}) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024 ** 2) throw new Error("Legacy official package is not a bounded regular ZIP.");
  const archive = readZipEntries(filePath);
  if (!archive || archive.info.entries > 256 || archive.info.cdSize > 1024 * 1024 || archive.entries.length !== archive.info.entries) throw new Error("Legacy official package inventory is invalid or too large.");
  const matching = archive.entries.filter(item => item.name === member);
  if (matching.length !== 1) throw new Error("Legacy official package must contain exactly one selected member.");
  const entry = matching[0];
  if (entry.uncompressedSize < 1 || entry.uncompressedSize > maxBytes || entry.compressedSize < 12 || entry.compressedSize > maxBytes) {
    throw new Error("Legacy official package member exceeds the extraction limit.");
  }
  const fd = fs.openSync(filePath, "r");
  const read = (offset, length) => {
    if (offset < 0 || offset + length > archive.info.zipBase + archive.info.cdOffset) throw new Error("Legacy official package member escapes its payload.");
    const buffer = Buffer.alloc(length);
    if (fs.readSync(fd, buffer, 0, length, offset) !== length) throw new Error("Legacy official package member is truncated.");
    return buffer;
  };
  try {
    const central = Buffer.alloc(archive.info.cdSize);
    if (fs.readSync(fd, central, 0, central.length, archive.info.zipBase + archive.info.cdOffset) !== central.length) throw new Error("Legacy official package directory is truncated.");
    let centralRecord;
    for (let offset = 0, index = 0; index < archive.info.entries; index++) {
      if (offset + 46 > central.length || central.readUInt32LE(offset) !== 0x02014b50) throw new Error("Legacy official package directory is invalid.");
      const end = offset + 46 + central.readUInt16LE(offset + 28);
      const next = end + central.readUInt16LE(offset + 30) + central.readUInt16LE(offset + 32);
      if (next > central.length) throw new Error("Legacy official package directory is truncated.");
      if (central.subarray(offset + 46, end).toString("utf8") === member) centralRecord = {
        flags: central.readUInt16LE(offset + 8), method: central.readUInt16LE(offset + 10), crc: central.readUInt32LE(offset + 16)
      };
      offset = next;
    }
    const header = read(entry.absoluteLocalHeaderOffset, 30);
    const flags = header.readUInt16LE(6), method = header.readUInt16LE(8), crc = header.readUInt32LE(14);
    if (header.readUInt32LE(0) !== 0x04034b50 || !(flags & 1) || (flags & 0x40) || ![0, 8].includes(method)) {
      throw new Error("Legacy official package uses an unsupported transport format.");
    }
    if (!centralRecord || centralRecord.flags !== flags || centralRecord.method !== method || (!(flags & 8) && centralRecord.crc !== crc)) {
      throw new Error("Legacy official package member headers disagree.");
    }
    const nameBytes = header.readUInt16LE(26), extraBytes = header.readUInt16LE(28);
    if (nameBytes > 1024 || extraBytes > 4096 || read(entry.absoluteLocalHeaderOffset + 30, nameBytes).toString("utf8") !== member) {
      throw new Error("Legacy official package member headers disagree.");
    }
    if (!(flags & 8) && (header.readUInt32LE(18) !== entry.compressedSize || header.readUInt32LE(22) !== entry.uncompressedSize)) {
      throw new Error("Legacy official package member sizes disagree.");
    }
    const encrypted = read(entry.absoluteLocalHeaderOffset + 30 + nameBytes + extraBytes, entry.compressedSize);
    const payload = decrypt(encrypted, packageKey(publishedFilename), (flags & 8) ? (header.readUInt16LE(10) >>> 8) : (crc >>> 24));
    const output = method === 8 ? zlib.inflateRawSync(payload, { maxOutputLength: Math.max(1, entry.uncompressedSize) }) : payload;
    if (output.length !== entry.uncompressedSize || crc32(output) !== centralRecord.crc) throw new Error("Legacy official package member failed its length or CRC check.");
    return output;
  } finally { fs.closeSync(fd); }
}

module.exports = { readPackageMember, crc32 };
