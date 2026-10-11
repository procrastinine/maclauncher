const zlib = require("node:zlib");
const { promisify } = require("node:util");
const inflate = promisify(zlib.inflate), decoder = require("./encoding");
const LIMITS = Object.freeze({ storedBytes: 16 * 1024 * 1024, decodedBytes: 32 * 1024 * 1024, lines: 250000, lineBytes: 64 * 1024 });
const TYPES = Object.freeze({ 2: "input", 3: "page", 32: "message", 33: "name", 48: "command", 240: "script-name", 241: "line-number" });

function parseScript(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 16 || bytes.length > LIMITS.decodedBytes) throw new Error("CatScene decoded data exceeds its bounds.");
  const scriptLength = bytes.readUInt32LE(0), inputCount = bytes.readUInt32LE(4), offsets = bytes.readUInt32LE(8), strings = bytes.readUInt32LE(12);
  if (scriptLength !== bytes.length - 16 || inputCount > LIMITS.lines || offsets !== inputCount * 8 || strings < offsets || strings > scriptLength || (strings - offsets) % 4)
    throw new Error("Unsupported or corrupt CatScene table layout.");
  const lineCount = (strings - offsets) / 4;
  if (!lineCount || lineCount > LIMITS.lines) throw new Error("CatScene line count exceeds its limit.");
  for (let i = 0; i < inputCount; i++) {
    const next = bytes.readUInt32LE(16 + i * 8), index = bytes.readUInt32LE(20 + i * 8);
    if (index > lineCount || next > lineCount - index) throw new Error("CatScene input table exceeds its line range.");
  }
  const lines = [], unknownTypes = new Set(); let previous = -1;
  for (let i = 0; i < lineCount; i++) {
    const offset = bytes.readUInt32LE(16 + offsets + i * 4), next = i + 1 === lineCount ? scriptLength - strings : bytes.readUInt32LE(20 + offsets + i * 4);
    if (offset <= previous || offset >= next || next > scriptLength - strings || next - offset < 3 || next - offset > LIMITS.lineBytes)
      throw new Error("CatScene string offsets exceed their table range.");
    previous = offset;
    const raw = bytes.subarray(16 + strings + offset, 16 + strings + next), end = raw.indexOf(0, 2);
    if (raw[0] !== 1 || end < 2 || raw.subarray(end).some(byte => byte !== 0)) throw new Error("Unsupported or corrupt CatScene line record.");
    const typeCode = raw[1], type = TYPES[typeCode] || "unknown", text = decoder.decode(raw.subarray(2, end));
    if (type === "unknown") unknownTypes.add(typeCode);
    lines.push({ index: i, type, typeCode, text, rawBase64: raw.subarray(2, end).toString("base64") });
  }
  return { format: "CatScene", sourceEncoding: "CP932", scriptLength, inputCount, lineCount, lines,
    unknownTypes: [...unknownTypes].sort((a, b) => a - b), losslessCompilation: false };
}

async function inspectScene(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 16 || bytes.length > LIMITS.storedBytes || bytes.subarray(0, 8).toString("ascii") !== "CatScene")
    throw new Error("Unsupported CatScene signature or stored size.");
  const compressedBytes = bytes.readUInt32LE(8), decodedBytes = bytes.readUInt32LE(12), storedBytes = compressedBytes || decodedBytes;
  if (decodedBytes < 16 || decodedBytes > LIMITS.decodedBytes || storedBytes !== bytes.length - 16) throw new Error("CatScene payload sizes exceed their source range.");
  let decoded;
  if (compressedBytes) {
    let result;
    try { result = await inflate(bytes.subarray(16), { maxOutputLength: decodedBytes, info: true }); }
    catch { throw new Error("CatScene compressed data is invalid or exceeds its decoded limit."); }
    if (result.engine.bytesWritten !== compressedBytes || result.buffer.length !== decodedBytes) throw new Error("CatScene compressed data does not match its declared sizes.");
    decoded = result.buffer;
  } else decoded = bytes.subarray(16);
  return { ...parseScript(decoded), storedBytes: bytes.length, compressedBytes, decodedBytes };
}

function decompile(scene) {
  return scene.lines.map(line => `[${line.type === "unknown" ? "type-0x" + line.typeCode.toString(16).padStart(2, "0") : line.type}] ${line.text}`).join("\n") + "\n";
}

module.exports = { LIMITS, TYPES, parseScript, inspectScene, decompile };
