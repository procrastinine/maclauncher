const fs = require("node:fs");
const https = require("node:https");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const zlib = require("node:zlib");
const MAX_BUFFER_BYTES = 32 * 1024 * 1024;

function decodeResponseBody(body, headers, { maxBytes = MAX_BUFFER_BYTES } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Buffered download limit must be a positive byte count.");
  const tooLarge = () => new Error(`Download response exceeds the ${maxBytes} byte limit.`);
  if (body.length > maxBytes) throw tooLarge();
  const encoding = String(headers?.["content-encoding"] || "").toLowerCase();
  const decode = encoding.includes("gzip") ? zlib.gunzipSync
    : encoding.includes("deflate") ? zlib.inflateSync : encoding.includes("br") ? zlib.brotliDecompressSync : null;
  if (decode) {
    try { return decode(body, { maxOutputLength: maxBytes }); }
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

function httpGet(url, headers = {}, signal) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, res => resolve(res));
    const cleanup = attachAbortSignal(signal, () => {
      req.destroy(createAbortError());
    });
    req.on("error", err => {
      cleanup();
      reject(err);
    });
    req.once("close", cleanup);
  });
}

async function fetchUrlBuffer(
  url,
  { headers = {}, redirectDepth = 0, maxRedirects = 5, signal, maxBytes = MAX_BUFFER_BYTES } = {}
) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Buffered download limit must be a positive byte count.");
  if (redirectDepth > maxRedirects) throw new Error("Too many redirects while fetching data");
  throwIfAborted(signal);

  const res = await httpGet(url, headers, signal);
  const status = Number(res.statusCode || 0);

  if ([301, 302, 303, 307, 308].includes(status)) {
    const loc = res.headers.location;
    res.destroy();
    if (!loc) throw new Error(`Redirect missing location: ${url}`);
    const nextUrl = new URL(loc, url).toString();
    return fetchUrlBuffer(nextUrl, {
      headers,
      redirectDepth: redirectDepth + 1,
      maxRedirects,
      signal,
      maxBytes
    });
  }

  const chunks = [];
  let received = 0;
  try {
    const checkSize = size => {
      if (size > maxBytes) throw new Error(`Download response exceeds the ${maxBytes} byte limit.`);
    };
    checkSize(Number(res.headers?.["content-length"]));
    for await (const chunk of res) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      received += bytes.length;
      checkSize(received);
      chunks.push(bytes);
    }
    throwIfAborted(signal);
    return { status, headers: res.headers || {}, body: chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, received) };
  } catch (err) {
    res.destroy();
    throwIfAborted(signal);
    throw err;
  }
}

async function downloadToFile(
  url,
  destPath,
  { headers = {}, onProgress, redirectDepth = 0, maxRedirects = 5, signal } = {}
) {
  if (redirectDepth > maxRedirects) throw new Error("Too many redirects while downloading");
  throwIfAborted(signal);

  const res = await httpGet(url, headers, signal);
  const status = Number(res.statusCode || 0);

  if ([301, 302, 303, 307, 308].includes(status)) {
    const loc = res.headers.location;
    res.destroy();
    if (!loc) throw new Error(`Redirect missing location: ${url}`);
    const nextUrl = new URL(loc, url).toString();
    return downloadToFile(nextUrl, destPath, {
      headers,
      onProgress,
      redirectDepth: redirectDepth + 1,
      maxRedirects,
      signal
    });
  }

  if (status !== 200) {
    res.destroy();
    const err = new Error(`Download failed (${status})`);
    err.statusCode = status;
    throw err;
  }

  const rawTotal = res.headers["content-length"];
  const parsedTotal = rawTotal == null ? NaN : Number(rawTotal);
  const total = Number.isFinite(parsedTotal) && parsedTotal >= 0 ? parsedTotal : null;
  const tempPath = path.join(path.dirname(destPath), `.maclauncher-${randomUUID()}.download`);
  let downloaded = 0;
  const progress = new Transform({
    transform(chunk, encoding, callback) {
      downloaded += chunk.length;
      try {
        onProgress?.({ downloaded, total });
      } catch {}
      callback(null, chunk);
    }
  });
  try {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    // The destination may already contain an archive or even be a directory.
    // Only publish a completed file, and only ever remove our own temporary file.
    const out = fs.createWriteStream(tempPath, { flags: "wx" });
    await pipeline(res, progress, out, signal ? { signal } : {});
    throwIfAborted(signal);
    fs.renameSync(tempPath, destPath);
    return { downloaded, total };
  } catch (err) {
    res.destroy();
    throwIfAborted(signal);
    throw err;
  } finally {
    // pipeline waits for file closure, including an in-flight open on abort.
    fs.rmSync(tempPath, { force: true });
  }
}

module.exports = {
  MAX_BUFFER_BYTES,
  decodeResponseBody,
  attachAbortSignal,
  createAbortError,
  isAbortError,
  throwIfAborted,
  fetchUrlBuffer,
  downloadToFile
};
