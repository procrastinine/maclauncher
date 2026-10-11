const fs = require("node:fs");
const crypto = require("node:crypto");
const { detectStudioVersion } = require("./version");
const { inspectSpriteSequences } = require("./sequence-layout");

const LIMITS = Object.freeze({ fileBytes: 2 * 1024 ** 3, chunks: 256, entries: 250000, stringBytes: 65536, names: 2000, nameBytes: 4 * 1024 * 1024 });
const COUNTED = new Set(["SPRT", "BGND", "SOND", "PATH", "SCPT", "SHDR", "FONT", "TMLN", "OBJT", "ROOM", "EXTN", "TXTR", "AUDO", "SEQN", "AGRP"]);

function openReader(filePath, limits = LIMITS) {
  const fd = fs.openSync(filePath, "r");
  const stat = fs.fstatSync(fd);
  if (!stat.isFile() || stat.size < 8 || stat.size > limits.fileBytes) {
    fs.closeSync(fd);
    throw new Error("GameMaker data is empty, too large, or not a regular file.");
  }
  return {
    fd, stat,
    read(offset, size) {
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0 || offset > stat.size - size) {
        throw new Error("GameMaker data contains an out-of-bounds offset.");
      }
      const data = Buffer.alloc(size);
      if (fs.readSync(fd, data, 0, size, offset) !== size) throw new Error("GameMaker data changed or is truncated.");
      return data;
    },
    close() { fs.closeSync(fd); }
  };
}

function hashFile(filePath) {
  const fd = fs.openSync(filePath, "r");
  try {
    const hash = crypto.createHash("sha256");
    const block = Buffer.alloc(1024 * 1024);
    let count;
    while ((count = fs.readSync(fd, block, 0, block.length, null)) > 0) hash.update(block.subarray(0, count));
    return hash.digest("hex");
  } finally { fs.closeSync(fd); }
}

