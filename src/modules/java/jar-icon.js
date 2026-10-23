const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const Zip = require("../shared/runtime/zip");
const Images = require("../../core/icon-utils");
const Writable = require("../shared/writable-input");

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const MAX_ICON_ENTRY_BYTES = 8 * 1024 * 1024;

function normalizeZipEntryName(name) {
  return String(name || "").replace(/\\/g, "/");
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
      uncompressed = zlib.inflateRawSync(compressed, { maxOutputLength: maxBytes });
    } catch {
      return null;
    }
    if (!uncompressed || uncompressed.length > maxBytes) return null;
    return uncompressed;
  }

  return null;
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

function rankedIconEntries(entries) {
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
  return candidates.map(item => item.entry);
}
function pickBestIconEntry(entries) { return rankedIconEntries(entries)?.[0] || null; }

function extractJarIconToPath(jarPath, outputPath, { root = path.dirname(outputPath) } = {}) {
  if (!jarPath || !outputPath) return null;
  let zip = null;
  try {
    zip = Zip.readZipEntries(jarPath);
  } catch {
    return null;
  }
  if (!zip || !Array.isArray(zip.entries) || zip.entries.length === 0) return null;

  const entries = rankedIconEntries(zip.entries);
  if (!entries?.length) return null;

  let fd = null;
  try {
    fd = fs.openSync(jarPath, "r");
    let total = 0;
    for (const iconEntry of entries.slice(0, 16)) {
      const size = Number(iconEntry.uncompressedSize);
      if (size > MAX_ICON_ENTRY_BYTES || (total += size || 0) > 32 * 1024 ** 2) continue;
      const buf = readZipEntryBuffer(fd, iconEntry, MAX_ICON_ENTRY_BYTES);
      if (!Images.isSupportedImageBuffer(buf)) continue;
      Writable.atomicWrite(outputPath, buf, { root });
      return outputPath;
    }
    return null;
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
