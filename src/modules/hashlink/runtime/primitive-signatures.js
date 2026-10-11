const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");

const LIMITS = Object.freeze({ bytes: 64 * 1024 * 1024, commands: 4096, sections: 1024,
  symbols: 262144, primitives: 8192, name: 128, signature: 255, getter: 80, cache: 32 });
const cache = new Map();
const utf8 = new TextDecoder("utf-8", { fatal: true });
function fail(message) { throw new Error(`HashLink primitive profile: ${message}`); }
function range(offset, size, length) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0 || offset > length - size)
    fail("invalid native file bounds.");
}
function safe64(data, offset) {
  const value = data.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail("native address exceeds inspection bounds.");
  return Number(value);
}
function text(data, offset, maximum) {
  range(offset, 1, data.length);
  const end = data.subarray(offset, Math.min(data.length, offset + maximum + 1)).indexOf(0);
  if (end < 0) fail("unterminated native string.");
  try { return utf8.decode(data.subarray(offset, offset + end)); } catch { fail("invalid native string encoding."); }
}
function fixedName(data, offset) {
  const bytes = data.subarray(offset, offset + 16), end = bytes.indexOf(0);
  try { return utf8.decode(end < 0 ? bytes : bytes.subarray(0, end)); } catch { fail("invalid native section name."); }
}

function intelSlice(input) {
  if (!Buffer.isBuffer(input) || input.length < 32 || input.length > LIMITS.bytes) fail("native file exceeds inspection bounds.");
  const magic = input.readUInt32BE(0);
  if (![0xcafebabe, 0xcafebabf].includes(magic)) return input;
  const count = input.readUInt32BE(4), wide = magic === 0xcafebabf, stride = wide ? 32 : 20;
  if (!count || count > 32) fail("invalid universal slice count.");
  range(8, count * stride, input.length);
  const slices = [], candidates = [];
  for (let i = 0; i < count; i++) {
    const cursor = 8 + i * stride;
    const value = offset => wide ? Number(input.readBigUInt64BE(cursor + offset)) : input.readUInt32BE(cursor + offset);
    const offset = value(8), size = value(wide ? 16 : 12);
    range(offset, size, input.length);
    if (offset < 8 + count * stride || size < 32 || slices.some(s => offset < s.offset + s.size && s.offset < offset + size))
      fail("invalid or overlapping universal slices.");
    slices.push({ offset, size });
    if (input.readUInt32BE(cursor) === 0x01000007) candidates.push(input.subarray(offset, offset + size));
  }
  if (candidates.length !== 1) fail("one Intel bytecode slice is required.");
  return candidates[0];
}

function layout(input) {
  const data = intelSlice(input);
  if (data.readUInt32LE(0) !== 0xfeedfacf || data.readUInt32LE(4) !== 0x01000007 || ![2, 6, 8].includes(data.readUInt32LE(12)))
    fail("an Intel Mach-O executable or library is required.");
  const count = data.readUInt32LE(16), bytes = data.readUInt32LE(20);
  if (count > LIMITS.commands || bytes > 4 * 1024 * 1024 || count * 8 > bytes) fail("load commands exceed inspection bounds.");
  range(32, bytes, data.length);
  const sections = [], symbols = new Map();
  let cursor = 32, table;
  for (let i = 0; i < count; i++) {
    range(cursor, 8, 32 + bytes);
    const kind = data.readUInt32LE(cursor), size = data.readUInt32LE(cursor + 4);
    if (size < 8 || size % 8) fail("invalid native load command.");
    range(cursor, size, 32 + bytes);
    if (kind === 0x19) {
      if (size < 72) fail("truncated native segment.");
      const n = data.readUInt32LE(cursor + 64), writable = !!(data.readUInt32LE(cursor + 60) & 2);
      if (n > LIMITS.sections - sections.length || size !== 72 + n * 80) fail("native sections exceed inspection bounds.");
      for (let j = 0; j < n; j++) {
        const pos = cursor + 72 + j * 80, address = safe64(data, pos + 32), length = safe64(data, pos + 40), offset = data.readUInt32LE(pos + 48);
        const flags = data.readUInt32LE(pos + 64), zeroFill = [1, 12, 18].includes(flags & 255);
        if (!zeroFill) range(offset, length, data.length);
        sections.push({ index: sections.length + 1, name: fixedName(data, pos), address, length, offset, flags, writable, zeroFill });
      }
    } else if (kind === 2) {
      if (size !== 24 || table) fail("invalid native symbol table.");
      table = { offset: data.readUInt32LE(cursor + 8), count: data.readUInt32LE(cursor + 12),
        strings: data.readUInt32LE(cursor + 16), bytes: data.readUInt32LE(cursor + 20) };
    } else if (kind === 0x2c && size >= 20 && data.readUInt32LE(cursor + 16)) fail("encrypted native code is unsupported.");
    cursor += size;
  }
  if (cursor !== 32 + bytes || !table || table.count > LIMITS.symbols || table.bytes > 16 * 1024 * 1024) fail("native symbol metadata is unavailable.");
  range(table.offset, table.count * 16, data.length); range(table.strings, table.bytes, data.length);
  const strings = data.subarray(table.strings, table.strings + table.bytes);
  for (let i = 0; i < table.count; i++) {
    const pos = table.offset + i * 16, type = data[pos + 4];
    if ((type & 0xe0) || !(type & 1) || (type & 0x0e) !== 0x0e || (type & 0x10)) continue;
    const index = data.readUInt32LE(pos), section = sections[data[pos + 5] - 1], address = safe64(data, pos + 8);
    if (!section || section.zeroFill || address < section.address || address >= section.address + section.length) continue;
    range(index, 1, strings.length);
    if (strings.subarray(index, index + 5).toString("ascii") === "_hlp_") {
      const name = text(strings, index, LIMITS.name);
      if (symbols.has(name) || symbols.size >= LIMITS.primitives) fail("ambiguous native primitive exports.");
      symbols.set(name, { name, section, address, offset: section.offset + address - section.address });
    }
  }
  return { data, sections, symbols };
}

