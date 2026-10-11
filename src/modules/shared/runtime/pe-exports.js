const fs = require("node:fs");

const LIMITS = Object.freeze({ sections: 96, exportNames: 8192, exportBytes: 1024 * 1024,
  readBytes: 2 * 1024 * 1024, nameBytes: 512 });
const ARCHITECTURES = new Map([[0x14c, "x86"], [0x8664, "x86_64"], [0xaa64, "arm64"]]);

// IMAGE_EXPORT_DIRECTORY and file-backed RVAs, as defined by Microsoft's PE format.
// Export names alone are not executable-code evidence: forwarded and data exports
// remain distinct from targets in an executable section.
function readPeExports(file, { detection } = {}) {
  let fd;
  try {
    const stat = detection?.stat ? detection.stat(file) : fs.statSync(file);
    if (!stat?.isFile() || stat.size < 64 || fs.lstatSync(file).isSymbolicLink()) return null;
    let bytesRead = 0;
    const ranges = [];
    function read(offset, size) {
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0 || offset > stat.size - size)
        throw new Error("PE export range is outside the file.");
      const cached = ranges.find(range => offset >= range.offset && offset + size <= range.offset + range.bytes.length);
      if (cached) return cached.bytes.subarray(offset - cached.offset, offset - cached.offset + size);
      if ((bytesRead += size) > LIMITS.readBytes) throw new Error("PE export metadata exceeds its read limit.");
      let bytes;
      if (detection?.readBytes) bytes = detection.readBytes(file, offset, size);
      else {
        fd ??= fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        bytes = Buffer.alloc(size);
        if (fs.readSync(fd, bytes, 0, size, offset) !== size) throw new Error("Truncated PE export metadata.");
      }
      if (!Buffer.isBuffer(bytes) || bytes.length !== size) throw new Error("Truncated PE export metadata.");
      if (ranges.length < 64) ranges.push({ offset, bytes });
      return bytes;
    }
    const dos = read(0, 64);
    if (dos.readUInt16LE(0) !== 0x5a4d) return null;
    const peOffset = dos.readUInt32LE(60);
    if (peOffset < 64 || peOffset > 1024 * 1024) return null;
    const coff = read(peOffset, 24);
    if (coff.readUInt32LE(0) !== 0x4550) return null;
    const architecture = ARCHITECTURES.get(coff.readUInt16LE(4));
    const count = coff.readUInt16LE(6), optionalBytes = coff.readUInt16LE(20);
    if (!architecture || !(coff.readUInt16LE(22) & 2) || !count || count > LIMITS.sections || optionalBytes < 104 || optionalBytes > 4096) return null;
    const optional = read(peOffset + 24, optionalBytes), magic = optional.readUInt16LE(0);
    const directories = magic === 0x10b ? 96 : magic === 0x20b ? 112 : null;
    if (!directories || (architecture === "x86") !== (magic === 0x10b) || directories + 8 > optional.length) return null;
    const directoryCount = optional.readUInt32LE(directories - 4);
    if (!directoryCount || directoryCount > 64 || directories + directoryCount * 8 > optional.length) return null;
    const table = read(peOffset + 24 + optionalBytes, count * 40), sections = [];
    for (let i = 0; i < count; i++) {
      const start = i * 40, offset = table.readUInt32LE(start + 20), size = table.readUInt32LE(start + 16);
      if (offset > stat.size - size) return null;
      sections.push({ name: table.toString("ascii", start, start + 8).replace(/\0.*$/, ""),
        rva: table.readUInt32LE(start + 12), offset, size, executable: Boolean(table.readUInt32LE(start + 36) & 0x20000000) });
    }
    function fileOffset(rva, size) {
      const section = sections.find(row => rva >= row.rva && rva - row.rva <= row.size && size <= row.size - (rva - row.rva));
      if (!section) throw new Error("PE export RVA is not file-backed.");
      return section.offset + rva - section.rva;
    }
    const exportRva = optional.readUInt32LE(directories), exportBytes = optional.readUInt32LE(directories + 4);
    const exports = new Map();
    if (exportRva || exportBytes) {
      if (!exportRva || exportBytes < 40 || exportBytes > LIMITS.exportBytes) return null;
      const blobOffset = fileOffset(exportRva, exportBytes), blob = read(blobOffset, exportBytes);
      const functions = blob.readUInt32LE(20), names = blob.readUInt32LE(24);
      if (functions > LIMITS.exportNames || names > LIMITS.exportNames || names && !functions) return null;
      const addresses = functions ? read(fileOffset(blob.readUInt32LE(28), functions * 4), functions * 4) : Buffer.alloc(0);
      const nameAddresses = names ? read(fileOffset(blob.readUInt32LE(32), names * 4), names * 4) : Buffer.alloc(0);
      const ordinals = names ? read(fileOffset(blob.readUInt32LE(36), names * 2), names * 2) : Buffer.alloc(0);
      for (let i = 0; i < names; i++) {
        const rva = nameAddresses.readUInt32LE(i * 4), ordinal = ordinals.readUInt16LE(i * 2);
        if (ordinal >= functions) return null;
        const nameOffset = fileOffset(rva, 1), section = sections.find(row => nameOffset >= row.offset && nameOffset < row.offset + row.size);
        const maximum = Math.min(LIMITS.nameBytes, section.offset + section.size - nameOffset);
        const bytes = read(nameOffset, maximum), end = bytes.indexOf(0);
        if (end <= 0 || bytes.subarray(0, end).some(byte => byte < 0x20 || byte > 0x7e)) return null;
        const name = bytes.toString("ascii", 0, end), address = addresses.readUInt32LE(ordinal * 4);
        if (exports.has(name)) return null;
        const forwarded = address >= exportRva && address - exportRva < exportBytes;
        const target = sections.find(row => address >= row.rva && address - row.rva < row.size);
        exports.set(name, { rva: address, forwarded, executable: !forwarded && Boolean(target?.executable) });
      }
    }
    return { architecture, isDll: Boolean(coff.readUInt16LE(22) & 0x2000), sections, exports, bytesRead };
  } catch (error) {
    if (error.code === "DETECTION_LIMIT") throw error;
    return null;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

module.exports = { LIMITS, readPeExports };
