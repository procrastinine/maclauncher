const fs = require("node:fs");
const path = require("node:path");
const { parseAssetVersion } = require("./detect");

const GRAPHICS = Object.freeze({ 0: "OpenGL", 1: "Direct3D 9", 2: "Direct3D 11", 8: "OpenGL ES 2", 11: "OpenGL ES 3", 16: "Metal", 17: "OpenGL Core", 18: "Direct3D 12", 21: "Vulkan" });
const MAC_APIS = new Set([0, 16, 17]);
const LIMITS = Object.freeze({ metadata: 2 * 1024 * 1024, block: 2 * 1024 * 1024, blocks: 32768, members: 1024, member: 2 * 1024 * 1024, types: 4096, objects: 8192 });

function lz4Block(input, expected) {
  if (!Number.isSafeInteger(expected) || expected < 0 || expected > LIMITS.block || input.length > LIMITS.block) throw new Error("Unity LZ4 block exceeds its bounds.");
  const output = Buffer.alloc(expected); let source = 0, destination = 0;
  const length = base => {
    let result = base;
    if (base === 15) { let value; do { if (source >= input.length) throw new Error("Truncated Unity LZ4 length."); value = input[source++]; result += value; } while (value === 255); }
    return result;
  };
  while (source < input.length) {
    const token = input[source++], literals = length(token >>> 4);
    if (source + literals > input.length || destination + literals > output.length) throw new Error("Unity LZ4 literal escapes its block.");
    input.copy(output, destination, source, source + literals); source += literals; destination += literals;
    if (source === input.length) break;
    if (source + 2 > input.length) throw new Error("Truncated Unity LZ4 match offset.");
    const offset = input.readUInt16LE(source); source += 2;
    const matches = length(token & 15) + 4;
    if (!offset || offset > destination || destination + matches > output.length) throw new Error("Unity LZ4 match escapes its block.");
    for (let i = 0; i < matches; i++) output[destination + i] = output[destination + i - offset];
    destination += matches;
  }
  if (destination !== expected) throw new Error("Unity LZ4 decompressed size differs from its header.");
  return output;
}

function inflate(bytes, expected, flags) {
  if ((flags & 63) === 0) { if (bytes.length !== expected) throw new Error("Unity uncompressed block size differs from its header."); return bytes; }
  if ([2, 3].includes(flags & 63)) return lz4Block(bytes, expected);
  throw new Error("Unity graphics inspection does not support this archive compression.");
}

function fileReader(file, detection) {
  const stat = detection?.stat ? detection.stat(file) : fs.statSync(file);
  if (!stat?.isFile()) throw new Error("Unity data file was not found.");
  return { size: stat.size, read: (offset, length) => {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || length > LIMITS.metadata || offset + length > stat.size) throw new Error("Unity graphics read exceeds its bounds.");
    if (detection?.readBytes) { const bytes = detection.readBytes(file, offset, length); if (!bytes || bytes.length !== length) throw new Error("Truncated Unity data file."); return bytes; }
    const fd = fs.openSync(file, "r");
    try { const bytes = Buffer.alloc(length); if (fs.readSync(fd, bytes, 0, length, offset) !== length) throw new Error("Truncated Unity data file."); return bytes; }
    finally { fs.closeSync(fd); }
  } };
}

function archiveMember(reader, memberName) {
  const header = reader.read(0, Math.min(256, reader.size)), parsed = parseAssetVersion(header, reader.size);
  if (parsed?.format !== "UnityFS") throw new Error("Unity data is not a supported UnityFS archive.");
  const end = header.indexOf(0, parsed.versionOffset) + 1, compressedSize = header.readUInt32BE(end + 8), rawSize = header.readUInt32BE(end + 12), flags = header.readUInt32BE(end + 16);
  if (compressedSize > LIMITS.metadata || rawSize > LIMITS.metadata) throw new Error("Unity archive metadata exceeds its bounds.");
  let headerEnd = end + 20;
  if (parsed.formatVersion >= 7) headerEnd = Math.ceil(headerEnd / 16) * 16;
  const metadataOffset = flags & 128 ? reader.size - compressedSize : headerEnd;
  if (metadataOffset < headerEnd) throw new Error("Unity archive metadata overlaps its header.");
  const bytes = inflate(reader.read(metadataOffset, compressedSize), rawSize, flags);
  let cursor = 16;
  function take(length) { if (cursor + length > bytes.length) throw new Error("Truncated Unity archive metadata."); const result = bytes.subarray(cursor, cursor + length); cursor += length; return result; }
  const blockCount = take(4).readUInt32BE(0);
  if (blockCount > LIMITS.blocks) throw new Error("Unity archive block count exceeds its bound.");
  let compressedOffset = flags & 128 ? headerEnd : metadataOffset + compressedSize;
  if (flags & 512) compressedOffset = Math.ceil(compressedOffset / 16) * 16;
  let rawOffset = 0; const blocks = [];
  for (let i = 0; i < blockCount; i++) {
    const row = take(10), raw = row.readUInt32BE(0), compressed = row.readUInt32BE(4), compression = row.readUInt16BE(8);
    if (!raw || raw > LIMITS.block || !compressed || compressed > LIMITS.block || compressedOffset + compressed > (flags & 128 ? metadataOffset : reader.size)) throw new Error("Unity archive block bounds are invalid.");
    blocks.push({ rawOffset, compressedOffset, raw, compressed, compression }); rawOffset += raw; compressedOffset += compressed;
  }
  const count = take(4).readUInt32BE(0); if (count > LIMITS.members) throw new Error("Unity archive member count exceeds its bound.");
  const found = [];
  for (let i = 0; i < count; i++) {
    const row = take(20), offset = Number(row.readBigUInt64BE(0)), size = Number(row.readBigUInt64BE(8)), endName = bytes.indexOf(0, cursor);
    if (endName < cursor || endName - cursor > 4096 || !Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0 || offset + size > rawOffset) throw new Error("Unity archive member bounds are invalid.");
    const name = bytes.toString("utf8", cursor, endName); cursor = endName + 1;
    if (name === memberName) found.push({ name, offset, size });
  }
  if (found.length !== 1 || found[0].size > LIMITS.member) throw new Error("Unity archive does not contain one bounded global settings file.");
  const member = found[0], output = Buffer.alloc(member.size);
  for (const block of blocks) {
    const start = Math.max(member.offset, block.rawOffset), stop = Math.min(member.offset + member.size, block.rawOffset + block.raw);
    if (stop <= start) continue;
    const data = inflate(reader.read(block.compressedOffset, block.compressed), block.raw, block.compression);
    data.copy(output, start - member.offset, start - block.rawOffset, stop - block.rawOffset);
  }
  return output;
}

