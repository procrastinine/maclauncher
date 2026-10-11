const fs = require("node:fs");
const https = require("node:https");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");

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
  { headers = {}, redirectDepth = 0, maxRedirects = 5, signal } = {}
) {
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
      signal
    });
  }

  const chunks = [];
  try {
    for await (const chunk of res) chunks.push(Buffer.from(chunk));
    throwIfAborted(signal);
    return { status, headers: res.headers || {}, body: Buffer.concat(chunks) };
  } catch (err) {
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
  attachAbortSignal,
  createAbortError,
  isAbortError,
  throwIfAborted,
  fetchUrlBuffer,
  downloadToFile
};
