const fs = require("node:fs");
// Inspect only a bounded PE export directory; malformed or unnamed interfaces
// cannot opt a game into the camera adapter.
function inspect(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size < 256 || stat.size > 32 * 1024 * 1024) return null;
    const b = fs.readFileSync(file), pe = b.readUInt32LE(60);
    if (b.readUInt16LE(0) !== 0x5a4d || pe < 64 || pe + 24 > b.length || b.readUInt32LE(pe) !== 0x4550 || b.readUInt16LE(pe + 4) !== 0x8664) return null;
    const count = b.readUInt16LE(pe + 6), size = b.readUInt16LE(pe + 20), optional = pe + 24;
    if (!count || count > 96 || size < 120 || optional + size + count * 40 > b.length || b.readUInt16LE(optional) !== 0x20b || b.readUInt32LE(optional + 108) < 1) return null;
    const sections = Array.from({ length: count }, (_, i) => { const p = optional + size + 40 * i;return { rva: b.readUInt32LE(p + 12), size: b.readUInt32LE(p + 16), offset: b.readUInt32LE(p + 20) }; });
    function raw(rva, length) {
      const section = sections.find(s => rva >= s.rva && rva - s.rva <= s.size && length <= s.size - (rva - s.rva));
      if (!section) throw Error("Invalid export range");
      const at = section.offset + rva - section.rva;
      if (length > b.length - at) throw Error("Invalid export range");
      return at;
    }
    function name(rva) {
      const at = raw(rva, 1), end = b.indexOf(0, at);
      if (end < at || end - at > 256 || raw(rva, end - at + 1) !== at) throw Error("Invalid export name");
      const value = b.toString("ascii", at, end);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw Error("Invalid export name");
      return value;
    }
    const exportRva = b.readUInt32LE(optional + 112), exportSize = b.readUInt32LE(optional + 116), e = raw(exportRva, 40);
    const base = b.readUInt32LE(e + 16), functions = b.readUInt32LE(e + 20), names = b.readUInt32LE(e + 24);
    if (!functions || functions > 1024 || names !== functions || base + functions > 65536) return null;
    const table = raw(b.readUInt32LE(e + 28), functions * 4), strings = raw(b.readUInt32LE(e + 32), names * 4), ordinals = raw(b.readUInt32LE(e + 36), names * 2);
    const result = [], seen = new Set();
    for (let i = 0; i < names; i++) {
      const ordinal = b.readUInt16LE(ordinals + 2 * i), address = b.readUInt32LE(table + ordinal * 4);
      if (ordinal >= functions || seen.has(ordinal) || !address || address >= exportRva && address < exportRva + exportSize) return null;
      raw(address, 1);seen.add(ordinal);result.push({ name: name(b.readUInt32LE(strings + 4 * i)), ordinal: base + ordinal });
    }
    if (new Set(result.map(item => item.name)).size !== names) return null;
    return result.sort((a, z) => a.ordinal - z.ordinal);
  } catch { return null; }
}
module.exports = { inspect };
