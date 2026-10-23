const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const VERSION = "cp932-2.01-eudc-ml1";
const TABLE_SHA256 = "ed7aa2abc794fd872c1ce4a2c39b87445e83ae05d7ed74f0781ce73c6537cf44";
let table, inverse;

function mapping() {
  if (!table) {
    const file = path.join(__dirname, "resources/encoding/cp932.bin"), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== 22560) throw new Error("The pinned CatSystem2 CP932 data changed.");
    const bytes = fs.readFileSync(file);
    if (crypto.createHash("sha256").update(bytes).digest("hex") !== TABLE_SHA256) throw new Error("The pinned CatSystem2 CP932 data changed.");
    table = bytes;
  }
  return table;
}

/** Strict published CP932 mappings, independent of a host's ICU converter. */
function decode(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length > 32 * 1024 * 1024) throw new Error("CP932 text exceeds its byte limit.");
  const values = [], chunks = [], data = mapping();
  for (let i = 0; i < bytes.length; i++) {
    const lead = bytes[i]; let unicode;
    if (lead <= 0x7f) unicode = lead;
    else if (lead >= 0xa1 && lead <= 0xdf) unicode = 0xff61 + lead - 0xa1;
    else if ((lead >= 0x81 && lead <= 0x9f) || (lead >= 0xe0 && lead <= 0xfc)) {
      const trail = bytes[++i];
      if (trail === undefined || trail < 0x40 || trail > 0xfc || trail === 0x7f) throw new Error("Invalid CP932 byte sequence.");
      const pointer = (lead - (lead < 0xa0 ? 0x81 : 0xc1)) * 188 + trail - (trail < 0x7f ? 0x40 : 0x41);
      unicode = pointer >= 8836 && pointer <= 10715 ? 0xe000 + pointer - 8836 : data.readUInt16LE(pointer * 2);
      if (!unicode) throw new Error("Undefined CP932 character mapping.");
    } else throw new Error("Undefined CP932 single byte.");
    values.push(unicode);
    if (values.length === 4096) { chunks.push(String.fromCharCode(...values)); values.length = 0; }
  }
  if (values.length) chunks.push(String.fromCharCode(...values));
  return chunks.join("");
}
/** Strict inverse of the same pinned table; no best-fit replacements. */
function encode(text) {
  if (typeof text !== "string" || text.length > 16 * 1024 * 1024) throw new Error("CP932 text exceeds its character limit.");
  if (!inverse) {
    inverse = new Map(); const data = mapping();
    for (let pointer = 0; pointer < data.length / 2; pointer++) {
      if (pointer >= 8836 && pointer <= 10715) continue;
      const cp = data.readUInt16LE(pointer * 2); if (cp && !inverse.has(cp)) inverse.set(cp, pointer);
    }
  }
  const bytes = Buffer.alloc(text.length * 2); let at = 0;
  for (const character of text) {
    const cp = character.codePointAt(0);
    if (cp <= 0x7f) bytes[at++] = cp;
    else if (cp >= 0xff61 && cp <= 0xff9f) bytes[at++] = 0xa1 + cp - 0xff61;
    else {
      const pointer = cp >= 0xe000 && cp <= 0xe757 ? 8836 + cp - 0xe000 : inverse.get(cp);
      if (pointer == null) throw new Error("Character is not representable in pinned CP932.");
      const lead = Math.floor(pointer / 188), trail = pointer % 188;
      bytes[at++] = lead + (lead < 31 ? 0x81 : 0xc1); bytes[at++] = trail + (trail < 63 ? 0x40 : 0x41);
    }
  }
  return bytes.subarray(0, at);
}
module.exports = { VERSION, TABLE_SHA256, decode, encode };
