const zlib = require("node:zlib"), { promisify } = require("node:util");
const Encoding = require("./encoding");
const inflate = promisify(zlib.inflate);
const LIMITS = Object.freeze({ storedBytes: 16 * 1024 * 1024, decodedBytes: 32 * 1024 * 1024,
  codeBytes: 16 * 1024 * 1024, memoryBytes: 16 * 1024 * 1024, strings: 100000, stringBytes: 1024 * 1024 });

/** KCS v2 header/initializers, independently derived from bounded original PE reads. */
async function inspectKernelScript(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 54 || bytes.length > LIMITS.storedBytes || bytes.subarray(0, 4).toString("ascii") !== "KCS\0")
    throw new Error("Unsupported KCS script signature or stored size.");
  const version = bytes.readUInt32LE(4), flags = bytes.readUInt32LE(8), codeOffset = bytes.readUInt32LE(12), codeBytes = bytes.readUInt32LE(16),
    stringsOffset = bytes.readUInt32LE(20), stringCount = bytes.readUInt32LE(24), stringsBytes = bytes.readUInt32LE(28),
    globalsBytes = bytes.readUInt32LE(32), stackBytes = bytes.readUInt32LE(36), decodedEnd = bytes.readUInt32LE(40),
    reserved = bytes.readUInt32LE(44), allocationHint = bytes.readUInt32LE(48);
  if (version !== 2 || flags !== 0 || codeOffset !== 52 || reserved !== 0) throw new Error("Unsupported KCS header version or flags.");
  if (!codeBytes || codeBytes > LIMITS.codeBytes || stringsOffset !== codeOffset + codeBytes || stringsBytes < stringCount * 8 ||
      stringCount > LIMITS.strings || decodedEnd !== stringsOffset + stringsBytes || decodedEnd - codeOffset > LIMITS.decodedBytes ||
      globalsBytes + stackBytes > LIMITS.memoryBytes || !stackBytes || allocationHint < decodedEnd - codeOffset || allocationHint > LIMITS.decodedBytes)
    throw new Error("Corrupt or oversized KCS code, initializer or memory bounds.");
  let result;
  try { result = await inflate(bytes.subarray(codeOffset), { maxOutputLength: decodedEnd - codeOffset, info: true }); }
  catch { throw new Error("KCS compressed program is invalid or exceeds its decoded limit."); }
  if (result.engine.bytesWritten !== bytes.length - codeOffset || result.buffer.length !== decodedEnd - codeOffset)
    throw new Error("KCS compressed program does not match its declared extents.");
  const code = result.buffer.subarray(0, codeBytes), initializers = result.buffer.subarray(codeBytes), strings = [], memory = Buffer.alloc(globalsBytes + stackBytes);
  for (let index = 0; index < stringCount; index++) {
    const source = initializers.readUInt32LE(index * 8), destination = initializers.readUInt32LE(index * 8 + 4);
    if (source < stringCount * 8 || source >= stringsBytes || destination >= globalsBytes) throw new Error("KCS initializer exceeds its section.");
    const end = initializers.indexOf(0, source), length = end - source + 1;
    if (end < source || length > LIMITS.stringBytes || length > globalsBytes - destination) throw new Error("KCS initializer string exceeds its memory range.");
    const raw = initializers.subarray(source, end + 1);
    raw.copy(memory, destination);
    strings.push({ index, sourceOffset: source, memoryOffset: destination, text: Encoding.decode(raw.subarray(0, -1)), rawBase64: raw.toString("base64") });
  }
  return { format: "KCS", version, flags, codeOffset, codeBytes, stringsOffset, stringsBytes, stringCount, globalsBytes, stackBytes,
    storedBytes: bytes.length, decodedBytes: result.buffer.length, allocationHint, code, memory, strings, executionSupported: false };
}
module.exports = { LIMITS, inspectKernelScript };
