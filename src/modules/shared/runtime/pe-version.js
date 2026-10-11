const fs = require("node:fs");
const path = require("node:path");

const LIMITS = Object.freeze({ bytes: 256 * 1024, reads: 64, sections: 96, directoryEntries: 256, versionBytes: 65535 });
const align4 = value => (value + 3) & ~3;
const versionString = (high, low) => [high >>> 16, high & 0xffff, low >>> 16, low & 0xffff].join(".");

function parseVersionResource(bytes) {
  let nodes = 0;
  function block(start, limit, depth = 0) {
    if (depth > 5 || ++nodes > 256 || start + 6 > limit) throw new Error("Invalid version block.");
    const length = bytes.readUInt16LE(start), valueLength = bytes.readUInt16LE(start + 2), type = bytes.readUInt16LE(start + 4), end = start + length;
    if (length < 8 || end > limit || type > 1) throw new Error("Invalid version range.");
    let cursor = start + 6;
    while (cursor + 2 <= end && cursor - start <= 1024 && bytes.readUInt16LE(cursor)) cursor += 2;
    if (cursor + 2 > end || bytes.readUInt16LE(cursor)) throw new Error("Unterminated version key.");
    const key = bytes.toString("utf16le", start + 6, cursor);
    cursor = align4(cursor + 2);
    const size = type ? valueLength * 2 : valueLength;
    if (cursor + size > end) throw new Error("Invalid version value.");
    const value = bytes.subarray(cursor, cursor + size);
    cursor = align4(cursor + size);
    const children = [];
    while (cursor + 6 <= end) {
      const child = block(cursor, end, depth + 1);
      children.push(child); cursor = align4(child.end);
    }
    return { key, type, value, children, end };
  }
  try {
    if (!Buffer.isBuffer(bytes) || bytes.length > LIMITS.versionBytes) return null;
    const root = block(0, bytes.length);
    if (root.key !== "VS_VERSION_INFO" || root.type !== 0 || root.value.length !== 52 ||
      root.value.readUInt32LE(0) !== 0xfeef04bd || root.value.readUInt32LE(4) !== 0x00010000) return null;
    const strings = {};
    for (const info of root.children.filter(node => node.key === "StringFileInfo")) {
      for (const table of info.children) {
        if (!/^[a-f0-9]{8}$/i.test(table.key)) continue;
        for (const node of table.children) {
          if (node.type !== 1 || node.value.length > 4096 || !["CompanyName", "FileDescription", "FileVersion", "ProductName", "ProductVersion", "OriginalFilename"].includes(node.key)) continue;
          const value = node.value.toString("utf16le").replace(/\0+$/, "").trim();
          if (value && !Object.hasOwn(strings, node.key)) strings[node.key] = value;
        }
      }
    }
    return { fileVersion: versionString(root.value.readUInt32LE(8), root.value.readUInt32LE(12)),
      productVersion: versionString(root.value.readUInt32LE(16), root.value.readUInt32LE(20)),
      flags: (root.value.readUInt32LE(28) & root.value.readUInt32LE(24)) >>> 0, strings };
  } catch { return null; }
}

