const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const MIME = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".svg", "image/svg+xml"],
  [".ico", "image/x-icon"],
  [".mp3", "audio/mpeg"],
  [".ogg", "audio/ogg"],
  [".m4a", "audio/mp4"],
  [".wav", "audio/wav"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".ttf", "font/ttf"],
  [".otf", "font/otf"],
  [".eot", "application/vnd.ms-fontobject"],
  [".wasm", "application/wasm"],
  [".bin", "application/octet-stream"],
  [".dat", "application/octet-stream"],
  [".txt", "text/plain; charset=utf-8"]
]);

function httpError(statusCode) {
  return Object.assign(new Error(http.STATUS_CODES[statusCode]), { statusCode });
}

function decodePathname(rawUrl, allowLiteralPercent = false) {
  // WHATWG URL parsing removes dot segments before they can be checked.
  const rawPath = rawUrl.split(/[?#]/, 1)[0];
  if (!rawPath.startsWith("/")) throw httpError(400);
  let pathname;
  try {
    // Some older games use escape()'s UTF-16 %uXXXX filenames. Re-encode
    // consecutive units together to preserve surrogate pairs and decode once.
    let encoded = rawPath.replace(/(?:%u[0-9a-f]{4})+/gi, units =>
      encodeURIComponent(units.replace(/%u([0-9a-f]{4})/gi, (_match, hex) =>
        String.fromCharCode(parseInt(hex, 16))
      ))
    );
    // RPG Maker MV decodes asset URLs before passing them to Image/Audio.
    // Preserve stray literal '%' characters only for the confined existing
    // file fallback below. Valid escapes still decode exactly once.
    if (allowLiteralPercent) encoded = encoded.replace(/%(?![0-9a-f]{2})/gi, "%25");
    pathname = decodeURIComponent(encoded);
  } catch {
    throw httpError(400);
  }
  if (pathname.includes("\0")) throw httpError(400);
  if (pathname.split(/[\\/]/).includes("..")) throw httpError(403);
  return pathname;
}

function isWithinRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function resolveFile(root, pathname, readRoots = []) {
  let filename = path.resolve(root, `.${pathname}`);
  if (!isWithinRoot(root, filename)) throw httpError(403);
  let realPath = await fs.promises.realpath(filename);
  const confined = file => isWithinRoot(root, file) || readRoots.some(source => isWithinRoot(source, file));
  if (!confined(realPath)) throw httpError(403);
  if ((await fs.promises.stat(realPath)).isDirectory()) {
    filename = path.join(filename, "index.html");
    realPath = await fs.promises.realpath(path.join(realPath, "index.html"));
    if (!confined(realPath)) throw httpError(403);
  }
  return { filename, realPath };
}

function parseRange(value, size) {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value.trim());
  if (!match || (!match[1] && !match[2]) || size === 0) return null;
  // BigInt keeps very large ends/suffixes valid without rounding their values.
  const length = BigInt(size);
  let start;
  let end;
  if (!match[1]) {
    const suffix = BigInt(match[2]);
    if (suffix === 0n) return null;
    start = suffix >= length ? 0n : length - suffix;
    end = length - 1n;
  } else {
    start = BigInt(match[1]);
    end = match[2] ? BigInt(match[2]) : length - 1n;
    if (start >= length || end < start) return null;
    if (end >= length) end = length - 1n;
  }
  return { start: Number(start), end: Number(end) };
}

function sendError(req, res, error) {
  if (res.destroyed) return;
  if (res.headersSent) {
    res.destroy(error);
    return;
  }
  const statusCode = error.statusCode || (
    ["ENOENT", "ENOTDIR", "EISDIR"].includes(error.code) ? 404 :
      ["EACCES", "EPERM", "ELOOP"].includes(error.code) ? 403 : 500
  );
  const message = statusCode === 404 ? "Not found" :
    statusCode === 500 ? "Internal error" : http.STATUS_CODES[statusCode];
  res.statusCode = statusCode;
  res.removeHeader("Content-Range");
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Length", String(Buffer.byteLength(message)));
  res.end(req.method === "HEAD" ? undefined : message);
}

async function serveFile(root, req, res, readRoots) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    throw httpError(405);
  }
  let resolved;
  try {
    resolved = await resolveFile(root, decodePathname(req.url || "/"), readRoots);
  } catch (error) {
    if (error.statusCode !== 400) throw error;
    try {
      resolved = await resolveFile(root, decodePathname(req.url || "/", true), readRoots);
    } catch (fallbackError) {
      if (["ENOENT", "ENOTDIR"].includes(fallbackError.code)) throw error;
      throw fallbackError;
    }
  }
  const { filename, realPath } = resolved;
  // Open the checked canonical path, rather than following the requested alias
  // again. O_NOFOLLOW also rejects a final symlink substituted before open.
  let file = await fs.promises.open(realPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw httpError(404);
    if (res.destroyed) return;

    res.setHeader("Content-Type", MIME.get(path.extname(filename).toLowerCase()) || "application/octet-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Accept-Ranges", "bytes");
    // Range applies to GET; HEAD reports the complete representation's headers.
    let range;
    if (req.method === "GET" && req.headers.range !== undefined) {
      range = parseRange(req.headers.range, stat.size);
      if (!range) {
        res.statusCode = 416;
        res.setHeader("Content-Range", `bytes */${stat.size}`);
        res.setHeader("Content-Length", "0");
        res.end();
        return;
      }
    }
    res.statusCode = range ? 206 : 200;
    res.setHeader("Content-Length", String(range ? range.end - range.start + 1 : stat.size));
    if (range) res.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${stat.size}`);
    if (req.method === "HEAD") {
      res.end();
      return;
    }

    const stream = file.createReadStream(range || {});
    file = null; // The stream now owns and closes the file descriptor.
    res.once("close", () => stream.destroy());
    res.once("error", () => stream.destroy());
    stream.once("error", error => sendError(req, res, error));
    stream.pipe(res);
  } finally {
    if (file) await file.close();
  }
}

/**
 * Serve a game directory on an ephemeral IPv4 loopback port without Electron.
 * Resolves to { port, close, server }; close() returns an idempotent Promise.
 * Directories map to index.html, and symlinks are allowed within the real root.
 * GET streams files and supports one closed/open/suffix byte range (invalid or
 * unsatisfiable ranges return 416). HEAD ignores Range and sends no body.
 * Malformed encodings return 400; existing confined asset names may contain
 * stray literal '%'. Traversal/outside symlinks return 403.
 * Startup rejects for inaccessible/non-directory roots and listen failures.
 */
async function createStaticServer(rootDir, { readRoots = [] } = {}) {
  const root = await fs.promises.realpath(path.resolve(rootDir));
  if (!(await fs.promises.stat(root)).isDirectory()) {
    throw new Error("Static server root must be a directory");
  }
  if (!Array.isArray(readRoots) || readRoots.some(value => typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0"))) {
    throw new Error("Content read roots must be explicit absolute directories.");
  }
  const sources = [...new Set(await Promise.all(readRoots.map(async directory => {
    const source = await fs.promises.realpath(directory);
    if (source === path.parse(source).root || !(await fs.promises.stat(source)).isDirectory()) throw new Error("Invalid content read root.");
    return source;
  })))];
  const server = http.createServer((req, res) => {
    serveFile(root, req, res, sources).catch(error => sendError(req, res, error));
  });
  await new Promise((resolve, reject) => {
    function onError(error) {
      server.removeListener("listening", onListening);
      reject(error);
    }
    function onListening() {
      server.removeListener("error", onError);
      resolve();
    }
    server.once("error", onError);
    server.once("listening", onListening);
    try {
      server.listen(0, "127.0.0.1");
    } catch (error) {
      server.removeListener("error", onError);
      onError(error);
    }
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Failed to bind game server");
  }
  let closePromise;
  return {
    port: address.port,
    server,
    close: () => {
      if (!closePromise) {
        closePromise = new Promise((resolve, reject) => {
          server.close(error => {
            if (error && error.code !== "ERR_SERVER_NOT_RUNNING") reject(error);
            else resolve();
          });
        });
      }
      return closePromise;
    }
  };
}

module.exports = { createStaticServer };
