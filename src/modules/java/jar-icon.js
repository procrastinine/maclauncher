const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const Zip = require("../shared/runtime/zip");

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const MAX_ICON_ENTRY_BYTES = 8 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function normalizeZipEntryName(name) {
  return String(name || "").replace(/\\/g, "/");
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readLocalHeader(fd, offset) {
  if (!Number.isFinite(offset) || offset < 0) return null;
  const header = Buffer.alloc(30);
  const read = fs.readSync(fd, header, 0, header.length, offset);
  if (read < header.length) return null;
  if (header.readUInt32LE(0) !== LOCAL_FILE_HEADER_SIGNATURE) return null;
  return {
    method: header.readUInt16LE(8),
    nameLength: header.readUInt16LE(26),
    extraLength: header.readUInt16LE(28)
  };
}

function readZipEntryBuffer(fd, entry, maxBytes = MAX_ICON_ENTRY_BYTES) {
  const localOffset = Number(entry?.absoluteLocalHeaderOffset);
  const compressedSize = Number(entry?.compressedSize);
  const uncompressedSize = Number(entry?.uncompressedSize);
  if (!Number.isFinite(localOffset) || localOffset < 0) return null;
  if (!Number.isFinite(compressedSize) || compressedSize < 0) return null;
  if (Number.isFinite(uncompressedSize) && uncompressedSize > maxBytes) return null;

  const local = readLocalHeader(fd, localOffset);
  if (!local) return null;

  const dataOffset = localOffset + 30 + local.nameLength + local.extraLength;
  if (!Number.isFinite(dataOffset) || dataOffset < 0) return null;
  if (compressedSize > maxBytes * 2) return null;

  const compressed = Buffer.alloc(compressedSize);
  const read = fs.readSync(fd, compressed, 0, compressedSize, dataOffset);
  if (read < compressedSize) return null;

  if (local.method === 0) {
    if (compressed.length > maxBytes) return null;
    return compressed;
  }

  if (local.method === 8) {
    let uncompressed = null;
    try {
      uncompressed = zlib.inflateRawSync(compressed);
    } catch {
      return null;
    }
    if (!uncompressed || uncompressed.length > maxBytes) return null;
    return uncompressed;
  }

  return null;
}

function isPngBuffer(buf) {
  if (!buf || buf.length < PNG_SIGNATURE.length) return false;
  return buf.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
}

function scoreIconEntry(entry) {
  const normalized = normalizeZipEntryName(entry?.name || "").toLowerCase();
  if (!normalized.endsWith(".png")) return -Infinity;
  if (normalized.startsWith("meta-inf/")) return -Infinity;

  const base = path.basename(normalized, ".png");
  let score = 0;

  if (!normalized.includes("/")) score += 20;
  if (base === "icon") score += 150;
  if (base.includes("icon")) score += 80;
  if (base.includes("logo")) score += 50;
  if (base.includes("favicon")) score += 35;
  if (normalized.includes("/icons/")) score += 35;
  if (normalized.includes("/images/")) score += 15;
  if (normalized.includes("/assets/")) score += 10;

  const size = Number(entry?.uncompressedSize);
  if (Number.isFinite(size) && size > 0) {
    score += Math.min(45, Math.floor(Math.log2(size + 1) * 4));
  }

  score -= Math.min(20, Math.max(0, base.length - 18));
  return score;
}

function pickBestIconEntry(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const candidates = entries
    .map(entry => ({
      entry,
      score: scoreIconEntry(entry)
    }))
    .filter(item => Number.isFinite(item.score));
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    const sizeA = Number(a.entry?.uncompressedSize) || 0;
    const sizeB = Number(b.entry?.uncompressedSize) || 0;
    if (sizeA !== sizeB) return sizeB - sizeA;
    return String(a.entry?.name || "").localeCompare(String(b.entry?.name || ""));
  });
  return candidates[0].entry || null;
}

function extractJarIconToPath(jarPath, outputPath) {
  if (!jarPath || !outputPath) return null;
  let zip = null;
  try {
    zip = Zip.readZipEntries(jarPath);
  } catch {
    return null;
  }
  if (!zip || !Array.isArray(zip.entries) || zip.entries.length === 0) return null;

  const iconEntry = pickBestIconEntry(zip.entries);
  if (!iconEntry) return null;

  let fd = null;
  try {
    fd = fs.openSync(jarPath, "r");
    const buf = readZipEntryBuffer(fd, iconEntry, MAX_ICON_ENTRY_BYTES);
    if (!isPngBuffer(buf)) return null;
    ensureDir(path.dirname(outputPath));
    fs.writeFileSync(outputPath, buf);
    const stat = fs.statSync(outputPath);
    if (!stat.isFile() || stat.size === 0) return null;
    return outputPath;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

module.exports = {
  extractJarIconToPath,
  __test: {
    pickBestIconEntry,
    scoreIconEntry
  }
};
