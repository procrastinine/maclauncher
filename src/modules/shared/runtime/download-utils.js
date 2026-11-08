const zlib = require("node:zlib");
const Guards = require("./guards");
const MAX_BUFFER_BYTES = 32 * 1024 * 1024;

function decodeResponseBody(body, headers, { maxBytes = MAX_BUFFER_BYTES } = {}) {
  maxBytes = Guards.optional(maxBytes);
  if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 1)) throw new Error("Buffered download limit must be a positive byte count.");
  const tooLarge = () => new Error(`Download response exceeds the ${maxBytes} byte limit.`);
  if (maxBytes !== undefined && body.length > maxBytes) throw tooLarge();
  const encoding = String(headers?.["content-encoding"] || "").toLowerCase();
  const decode = encoding.includes("gzip") ? zlib.gunzipSync
    : encoding.includes("deflate") ? zlib.inflateSync : encoding.includes("br") ? zlib.brotliDecompressSync : null;
  if (decode) {
    try { return decode(body, maxBytes === undefined ? {} : { maxOutputLength: maxBytes }); }
    catch (error) { if (error.code === "ERR_BUFFER_TOO_LARGE") throw tooLarge(); }
  }
  return body;
}

function createAbortError(message = "Download canceled.") {
  const err = new Error(message);
  err.name = "AbortError";
  err.code = "ABORT_ERR";
  return err;
}

function isAbortError(err) {
  if (!err) return false;
  return err.name === "AbortError" || err.code === "ABORT_ERR";
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

function attachAbortSignal(signal, onAbort) {
  if (!signal) return () => {};
  if (signal.aborted) {
    onAbort?.();
    return () => {};
  }
  const handler = () => onAbort?.();
  signal.addEventListener("abort", handler, { once: true });
  return () => signal.removeEventListener("abort", handler);
}

module.exports = {
  MAX_BUFFER_BYTES,
  decodeResponseBody,
  attachAbortSignal,
  createAbortError,
  isAbortError,
  throwIfAborted
};
