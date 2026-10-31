const fs = require("node:fs");
const https = require("node:https");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { MAX_BUFFER_BYTES, attachAbortSignal, createAbortError, isAbortError, throwIfAborted } = require("./download-utils");
const IDLE_TIMEOUT_MS = 30000, RETRY_DELAYS = [1000, 2000, 4000];

// The network side of run-time downloads. Only the shared upstream layer
// (upstream.js) and the MacLauncher Builds catalog require this module; every
// other module downloads through an upstream source.

// A connection that delivers no bytes for idleTimeoutMs ends as a transient
// failure instead of waiting indefinitely. The returned touch() records body
// activity; the caller reads the body itself, so the response mode is unchanged.
function httpGet(url, headers = {}, signal, { idleTimeoutMs = IDLE_TIMEOUT_MS, method = "GET", body } = {}) {
  return new Promise((resolve, reject) => {
    let res = null, timer = null;
    const stalled = () => Object.assign(new Error("The download stalled."), { code: "DOWNLOAD_STALLED" });
    const touch = () => {
      clearTimeout(timer);
      timer = setTimeout(() => (res || req).destroy(stalled()), idleTimeoutMs);
      timer.unref?.();
    };
    const req = https.request(url, { method, headers: body ? { ...headers, "Content-Length": String(Buffer.byteLength(body)) } : headers }, response => {
      res = response;touch();
      response.once("close", () => clearTimeout(timer));
      resolve([response, touch]);
    });
    req.end(body);
    touch();
    const cleanup = attachAbortSignal(signal, () => {
      req.destroy(createAbortError());
    });
    req.on("error", err => {
      clearTimeout(timer);
      cleanup();
      reject(err);
    });
    req.once("close", () => { if (!res) clearTimeout(timer); cleanup(); });
  });
}

// Dropped or stalled connections and busy servers are transient: the request
// is made again on a bounded schedule. Other failures end it at once. A
// transfer that is still failing after the last attempt ends with its reason.
const TRANSIENT_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "ETIMEDOUT", "EPIPE", "ENETDOWN", "ENETUNREACH",
  "EHOSTUNREACH", "EAI_AGAIN", "ERR_STREAM_PREMATURE_CLOSE", "DOWNLOAD_STALLED", "DOWNLOAD_RESTART"]);
const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const transient = error => !isAbortError(error) && (TRANSIENT_CODES.has(error?.code) || TRANSIENT_STATUS.has(error?.statusCode));
async function withRetries(attempt, { signal, retryDelays = RETRY_DELAYS, retryStatus = () => false } = {}) {
  let attempts = 0;
  const once = async () => {
    attempts++;
    try { return { value: await attempt() }; } catch (error) { return { error }; }
  };
  let result;
  try {
    result = await require("../bounded-retry").until(await once(), once, {
      delays: retryDelays, signal,
      settled: value => value.error ? !transient(value.error) : !retryStatus(value.value)
    });
  } catch (error) {
    throwIfAborted(signal);
    throw error;
  }
  if (result.error && attempts > 1 && transient(result.error)) {
    const { code, statusCode } = result.error;
    throw Object.assign(new Error(`The download did not complete after ${attempts} attempts: ${result.error.message}`),
      { cause: result.error, ...(code ? { code } : {}), ...(statusCode ? { statusCode } : {}) });
  }
  if (result.error) throw result.error;
  return result.value;
}

// A redirect to another origin does not carry the request's credentials.
function redirectHeaders(headers, from, to) {
  return new URL(from).origin === new URL(to).origin ? headers
    : Object.fromEntries(Object.entries(headers).filter(([name]) => !/^(?:authorization|cookie)$/i.test(name)));
}

// A request with a body (`method`, `body`) is sent once; only GET requests are
// retried.
function fetchUrlBuffer(url, options = {}) {
  return withRetries(() => fetchUrlBufferOnce(url, options),
    { ...options, ...(options.body === undefined ? {} : { retryDelays: [] }), retryStatus: result => TRANSIENT_STATUS.has(result.status) });
}

