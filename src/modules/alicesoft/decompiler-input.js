const fs = require("node:fs");
const path = require("node:path");
const Native = require("../shared/runtime/local-native");
const { inspectRoot } = require("./detect");

const LIMITS = Object.freeze({ files: 32, fileBytes: 128 * 1024 ** 2, bytes: 256 * 1024 ** 2, entries: 4096 });

function validateDri(bytes, filename) {
  if (bytes.length < 256) throw new Error("Truncated DRI scenario archive.");
  const start = (bytes.readUInt16LE(0) - 1) * 256, end = (bytes.readUInt16LE(2) - 1) * 256;
  if (start < 256 || end <= start || end > bytes.length || (end - start) / 2 > LIMITS.entries) throw new Error("Invalid DRI scenario table bounds.");
  const volume = filename.match(/^([A-Z])DISK\.DAT$/i)?.[1]?.toUpperCase().charCodeAt(0) - 64;
  let entries = 0;
  for (let offset = start; offset + 2 <= end; offset += 2) {
    if (bytes[offset] !== volume) continue;
    const index = bytes[offset + 1];
    if (index < 1 || (index + 2) * 2 > start) throw new Error("DRI scenario pointer escapes its table.");
    const a = (bytes.readUInt16LE(index * 2) - 1) * 256, b = (bytes.readUInt16LE((index + 1) * 2) - 1) * 256;
    if (a < end || b <= a || b > bytes.length) throw new Error("DRI scenario range escapes its archive.");
    entries++;
  }
  if (!entries) throw new Error("DRI archive contains no scenario pages for its volume.");
  return entries;
}

function validateAld(bytes, filename) {
  if (bytes.length < 528 || bytes.length % 256 !== 16 || ![0x14c4e, 0x12020].includes(bytes.readUInt32LE(bytes.length - 16))) throw new Error("Invalid ALD scenario footer.");
  const start = bytes.readUIntLE(0, 3) * 256, end = bytes.readUIntLE(3, 3) * 256;
  if (start < 256 || end <= start || end > bytes.length - 16 || Math.floor((end - start) / 3) > LIMITS.entries) throw new Error("Invalid ALD scenario table bounds.");
  const volume = filename.at(-5).toUpperCase().charCodeAt(0) - 64;
  let entries = 0;
  for (let offset = start; offset + 3 <= end; offset += 3) {
    if (bytes[offset] !== volume) continue;
    const index = bytes.readUInt16LE(offset + 1);
    if (index < 1 || index * 3 + 3 > start) throw new Error("ALD scenario pointer escapes its table.");
    const entry = bytes.readUIntLE(index * 3, 3) * 256;
    if (entry < end || entry > bytes.length - 32) throw new Error("ALD scenario header escapes its archive.");
    const header = bytes.readUInt32LE(entry), size = bytes.readUInt32LE(entry + 4);
    if (header < 18 || header > 4096 || size < 18 || entry + header + size > bytes.length - 16 ||
        bytes.indexOf(0, entry + 16) >= entry + header || bytes.indexOf(0, entry + 16) < 0) throw new Error("Invalid ALD scenario payload bounds.");
    const data = entry + header, signature = bytes.subarray(data, data + 4).toString("ascii");
    if (!["S350", "S351", "153S", "S360", "S380"].includes(signature)) throw new Error("Unsupported System3.x scenario generation.");
    const scriptHeader = bytes.readUInt32LE(data + 4), declared = bytes.readUInt32LE(data + 8), nameLength = bytes.readUInt16LE(data + 16);
    if (declared !== size || scriptHeader < 18 + nameLength || scriptHeader > size) throw new Error("Invalid System3.x compiled scenario header.");
    entries++;
  }
  if (!entries) throw new Error("ALD archive contains no scenario pages for its volume.");
  return entries;
}

