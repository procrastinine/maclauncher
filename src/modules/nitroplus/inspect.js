const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { readPeVersion } = require("../shared/runtime/pe-version");

const LIMITS = Object.freeze({ indexBytes: 2 * 1024 * 1024, entries: 16384, nameBytes: 1024,
  entryBytes: 32 * 1024 * 1024, configBytes: 65536, bootBytes: 65536, archives: 64 });
const MAGIC = Buffer.from([0x4e, 0x50, 0x41, 1, 0, 0, 0]);
const decode = bytes => new TextDecoder("shift_jis", { fatal: true }).decode(bytes);

function safeName(name) {
  if (typeof name !== "string" || !name || name.includes("\0") || /[\u0000-\u001f]/.test(name) || /^[A-Za-z]:/.test(name)) return null;
  const normalized = name.replaceAll("\\", "/");
  if (normalized.startsWith("/") || normalized.split("/").some(part => !part || part === "." || part === "..")) return null;
  return normalized;
}

function readAt(file, offset, length, detection) {
  if (detection?.readBytes) {
    const bytes = detection.readBytes(file, offset, length);
    if (!bytes || bytes.length !== length) throw new Error("Truncated NPA data.");
    return bytes;
  }
  const fd = fs.openSync(file, "r");
  try {
    const bytes = Buffer.alloc(length);
    if (fs.readSync(fd, bytes, 0, length, offset) !== length) throw new Error("Truncated NPA data.");
    return bytes;
  } finally { fs.closeSync(fd); }
}

// NPA v1's public filename transform is documented by libnpa's inipafile.cpp.
// Inspect only the complete bounded directory, never image/audio payloads.
function inspectArchive(file, { detection } = {}) {
  try {
    const stat = detection?.stat ? detection.stat(file) : fs.statSync(file);
    if (!stat?.isFile() || stat.size < 41 || stat.size > 0xffffffff) return null;
    const header = readAt(file, 0, 41, detection);
    if (!header.subarray(0, 7).equals(MAGIC)) return null;
    const compressed = header[15], encrypted = header[16], totalCount = header.readUInt32LE(17),
      folderCount = header.readUInt32LE(21), fileCount = header.readUInt32LE(25), indexBytes = header.readUInt32LE(37);
    if (compressed > 1 || encrypted > 1 || !totalCount || totalCount > LIMITS.entries ||
        folderCount + fileCount !== totalCount || indexBytes < totalCount * 22 || indexBytes > LIMITS.indexBytes || 41 + indexBytes > stat.size) return null;
    const table = readAt(file, 41, indexBytes, detection), entries = [], names = new Set();
    // Lamento uses a different transform only for encrypted archives. A known
    // encryption profile is required before decoding that family for launch.
    const key = Math.imul(header.readInt32LE(7), header.readInt32LE(11)) >>> 0;
    const keySum = (key >>> 24) + ((key >>> 16) & 255) + ((key >>> 8) & 255) + (key & 255);
    let cursor = 0, directories = 0;
    for (let i = 0; i < totalCount; i++) {
      if (cursor + 4 > table.length) return null;
      const length = table.readUInt32LE(cursor); cursor += 4;
      if (!length || length > LIMITS.nameBytes || cursor + length + 17 > table.length) return null;
      const encoded = table.subarray(cursor, cursor + length), plain = Buffer.alloc(length);
      const fileSum = (i >>> 24) + ((i >>> 16) & 255) + ((i >>> 8) & 255) + (i & 255);
      for (let character = 0; character < length; character++) plain[character] = (encoded[character] + 0xfc * character - keySum - fileSum) & 255;
      const name = safeName(decode(plain)); cursor += length;
      const type = table[cursor], fileId = table.readUInt32LE(cursor + 1), relativeOffset = table.readUInt32LE(cursor + 5),
        packedSize = table.readUInt32LE(cursor + 9), size = table.readUInt32LE(cursor + 13); cursor += 17;
      if (!name || names.has(name.toLowerCase()) || ![1, 2].includes(type)) return null;
      names.add(name.toLowerCase());
      if (type === 1) { if (packedSize || size) return null; directories++; }
      else if (!size || !packedSize || (!compressed && packedSize !== size) || relativeOffset > stat.size - 41 - indexBytes || packedSize > stat.size - 41 - indexBytes - relativeOffset) return null;
      entries.push({ name, type: type === 1 ? "directory" : "file", fileId, offset: 41 + indexBytes + relativeOffset, packedSize, size });
    }
    if (cursor !== table.length || directories !== folderCount) return null;
    return { path: file, format: "NPA v1", archiveVersion: 1, bytes: stat.size, indexBytes, compressed: Boolean(compressed),
      encrypted: Boolean(encrypted), totalCount, folderCount, fileCount, entries };
  } catch (error) { if (error.code === "DETECTION_LIMIT") throw error; return null; }
}