// Read only format metadata. Never evaluate GML, load a DLL, or execute the imported PE.
function inspectStudio(filePath, { includeNames = false, limits = LIMITS } = {}) {
  const reader = openReader(filePath, limits);
  try {
    const header = reader.read(0, 8);
    if (header.toString("ascii", 0, 4) !== "FORM") throw new Error("Not a GameMaker Studio FORM container.");
    const containerEnd = header.readUInt32LE(4) + 8;
    if (containerEnd < 8 || containerEnd > reader.stat.size) throw new Error("Truncated GameMaker FORM container.");
    const chunks = [];
    const byId = new Map();
    let offset = 8;
    while (offset < containerEnd) {
      if (chunks.length >= limits.chunks || containerEnd - offset < 8) throw new Error("Invalid GameMaker chunk table.");
      const data = reader.read(offset, 8);
      const id = data.toString("ascii", 0, 4);
      const size = data.readUInt32LE(4);
      if (!/^[A-Z0-9_]{4}$/.test(id) || size > containerEnd - offset - 8 || byId.has(id)) {
        throw new Error("Invalid, duplicate, or truncated GameMaker chunk.");
      }
      const chunk = { id, offset, dataOffset: offset + 8, size };
      chunks.push(chunk);
      byId.set(id, chunk);
      offset += 8 + size;
    }
    const gen8 = byId.get("GEN8");
    if (!gen8 || gen8.size < 76 || !byId.has("STRG")) throw new Error("FORM container lacks GameMaker metadata.");
    const gen = reader.read(gen8.dataOffset, Math.min(gen8.size, 128));
    const wadVersion = gen[1];
    const compact = wadVersion <= 8 && gen8.size < 108;
    const rawVersion = compact ? "1.0.0.198" : [44, 48, 52, 56].map(index => gen.readUInt32LE(index)).join(".");
    const strg = byId.get("STRG");
    if (strg.size < 4) throw new Error("Invalid STRG resource table.");
    const stringCount = reader.read(strg.dataOffset, 4).readUInt32LE(0);
    if (stringCount > limits.entries || stringCount * 4 > strg.size - 4) throw new Error("Invalid STRG resource table.");
    let totalNameBytes = 0;
    function readString(pointer) {
      if (!pointer) return null;
      if (pointer < strg.dataOffset + 4 || pointer > strg.dataOffset + strg.size - 1) throw new Error("GameMaker string pointer is outside STRG.");
      const length = reader.read(pointer - 4, 4).readUInt32LE(0);
      if (length > limits.stringBytes || length + 1 > strg.dataOffset + strg.size - pointer) throw new Error("GameMaker string is too large or truncated.");
      const bytes = reader.read(pointer, length + 1);
      if (bytes[length] !== 0) throw new Error("GameMaker string lacks its terminator.");
      totalNameBytes += length;
      if (totalNameBytes > limits.nameBytes) throw new Error("GameMaker metadata names exceed the inspection limit.");
      return bytes.subarray(0, length).toString("utf8");
    }
    const name = compact ? null : readString(gen.readUInt32LE(40));
    const displayName = !compact && wadVersion >= 10 && gen8.size >= 104 ? readString(gen.readUInt32LE(100)) : null;
    const steamEnabled = !compact && gen8.size >= 124 ? Boolean(gen.readUInt32LE(68) & 0x1000) : null;
    const steamAppId = !compact && gen8.size >= 124 ? gen.readInt32LE(120) : null;
    // GEN8 has two independent subsystem declarations. Older exports may omit
    // InfoFlags.SteamEnabled while FunctionClassifications.Steam still makes
    // the native runner initialize Steam. UMT's pinned serializer places this
    // uint64 at112 and defines Steam as0x2000000000000000; preserve both facts.
    const functionClassifications = !compact && gen8.size >= 124 ? gen.readBigUInt64LE(112) : null;
    const steamFunctions = functionClassifications == null ? null : Boolean(functionClassifications & 0x2000000000000000n);
    const steamRequired = steamEnabled === true || steamFunctions === true;
    const inventory = {};
    for (const chunk of chunks) {
      if (!COUNTED.has(chunk.id) || chunk.size < 4) continue;
      const count = reader.read(chunk.dataOffset, 4).readUInt32LE(0);
      if (count > limits.entries || count * 4 > chunk.size - 4) throw new Error(`Invalid ${chunk.id} resource table.`);
      inventory[chunk.id] = count;
    }
    let audioGroupLayout = "absent";
    const audio = byId.get("AGRP");
    if (audio) {
      const count = inventory.AGRP;
      if (count === undefined || count > 4096) throw new Error("Invalid or oversized GameMaker audio-group table.");
      audioGroupLayout = count ? "name-and-path" : "empty";
      const pointers = reader.read(audio.dataOffset + 4, count * 4);
      for (let index = 0; index < count; index++) {
        const pointer = pointers.readUInt32LE(index * 4), end = index + 1 < count ? pointers.readUInt32LE((index + 1) * 4) : audio.dataOffset + audio.size;
        if (pointer < audio.dataOffset + 4 + count * 4 || end < pointer + 4 || end > audio.dataOffset + audio.size) throw new Error("GameMaker audio-group entry is outside AGRP.");
        readString(reader.read(pointer, 4).readUInt32LE(0));
        const pathPointer = end >= pointer + 8 ? reader.read(pointer + 4, 4).readUInt32LE(0) : 0;
        if (!pathPointer) audioGroupLayout = "legacy-name-only-or-null-path";
        else readString(pathPointer);
      }
    }
    const code = byId.get("CODE");
    const codeEntries = [];
    let codeCount = 0;
    let codeBytes = 0;
    if (code && code.size > 0) {
      if (code.size < 4) throw new Error("Invalid GameMaker CODE table.");
      codeCount = reader.read(code.dataOffset, 4).readUInt32LE(0);
      if (codeCount > limits.entries || codeCount * 4 > code.size - 4) throw new Error("Invalid GameMaker CODE table.");
      const pointers = reader.read(code.dataOffset + 4, codeCount * 4);
      for (let i = 0; i < codeCount; i += 1) {
        const pointer = pointers.readUInt32LE(i * 4);
        if (pointer === 0) continue;
        const entryBytes = wadVersion <= 14 ? 8 : 20;
        if (pointer < code.dataOffset + 4 + codeCount * 4 || pointer > code.dataOffset + code.size - entryBytes) {
          throw new Error("GameMaker code entry is outside CODE.");
        }
        const entry = reader.read(pointer, entryBytes);
        const length = entry.readUInt32LE(4);
        const bytecodeOffset = wadVersion <= 14 ? pointer + 8 : pointer + 12 + entry.readInt32LE(12);
        if (length % 4 || bytecodeOffset < code.dataOffset || bytecodeOffset > code.dataOffset + code.size - length) {
          throw new Error("GameMaker bytecode is outside CODE or misaligned.");
        }
        codeBytes += length;
        if (includeNames && codeEntries.length < limits.names) {
          codeEntries.push({ index: i, name: readString(entry.readUInt32LE(0)), bytecodeOffset, length });
        }
      }
    }
    const hasBytecode = codeCount > 0 && codeBytes > 0;
    const executionKind = hasBytecode ? "studio-vm" : "native-or-no-code";
    const reasons = [];
    if (!hasBytecode) reasons.push("No nonempty VM code was found; YYC/native packages require their own macOS build.");
    if (wadVersion < 8 || wadVersion > 17) reasons.push(`WAD ${wadVersion} is outside the pinned Butterscotch 8–17 range.`);
    if (inventory.EXTN > 0) reasons.push("Windows extensions may require additional native support.");
    const isCandidate = hasBytecode && wadVersion >= 8 && wadVersion <= 17 && !(inventory.EXTN > 0);
    const spriteSequences = inspectSpriteSequences({ reader, spriteChunk: byId.get("SPRT"), stringChunk: strg,
      spriteCount: inventory.SPRT || 0, rawVersion });
    const versionInfo = detectStudioVersion({ wadVersion, rawVersion, gen8Offset: gen8.dataOffset, chunks, compact, audioGroupLayout, spriteSequences });
    return {
      format: "gamemaker-studio-form", executionKind, wadVersion, rawVersion,
      ...versionInfo,
      // Later GMS2 versions retain old GEN8 version numbers. Do not call this a resolved runtime version.
      rawVersionReliable: !compact && Number(rawVersion.split(".")[0]) < 2 && rawVersion !== "1.0.0.9999",
      name, displayName, steamEnabled, steamAppId, steamFunctions, steamRequired,
      functionClassifications: functionClassifications == null ? null : `0x${functionClassifications.toString(16).padStart(16, "0")}`,
      fileBytes: reader.stat.size, containerBytes: containerEnd,
      trailingBytes: reader.stat.size - containerEnd, chunks, inventory, audioGroupLayout,
      spriteSequenceLayout: spriteSequences.layout, spriteSequenceInspection: spriteSequences, stringCount, codeCount, codeBytes,
      ...(includeNames ? { codeEntries, namesTruncated: codeCount > limits.names } : {}),
      butterscotchCandidate: isCandidate, compatibility: "unverified", reasons
    };
  } finally { reader.close(); }
}

