const fs = require("node:fs");
const path = require("node:path");
const { readPeResources } = require("../shared/runtime/pe-resources");
const Cipher = require("./cipher");
const Crypto = require("./runtime/crypto");

const LIMITS = Object.freeze({ entries: 100000, indexBytes: 8 * 1024 * 1024, memberBytes: 64 * 1024 * 1024, codeBytes: 256 });
const hidden = new WeakMap(), decoder = require("./encoding");
const identity = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");

async function source(file, expected, operation) {
  const before = await fs.promises.lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || expected && identity(before) !== expected) throw new Error("The KIF source changed or is not a regular file.");
  const handle = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    if (identity(await handle.stat()) !== identity(before)) throw new Error("The KIF source changed during inspection.");
    async function read(offset, length) {
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || length > before.size - offset)
        throw new Error("KIF data exceeds its source range.");
      const bytes = Buffer.alloc(length); let at = 0;
      while (at < length) {
        const result = await handle.read(bytes, at, length - at, offset + at);
        if (!result.bytesRead) throw new Error("Truncated KIF data.");
        at += result.bytesRead;
      }
      return bytes;
    }
    const result = await operation(read, before);
    if (identity(await handle.stat()) !== identity(before) || identity(await fs.promises.lstat(file)) !== identity(before))
      throw new Error("The KIF source changed during inspection.");
    return result;
  } finally { await handle.close(); }
}

function safeName(bytes) {
  const end = bytes.indexOf(0);
  if (end <= 0 || bytes.subarray(end).some(byte => byte !== 0)) throw new Error("KIF entry name is invalid or uses an unknown index format.");
  const name = decoder.decode(bytes.subarray(0, end)).replaceAll("\\", "/"), parts = name.split("/");
  if (name.length > 256 || /[\x00-\x1f\x7f:]/.test(name) || path.posix.isAbsolute(name) || parts.some(part => !part || part === "." || part === ".."))
    throw new Error("KIF entry name escapes its archive output.");
  return name;
}

async function readTocSeed(runnerPath, helper, { signal } = {}) {
  const resources = readPeResources(runnerPath, [{ type: "KEY_CODE", name: "KEY" }, { type: "V_CODE2", name: "DATA" }]);
  const keys = resources.filter(resource => resource.type === "KEY_CODE"), codes = resources.filter(resource => resource.type === "V_CODE2");
  const pairs = codes.flatMap(code => {
    const exact = keys.filter(key => key.language === code.language);
    return (exact.length ? exact : keys.filter(key => key.language === 0)).map(key => ({ key, code }));
  });
  const expected = pairs.filter(pair => pair.code.language === 0x411), candidates = expected.length ? expected : pairs;
  if (candidates.length !== 1) throw new Error("Encrypted KIF archives need one matching KEY_CODE / V_CODE2 resource pair in the original runner.");
  const { key, code } = candidates[0];
  if (key.data.length < 4 || key.data.length > 56 || !code.data.length || code.data.length > LIMITS.codeBytes)
    throw new Error("The CatSystem2 key resources use an unsupported format.");
  const material = Buffer.from(key.data);
  for (let i = 0; i < material.length; i++) material[i] ^= 0xcd;
  const padded = Buffer.alloc(Math.ceil(code.data.length / 8) * 8); code.data.copy(padded);
  let decoded;
  try {
    decoded = await Crypto.transform(helper, material, padded, { signal });
    const end = decoded.indexOf(0), text = decoded.subarray(0, end < 0 ? decoded.length : end);
    if (!text.length || text.some(byte => byte < 0x20 || byte > 0x7e) || end >= 0 && decoded.subarray(end).some(byte => byte !== 0))
      throw new Error("The original CatSystem2 key resources could not be decoded.");
    return Cipher.tocSeed(text);
  } finally {
    material.fill(0); padded.fill(0); decoded?.fill(0);
    for (const resource of resources) resource.data.fill(0);
  }
}