function validateAin(bytes) {
  if (bytes.length < 12 || !["AINI", "AIN2"].includes(bytes.subarray(0, 4).toString("ascii")) || ![1, 2].includes(bytes.readUInt32LE(4))) throw new Error("Unsupported System39 AIN metadata.");
  const data = Buffer.from(bytes);
  for (let index = 8; index < data.length; index++) data[index] = (data[index] << 2 | data[index] >> 6) & 255;
  let offset = 8;
  const need = count => { if (offset > data.length - count) throw new Error("Truncated System39 AIN metadata."); };
  const number = maximum => { need(4); const value = data.readUInt32LE(offset); offset += 4; if (value > maximum) throw new Error("System39 AIN count exceeds its limit."); return value; };
  const string = () => { const end = data.indexOf(0, offset); if (end < 0 || end - offset > 65536) throw new Error("Invalid System39 AIN string."); const value = data.subarray(offset, end); offset = end + 1; return value; };
  const names = new Set();
  while (offset < data.length) {
    need(8); const tag = data.subarray(offset, offset + 4).toString("ascii"); offset += 8;
    const count = number(tag === "HEL0" ? 1024 : 65536);
    for (let index = 0; index < count; index++) {
      const name = string();
      if (tag === "HEL0") {
        // Upstream emits a .HEL filename from this key. Sequential ADV names
        // protect scenario exports; validate these independent library names.
        const value = name.toString("ascii");
        if (name.some(byte => byte > 127) || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,79}$/.test(value) || value.includes("..") || names.has(value.toLowerCase())) throw new Error("Unsafe or duplicated System39 library output name.");
        names.add(value.toLowerCase());
        const functions = number(65536);
        for (let fn = 0; fn < functions; fn++) { string(); const argumentsCount = number(4096); need(argumentsCount * 4); offset += argumentsCount * 4; }
      } else if (tag === "FUNC") { need(6); offset += 6; }
      else if (!["VARI", "MSGI"].includes(tag)) throw new Error("Unsupported System39 AIN section.");
    }
    if (!["HEL0", "FUNC", "VARI", "MSGI"].includes(tag)) throw new Error("Unsupported System39 AIN section.");
  }
  return names.size;
}

function inspectInputs(entry, context = {}) {
  const rootDir = fs.realpathSync(entry.contentRootDir), detected = inspectRoot(rootDir);
  if (!detected || detected.generation !== entry.moduleData?.generation || !["system3", "system35"].includes(detected.generation)) throw new Error("Decompile supports matching original System1–3 or System3.x scenario data.");
  const names = fs.readdirSync(rootDir);
  if (names.length > 20000) throw new Error("Too many game files for scenario decompilation.");
  const stem = detected.generation === "system35" ? path.basename(detected.scenarioPath).slice(0, -5).toLowerCase() : null;
  const gameId = detected.generation === "system3" ? context.runtimeSettings?.gameId || detected.detectedGameId || null : null;
  const selected = names.filter(name => detected.generation === "system3"
    ? /^[A-Z]DISK\.DAT$/i.test(name) && (gameId !== "rance2" || !/^GDISK/i.test(name)) || (gameId === "rance2_hint" ? /^GG00\.DAT$/i : /^(AG00\.DAT|AO00\.ASC)$/i).test(name)
    : name.slice(0, -5).toLowerCase() === stem && /^S[A-Z]\.ALD$/i.test(name.slice(-6)) || /^System39\.ain$/i.test(name)).sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  if (!selected.length || selected.length > LIMITS.files) throw new Error("Scenario input count exceeds its limit.");
  let total = 0, pages = 0;
  const files = selected.map(name => {
    const file = path.join(rootDir, name), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > LIMITS.fileBytes || (total += stat.size) > LIMITS.bytes) throw new Error("Scenario inputs must be bounded regular original files.");
    const bytes = fs.readFileSync(file);
    if (/DISK\.DAT$/i.test(name)) pages += validateDri(bytes, name);
    else if (/\.ALD$/i.test(name)) pages += validateAld(bytes, name);
    else if (/\.ain$/i.test(name)) validateAin(bytes);
    return { file, bytes: stat.size, sha256: Native.hashFile(file) };
  });
  if (!pages || pages > LIMITS.entries) throw new Error("Scenario page count exceeds its limit.");
  if (gameId && !/^[a-z0-9_]{1,80}$/.test(gameId)) throw new Error("Invalid upstream System1–3 game ID.");
  return { generation: detected.generation, detectedVersion: detected.detectedVersion, gameId, pages, files, rootDir };
}

module.exports = { LIMITS, validateDri, validateAld, validateAin, inspectInputs };
