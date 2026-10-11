const fs = require("node:fs");
const { readPeResources } = require("../runtime/pe-resources");

// Follow Inno's loader pointer/resource, then its versioned setup header. No
// whole-file scans or child processes are needed to reject ordinary game EXEs.
const MAGIC = new Map([
  ["72446c507453303287655678", [1, 2, 10]], ["72446c507453303487655678", [4, 0, 0]],
  ["72446c507453303587655678", [4, 0, 3]], ["72446c507453303687655678", [4, 0, 10]],
  ["72446c507453303787655678", [4, 1, 6]], ["72446c507453cde6d77b0b2a", [5, 1, 5]],
  ["6e53355737645483aa1b0f6a", [5, 1, 5]]
]);
const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
function installerError(message, code = "INSTALLER_INVALID") {
  return Object.assign(new Error(message), { code });
}
function parseOffsets(bytes, size) {
  const version = MAGIC.get(bytes.subarray(0, 12).toString("hex"));
  if (!version) return null;
  const modern = compare(version, [5, 1, 5]) >= 0, crc = compare(version, [4, 0, 10]) >= 0;
  const length = modern ? 44 : compare(version, [4, 1, 6]) >= 0 ? 40 : crc ? 44 : compare(version, [4, 0, 0]) >= 0 ? 40 : 44;
  if (bytes.length < length || modern && bytes.readUInt32LE(12) !== 1)
    throw installerError("The installer loader header is damaged or unsupported.");
  if (crc && crc32(bytes.subarray(0, length - 4)) !== bytes.readUInt32LE(length - 4))
    throw installerError("The installer loader checksum is invalid.");
  const at = modern ? 32 : compare(version, [4, 1, 6]) >= 0 ? 28 : compare(version, [4, 0, 0]) >= 0 ? 32 : 36;
  const headerOffset = bytes.readUInt32LE(at), dataOffset = bytes.readUInt32LE(at + 4);
  // Embedded file data can precede the setup header. Zero denotes external
  // data; other offsets are independent positions within the executable.
  if (headerOffset < 64 || headerOffset > size - 64 || dataOffset && dataOffset >= size)
    throw installerError("The installer data offsets are invalid.");
  return { headerOffset, dataOffset, loaderVersion: version.join("."), loaderChecksum: crc ? "crc32" : "legacy" };
}
function probeInno(file, { detection } = {}) {
  let fd;
  try {
    const stat = detection?.stat ? detection.stat(file) : fs.lstatSync(file);
    if (!stat?.isFile() || stat.isSymbolicLink?.() || stat.size < 64) return null;
    let total = 0;
    const read = (offset, length) => {
      if (!Number.isSafeInteger(offset) || offset < 0 || length > stat.size - offset || (total += length) > 512 * 1024)
        throw installerError("Installer header exceeds its bounds.");
      if (detection?.readBytes) {
        const bytes = detection.readBytes(file, offset, length);
        if (bytes?.length !== length) throw installerError("The installer header is truncated.");
        return bytes;
      }
      fd ??= fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const bytes = Buffer.alloc(length);
      if (fs.readSync(fd, bytes, 0, length, offset) !== length) throw installerError("The installer header is truncated.");
      return bytes;
    };
    const dos = read(0, 64);
    if (dos.readUInt16LE(0) !== 0x5a4d) return null;
    let offsets;
    if (dos.readUInt32LE(0x30) === 0x6f6e6e49) {
      const pointer = dos.readUInt32LE(0x34);
      if (pointer !== (~dos.readUInt32LE(0x38) >>> 0)) throw installerError("The installer loader pointer is damaged.");
      offsets = parseOffsets(read(pointer, 44), stat.size);
      if (!offsets) throw installerError("The installer loader version is unsupported.");
    } else {
      const resources = readPeResources(file, [{ type: 10, name: 11111 }], { detection });
      if (!resources.length) return null;
      const values = resources.map(item => parseOffsets(item.data, stat.size));
      if (values.every(value => !value)) return null;
      if (values.some(value => !value || JSON.stringify(value) !== JSON.stringify(values[0])))
        throw installerError("The installer has conflicting loader headers.");
      offsets = values[0];
    }
    const text = read(offsets.headerOffset, 64).toString("ascii").replace(/\0.*$/s, "");
    const version = /^Inno Setup Setup Data \((\d+\.\d+\.\d+(?:[a-z])?)\)(?: \((u)\))?/.exec(text);
    const legacy = /^i(\d+\.\d+\.\d+)(?:--|\u001a)/.exec(text);
    if (!version && !legacy) throw installerError("The installer setup header is damaged or unsupported.");
    if (fd !== undefined) {
      const after = fs.fstatSync(fd);
      if (["dev", "ino", "size", "mtimeMs", "ctimeMs"].some(name => stat[name] !== after[name]))
        throw installerError("The installer changed during inspection.");
    }
    return { format: "inno", formatVersion: (version || legacy)[1], unicode: Boolean(version?.[2]),
      externalData: offsets.dataOffset === 0, ...offsets };
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw error;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

module.exports = { probeInno, parseOffsets, crc32, installerError };
