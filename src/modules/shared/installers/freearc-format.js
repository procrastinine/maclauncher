// FreeArc container layout adapted from mac-game-porter / cellar-freearc-native.
// MIT: Copyright (c) 2026 KarmSakha; Copyright (c) 2026 Joe Munene.
// Their complete notices are retained in freearc-notices.txt.
const fs = require("node:fs");
const path = require("node:path");
const { installerError } = require("./inno-header");
const SIGNATURE = Buffer.from([65, 114, 67, 1]);
const LIMITS = Object.freeze({ files: 100000, bytes: 128 * 1024 ** 3, fileBytes: 64 * 1024 ** 3, control: 64 * 1024 ** 2, blocks: 100000, archives: 512 });
const fail = message => { throw installerError(message, "INSTALLER_FREEARC_INVALID"); };
const crcTable = Array.from({ length: 256 }, (_, i) => { for (let n = 0; n < 8; n++) i = i & 1 ? 0xedb88320 ^ (i >>> 1) : i >>> 1; return i >>> 0; });
function crc32(bytes, previous = 0) {
  let value = (previous ^ 0xffffffff) >>> 0;
  for (const byte of bytes) value = (crcTable[(value ^ byte) & 255] ^ (value >>> 8)) >>> 0;
  return (value ^ 0xffffffff) >>> 0;
}
function safePath(value) {
  if (typeof value !== "string" || !value || value.length > 4096 || /[\x00-\x1f\x7f:]/.test(value) || /^[\/\\]/.test(value)) fail("The FreeArc archive contains an unsafe file path.");
  const name = value.replaceAll("\\", "/");
  if (name.split("/").some(p => !p || p === "." || p === ".." || /[. ]$/.test(p))) fail("The FreeArc archive contains an unsafe file path.");
  return name;
}
function validateFiles(files) {
  if (!Array.isArray(files) || files.length > LIMITS.files) fail("The FreeArc file count exceeds its limit.");
  const names = new Set(), dirs = new Set(); let total = 0;
  for (const file of files) {
    file.path = safePath(file.path);
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > LIMITS.fileBytes || file.dir && file.size !== 0) fail("The FreeArc archive has an invalid file size.");
    if (file.crc !== undefined && (!Number.isInteger(file.crc) || file.crc < 0 || file.crc > 0xffffffff)) fail("The FreeArc archive has an invalid checksum.");
    const key = file.path.normalize("NFC").toLowerCase();
    if (names.has(key) || !file.dir && dirs.has(key)) fail("The FreeArc archive has conflicting paths.");
    if (!file.dir) names.add(key); else dirs.add(key);
    for (let parent = path.posix.dirname(key); parent !== "."; parent = path.posix.dirname(parent)) {
      if (names.has(parent)) fail("The FreeArc archive has conflicting output directories.");
      dirs.add(parent);
    }
    if ((total += file.size) > LIMITS.bytes) fail("The FreeArc archive exceeds the extraction size limit.");
  }
  return total;
}
class Reader {
  constructor(bytes) { this.bytes = bytes; this.pos = 0; }
  take(n) { if (!Number.isSafeInteger(n) || n < 0 || this.pos + n > this.bytes.length) fail("The FreeArc table is truncated."); const b = this.bytes.subarray(this.pos, this.pos + n); this.pos += n; return b; }
  integer() {
    const first = this.bytes[this.pos]; if (first === undefined) fail("The FreeArc integer is truncated.");
    let width = 1; while (width <= 8 && first & (1 << (width - 1))) width++;
    const bytes = this.take(width); let value = 0n;
    for (let i = width - 1; i >= (width === 9 ? 1 : 0); i--) value = value << 8n | BigInt(bytes[i]);
    if (width !== 9) value >>= BigInt(width);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail("The FreeArc integer exceeds its limit.");
    return Number(value);
  }
  count(max = LIMITS.files) { const n = this.integer(); if (n > max) fail("The FreeArc table count exceeds its limit."); return n; }
  string() { const end = this.bytes.indexOf(0, this.pos); if (end < 0 || end - this.pos > 4096) fail("The FreeArc string is invalid."); const b = this.take(end - this.pos + 1).subarray(0, -1); try { return new TextDecoder("utf-8", { fatal: true }).decode(b); } catch { fail("The FreeArc path encoding is invalid."); } }
  u32() { return this.take(4).readUInt32LE(); }
  column(n, read) { return Array.from({ length: n }, () => read.call(this)); }
}
function descriptor(bytes, absolute) {
  const r = new Reader(bytes);
  if (!r.take(4).equals(SIGNATURE)) fail("The FreeArc descriptor signature is invalid.");
  const type = r.integer(), method = r.string(), size = r.integer(), compressed = r.integer(), crc = r.u32();
  const checksum = r.u32();
  if (crc32(bytes.subarray(0, r.pos - 4)) !== checksum || compressed > absolute || size > LIMITS.control || compressed > LIMITS.control) fail("The FreeArc descriptor is invalid.");
  return { type, method, size, compressed, crc, offset: absolute - compressed };
}
function footerInTail(tail, start, strict) {
  for (let at = tail.lastIndexOf(SIGNATURE); at >= 0; at = at === 0 ? -1 : tail.lastIndexOf(SIGNATURE, at - 1)) {
    try { const found = descriptor(tail.subarray(at), start + at); if (found.type === 4) return found; } catch {}
  }
  if (strict) fail("The FreeArc footer descriptor is invalid or missing.");
  return null;
}
function findArchives(installer) {
  const directory = path.dirname(installer), names = fs.readdirSync(directory);
  if (names.length > 100000) fail("The installer directory exceeds its entry limit.");
  const found = [];
  for (const name of names.sort()) {
    if (!/\.(?:bin|arc|0)$/i.test(name)) continue;
    const file = path.join(directory, name), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const tail = Buffer.alloc(Math.min(4096, stat.size)); fs.readSync(fd, tail, 0, tail.length, stat.size - tail.length);
      const head = Buffer.alloc(4); fs.readSync(fd, head, 0, 4, 0);
      if (footerInTail(tail, stat.size - tail.length, head.equals(SIGNATURE))) found.push(file);
    } finally { fs.closeSync(fd); }
    if (found.length > LIMITS.archives) fail("The FreeArc part count exceeds its limit.");
  }
  return found;
}
async function mapArchive(file, { decode, signal } = {}) {
  const handle = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat(); if (!stat.isFile()) fail("FreeArc input must be a regular file.");
    async function read(offset, size) {
      signal?.throwIfAborted();
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(size) || size < 0 || size > LIMITS.control || offset + size > stat.size) fail("The FreeArc block exceeds its bounds.");
      const b = Buffer.alloc(size); let got = 0;
      while (got < size) { const part = await handle.read(b, got, size - got, offset + got); if (!part.bytesRead) fail("The FreeArc block is truncated."); got += part.bytesRead; }
      return b;
    }
    const tail = await read(Math.max(0, stat.size - 4096), Math.min(stat.size, 4096));
    const footer = footerInTail(tail, Math.max(0, stat.size - 4096), true);
    async function control(entry) {
      const input = await read(entry.offset, entry.compressed);
      const bytes = entry.method === "storing" ? input : await decode(entry.method, input, entry.size);
      if (!Buffer.isBuffer(bytes) || bytes.length !== entry.size || crc32(bytes) !== entry.crc) fail("The FreeArc control table checksum or size is invalid.");
      return bytes;
    }
    const f = new Reader(await control(footer)), controls = f.count(LIMITS.blocks), blocks = [];
    for (let n = 0; n < controls; n++) {
      const type = f.integer(), method = f.string(), offset = footer.offset - f.integer(), size = f.integer(), compressed = f.integer(), crc = f.u32();
      if (type !== 3) continue;
      const r = new Reader(await control({ method, offset, size, compressed, crc }));
      const count = r.count(LIMITS.blocks), counts = r.column(count, r.count), methods = r.column(count, r.string), offsets = r.column(count, r.integer), sizes = r.column(count, r.integer);
      const total = counts.reduce((a, b) => a + b, 0); if (total > LIMITS.files) fail("The FreeArc file count exceeds its limit.");
      const dirs = r.column(r.count(), r.string), names = r.column(total, r.string), parents = r.column(total, r.integer), lengths = r.column(total, r.integer);
      r.column(total, r.u32); const flags = r.column(total, function() { return this.take(1)[0]; }), crcs = r.column(total, r.u32);
      let index = 0;
      for (let i = 0; i < count; i++) {
        const block = { method: methods[i], offset: offset - offsets[i], compsize: sizes[i], files: [] };
        if (block.offset < 0 || block.compsize < 0 || block.offset + block.compsize > offset) fail("The FreeArc solid block exceeds its bounds.");
        for (let j = 0; j < counts[i]; j++, index++) {
          if (parents[index] >= dirs.length || /[\/\\]/.test(names[index])) fail("The FreeArc file directory is invalid.");
          block.files.push({ path: safePath((dirs[parents[index]] ? dirs[parents[index]] + "/" : "") + names[index]), size: lengths[index], dir: flags[index] !== 0, crc: crcs[index] });
        }
        blocks.push(block);
      }
      if (r.pos !== r.bytes.length) fail("The FreeArc directory table contains unexpected data.");
    }
    validateFiles(blocks.flatMap(b => b.files));
    if (!blocks.length) fail("The FreeArc archive has no file table.");
    return blocks;
  } finally { await handle.close(); }
}
module.exports = { SIGNATURE, LIMITS, crc32, Reader, descriptor, safePath, validateFiles, findArchives, mapArchive };
