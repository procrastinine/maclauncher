const zlib = require("node:zlib");

const LZString = require("../lz-string");

function decodeSave(engineId, raw) {
  if (raw == null) throw new Error("Missing save data");

  if (engineId === "mv") {
    const json = LZString.decompressFromBase64(raw);
    if (typeof json !== "string") throw new Error("Failed to decode MV save via LZString");
    return json;
  }

  if (engineId === "mz") {
    const buf = Buffer.from(String(raw), "binary");
    return zlib.inflateSync(buf).toString("utf8");
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
