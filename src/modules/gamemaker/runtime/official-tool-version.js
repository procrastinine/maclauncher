const fs = require("node:fs");

// Read the DLL's PE version resource, rather than treating the .NET assembly's
// default 1.0.0 version or an arbitrary embedded string as the Igor build.
function readIgorVersion(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024 ** 2) throw new Error("Igor DLL is not a bounded regular file.");
  return parseIgorVersion(fs.readFileSync(file));
}
function parseIgorVersion(bytes) {
  const check = (offset, size) => {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset + size > bytes.length) throw new Error("Truncated Igor PE version metadata.");
    return offset;
  };
  const u16 = offset => bytes.readUInt16LE(check(offset, 2));
  const u32 = offset => bytes.readUInt32LE(check(offset, 4));
  if (bytes.length > 128 * 1024 ** 2 || u16(0) !== 0x5a4d) throw new Error("Igor build metadata requires a PE DLL.");
  const pe = u32(0x3c);
  if (u32(pe) !== 0x4550) throw new Error("Invalid Igor PE header.");
  const sections = u16(pe + 6), optional = pe + 24, optionalSize = u16(pe + 20), magic = u16(optional);
  if (!sections || sections > 96 || ![0x10b, 0x20b].includes(magic)) throw new Error("Unsupported Igor PE sections.");
  const directory = optional + (magic === 0x10b ? 96 : 112) + 16;
  if (directory + 8 > optional + optionalSize) throw new Error("Igor PE has no resource directory.");
  const resourceRva = u32(directory), resourceSize = u32(directory + 4);
  const table = optional + optionalSize;
  const mapRva = (rva, size) => {
    for (let index = 0; index < sections; index++) {
      const section = table + index * 40, start = u32(section + 12), length = u32(section + 16), raw = u32(section + 20);
      if (rva >= start && rva - start + size <= length) return check(raw + rva - start, size);
    }
    throw new Error("Igor PE resource lies outside its file sections.");
  };
  if (!resourceRva || resourceSize < 16 || resourceSize > 8 * 1024 ** 2) throw new Error("Igor PE has no bounded version resources.");
  const root = mapRva(resourceRva, resourceSize);
  const resourceOffset = (offset, size) => {
    if (offset < 0 || offset + size > resourceSize) throw new Error("Igor version resource pointer is out of bounds.");
    return root + offset;
  };
  const entries = offset => {
    const current = resourceOffset(offset, 16), count = u16(current + 12) + u16(current + 14);
    if (!count || count > 256) throw new Error("Invalid Igor version resource tree.");
    resourceOffset(offset + 16, count * 8);
    return Array.from({ length: count }, (_, index) => ({ id: u32(current + 16 + index * 8), target: u32(current + 20 + index * 8) }));
  };
  const type = entries(0).find(entry => entry.id === 16);
  if (!type || !(type.target & 0x80000000)) throw new Error("Igor PE has no version resource.");
  const names = entries(type.target & 0x7fffffff);
  if (names.length !== 1 || !(names[0].target & 0x80000000)) throw new Error("Igor PE has ambiguous version resources.");
  const languages = entries(names[0].target & 0x7fffffff);
  if (languages.length !== 1 || languages[0].target & 0x80000000) throw new Error("Igor PE has ambiguous version languages.");
  const data = resourceOffset(languages[0].target, 16), length = u32(data + 4), start = mapRva(u32(data), length);
  if (length < 92 || length > 65536 || u16(start) > length || u16(start + 2) !== 52 || u16(start + 4) !== 0) throw new Error("Invalid Igor fixed version resource.");
  const key = Buffer.from("VS_VERSION_INFO\0", "utf16le");
  if (!bytes.subarray(start + 6, start + 6 + key.length).equals(key)) throw new Error("Invalid Igor version resource key.");
  const fixed = (start + 6 + key.length + 3) & ~3;
  if (fixed + 52 > start + u16(start) || u32(fixed) !== 0xfeef04bd) throw new Error("Invalid Igor fixed file information.");
  const tuple = offset => { const ms = u32(offset), ls = u32(offset + 4); return [ms >>> 16, ms & 65535, ls >>> 16, ls & 65535].join("."); };
  const fileVersion = tuple(fixed + 8), productVersion = tuple(fixed + 16);
  if (fileVersion !== productVersion) throw new Error("Igor product and file builds disagree.");
  return { version: fileVersion, fileVersion, productVersion, evidence: "Igor.dll PE VS_FIXEDFILEINFO" };
}
module.exports = { readIgorVersion, parseIgorVersion };