function serializedObjects(bytes) {
  const header = parseAssetVersion(bytes.subarray(0, 256), bytes.length);
  if (header?.format !== "SerializedFile" || header.formatVersion < 13 || header.formatVersion > 22) throw new Error("Unity graphics settings use an unsupported serialized format.");
  const format = header.formatVersion, little = bytes[16] === 0, read32 = offset => little ? bytes.readInt32LE(offset) : bytes.readInt32BE(offset), read16 = offset => little ? bytes.readUInt16LE(offset) : bytes.readUInt16BE(offset);
  const read64 = offset => Number(little ? bytes.readBigUInt64LE(offset) : bytes.readBigUInt64BE(offset));
  const dataOffset = format >= 22 ? Number(bytes.readBigUInt64BE(32)) : bytes.readUInt32BE(12);
  let cursor = bytes.indexOf(0, header.versionOffset) + 1;
  const targetPlatform = read32(cursor); cursor += 4; const typeTree = Boolean(bytes[cursor++]), typeCount = read32(cursor); cursor += 4;
  function skip(length) { if (!Number.isSafeInteger(length) || length < 0 || cursor + length > dataOffset) throw new Error("Unity serialized metadata exceeds its bounds."); cursor += length; }
  if (typeCount < 0 || typeCount > LIMITS.types) throw new Error("Unity serialized type count exceeds its bound.");
  const types = [];
  for (let i = 0; i < typeCount; i++) {
    const classId = read32(cursor); skip(4); if (format >= 16) skip(1); if (format >= 17) skip(2);
    if ((format < 16 && classId < 0) || (format >= 16 && classId === 114)) skip(16); skip(16);
    if (typeTree) {
      const nodes = read32(cursor), strings = read32(cursor + 4); skip(8);
      if (nodes < 0 || nodes > 100000 || strings < 0 || strings > LIMITS.metadata) throw new Error("Unity type-tree bounds are invalid.");
      skip(nodes * (format >= 19 ? 32 : 24) + strings);
      if (format >= 21) { const dependencies = read32(cursor); skip(4); if (dependencies < 0 || dependencies > LIMITS.types) throw new Error("Unity type dependencies exceed their bound."); skip(dependencies * 4); }
    }
    types.push(classId);
  }
  let bigIds = false; if (format < 14) { bigIds = read32(cursor) !== 0; skip(4); }
  const count = read32(cursor); skip(4); if (count < 0 || count > LIMITS.objects) throw new Error("Unity serialized object count exceeds its bound.");
  const objects = [];
  for (let i = 0; i < count; i++) {
    if (format >= 14) cursor = Math.ceil(cursor / 4) * 4;
    skip(bigIds || format >= 14 ? 8 : 4);
    const relative = format >= 22 ? read64(cursor) : (little ? bytes.readUInt32LE(cursor) : bytes.readUInt32BE(cursor)); skip(format >= 22 ? 8 : 4);
    const size = little ? bytes.readUInt32LE(cursor) : bytes.readUInt32BE(cursor); skip(4);
    const typeId = read32(cursor); skip(4); const classId = format < 16 ? read16(cursor) : types[typeId];
    if (format < 16) skip(2); if (format < 17) skip(2); if (format === 15 || format === 16) skip(1);
    const offset = dataOffset + relative;
    if (!Number.isSafeInteger(offset) || offset < dataOffset || offset + size > bytes.length || classId === undefined) throw new Error("Unity object bounds are invalid.");
    objects.push({ classId, offset, size });
  }
  return { version: header.version, format, little, targetPlatform, objects };
}