// DEFINE_PRIM getters only store a constant type signature and return a native
// function address. Recognize that finite x86 contract; never invoke the getter,
// load a dylib, follow a branch, or execute imported game code.
function signatureOf(image, symbol) {
  const { data, sections } = image;
  if (symbol.section.writable || !(symbol.section.flags & 0x80000000)) fail(`unsupported getter for ${symbol.name.slice(5)}.`);
  const end = Math.min(data.length, symbol.offset + LIMITS.getter, symbol.section.offset + symbol.section.length);
  let cursor = symbol.offset, signatureAddress, frame = false;
  const outputPointer = Object.freeze({ outputPointer: true }), registers = new Map([[7, outputPointer]]), stack = new Map();
  while (cursor < end) {
    const first = data[cursor];
    if (first === 0x55 && cursor === symbol.offset) { frame = true; cursor++; continue; }
    if (frame && data.subarray(cursor, cursor + 3).equals(Buffer.from([0x48, 0x89, 0xe5]))) { cursor += 3; continue; }
    if (first === 0x90) { cursor++; continue; }
    if (data.subarray(cursor, cursor + 4).equals(Buffer.from([0xf3, 0x0f, 0x1e, 0xfa])) && cursor === symbol.offset) { cursor += 4; continue; }
    if (first === 0x5d && frame) { frame = false; cursor++; continue; }
    if (frame && first === 0x48 && cursor + 4 <= end && [0x89, 0x8b].includes(data[cursor + 1]) && (data[cursor + 2] & 0xc7) === 0x45) {
      const register = (data[cursor + 2] >> 3) & 7, slot = data.readInt8(cursor + 3);
      if (slot > -8 || slot < -64 || slot % 8) fail("a primitive getter uses unsupported stack storage.");
      if (data[cursor + 1] === 0x89) {
        if (registers.get(register) !== outputPointer || stack.has(slot)) fail("a primitive getter stores a nonconstant value.");
        stack.set(slot, outputPointer);
      } else {
        if (!stack.has(slot) || register === 7) fail("a primitive getter loads unsupported stack storage.");
        registers.set(register, stack.get(slot));
      }
      cursor += 4; continue;
    }
    if ([0x48, 0x4c].includes(first) && cursor + 7 <= end && data[cursor + 1] === 0x8d && (data[cursor + 2] & 0xc7) === 5) {
      const register = ((data[cursor + 2] >> 3) & 7) + (first === 0x4c ? 8 : 0);
      if (register === 7) fail("a primitive getter changes its output pointer.");
      registers.set(register, symbol.address + cursor - symbol.offset + 7 + data.readInt32LE(cursor + 3)); cursor += 7; continue;
    }
    if ([0x48, 0x4c].includes(first) && cursor + 3 <= end && data[cursor + 1] === 0x89 && (data[cursor + 2] & 0xc0) === 0) {
      const register = ((data[cursor + 2] >> 3) & 7) + (first === 0x4c ? 8 : 0), target = data[cursor + 2] & 7;
      if (signatureAddress !== undefined || registers.get(target) !== outputPointer || typeof registers.get(register) !== "number")
        fail("a primitive signature is not a constant.");
      signatureAddress = registers.get(register); cursor += 3; continue;
    }
    if (first === 0xc3 && !frame && signatureAddress !== undefined) {
      const functionAddress = registers.get(0);
      if (typeof functionAddress !== "number" || !sections.some(s => !s.zeroFill && !s.writable && (s.flags & 0x80000000) && functionAddress >= s.address && functionAddress < s.address + s.length))
        fail("a primitive getter does not return native code.");
      const section = sections.find(s => !s.zeroFill && !s.writable && s.name === "__cstring" && signatureAddress >= s.address && signatureAddress < s.address + s.length);
      if (!section) fail("a primitive signature leaves immutable string data.");
      const offset = section.offset + signatureAddress - section.address;
      const signature = text(data.subarray(0, section.offset + section.length), offset, LIMITS.signature);
      if (!/^P[A-Za-z0-9_?]+$/.test(signature)) fail("invalid native primitive signature.");
      return signature;
    }
    fail(`unsupported getter instructions for ${symbol.name.slice(5)}.`);
  }
  fail(`unterminated primitive getter for ${symbol.name.slice(5)}.`);
}