function readEntry(archive, entry, { maximum = LIMITS.entryBytes, detection } = {}) {
  if (!archive?.entries?.includes(entry) || entry.type !== "file" || entry.size > maximum || entry.packedSize > maximum) throw new Error("NPA entry exceeds the selected read limit.");
  if (archive.encrypted) throw new Error("This NPA payload requires an independently identified encryption profile.");
  const packed = readAt(archive.path, entry.offset, entry.packedSize, detection);
  const bytes = archive.compressed ? zlib.inflateSync(packed, { maxOutputLength: maximum }) : packed;
  if (bytes.length !== entry.size) throw new Error("NPA entry size differs from its directory.");
  return bytes;
}

function configuration(text) {
  const result = {}; let section = "";
  for (const raw of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = raw.trim(); if (!line || /^[;#]/.test(line)) continue;
    const heading = /^\[([^\]]+)\]$/.exec(line);
    if (heading) { section = heading[1]; result[section] ||= {}; continue; }
    const field = /^([^=]+)=(.*)$/.exec(line);
    if (field && section) result[section][field[1].trim().toLowerCase()] = field[2].trim();
  }
  return result;
}

function localFiles(root, detection) {
  const entries = detection?.readdir ? detection.readdir(root) : fs.readdirSync(root, { withFileTypes: true });
  const realRoot = fs.realpathSync(root), files = new Map();
  for (const item of entries) {
    if (!item.isFile() || item.isSymbolicLink()) continue;
    const file = path.join(root, item.name);
    if (!fs.realpathSync(file).startsWith(realRoot + path.sep)) continue;
    const lower = item.name.toLowerCase();
    if (files.has(lower)) throw new Error("Ambiguous case-insensitive Nitroplus filenames.");
    files.set(lower, file);
  }
  return files;
}

function inspectGame(root, { inputPath, detection, includeEntries = false } = {}) {
  try {
    const files = localFiles(root, detection), scriptPath = files.get("nss.npa"), systemPath = files.get("system.npa");
    if (!scriptPath) return null;
    const scriptArchive = inspectArchive(scriptPath, { detection });
    if (!scriptArchive || !scriptArchive.entries.some(entry => entry.type === "file" && /\.nss$/i.test(entry.name))) return null;
    const archives = [scriptArchive], invalidArchives = [], systemArchive = systemPath && inspectArchive(systemPath, { detection });
    let config = {};
    const systemEntry = systemArchive?.entries.find(entry => entry.name.toLowerCase() === "system.ini");
    if (systemArchive && !systemArchive.encrypted && systemEntry) config = configuration(decode(readEntry(systemArchive, systemEntry, { maximum: LIMITS.configBytes, detection })));
    const looseConfig = files.get("system.ini");
    if (looseConfig && (detection?.stat ? detection.stat(looseConfig) : fs.statSync(looseConfig)).size <= LIMITS.configBytes) {
      const size = (detection?.stat ? detection.stat(looseConfig) : fs.statSync(looseConfig)).size;
      config = configuration(decode(readAt(looseConfig, 0, size, detection)));
    }
    const declaredBoot = config["スクリプト"]?.start || config.script?.start || "nss/boot.nss";
    const boot = safeName(declaredBoot);
    if (!boot || !/\.nss$/i.test(boot)) return null;
    const bootEntry = scriptArchive.entries.find(entry => entry.name.toLowerCase() === boot.replace(/^nss\//i, "").toLowerCase());
    if (!bootEntry) return null;
    let bootText = null;
    if (!scriptArchive.encrypted && bootEntry.size <= LIMITS.bootBytes) bootText = decode(readEntry(scriptArchive, bootEntry, { maximum: LIMITS.bootBytes, detection }));
    if (bootText && !/\bchapter\s+main\b/.test(bootText)) return null;
    for (const [name, file] of files) {
      if (!name.endsWith(".npa") || file === scriptPath) continue;
      if (archives.length >= LIMITS.archives) throw new Error("Too many Nitroplus archives.");
      const archive = file === systemPath ? systemArchive : inspectArchive(file, { detection });
      if (archive) archives.push(archive); else invalidArchives.push(path.basename(file));
    }
    const runners = [...files].filter(([name]) => name.endsWith(".exe")).sort(([a, ap], [b, bp]) => Number(bp === inputPath) - Number(ap === inputPath) || a.localeCompare(b)).slice(0, 8);
    let originalRunner = null, originalRunnerPath = null;
    for (const [, file] of runners) {
      const version = readPeVersion(file, { detection });
      if (!version || !/Nitroplus|5pb|MAGES/i.test([version.strings.CompanyName, version.strings.FileDescription, version.strings.ProductName].join(" "))) continue;
      originalRunner = version; originalRunnerPath = file; break;
    }
    const compressedMediaArchives = archives.filter(archive => archive.compressed && archive.entries.some(entry => /\.(?:ogg|wav|mp3|wma|mp4|mpg|mpeg|avi|wmv)$/i.test(entry.name))).map(archive => path.basename(archive.path));
    const supported = archives.every(archive => !archive.encrypted) && Boolean(bootText) && !invalidArchives.length && !compressedMediaArchives.length;
    const scriptVersion = bootText && /(?:^|\n)\s*#SCRIPT_VERSION\s*=\s*"([\d.]+)"\s*;/.exec(bootText)?.[1] || null;
    const product = config["プロダクト"] || config.product || {}, window = config["ウィンドウ"] || config.window || {};
    return { title: window.title || product.name || originalRunner?.strings.ProductName || path.basename(root),
      scriptArchivePath: scriptPath, systemArchivePath: systemPath || null, configPath: looseConfig || null,
      originalRunner, originalRunnerPath, archiveVersion: 1, scriptFormat: "NSS source", scriptVersion,
      scriptVersionSource: scriptVersion ? "nss.npa/boot.nss!#SCRIPT_VERSION" : null,
      productVersion: product.version || null, productVersionSource: product.version ? (looseConfig ? "system.ini" : "system.npa/system.ini") + "![プロダクト].version" : null,
      detectedVersion: null, detectedVersionSource: null, bootScript: boot, bootValidated: Boolean(bootText), invalidArchives, compressedMediaArchives,
      width: /^\d+$/.test(window.width || "") ? Math.max(320, Math.min(3840, Number(window.width))) : 800,
      height: /^\d+$/.test(window.height || "") ? Math.max(240, Math.min(2160, Number(window.height))) : 600,
      supported, compatibility: supported ? "NPA v1 / NSS interpreter candidate; playtesting is required." : invalidArchives.length
        ? `NPA archive validation failed: ${invalidArchives.join(", ")}.` : compressedMediaArchives.length
          ? `Compressed NPA audio/movie streaming is not supported by this native profile: ${compressedMediaArchives.join(", ")}.`
          : "This NPA encryption format is unsupported.",
      archives: archives.map(archive => includeEntries ? archive : { ...archive, entries: undefined }), scriptCount: scriptArchive.entries.filter(entry => /\.nss$/i.test(entry.name)).length,
      configuration: config };
  } catch (error) { if (error.code === "DETECTION_LIMIT") throw error; return null; }
}

module.exports = { LIMITS, MAGIC, decode, safeName, inspectArchive, readEntry, configuration, inspectGame };