// Conservative Classic identification. Protected/UPX/GM7 executables remain unknown.
// Newer GM8.1 executables retain the default encrypted data header while their
// runner loading sequence differs. This mirrors gm8exe's bounded header evidence
// and also validates the adjacent version and compressed-settings envelope.
function inspectClassic(filePath) {
  const reader = openReader(filePath);
  try {
    if (reader.stat.size < 0x40 || reader.read(0, 2).toString("ascii") !== "MZ") return null;
    const peOffset = reader.read(0x3c, 4).readUInt32LE(0);
    if (peOffset > reader.stat.size - 24 || !reader.read(peOffset, 6).equals(Buffer.from([0x50, 0x45, 0, 0, 0x4c, 1]))) return null;
    const candidates = [
      { version: "8.0", offset: 0xa49be, signature: Buffer.from([0x8b, 0x45, 0xf4, 0xe8, 0x2a, 0xbd, 0xfd, 0xff]), headerOffset: 0x144ac0 },
      { version: "8.1", offset: 0x226cf3, signature: Buffer.from([0xe8, 0x80, 0xf2, 0xdd, 0xff, 0xc7, 0x45, 0xf0]), headerOffset: 0x226cfb }
    ];
    for (const candidate of candidates) {
      if (reader.stat.size < candidate.headerOffset + 4 || reader.stat.size < candidate.offset + 8) continue;
      if (!reader.read(candidate.offset, 8).equals(candidate.signature)) continue;
      const assetOffset = reader.read(candidate.headerOffset, 4).readUInt32LE(0);
      if (assetOffset < candidate.headerOffset + 4 || assetOffset > reader.stat.size - 16) continue;
      return {
        format: "gamemaker-classic-pe", executionKind: "classic", classicVersion: candidate.version,
        detectedVersion: candidate.version, exactEngineVersion: candidate.version,
        detectedVersionSource: "standard Classic runner loading sequence", detectedVersionConfidence: "runner-signature",
        versionEvidence: [{ kind: "classic-runner-signature", offset: candidate.offset, value: candidate.version,
          meaning: "Identifies the standard GM8.0/8.1 runner; embedded assets have not yet been parsed." }],
        evidence: "standard-runner-signature", assetsVerified: false, fileBytes: reader.stat.size,
        assetOffset, compatibility: "beta-format-candidate", butterscotchCandidate: false,
        reasons: ["OpenGMK Classic beta; Windows extensions and game compatibility vary."]
      };
    }
    const headerStart = 3800004;
    if (reader.stat.size >= headerStart + 44) {
      const bytes = reader.read(headerStart, Math.min(4 * 1024 ** 2, reader.stat.size - headerStart));
      for (let offset = 0; offset <= bytes.length - 44; offset++) {
        const magic = ((bytes.readUInt32LE(offset) & 0xff00ff00) | (bytes.readUInt32LE(offset + 4) & 0x00ff00ff)) >>> 0;
        if (magic !== 0xf7140067 || bytes.readUInt32LE(offset + 32) !== 800) continue;
        const length = bytes.readUInt32LE(offset + 36), settingsOffset = headerStart + offset + 40;
        const zlib = bytes.readUInt16BE(offset + 40);
        if (length < 8 || length > reader.stat.size - settingsOffset || (zlib >>> 8 & 0x0f) !== 8 || zlib % 31) continue;
        return { format: "gamemaker-classic-pe", executionKind: "classic", classicVersion: "8.1",
          detectedVersion: "8.1", exactEngineVersion: null,
          detectedVersionSource: "default GM8.1 encrypted data header and settings envelope",
          detectedVersionConfidence: "format-header", versionEvidence: [{ kind: "classic-encrypted-data-header",
            offset: headerStart + offset, value: "8.1", meaning: "Default GM8.1 magic, version 800 and bounded zlib settings; full assets are checked on Play." }],
          evidence: "default-gm81-data-header", assetsVerified: false, fileBytes: reader.stat.size,
          assetOffset: headerStart + offset + 36, compatibility: "beta-format-candidate", butterscotchCandidate: false,
          reasons: ["OpenGMK Classic beta; Windows extensions and game compatibility vary."] };
      }
    }
    return null;
  } finally { reader.close(); }
}

module.exports = { LIMITS, inspectStudio, inspectClassic, hashFile };
