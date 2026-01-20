const fs = require("node:fs");
const path = require("node:path");

const BAD_EXE_TOKENS = [
  "unins",
  "uninstall",
  "setup",
  "installer",
  "vcredist",
  "dxsetup",
  "redist",
  "patch",
  "update",
  "launcher",
  "config",
  "settings",
  "crash",
  "helper",
  "server",
  "editor",
  "tool"
];

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function normalizeToken(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function scoreExeCandidate(baseName, gameName, folderName) {
  const rawBase = String(baseName || "");
  if (!rawBase) return -Infinity;
  const normalized = normalizeToken(rawBase);
  const normalizedGame = normalizeToken(gameName);
  const normalizedFolder = normalizeToken(folderName);

  let score = 0;

  if (normalizedGame) {
    if (normalized === normalizedGame) score += 140;
    else if (normalized.startsWith(normalizedGame)) score += 80;
    else if (normalized.includes(normalizedGame)) score += 50;
  }

  if (normalizedFolder) {
    if (normalized === normalizedFolder) score += 90;
    else if (normalized.startsWith(normalizedFolder)) score += 50;
    else if (normalized.includes(normalizedFolder)) score += 25;
  }

  if (["game", "start", "play"].includes(rawBase.toLowerCase())) score += 10;

  for (const token of BAD_EXE_TOKENS) {
    if (normalized.includes(token)) score -= 70;
  }

  const targetLen = normalizedGame.length || 6;
  score -= Math.min(20, Math.max(0, normalized.length - targetLen));

  return score;
}

function pickBestExeCandidate(candidates, gameName, folderName) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  let best = null;
  let bestScore = -Infinity;

  for (const candidate of candidates) {
    const baseName = path.basename(candidate, path.extname(candidate));
    const score = scoreExeCandidate(baseName, gameName, folderName);
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
      continue;
    }
    if (score === bestScore && best) {
      if (candidate.length < best.length) {
        best = candidate;
      } else if (candidate.length === best.length && candidate < best) {
        best = candidate;
      }
    }
  }

  return best;
}

function listExeCandidates(rootDir) {
  let entries = [];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith(".exe"))
    .map(entry => entry.name);
}

function findBestExePath(rootDir, gameName) {
  const candidates = listExeCandidates(rootDir);
  const folderName = path.basename(rootDir || "");
  const pick = pickBestExeCandidate(candidates, gameName, folderName);
  return pick ? path.join(rootDir, pick) : null;
}

function readXmlPlistValue(text, key) {
  if (!text || !key) return null;
  const pattern = new RegExp(
    `<key>\\s*${String(key).replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\s*<\\/key>\\s*<string>([^<]+)<\\/string>`,
    "i"
  );
  const match = text.match(pattern);
  return match ? String(match[1]).trim() : null;
}

function readAppBundleIconName(appPath) {
  const infoPath = path.join(appPath, "Contents", "Info.plist");
  try {
    const raw = fs.readFileSync(infoPath);
    if (!raw || raw.length < 16) return null;
    const header = raw.subarray(0, 6).toString("utf8");
    if (header === "bplist") return null;
    const text = raw.toString("utf8");
    return readXmlPlistValue(text, "CFBundleIconFile");
  } catch {
    return null;
  }
}

function scoreIcnsCandidate(name, bundleName, iconName) {
  const base = path.basename(name, ".icns");
  const normalized = normalizeToken(base);
  const normalizedBundle = normalizeToken(bundleName);
  const normalizedIcon = normalizeToken(iconName);
  let score = 0;

  if (normalizedIcon) {
    if (normalized === normalizedIcon) score += 150;
    if (normalized.startsWith(normalizedIcon)) score += 80;
  }

  if (normalizedBundle) {
    if (normalized === normalizedBundle) score += 100;
    if (normalized.startsWith(normalizedBundle)) score += 50;
  }

  if (normalized.includes("appicon")) score += 40;
  if (normalized.includes("icon")) score += 15;
  return score;
}

