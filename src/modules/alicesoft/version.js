const fs = require("node:fs");
const path = require("node:path");
const identifiers = require("./resources/system3-identifiers.json").entries;
const SCENARIO_VERSIONS = Object.freeze({ S350: "3.5", S351: "3.5", "153S": "3.5", S360: "3.6", S380: "3.8" });

function readAt(filePath, size, offset = 0) {
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
    const data = Buffer.alloc(size);
    return fs.readSync(fd, data, 0, size, offset) === size ? data : null;
  } catch { return null; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function identifySystem3(crcA, crcB, declaredId) {
  const declared = declaredId && identifiers.find(item => item.id === declaredId);
  if (declared) return { detectedVersion: String(declared.generation), detectedMajor: declared.generation,
    detectedVersionSource: "system3.ini explicit game ID", detectedVersionConfidence: "declared", detectedGameId: declared.id };
  const matched = identifiers.find(item => item.crcA && item.crcA === crcA && (!item.crcB || item.crcB === crcB));
  if (matched) return { detectedVersion: String(matched.generation), detectedMajor: matched.generation,
    detectedVersionSource: "ADISK/BDISK first 256-byte CRC32 matched pinned upstream game table", detectedVersionConfidence: "high", detectedGameId: matched.id };
  return { detectedVersion: "unknown (System 1–3)", detectedMajor: null,
    detectedVersionSource: "DRI scenario archive; no recognized game fingerprint", detectedVersionConfidence: "unknown", detectedGameId: null };
}

function detectSystem3Version(rootDir, files, scenarioPath) {
  const config = files.find(name => /^system3\.ini$/i.test(name));
  let declaredId;
  if (config) {
    try {
      const filePath = path.join(rootDir, config);
      if (fs.statSync(filePath).size <= 64 * 1024) {
        let section = "";
        for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
          const nextSection = line.match(/^\s*\[([^\]]+)\]/)?.[1];
          if (nextSection) { section = nextSection.toLowerCase(); continue; }
          if (section !== "config") continue;
          const id = line.match(/^\s*game\s*=\s*([a-z0-9_]+)\s*(?:[;#].*)?$/i)?.[1];
          if (id) declaredId = id.toLowerCase();
        }
      }
    } catch {}
  }
  const a = readAt(scenarioPath, 256);
  const bName = files.find(name => /^BDISK\.DAT$/i.test(name));
  const b = bName ? readAt(path.join(rootDir, bName), 256) : null;
  return { ...identifySystem3(a ? crc32(a) : 0, b ? crc32(b) : 0, declaredId), scenarioHeaderCrc32: a ? crc32(a).toString(16).padStart(8, "0") : null };
}

function readAldScenarioTag(filePath) {
  const header = readAt(filePath, 6);
  if (!header) return null;
  const offsetsSize = header.readUIntLE(0, 3) * 256;
  const linksEnd = header.readUIntLE(3, 3) * 256;
  if (!offsetsSize || linksEnd <= offsetsSize) return null;
  const links = readAt(filePath, Math.min(linksEnd - offsetsSize, 256), offsetsSize);
  if (!links) return null;
  let fileSize;
  try { fileSize = fs.statSync(filePath).size; } catch { return null; }
  for (let cursor = 0; cursor + 3 <= links.length; cursor += 3) {
    if (links[cursor] !== 1) continue;
    const tableOffset = links.readUInt16LE(cursor + 1) * 3;
    if (tableOffset > offsetsSize - 3) continue;
    const entryPointer = readAt(filePath, 3, tableOffset);
    if (!entryPointer) continue;
    const entryOffset = entryPointer.readUIntLE(0, 3) * 256;
    if (entryOffset < linksEnd || entryOffset > fileSize - 8) continue;
    const entry = readAt(filePath, 8, entryOffset);
    if (!entry) continue;
    const payloadOffset = entry.readUInt32LE(0);
    const payloadSize = entry.readUInt32LE(4);
    if (payloadOffset < 16 || payloadSize < 4 || payloadOffset > fileSize - entryOffset - payloadSize) continue;
    const signature = readAt(filePath, 4, entryOffset + payloadOffset)?.toString("ascii");
    if (Object.hasOwn(SCENARIO_VERSIONS, signature || "")) return signature;
  }
  return null;
}

function detectSystem35Version(rootDir, files, scenarioPath) {
  const tag = readAldScenarioTag(scenarioPath);
  const ainName = files.find(name => /^System39\.ain$/i.test(name));
  const ain = ainName ? readAt(path.join(rootDir, ainName), 8) : null;
  const ain39 = ain && ["AINI", "AIN2"].includes(ain.subarray(0, 4).toString("ascii")) && [1, 2].includes(ain.readUInt32LE(4));
  if (ain39 && tag) return { detectedVersion: "3.9", detectedMajor: 3, detectedMinor: 9, scenarioFormat: tag,
    detectedVersionSource: "System39.ain AIN header and ALD scenario tag", detectedVersionConfidence: "high" };
  if (tag) return { detectedVersion: `${SCENARIO_VERSIONS[tag]}–3.9`, detectedMajor: 3, scenarioFormat: tag,
    detectedVersionSource: `ALD scenario header ${tag}; format tag does not establish the exact engine revision`, detectedVersionConfidence: "family" };
  return { detectedVersion: "unknown (System 3.5–3.9)", detectedMajor: 3, scenarioFormat: null,
    detectedVersionSource: "ALD archive tables; scenario version tag unavailable", detectedVersionConfidence: "unknown" };
}

module.exports = { detectSystem3Version, detectSystem35Version, readAldScenarioTag, identifySystem3, crc32 };