// Read only PE headers, the RT_VERSION directory branch and its bounded value.
// Other resources (including large icons) are not loaded or scanned for markers.
function readPeVersion(file, { detection } = {}) {
  let fd, reads = 0, total = 0;
  try {
    const stat = detection?.stat ? detection.stat(file) : fs.statSync(file);
    if (!stat?.isFile() || stat.size < 64) return null;
    function read(offset, length) {
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || offset + length > stat.size ||
        ++reads > LIMITS.reads || (total += length) > LIMITS.bytes) throw new Error("PE version read exceeds its bounds.");
      if (detection?.readBytes) {
        const bytes = detection.readBytes(file, offset, length);
        if (!bytes || bytes.length !== length) throw new Error("Truncated PE version data.");
        return bytes;
      }
      fd ??= fs.openSync(file, "r");
      const bytes = Buffer.alloc(length);
      if (fs.readSync(fd, bytes, 0, length, offset) !== length) throw new Error("Truncated PE version data.");
      return bytes;
    }
    const dos = read(0, 64);
    if (dos.readUInt16LE(0) !== 0x5a4d) return null;
    const peOffset = dos.readUInt32LE(60);
    if (peOffset < 64 || peOffset > 1024 * 1024) return null;
    const pe = read(peOffset, 24);
    if (pe.readUInt32LE(0) !== 0x00004550) return null;
    const count = pe.readUInt16LE(6), optionalLength = pe.readUInt16LE(20);
    if (!count || count > LIMITS.sections || optionalLength < 96 || optionalLength > 4096) return null;
    const optional = read(peOffset + 24, optionalLength), magic = optional.readUInt16LE(0);
    const directories = magic === 0x10b ? 96 : magic === 0x20b ? 112 : null;
    if (!directories || directories + 24 > optional.length || optional.readUInt32LE(directories - 4) < 3) return null;
    const resourceRva = optional.readUInt32LE(directories + 16), resourceSize = optional.readUInt32LE(directories + 20);
    if (!resourceRva || resourceSize < 16 || resourceSize > 64 * 1024 * 1024) return null;
    const table = read(peOffset + 24 + optionalLength, count * 40), sections = [];
    for (let i = 0; i < count; i++) sections.push({ rva: table.readUInt32LE(i * 40 + 12), size: table.readUInt32LE(i * 40 + 16), offset: table.readUInt32LE(i * 40 + 20) });
    function offsetFor(rva, size) {
      const section = sections.find(item => rva >= item.rva && rva - item.rva <= item.size && size <= item.size - (rva - item.rva));
      if (!section || section.offset + rva - section.rva + size > stat.size) throw new Error("PE resource escapes its raw section.");
      return section.offset + rva - section.rva;
    }
    const rootOffset = offsetFor(resourceRva, resourceSize), visited = new Set();
    function directory(relative) {
      if (visited.has(relative) || relative > resourceSize - 16) throw new Error("Invalid or cyclic PE resource directory.");
      visited.add(relative);
      const header = read(rootOffset + relative, 16), count = header.readUInt16LE(12) + header.readUInt16LE(14);
      if (!count || count > LIMITS.directoryEntries || relative + 16 + count * 8 > resourceSize) throw new Error("Invalid PE resource directory count.");
      const entries = read(rootOffset + relative + 16, count * 8), result = [];
      for (let i = 0; i < count; i++) {
        const name = entries.readUInt32LE(i * 8), target = entries.readUInt32LE(i * 8 + 4);
        result.push({ id: name & 0x80000000 ? null : name, directory: Boolean(target & 0x80000000), offset: target & 0x7fffffff });
      }
      return result;
    }
    const version = directory(0).find(item => item.id === 16 && item.directory);
    if (!version) return null;
    const names = directory(version.offset).filter(item => item.directory).slice(0, 8);
    for (const name of names) {
      const languages = directory(name.offset).filter(item => !item.directory).sort((a, b) => (a.id === 1033 ? -1 : b.id === 1033 ? 1 : a.id - b.id)).slice(0, 8);
      for (const language of languages) {
        if (language.offset > resourceSize - 16) return null;
        const data = read(rootOffset + language.offset, 16), size = data.readUInt32LE(4);
        if (size < 8 || size > LIMITS.versionBytes) continue;
        const value = parseVersionResource(read(offsetFor(data.readUInt32LE(0), size), size));
        if (value) return { ...value, source: `${path.basename(file)}!RT_VERSION/${name.id ?? "named"}/${language.id ?? "named"}` };
      }
    }
    return null;
  } catch (error) {
    if (error.code === "DETECTION_LIMIT") throw error;
    return null;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

module.exports = { LIMITS, parseVersionResource, readPeVersion };