function buildGraphicsAPIs(bytes) {
  const parsed = serializedObjects(bytes), settings = parsed.objects.filter(object => object.classId === 141);
  // The terminal GraphicsDeviceType vector is stable in the reviewed Unity
  // 5.3–2020.3 BuildSettings schema. Newer schemas remain explicitly unknown.
  const major = Number(parsed.version.split(".")[0]);
  if (!(major === 5 || (major >= 2017 && major <= 2020)) || settings.length !== 1) return null;
  const object = settings[0], end = object.offset + object.size, candidates = [];
  for (let count = 1; count <= 8; count++) {
    const offset = end - 4 * (count + 1); if (offset < object.offset) continue;
    const read = position => parsed.little ? bytes.readInt32LE(position) : bytes.readInt32BE(position);
    if (read(offset) !== count) continue;
    const apis = Array.from({ length: count }, (_, index) => read(offset + 4 * (index + 1)));
    if (apis.every(api => Object.hasOwn(GRAPHICS, api)) && new Set(apis).size === apis.length) candidates.push({ apis, vectorOffset: offset });
  }
  if (candidates.length !== 1) return null;
  return { ...candidates[0], version: parsed.version, targetPlatform: parsed.targetPlatform, objectClassId: 141,
    playerSettings: playerSettingsIdentity(bytes, parsed) };
}

function playerSettingsIdentity(bytes, parsed = serializedObjects(bytes)) {
  // The reviewed 5.3 PlayerSettings prefix stores aligned UTF-8 company and
  // product strings after its fixed platform flags. Later schemas use app.info
  // or a separately reviewed layout; never scan arbitrary assets for names.
  if (!/^5\.3\./.test(parsed.version)) return null;
  const objects = parsed.objects.filter(object => object.classId === 129);
  if (objects.length !== 1 || objects[0].size < 28) return null;
  const object = objects[0], end = object.offset + object.size;
  const read32 = at => parsed.little ? bytes.readInt32LE(at) : bytes.readInt32BE(at);
  if (bytes[object.offset] > 1 || bytes[object.offset + 12] > 1 || read32(object.offset + 4) < 0 || read32(object.offset + 4) > 5 ||
    read32(object.offset + 8) < 0 || read32(object.offset + 8) > 4 || read32(object.offset + 16) < 0 || read32(object.offset + 16) > 1000) return null;
  let cursor = object.offset + 20;
  function string() {
    if (cursor + 4 > end) return null;
    const size = read32(cursor); cursor += 4;
    if (size < 1 || size > 255 || cursor + size > end) return null;
    let text;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(cursor, cursor + size)); } catch { return null; }
    cursor = Math.ceil((cursor + size) / 4) * 4;
    return !/[\x00-\x1f\\/]/.test(text) && ![".", ".."].includes(text) ? text : null;
  }
  const companyName = string(), productName = companyName && string();
  return companyName && productName ? { companyName, productName, source: "PlayerSettings serialized object" } : null;
}

function inspectGraphics(dataRoot, { detection } = {}) {
  try {
    const loose = path.join(dataRoot, "globalgamemanagers"), archive = path.join(dataRoot, "data.unity3d");
    const info = detection?.stat ? detection.stat(loose) : (() => { try { return fs.statSync(loose); } catch { return null; } })();
    const reader = fileReader(info?.isFile() ? loose : archive, detection);
    if (info?.isFile() && reader.size > LIMITS.member) throw new Error("Unity global settings exceed the graphics inspection bound.");
    const bytes = info?.isFile() ? reader.read(0, reader.size) : archiveMember(reader, "globalgamemanagers"), found = buildGraphicsAPIs(bytes);
    if (!found) return { status: "unknown", graphicsAPIs: [], nativeGraphicsAPIs: [], reason: "This Unity graphics format is unsupported." };
    const nativeGraphicsAPIs = found.apis.filter(api => MAC_APIS.has(api));
    return { status: nativeGraphicsAPIs.length ? "native-renderer-present" : "requires-shader-conversion", graphicsAPIs: found.apis,
      graphicsLabels: found.apis.map(api => GRAPHICS[api]), nativeGraphicsAPIs, source: info?.isFile() ? loose : `${archive}!globalgamemanagers`,
      version: found.version, targetPlatform: found.targetPlatform,
      playerSettings: found.playerSettings,
      reason: nativeGraphicsAPIs.length ? null : "This build contains only graphics APIs that the native Mac player cannot use." };
  } catch (error) {
    if (error.code === "DETECTION_LIMIT") throw error;
    return { status: "unknown", graphicsAPIs: [], nativeGraphicsAPIs: [], reason: error.message };
  }
}

module.exports = { GRAPHICS, MAC_APIS, LIMITS, lz4Block, archiveMember, serializedObjects, buildGraphicsAPIs, playerSettingsIdentity, inspectGraphics };