async function inspectArchive(file, { tocSeed, helper, maximumIndexBytes = LIMITS.indexBytes, signal } = {}) {
  signal?.throwIfAborted();
  return source(file, null, async (read, stat) => {
    const header = await read(0, 8);
    if (!header.subarray(0, 4).equals(Buffer.from("KIF\0"))) throw new Error("Unsupported CatSystem2 archive signature.");
    const count = header.readUInt32LE(4), indexBytes = 8 + count * 72;
    if (!count || count > LIMITS.entries || indexBytes > maximumIndexBytes || indexBytes > stat.size) throw new Error("KIF entry table exceeds its bounds.");
    const index = await read(8, count * 72), keyEntries = [];
    for (let i = 0; i < count; i++) {
      const name = index.subarray(i * 72, i * 72 + 64), end = name.indexOf(0);
      if (end >= 0 && name.subarray(0, end).equals(Buffer.from("__key__.dat"))) keyEntries.push(i);
    }
    if (keyEntries.length > 1) throw new Error("KIF contains ambiguous key entries.");
    const encrypted = keyEntries.length === 1, keyIndex = keyEntries[0], key = Buffer.alloc(4);
    let metadata;
    if (encrypted) {
      if (count < 2 || !helper || !Number.isInteger(tocSeed) || tocSeed < 0 || tocSeed > 0xffffffff) throw new Error("This KIF archive requires its original runner's key resources.");
      key.writeUInt32LE(Cipher.mt1999First(index.readUInt32LE(keyIndex * 72 + 68)));
      const blocks = Buffer.alloc((count - 1) * 8); let at = 0;
      for (let i = 0; i < count; i++) {
        if (i === keyIndex) continue;
        blocks.writeUInt32LE((index.readUInt32LE(i * 72 + 64) + i) >>> 0, at);
        blocks.writeUInt32LE(index.readUInt32LE(i * 72 + 68), at + 4); at += 8;
      }
      metadata = await Crypto.transform(helper, key, blocks, { signal });
    }
    const entries = [], names = new Map(); let metadataOffset = 0, duplicateNames = 0;
    try {
      for (let i = 0; i < count; i++) {
        if (i === keyIndex) continue;
        const original = index.subarray(i * 72, i * 72 + 64);
        const name = safeName(encrypted ? Cipher.transformName(original, (tocSeed + i) >>> 0) : original);
        const canonical = name.normalize("NFC").toLowerCase();
        // Patched archives can retain multiple generations of one member.
        // Inspection preserves every index instead of silently choosing one;
        // exports disambiguate them into separate, numbered directories.
        if (names.has(canonical)) duplicateNames++;
        names.set(canonical, (names.get(canonical) || 0) + 1);
        const offset = encrypted ? metadata.readUInt32LE(metadataOffset) : index.readUInt32LE(i * 72 + 64);
        const length = encrypted ? metadata.readUInt32LE(metadataOffset + 4) : index.readUInt32LE(i * 72 + 68);
        metadataOffset += encrypted ? 8 : 0;
        if (offset < indexBytes || offset > stat.size || length > stat.size - offset) throw new Error("KIF entry data exceeds its archive range.");
        entries.push(Object.freeze({ name, offset, length, index: i }));
      }
      let previousEnd = indexBytes;
      for (const entry of entries.filter(entry => entry.length).sort((a, b) => a.offset - b.offset)) {
        if (entry.offset < previousEnd) throw new Error("KIF entry data overlaps another member.");
        previousEnd = entry.offset + entry.length;
      }
      const archive = Object.freeze({ path: file, format: "KIF-64", bytes: stat.size, entries: Object.freeze(entries), encrypted, indexBytes, duplicateNames });
      hidden.set(archive, { key, helper, identity: identity(stat) });
      return archive;
    } catch (error) { key.fill(0); throw error; }
    finally { index.fill(0); metadata?.fill(0); }
  });
}

async function readEntry(archive, entry, { maximumBytes = LIMITS.memberBytes, signal } = {}) {
  signal?.throwIfAborted();
  const state = hidden.get(archive);
  if (!state || !archive.entries.includes(entry)) throw new Error("Choose a member from a validated KIF archive index.");
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0 || maximumBytes > LIMITS.memberBytes || entry.length > maximumBytes)
    throw new Error("KIF member exceeds its selected read limit.");
  return source(archive.path, state.identity, async read => {
    const bytes = await read(entry.offset, entry.length);
    if (!archive.encrypted) return bytes;
    const length = Math.floor(bytes.length / 8) * 8;
    if (!length) return bytes;
    const decoded = await Crypto.transform(state.helper, state.key, bytes.subarray(0, length), { signal });
    decoded.copy(bytes); return bytes;
  });
}

function releaseArchive(archive) { hidden.get(archive)?.key.fill(0); hidden.delete(archive); }
async function verifyArchive(archive, { signal } = {}) {
  signal?.throwIfAborted(); const state = hidden.get(archive);
  if (!state) throw new Error("A validated KIF archive index is required.");
  return source(archive.path, state.identity, async () => true);
}
module.exports = { LIMITS, safeName, readTocSeed, inspectArchive, readEntry, verifyArchive, releaseArchive };
