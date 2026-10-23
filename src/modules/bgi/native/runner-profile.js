// SPDX-License-Identifier: MIT
const fs = require("node:fs");
const crypto = require("node:crypto");
const { selectVerifiedDialect } = require("./dialects");

const LIMITS = Object.freeze({ fileBytes: 16 * 1024 * 1024, sections: 96, identifierBytes: 96 });
function parseRunnerProfile(bytes, inspected) {
  const dialect = selectVerifiedDialect(inspected);
  const invalid = () => { throw new Error("The original BGI executable has no supported project-identifier contract."); };
  if (!Buffer.isBuffer(bytes) || bytes.length < 64 || bytes.length > LIMITS.fileBytes || bytes.readUInt16LE(0) !== 0x5a4d) invalid();
  const pe = bytes.readUInt32LE(60);
  if (pe < 64 || pe > bytes.length - 24 || bytes.readUInt32LE(pe) !== 0x4550 || bytes.readUInt16LE(pe + 4) !== 0x14c) invalid();
  const count = bytes.readUInt16LE(pe + 6), optionalBytes = bytes.readUInt16LE(pe + 20), optional = pe + 24;
  if (!count || count > LIMITS.sections || optionalBytes < 96 || optionalBytes > 4096 || optionalBytes > bytes.length - optional || bytes.readUInt16LE(optional) !== 0x10b) invalid();
  const imageBase = bytes.readUInt32LE(optional + 28), start = optional + optionalBytes;
  if (count * 40 > bytes.length - start) invalid();
  const sections = [];
  for (let i = 0; i < count; i++) {
    const at = start + i * 40, rva = bytes.readUInt32LE(at + 12), size = bytes.readUInt32LE(at + 16), raw = bytes.readUInt32LE(at + 20), flags = bytes.readUInt32LE(at + 36);
    if (size > bytes.length - raw || imageBase + rva + size > 0x100000000) invalid();
    sections.push({ rva, raw, size, executable: Boolean(flags & 0x20000000) });
  }
  function sectionFor(address, length = 1) {
    const rva = address - imageBase;
    const matches = sections.filter(s => rva >= s.rva && rva - s.rva <= s.size && length <= s.size - (rva - s.rva));
    if (matches.length !== 1) return null;
    const section = matches[0]; return { section, raw: section.raw + rva - section.rva };
  }
  const signaturePrefix = Buffer.from("558bec8b4d08", "hex"), signatureEnd = Buffer.from("83c40833c05dc3", "hex"), candidates = [];
  for (const section of sections.filter(s => s.executable)) {
    for (let offset = section.raw; offset <= section.raw + section.size - 29; offset++) {
      if (!bytes.subarray(offset, offset + 6).equals(signaturePrefix) || bytes[offset + 6] !== 0xe8 || bytes[offset + 11] !== 0x68 ||
          bytes[offset + 16] !== 0x50 || bytes[offset + 17] !== 0xe8 || !bytes.subarray(offset + 22, offset + 29).equals(signatureEnd)) continue;
      const handler = imageBase + section.rva + offset - section.raw;
      const firstCall = handler + 11 + bytes.readInt32LE(offset + 7), secondCall = handler + 22 + bytes.readInt32LE(offset + 18);
      if (!sectionFor(firstCall)?.section.executable || !sectionFor(secondCall)?.section.executable) continue;
      /* A matching function body alone is insufficient. Its address must
         occupy Sys0.e8 in one unique, bounded VM service-pointer table. */
      let tables = 0;
      for (const data of sections.filter(s => !s.executable)) {
        for (let at = data.raw; at <= data.raw + data.size - 4; at += 4) {
          if (bytes.readUInt32LE(at) !== handler) continue;
          const table = at - 0xe8 * 4;
          if (table < data.raw || table + 1024 > data.raw + data.size) continue;
          let nonzero = 0, valid = true;
          for (let i = 0; i < 256; i++) {
            const target = bytes.readUInt32LE(table + i * 4);
            if (!target) continue;
            if (!sectionFor(target)?.section.executable) { valid = false; break; }
            nonzero++;
          }
          if (valid && nonzero >= 64 && [0, 4, 0x52, 0x70, 0xfd].every(i => bytes.readUInt32LE(table + i * 4))) tables++;
        }
      }
      if (tables !== 1) continue;
      const literal = sectionFor(bytes.readUInt32LE(offset + 12));
      if (!literal || literal.section.executable) continue;
      const remaining = Math.min(LIMITS.identifierBytes + 1, literal.section.raw + literal.section.size - literal.raw), end = bytes.indexOf(0, literal.raw);
      if (end <= literal.raw || end - literal.raw >= remaining) continue;
      const identifier = bytes.subarray(literal.raw, end);
      let safe = true;
      for (let i = 0; i < identifier.length; i++) {
        const byte = identifier[i];
        if (byte >= 0x81 && byte <= 0x9f || byte >= 0xe0 && byte <= 0xfc) {
          const trail = identifier[++i]; if (trail === undefined || trail < 0x40 || trail === 0x7f || trail > 0xfc) { safe = false; break; }
        } else if (byte < 0x20 || [0x2f, 0x5c, 0x3a].includes(byte)) { safe = false; break; }
      }
      if (safe) candidates.push(identifier.toString("hex"));
    }
  }
  if (candidates.length !== 1) invalid();
  return Object.freeze({ dialect: dialect.id, projectIdentifierHex: candidates[0], sourceSha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    source: "original-sys0-e8-service", windowsExecuted: false });
}
function readRunnerProfile(file, inspected) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 64 || stat.size > LIMITS.fileBytes) throw new Error("The original BGI runner must be a bounded regular file.");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const bytes = Buffer.alloc(stat.size);
    if (fs.readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) throw new Error("The original BGI runner is truncated.");
    const after = fs.fstatSync(fd);
    if (stat.dev !== after.dev || stat.ino !== after.ino || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs)
      throw new Error("The original BGI runner changed during inspection.");
    return parseRunnerProfile(bytes, inspected);
  } finally { fs.closeSync(fd); }
}
module.exports = { LIMITS, parseRunnerProfile, readRunnerProfile };
