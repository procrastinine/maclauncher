const fs = require("node:fs");

// Select exact PE resource branches. Large icons and unrelated payloads never
// enter memory; callers receive only the requested type/name/language values.
const LIMITS = Object.freeze({ bytes: 512 * 1024, reads: 1024, sections: 96, entries: 256,
  resourceBytes: 64 * 1024, names: 128, selectors: 8, languages: 8 });

function readPeResources(file, selectors, { detection } = {}) {
  if (!Array.isArray(selectors) || !selectors.length || selectors.length > LIMITS.selectors ||
      selectors.some(item => !item || ![item.type, item.name].every(value =>
        typeof value === "string" && value.length > 0 && value.length <= LIMITS.names || Number.isInteger(value) && value >= 0 && value <= 65535)))
    throw new Error("Choose bounded, exact PE resource type and name selectors.");
  let fd, reads = 0, total = 0;
  try {
    const stat = detection?.stat ? detection.stat(file) : fs.lstatSync(file);
    if (!stat?.isFile() || stat.isSymbolicLink?.() || stat.size < 64) return [];
    function read(offset, length) {
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 ||
          length > stat.size - offset || ++reads > LIMITS.reads || (total += length) > LIMITS.bytes)
        throw new Error("PE resource read exceeds its bounds.");
      if (detection?.readBytes) {
        const bytes = detection.readBytes(file, offset, length);
        if (!bytes || bytes.length !== length) throw new Error("Truncated PE resource data.");
        return bytes;
      }
      fd ??= fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const bytes = Buffer.alloc(length);
      if (fs.readSync(fd, bytes, 0, length, offset) !== length) throw new Error("Truncated PE resource data.");
      return bytes;
    }
    const dos = read(0, 64), peOffset = dos.readUInt32LE(60);
    if (dos.readUInt16LE(0) !== 0x5a4d || peOffset < 64 || peOffset > 1024 * 1024) return [];
    const pe = read(peOffset, 24), count = pe.readUInt16LE(6), optionalSize = pe.readUInt16LE(20);
    if (pe.readUInt32LE(0) !== 0x4550 || !count || count > LIMITS.sections || optionalSize < 96 || optionalSize > 4096) return [];
    const optional = read(peOffset + 24, optionalSize), magic = optional.readUInt16LE(0);
    const directories = magic === 0x10b ? 96 : magic === 0x20b ? 112 : null;
    if (!directories || directories + 24 > optionalSize || optional.readUInt32LE(directories - 4) < 3) return [];
    const rva = optional.readUInt32LE(directories + 16), size = optional.readUInt32LE(directories + 20);
    if (!rva || size < 16 || size > 64 * 1024 * 1024) return [];
    const sectionBytes = read(peOffset + 24 + optionalSize, count * 40), sections = [];
    for (let at = 0; at < sectionBytes.length; at += 40) sections.push({ rva: sectionBytes.readUInt32LE(at + 12),
      size: sectionBytes.readUInt32LE(at + 16), offset: sectionBytes.readUInt32LE(at + 20) });
    function raw(address, length) {
      const section = sections.find(item => address >= item.rva && address - item.rva <= item.size && length <= item.size - (address - item.rva));
      if (!section || length > stat.size - (section.offset + address - section.rva)) throw new Error("PE resource escapes its raw section.");
      return section.offset + address - section.rva;
    }
    const root = raw(rva, size), directoriesRead = new Map();
    function resource(relative, length) {
      if (!Number.isInteger(relative) || relative < 0 || length > size - relative) throw new Error("Invalid PE resource range.");
      return read(root + relative, length);
    }
    function directory(relative, ancestors) {
      if (ancestors.includes(relative)) throw new Error("Cyclic PE resource directory.");
      if (directoriesRead.has(relative)) return directoriesRead.get(relative);
      const header = resource(relative, 16), count = header.readUInt16LE(12) + header.readUInt16LE(14);
      if (!count || count > LIMITS.entries) throw new Error("Invalid PE resource directory count.");
      const table = resource(relative + 16, count * 8), values = [];
      for (let at = 0; at < table.length; at += 8) {
        const id = table.readUInt32LE(at), target = table.readUInt32LE(at + 4);
        let name = id;
        if (id & 0x80000000) {
          const location = id & 0x7fffffff, length = resource(location, 2).readUInt16LE(0);
          if (!length || length > LIMITS.names) throw new Error("Invalid PE resource name.");
          name = resource(location + 2, length * 2).toString("utf16le");
          if (name.includes("\0")) throw new Error("Invalid PE resource name.");
        }
        values.push({ name, directory: Boolean(target & 0x80000000), offset: target & 0x7fffffff });
      }
      directoriesRead.set(relative, values); return values;
    }
    const result = [], types = directory(0, []);
    for (const selector of selectors) {
      const branches = types.filter(item => item.name === selector.type);
      if (branches.length > 1) throw new Error("Ambiguous PE resource type.");
      const type = branches[0]; if (!type) continue;
      if (!type.directory) throw new Error("Invalid PE resource type branch.");
      const names = directory(type.offset, [0]).filter(item => item.name === selector.name);
      if (names.length > 1) throw new Error("Ambiguous PE resource name.");
      const name = names[0]; if (!name) continue;
      if (!name.directory) throw new Error("Invalid PE resource name branch.");
      const languages = directory(name.offset, [0, type.offset]);
      if (languages.length > LIMITS.languages || new Set(languages.map(item => item.name)).size !== languages.length)
        throw new Error("Ambiguous PE resource languages.");
      for (const language of languages) {
        if (language.directory || !Number.isInteger(language.name)) throw new Error("Invalid PE resource language.");
        const entry = resource(language.offset, 16), length = entry.readUInt32LE(4);
        if (!length || length > LIMITS.resourceBytes) throw new Error("PE resource value exceeds its limit.");
        result.push({ type: selector.type, name: selector.name, language: language.name,
          data: read(raw(entry.readUInt32LE(0), length), length) });
      }
    }
    if (fd !== undefined) {
      const current = fs.fstatSync(fd);
      if (current.dev !== stat.dev || current.ino !== stat.ino || current.size !== stat.size || current.mtimeMs !== stat.mtimeMs || current.ctimeMs !== stat.ctimeMs)
        throw new Error("PE resources changed during inspection.");
    }
    return result;
  } catch (error) {
    if (error.code === "DETECTION_LIMIT") throw error;
    return [];
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

module.exports = { LIMITS, readPeResources };
