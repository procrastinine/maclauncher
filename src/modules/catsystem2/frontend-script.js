const zlib = require("node:zlib");
const { promisify } = require("node:util");
const inflate = promisify(zlib.inflate), decoder = require("./encoding"), utf8 = new TextDecoder("utf-8", { fatal: true });
const LIMITS = Object.freeze({ storedBytes: 16 * 1024 * 1024, decodedBytes: 32 * 1024 * 1024 });

async function inspectFrontEndScript(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 16 || bytes.length > LIMITS.storedBytes || !bytes.subarray(0, 4).equals(Buffer.from("FES\0")))
    throw new Error("Unsupported FES front-end script signature or size.");
  const compressedBytes = bytes.readUInt32LE(4), decodedBytes = bytes.readUInt32LE(8);
  if (!compressedBytes || compressedBytes !== bytes.length - 16 || !decodedBytes || decodedBytes > LIMITS.decodedBytes || bytes.readUInt32LE(12) !== 0)
    throw new Error("Unsupported or corrupt FES front-end script header.");
  let result;
  try { result = await inflate(bytes.subarray(16), { maxOutputLength: decodedBytes, info: true }); }
  catch { throw new Error("FES compressed text is invalid or exceeds its decoded limit."); }
  if (result.engine.bytesWritten !== compressedBytes || result.buffer.length !== decodedBytes)
    throw new Error("FES text does not match its declared sizes.");
  const raw = result.buffer, terminated = raw.at(-1) === 0, content = terminated ? raw.subarray(0, -1) : raw;
  if (content.includes(0)) throw new Error("Unsupported FES embedded text terminator.");
  let text, sourceEncoding = "CP932", encodingSource = "published-format-default";
  try { text = decoder.decode(content); }
  catch {
    try { text = utf8.decode(content); }
    catch { throw new Error("FES text uses an unsupported or corrupt encoding."); }
    sourceEncoding = "UTF-8"; encodingSource = "inferred-valid-UTF8-after-CP932-rejection";
  }
  return { format: "FES", sourceEncoding, encodingSource, runtimeEncodingProven: false, storedBytes: bytes.length, compressedBytes, decodedBytes,
    text, rawBase64: raw.toString("base64"), terminated, lineCount: text.split(/\r?\n/).length, executionSupported: false };
}
module.exports = { LIMITS, inspectFrontEndScript };