function inspectSignatures(buffer) {
  const image = layout(buffer), signatures = {}, unsupported = [];
  for (const [name, symbol] of [...image.symbols].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const primitive = name.slice(5);
    if (!/^[A-Za-z0-9_]+$/.test(primitive)) fail("invalid native primitive name.");
    try { signatures[primitive] = signatureOf(image, symbol); }
    catch (error) { unsupported.push({ name: primitive, reason: error.message }); }
  }
  return { schemaVersion: 1, architecture: "x86_64", signatures, unsupported };
}

function readSignatures(file) {
  const stat = fs.statSync(file), identity = [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
  if (!stat.isFile() || stat.size > LIMITS.bytes) fail("native file exceeds inspection bounds.");
  const existing = cache.get(file); if (existing?.identity === identity) return existing.profile;
  const bytes = fs.readFileSync(file), profile = { ...inspectSignatures(bytes), sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
  if (cache.size >= LIMITS.cache) cache.delete(cache.keys().next().value);
  cache.set(file, { identity, profile }); return profile;
}

function compareRequired(natives, libraries, { callbackMarker = false } = {}) {
  const missing = [], incompatible = [], unknown = [];
  for (const native of natives || []) {
    const library = native.library.replace(/^\?/, ""), profile = libraries?.[library];
    const raw = profile?.signatures?.[native.name];
    // New VMs tag callback-capable primitives with HL_CALLB after the complete
    // signature. Older VMs require byte-for-byte signatures without that tag.
    const actual = callbackMarker && raw?.endsWith("C") ? raw.slice(0, -1) : raw;
    if (typeof native.signature !== "string") { unknown.push({ library, name: native.name }); continue; }
    if (!actual) {
      if (profile?.unsupported?.some(item => item.name === native.name)) unknown.push({ library, name: native.name });
      else if (!native.optional) missing.push({ library, name: native.name, expected: native.signature });
    } else if (actual !== native.signature) incompatible.push({ library, name: native.name, expected: native.signature, actual });
  }
  return { ready: !missing.length && !incompatible.length && !unknown.length, missing, incompatible, unknown };
}

function packageProfile({ executablePath, corePath, nativeFiles }) {
  const libraries = { std: readSignatures(corePath), builtin: readSignatures(executablePath) };
  for (const file of nativeFiles) {
    const name = path.basename(file);
    if (!name.endsWith(".hdll")) continue;
    const library = name.slice(0, -5), profile = readSignatures(file);
    libraries[library] = profile;
    if (library.endsWith("64")) libraries[library.slice(0, -2)] = profile;
  }
  return { schemaVersion: 1, architecture: "x86_64", libraries };
}

module.exports = { inspectSignatures, readSignatures, compareRequired, packageProfile, LIMITS };
