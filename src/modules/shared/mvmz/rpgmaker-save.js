const zlib = require("node:zlib");

const LZString = require("../lz-string");

// The bundled LZString implementation builds an unlimited output string. Keep
// its wire format, but count output before appending when a caller sets a bound.
function decompressMvBounded(raw, maxOutputBytes) {
  raw = raw.replace(/\s/g, "");
  if (raw.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(raw)) throw new Error("Invalid MV base64 data");
  const bytes = Buffer.from(raw, "base64");
  if (bytes.length % 2) throw new Error("Invalid MV compressed stream");
  let offset = 0;
  let bit = 0;
  function readBits(count) {
    let value = 0;
    for (let n = 0; n < count; n += 1) {
      if (offset >= bytes.length) throw new Error("Truncated MV compressed stream");
      const word = bytes.readUInt16BE(offset);
      value += ((word >>> (15 - bit)) & 1) * 2 ** n;
      if (++bit === 16) { bit = 0; offset += 2; }
    }
    return value;
  }
  const dictionary = [0, 1, 2];
  const first = readBits(2);
  if (first === 2) return "";
  if (first > 2) throw new Error("Invalid MV compressed stream");
  let previous = String.fromCharCode(readBits(first === 0 ? 8 : 16));
  dictionary[3] = previous;
  const chunks = [previous];
  let outputLength = previous.length;
  let bits = 3;
  let remaining = 4;
  function enlarge() {
    if (remaining === 0) { remaining = 2 ** bits; bits += 1; }
  }
  while (true) {
    let code = readBits(bits);
    if (code === 2) break;
    if (code === 0 || code === 1) {
      dictionary.push(String.fromCharCode(readBits(code === 0 ? 8 : 16)));
      code = dictionary.length - 1;
      remaining -= 1;
    }
    enlarge();
    const entry = dictionary[code] || (code === dictionary.length ? previous + previous[0] : null);
    if (entry === null) throw new Error("Invalid MV compressed stream");
    outputLength += entry.length;
    // UTF-16 length is a lower bound for UTF-8 size; check actual bytes below.
    if (outputLength > maxOutputBytes) throw new Error("Decoded save exceeds size limit");
    chunks.push(entry);
    dictionary.push(previous + entry[0]);
    if (dictionary.length > Math.min(maxOutputBytes + 4, 1000000)) throw new Error("Decoded save exceeds dictionary limit");
    remaining -= 1;
    previous = entry;
    enlarge();
  }
  const json = chunks.join("");
  if (Buffer.byteLength(json, "utf8") > maxOutputBytes) throw new Error("Decoded save exceeds size limit");
  return json;
}

function decodeSave(engineId, raw, { maxOutputBytes } = {}) {
  if (raw == null) throw new Error("Missing save data");
  if (maxOutputBytes !== undefined && (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1)) {
    throw new Error("Invalid decoded save size limit");
  }

  if (engineId === "mv") {
    const json = maxOutputBytes === undefined
      ? LZString.decompressFromBase64(raw)
      : decompressMvBounded(String(raw), maxOutputBytes);
    if (typeof json !== "string") throw new Error("Failed to decode MV save via LZString");
    return json;
  }

  if (engineId === "mz") {
    const buf = Buffer.from(String(raw), "binary");
    if (maxOutputBytes === undefined) return zlib.inflateSync(buf).toString("utf8");
    const decoded = zlib.inflateSync(buf, { maxOutputLength: maxOutputBytes, info: true });
    if (decoded.engine.bytesWritten !== buf.length) throw new Error("Unsupported trailing data in MZ compressed stream");
    return new TextDecoder("utf-8", { fatal: true }).decode(decoded.buffer);
  }

  throw new Error(`Unsupported engine: ${engineId}`);
}

function encodeSave(engineId, json) {
  if (typeof json !== "string") throw new Error("Save JSON must be a string");

  if (engineId === "mv") {
    return LZString.compressToBase64(json);
  }

  if (engineId === "mz") {
    const buf = zlib.deflateSync(Buffer.from(json, "utf8"), { level: 1 });
    return buf.toString("binary");
  }

  throw new Error(`Unsupported engine: ${engineId}`);
}

module.exports = {
  decodeSave,
  encodeSave
};