function findAppBundleIconPath(appPath) {
  if (!appPath || !appPath.toLowerCase().endsWith(".app")) return null;
  const resourcesDir = path.join(appPath, "Contents", "Resources");
  let entries = [];
  try {
    entries = fs.readdirSync(resourcesDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const iconName = readAppBundleIconName(appPath);
  if (iconName) {
    const withExt = iconName.toLowerCase().endsWith(".icns") ? iconName : `${iconName}.icns`;
    const direct = path.join(resourcesDir, withExt);
    if (fs.existsSync(direct)) return direct;
  }

  const bundleName = path.basename(appPath, ".app");
  const icns = entries
    .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith(".icns"))
    .map(entry => entry.name);
  if (icns.length === 0) return null;
  if (icns.length === 1) return path.join(resourcesDir, icns[0]);

  let best = icns[0];
  let bestScore = -Infinity;
  for (const name of icns) {
    const score = scoreIcnsCandidate(name, bundleName, iconName);
    if (score > bestScore) {
      bestScore = score;
      best = name;
    }
  }
  return best ? path.join(resourcesDir, best) : null;
}

function readUInt16LE(buf, offset) {
  if (offset + 2 > buf.length) return null;
  return buf.readUInt16LE(offset);
}

function readUInt32LE(buf, offset) {
  if (offset + 4 > buf.length) return null;
  return buf.readUInt32LE(offset);
}

function readInt32LE(buf, offset) {
  if (offset + 4 > buf.length) return null;
  return buf.readInt32LE(offset);
}

function rvaToOffset(rva, sections) {
  for (const sec of sections) {
    const start = sec.virtualAddress;
    const end = start + sec.rawSize;
    if (rva >= start && rva < end) {
      return sec.rawPointer + (rva - start);
    }
  }
  return null;
}

function readResourceDirectory(buf, baseOffset, dirOffset) {
  const offset = baseOffset + dirOffset;
  if (offset + 16 > buf.length) return null;
  const numNamed = readUInt16LE(buf, offset + 12) || 0;
  const numId = readUInt16LE(buf, offset + 14) || 0;
  const total = numNamed + numId;
  const entries = [];
  for (let i = 0; i < total; i += 1) {
    const entryOffset = offset + 16 + i * 8;
    if (entryOffset + 8 > buf.length) break;
    const name = readUInt32LE(buf, entryOffset);
    const data = readUInt32LE(buf, entryOffset + 4);
    if (name == null || data == null) continue;
    const nameIsString = Boolean(name & 0x80000000);
    const id = nameIsString ? null : name & 0xffff;
    const isDir = Boolean(data & 0x80000000);
    const childOffset = data & 0x7fffffff;
    entries.push({ id, isDir, offset: childOffset });
  }
  return entries;
}

function readResourceDataEntry(buf, baseOffset, dataOffset, sections) {
  const offset = baseOffset + dataOffset;
  if (offset + 16 > buf.length) return null;
  const rva = readUInt32LE(buf, offset);
  const size = readUInt32LE(buf, offset + 4);
  if (rva == null || size == null) return null;
  const fileOffset = rvaToOffset(rva, sections);
  if (fileOffset == null) return null;
  return { offset: fileOffset, size };
}

function extractGroupIconEntries(buf) {
  if (!buf || buf.length < 6) return [];
  const count = buf.readUInt16LE(4);
  const entries = [];
  let offset = 6;
  for (let i = 0; i < count; i += 1) {
    if (offset + 14 > buf.length) break;
    const width = buf.readUInt8(offset);
    const height = buf.readUInt8(offset + 1);
    const colorCount = buf.readUInt8(offset + 2);
    const planes = buf.readUInt16LE(offset + 4);
    const bitCount = buf.readUInt16LE(offset + 6);
    const bytesInRes = buf.readUInt32LE(offset + 8);
    const id = buf.readUInt16LE(offset + 12);
    entries.push({
      width: width === 0 ? 256 : width,
      height: height === 0 ? 256 : height,
      colorCount,
      planes,
      bitCount,
      bytesInRes,
      id
    });
    offset += 14;
  }
  return entries;
}

function pickBestGroupEntry(entries) {
  if (!entries.length) return null;
  let best = entries[0];
  let bestScore = -Infinity;
  for (const entry of entries) {
    const area = entry.width * entry.height;
    const score = area * 10 + (entry.bitCount || 0);
    if (score > bestScore) {
      bestScore = score;
      best = entry;
    }
  }
  return best;
}

function extractExeIconData(exePath) {
  let buf = null;
  try {
    buf = fs.readFileSync(exePath);
  } catch {
    return null;
  }
  if (!buf || buf.length < 64) return null;
  if (buf.readUInt16LE(0) !== 0x5a4d) return null;

  const peOffset = readUInt32LE(buf, 0x3c);
  if (peOffset == null || peOffset + 256 > buf.length) return null;
  if (buf.toString("ascii", peOffset, peOffset + 4) !== "PE\u0000\u0000") return null;

  const numSections = readUInt16LE(buf, peOffset + 6);
  const optHeaderSize = readUInt16LE(buf, peOffset + 20);
  if (!numSections || !optHeaderSize) return null;

  const optionalOffset = peOffset + 24;
  if (optionalOffset + optHeaderSize > buf.length) return null;
  const magic = readUInt16LE(buf, optionalOffset);
  const dataDirOffset =
    magic === 0x20b ? optionalOffset + 112 : magic === 0x10b ? optionalOffset + 96 : null;
  if (!dataDirOffset || dataDirOffset + 8 * 3 > buf.length) return null;

  const resourceRva = readUInt32LE(buf, dataDirOffset + 8 * 2);
  const resourceSize = readUInt32LE(buf, dataDirOffset + 8 * 2 + 4);
  if (!resourceRva || !resourceSize) return null;

  const sectionOffset = optionalOffset + optHeaderSize;
  const sections = [];
  for (let i = 0; i < numSections; i += 1) {
    const offset = sectionOffset + i * 40;
    if (offset + 40 > buf.length) break;
    const virtualAddress = readUInt32LE(buf, offset + 12);
    const rawSize = readUInt32LE(buf, offset + 16);
    const rawPointer = readUInt32LE(buf, offset + 20);
    if (virtualAddress == null || rawSize == null || rawPointer == null) continue;
    sections.push({ virtualAddress, rawSize, rawPointer });
  }

  const resourceOffset = rvaToOffset(resourceRva, sections);
  if (resourceOffset == null) return null;

  const root = readResourceDirectory(buf, resourceOffset, 0);
  if (!root) return null;

  const groupEntry = root.find(entry => entry.id === 14 && entry.isDir);
  if (!groupEntry) return null;

  const groupLevel = readResourceDirectory(buf, resourceOffset, groupEntry.offset);
  if (!groupLevel || groupLevel.length === 0) return null;

  const groupNameEntry = groupLevel.find(entry => entry.id != null && entry.isDir) || groupLevel[0];
  if (!groupNameEntry) return null;

  const groupLangLevel = readResourceDirectory(buf, resourceOffset, groupNameEntry.offset);
  if (!groupLangLevel || groupLangLevel.length === 0) return null;

  const groupDataEntry =
    groupLangLevel.find(entry => entry.id != null && !entry.isDir) || groupLangLevel[0];
  if (!groupDataEntry) return null;

  const groupData = readResourceDataEntry(buf, resourceOffset, groupDataEntry.offset, sections);
  if (!groupData) return null;

  const groupBuf = buf.subarray(groupData.offset, groupData.offset + groupData.size);
  const groupIcons = extractGroupIconEntries(groupBuf);
  const bestGroup = pickBestGroupEntry(groupIcons);
  if (!bestGroup) return null;

  const iconTypeEntry = root.find(entry => entry.id === 3 && entry.isDir);
  if (!iconTypeEntry) return null;

  const iconNameLevel = readResourceDirectory(buf, resourceOffset, iconTypeEntry.offset);
  if (!iconNameLevel || iconNameLevel.length === 0) return null;

  const iconNameEntry = iconNameLevel.find(entry => entry.id === bestGroup.id && entry.isDir);
  if (!iconNameEntry) return null;

  const iconLangLevel = readResourceDirectory(buf, resourceOffset, iconNameEntry.offset);
  if (!iconLangLevel || iconLangLevel.length === 0) return null;

  const iconDataEntry =
    iconLangLevel.find(entry => entry.id != null && !entry.isDir) || iconLangLevel[0];
  if (!iconDataEntry) return null;

  const iconData = readResourceDataEntry(buf, resourceOffset, iconDataEntry.offset, sections);
  if (!iconData) return null;

  const iconBuf = buf.subarray(iconData.offset, iconData.offset + iconData.size);
  if (iconBuf.length === 0) return null;
  return { buffer: Buffer.from(iconBuf), entry: bestGroup };
}

function extractExeIconPngBuffer(exePath) {
  const result = extractExeIconData(exePath);
  if (!result) return null;
  const iconBuf = result.buffer;
  if (iconBuf.length < PNG_SIGNATURE.length) return null;
  if (!iconBuf.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return null;
  return iconBuf;
}

function applyMaskToAlpha(out, buf, maskOffset, maskRowStride, width, height, flip, forceOpaque) {
  for (let y = 0; y < height; y += 1) {
    const srcRow = flip ? height - 1 - y : y;
    const rowStart = maskOffset + srcRow * maskRowStride;
    for (let x = 0; x < width; x += 1) {
      const byte = buf[rowStart + (x >> 3)];
      const maskBit = (byte >> (7 - (x & 7))) & 1;
      if (!maskBit && !forceOpaque) continue;
      const dest = (y * width + x) * 4 + 3;
      if (maskBit) out[dest] = 0;
      else if (forceOpaque) out[dest] = 255;
    }
  }
}

function decodeIconDibToBitmap(iconBuf, entry) {
  if (!iconBuf || iconBuf.length < 40) return null;
  const headerSize = readUInt32LE(iconBuf, 0);
  if (!headerSize || headerSize < 40 || headerSize > iconBuf.length) return null;

  const widthRaw = readInt32LE(iconBuf, 4);
  const heightRaw = readInt32LE(iconBuf, 8);
  if (!widthRaw || !heightRaw) return null;

  const width = Math.abs(widthRaw);
  const heightAbs = Math.abs(heightRaw);
  if (!width || !heightAbs) return null;

  let height = heightAbs;
  if (entry?.height && heightAbs >= entry.height && heightAbs % entry.height === 0) {
    height = entry.height;
  } else if (heightAbs % 2 === 0) {
    height = heightAbs / 2;
  }
  if (!height) return null;

  const planes = readUInt16LE(iconBuf, 12);
  const bitCount = readUInt16LE(iconBuf, 14);
  const compression = readUInt32LE(iconBuf, 16);
  const colorsUsed = readUInt32LE(iconBuf, 32) || 0;
  if (!planes || !bitCount) return null;
  if (compression !== 0) return null;

  const paletteEntries = bitCount <= 8 ? colorsUsed || (1 << bitCount) : 0;
  const paletteOffset = headerSize;
  const paletteSize = paletteEntries * 4;
  if (paletteOffset + paletteSize > iconBuf.length) return null;

  const pixelOffset = paletteOffset + paletteSize;
  const rowStride = Math.floor((bitCount * width + 31) / 32) * 4;
  const xorSize = rowStride * height;
  if (pixelOffset + xorSize > iconBuf.length) return null;

  const maskOffset = pixelOffset + xorSize;
  const maskRowStride = Math.floor((width + 31) / 32) * 4;
  const maskSize = maskRowStride * height;
  const hasMask = maskOffset + maskSize <= iconBuf.length;

  const out = Buffer.alloc(width * height * 4);
  const flip = heightRaw > 0;

  let alphaHasValue = false;
  let palette = null;
  if (paletteEntries) {
    palette = new Array(paletteEntries);
    for (let i = 0; i < paletteEntries; i += 1) {
      const base = paletteOffset + i * 4;
      palette[i] = [iconBuf[base + 2], iconBuf[base + 1], iconBuf[base]];
    }
  }

  for (let y = 0; y < height; y += 1) {
    const srcRow = flip ? height - 1 - y : y;
    const rowStart = pixelOffset + srcRow * rowStride;
    for (let x = 0; x < width; x += 1) {
      const dest = (y * width + x) * 4;
      if (bitCount === 32) {
        const src = rowStart + x * 4;
        const b = iconBuf[src];
        const g = iconBuf[src + 1];
        const r = iconBuf[src + 2];
        const a = iconBuf[src + 3];
        out[dest] = r;
        out[dest + 1] = g;
        out[dest + 2] = b;
        out[dest + 3] = a;
        if (a) alphaHasValue = true;
      } else if (bitCount === 24) {
        const src = rowStart + x * 3;
        out[dest] = iconBuf[src + 2];
        out[dest + 1] = iconBuf[src + 1];
        out[dest + 2] = iconBuf[src];
        out[dest + 3] = 255;
      } else if (bitCount === 8 && palette) {
        const src = rowStart + x;
        const idx = iconBuf[src];
        const color = palette[idx] || [0, 0, 0];
        out[dest] = color[0];
        out[dest + 1] = color[1];
        out[dest + 2] = color[2];
        out[dest + 3] = 255;
      } else if (bitCount === 4 && palette) {
        const src = rowStart + (x >> 1);
        const byte = iconBuf[src];
        const idx = x % 2 === 0 ? byte >> 4 : byte & 0x0f;
        const color = palette[idx] || [0, 0, 0];
        out[dest] = color[0];
        out[dest + 1] = color[1];
        out[dest + 2] = color[2];
        out[dest + 3] = 255;
      } else if (bitCount === 1 && palette) {
        const src = rowStart + (x >> 3);
        const byte = iconBuf[src];
        const idx = (byte >> (7 - (x & 7))) & 1;
        const color = palette[idx] || [0, 0, 0];
        out[dest] = color[0];
        out[dest + 1] = color[1];
        out[dest + 2] = color[2];
        out[dest + 3] = 255;
      } else {
        return null;
      }
    }
  }

  if (hasMask) {
    const forceOpaque = bitCount === 32 && !alphaHasValue;
    applyMaskToAlpha(out, iconBuf, maskOffset, maskRowStride, width, height, flip, forceOpaque);
  }

  return { width, height, buffer: out };
}

function extractExeIconImage(exePath) {
  const result = extractExeIconData(exePath);
  if (!result) return null;
  const iconBuf = result.buffer;
  if (iconBuf.length >= PNG_SIGNATURE.length) {
    if (iconBuf.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
      return { type: "png", buffer: iconBuf };
    }
  }

  const bitmap = decodeIconDibToBitmap(iconBuf, result.entry);
  if (!bitmap) return null;
  return { type: "bitmap", width: bitmap.width, height: bitmap.height, buffer: bitmap.buffer };
}

module.exports = {
  extractExeIconImage,
  extractExeIconPngBuffer,
  findAppBundleIconPath,
  findBestExePath,
  listExeCandidates,
  normalizeToken,
  pickBestExeCandidate,
  scoreExeCandidate
};
