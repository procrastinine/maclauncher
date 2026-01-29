const fs = require("node:fs");
const https = require("node:https");
const path = require("node:path");

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
    req.end();
  });
}

async function fetchUrlBuffer(url, { headers = {}, redirectDepth = 0, maxRedirects = 5, signal } = {}) {
  if (redirectDepth > maxRedirects) throw new Error("Too many redirects while fetching data");
  throwIfAborted(signal);

  const res = await httpGet(url, headers, signal);
  const status = Number(res.statusCode || 0);

  if ([301, 302, 303, 307, 308].includes(status)) {
    const loc = res.headers.location;
    res.resume();
    if (!loc) throw new Error(`Redirect missing location: ${url}`);
    const nextUrl = new URL(loc, url).toString();
    return fetchUrlBuffer(nextUrl, { headers, redirectDepth: redirectDepth + 1, maxRedirects, signal });
  }

  const chunks = [];
  return new Promise((resolve, reject) => {
    res.on("data", c => chunks.push(Buffer.from(c)));
    res.on("error", reject);
    res.on("end", () => resolve({ status, headers: res.headers || {}, body: Buffer.concat(chunks) }));
  });
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
    res.resume();
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
    res.resume();
    const err = new Error(`Download failed (${status})`);
    err.statusCode = status;
    throw err;
  }

  const total = Number(res.headers["content-length"] || 0) || null;
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const out = fs.createWriteStream(destPath);

  return new Promise((resolve, reject) => {
    let downloaded = 0;
    let settled = false;
    const cleanup = err => {
      if (settled) return;
      settled = true;
      try {
        out.close();
      } catch {}
      try {
        fs.rmSync(destPath, { recursive: true, force: true });
      } catch {}
      try {
        res.destroy();
      } catch {}
      reject(err);
    };
    const removeAbort = attachAbortSignal(signal, () => cleanup(createAbortError()));

    res.on("data", chunk => {
      downloaded += chunk.length || 0;
      try {
        onProgress?.({ downloaded, total });
      } catch {}
    });
    res.on("error", err => {
      removeAbort();
      cleanup(err);
    });
    out.on("error", err => {
      removeAbort();
      cleanup(err);
    });
    out.on("finish", () => {
      if (settled) return;
      settled = true;
      removeAbort();
      resolve({ downloaded, total });
    });
    res.pipe(out);
  });
}

module.exports = {
  attachAbortSignal,
  createAbortError,
  isAbortError,
  throwIfAborted,
  fetchUrlBuffer,
  downloadToFile
};