async function fetchUrlBufferOnce(
  url,
  { headers = {}, redirectDepth = 0, maxRedirects = 5, signal, maxBytes = MAX_BUFFER_BYTES, idleTimeoutMs, method = "GET", body } = {}
) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Buffered download limit must be a positive byte count.");
  if (redirectDepth > maxRedirects) throw new Error("Too many redirects while fetching data");
  throwIfAborted(signal);

  const [res, touch] = await httpGet(url, headers, signal, { idleTimeoutMs, method, body });
  const status = Number(res.statusCode || 0);

  if ([301, 302, 303, 307, 308].includes(status)) {
    const loc = res.headers.location;
    res.destroy();
    if (!loc) throw new Error(`Redirect missing location: ${url}`);
    const nextUrl = new URL(loc, url).toString();
    // 307 and 308 repeat the request; the others continue with GET. A HEAD
    // request stays a HEAD request.
    const repeat = [307, 308].includes(status) || method === "HEAD";
    return fetchUrlBufferOnce(nextUrl, {
      headers: redirectHeaders(headers, url, nextUrl),
      ...(repeat ? { method, body } : {}),
      redirectDepth: redirectDepth + 1,
      maxRedirects,
      signal,
      maxBytes,
      idleTimeoutMs
    });
  }

  const chunks = [];
  let received = 0;
  try {
    const checkSize = size => {
      if (size > maxBytes) throw new Error(`Download response exceeds the ${maxBytes} byte limit.`);
    };
    // A HEAD response's length describes the file, not this response.
    if (method !== "HEAD") checkSize(Number(res.headers?.["content-length"]));
    for await (const chunk of res) {
      touch();
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

// The partial file is kept between attempts. A retry asks only for the
// missing bytes when the server named a strong validator and byte ranges
// (If-Range); a server that sends the whole file again starts it over.
async function downloadToFile(url, destPath, options = {}) {
  const transfer = { tempPath: path.join(path.dirname(destPath), `.maclauncher-${randomUUID()}.download`), bytes: 0,
    validator: null, total: null, created: false };
  try {
    return await withRetries(() => downloadToFileOnce(url, destPath, { ...options, transfer }), options);
  } finally {
    // Each attempt waits for its file closure, including an in-flight open on abort.
    fs.rmSync(transfer.tempPath, { force: true });
  }
}

const restart = transfer => {
  Object.assign(transfer, { bytes: 0, validator: null, total: null });
  return Object.assign(new Error("The download could not continue and starts again."), { code: "DOWNLOAD_RESTART" });
};

async function downloadToFileOnce(
  url,
  destPath,
  { headers = {}, onProgress, redirectDepth = 0, maxRedirects = 5, signal, idleTimeoutMs, transfer } = {}
) {
  if (redirectDepth > maxRedirects) throw new Error("Too many redirects while downloading");
  throwIfAborted(signal);

  const resuming = transfer.bytes > 0 && Boolean(transfer.validator);
  const [res, touch] = await httpGet(url,
    resuming ? { ...headers, Range: `bytes=${transfer.bytes}-`, "If-Range": transfer.validator } : headers, signal, { idleTimeoutMs });
  const status = Number(res.statusCode || 0);

  if ([301, 302, 303, 307, 308].includes(status)) {
    const loc = res.headers.location;
    res.destroy();
    if (!loc) throw new Error(`Redirect missing location: ${url}`);
    const nextUrl = new URL(loc, url).toString();
    return downloadToFileOnce(nextUrl, destPath, {
      headers: redirectHeaders(headers, url, nextUrl),
      onProgress,
      redirectDepth: redirectDepth + 1,
      maxRedirects,
      signal,
      idleTimeoutMs,
      transfer
    });
  }

  const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(res.headers["content-range"] || "");
  const append = resuming && status === 206 && Number(range?.[1]) === transfer.bytes;
  if (resuming && (status === 206 || status === 416) && !append) {
    res.destroy();
    throw restart(transfer);
  }
  if (status !== 200 && !append) {
    res.destroy();
    const err = new Error(`Download failed (${status})`);
    err.statusCode = status;
    throw err;
  }

  if (append) transfer.total = Number(range[3]);
  else {
    const rawTotal = res.headers["content-length"];
    const parsedTotal = rawTotal == null ? NaN : Number(rawTotal);
    const etag = String(res.headers.etag || ""), lastModified = String(res.headers["last-modified"] || "");
    Object.assign(transfer, { bytes: 0, total: Number.isFinite(parsedTotal) && parsedTotal >= 0 ? parsedTotal : null,
      validator: /\bbytes\b/i.test(res.headers["accept-ranges"] || "") ? (etag && !etag.startsWith("W/") ? etag : lastModified) || null : null });
  }
  const total = transfer.total;
  let downloaded = transfer.bytes;
  const progress = new Transform({
    transform(chunk, encoding, callback) {
      touch();
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
    const out = fs.createWriteStream(transfer.tempPath, { flags: append ? "a" : transfer.created ? "w" : "wx" });
    transfer.created = true;
    await pipeline(res, progress, out, signal ? { signal } : {});
    throwIfAborted(signal);
    fs.renameSync(transfer.tempPath, destPath);
    return { downloaded, total };
  } catch (err) {
    res.destroy();
    throwIfAborted(signal);
    // The bytes on disk are the next attempt's starting point.
    try { transfer.bytes = transfer.validator ? fs.statSync(transfer.tempPath).size : 0; } catch { transfer.bytes = 0; }
    throw err;
  }
}

module.exports = { fetchUrlBuffer, downloadToFile };
