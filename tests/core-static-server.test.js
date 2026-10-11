const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createStaticServer } = require("../src/core/static-server");

async function fixture(t, { rootSymlink = false } = {}) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-static-server-"));
  const root = path.join(temporary, "root");
  const outside = path.join(temporary, "root-outside");
  let host;
  t.after(async () => {
    try {
      if (host) await host.close();
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(root, "index.html"), "<html>game</html>");
  fs.writeFileSync(path.join(root, "media.dat"), "0123456789");
  fs.writeFileSync(path.join(outside, "secret.txt"), "outside secret");
  let servedRoot = root;
  if (rootSymlink) {
    servedRoot = path.join(temporary, "root-link");
    fs.symlinkSync(root, servedRoot, "dir");
  }
  host = await createStaticServer(servedRoot);
  return { ...host, root, outside };
}

function request(host, target, { method = "GET", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1", port: host.port, path: target, method, headers, agent: false
    }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.once("error", reject);
      res.once("end", () => resolve({
        status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks)
      }));
    });
    req.once("error", reject);
    req.setTimeout(5000, () => req.destroy(new Error("HTTP request timed out")));
    req.end();
  });
}

test("module-declared source assets allow GET/HEAD ranges while preserving view and target confinement", async t => {
  const strict = await fixture(t), source = path.join(path.dirname(strict.root), "source");
  fs.mkdirSync(source); fs.writeFileSync(path.join(source, "asset.dat"), "0123456789");
  fs.symlinkSync(path.join(source, "asset.dat"), path.join(strict.root, "linked.dat"));
  fs.symlinkSync(path.join(strict.outside, "secret.txt"), path.join(strict.root, "outside.txt"));
  fs.symlinkSync(path.join(strict.outside, "secret.txt"), path.join(source, "escape.txt"));
  fs.symlinkSync(path.join(source, "escape.txt"), path.join(strict.root, "escape.txt"));
  assert.equal((await request(strict, "/linked.dat")).status, 403);
  await strict.close();
  const host = await createStaticServer(strict.root, { readRoots: [source] }); t.after(() => host.close());
  const range = await request(host, "/linked.dat", { headers: { Range: "bytes=2-5" } });
  assert.equal(range.status, 206); assert.equal(range.body.toString(), "2345");
  assert.equal(range.headers["content-range"], "bytes 2-5/10");
  const head = await request(host, "/linked.dat", { method: "HEAD", headers: { Range: "bytes=2-5" } });
  assert.equal(head.status, 200); assert.equal(head.body.length, 0); assert.equal(head.headers["content-length"], "10");
  assert.equal((await request(host, "/linked.dat", { method: "POST" })).status, 405);
  for (const target of ["/outside.txt", "/escape.txt", "/../source/asset.dat", "/%2e%2e/source/asset.dat", "/..%5csource/asset.dat",
    "/outside.txt?readRoots=" + encodeURIComponent(strict.outside)]) {
    assert.equal((await request(host, target)).status, 403, target);
  }
  await assert.rejects(createStaticServer(strict.root, { readRoots: ["relative"] }), /absolute/);
  await assert.rejects(createStaticServer(strict.root, { readRoots: [path.parse(source).root] }), /Invalid/);
  await assert.rejects(createStaticServer(strict.root, { readRoots: [path.join(source, "asset.dat")] }), /Invalid/);
});

test("static server preserves the port/Promise close API and binds only loopback", async t => {
  const host = await fixture(t);
  assert.ok(host.server instanceof http.Server);
  assert.ok(Number.isInteger(host.port) && host.port > 0);
  assert.equal(host.server.address().address, "127.0.0.1");
  assert.equal(host.server.address().port, host.port);
  const response = await request(host, "/");
  assert.equal(response.status, 200);
  assert.equal(response.body.toString(), "<html>game</html>");
  const closing = host.close();
  assert.ok(closing instanceof Promise);
  assert.equal(host.close(), closing);
  await closing;
  assert.equal(host.server.listening, false);
  await assert.rejects(request(host, "/"), { code: "ECONNREFUSED" });
});

test("static server maps directory indexes and keeps query strings out of filenames", async t => {
  const host = await fixture(t);
  fs.mkdirSync(path.join(host.root, "nested"));
  fs.writeFileSync(path.join(host.root, "nested", "index.html"), "nested game");
  for (const target of ["/", "/?cache=1", "/index.html?cache=%GG", "/nested", "/nested/", "/nested/?cache=1"]) {
    const response = await request(host, target);
    assert.equal(response.status, 200, target);
    assert.equal(response.body.toString(), target.startsWith("/nested") ? "nested game" : "<html>game</html>");
    assert.equal(response.headers["content-type"], "text/html; charset=utf-8");
    assert.equal(response.headers["cache-control"], "no-cache");
    assert.equal(response.headers["accept-ranges"], "bytes");
    assert.equal(Number(response.headers["content-length"]), response.body.length);
  }
});

test("static server preserves game asset MIME types and the binary fallback", async t => {
  const host = await fixture(t);
  const cases = [
    ["JS", "text/javascript; charset=utf-8"],
    ["css", "text/css; charset=utf-8"],
    ["json", "application/json; charset=utf-8"],
    ["png", "image/png"],
    ["jpeg", "image/jpeg"],
    ["svg", "image/svg+xml"],
    ["mp3", "audio/mpeg"],
    ["ogg", "audio/ogg"],
    ["m4a", "audio/mp4"],
    ["wav", "audio/wav"],
    ["woff2", "font/woff2"],
    ["eot", "application/vnd.ms-fontobject"],
    ["wasm", "application/wasm"],
    ["txt", "text/plain; charset=utf-8"],
    ["bin", "application/octet-stream"],
    ["dat", "application/octet-stream"],
    ["unknown", "application/octet-stream"]
  ];
  for (const [extension, mime] of cases) {
    fs.writeFileSync(path.join(host.root, `asset.${extension}`), "asset");
    const response = await request(host, `/asset.${extension}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers["content-type"], mime, extension);
    assert.equal(response.body.toString(), "asset");
  }
});

test("static server decodes UTF-8, legacy Unicode, and literal escaped names once", async t => {
  const host = await fixture(t);
  const cases = [
    ["snow 雪.txt", "/snow%20%E9%9B%AA.txt"],
    ["snow 雪.txt", "/snow%20%u96EA.txt"],
    ["👾.txt", "/%uD83D%uDC7E.txt"],
    ["percent%.txt", "/percent%u0025.txt"],
    ["$rodywalkingwine5%(5).png", "/$rodywalkingwine5%(5).png"],
    ["snow 雪%.txt", "/snow%20%E9%9B%AA%.txt"],
    ["literal%2e%2e.txt", "/literal%252e%252e.txt"],
    ["hash#query?.txt", "/hash%23query%3F.txt"]
  ];
  for (const [filename, target] of cases) {
    fs.writeFileSync(path.join(host.root, filename), filename);
    const response = await request(host, target);
    assert.equal(response.status, 200, target);
    assert.equal(response.body.toString(), filename);
  }
});

test("static server rejects malformed path encodings without breaking later requests", async t => {
  const host = await fixture(t);
  for (const target of ["/bad%", "/bad%GG", "/%C3%28", "/%uZZZZ", "/%uD800", "/%00", "http://example.invalid/index.html"]) {
    const response = await request(host, target);
    assert.equal(response.status, 400, target);
    assert.equal(response.body.toString(), "Bad Request");
  }
  assert.equal((await request(host, "/")).status, 200);
});

test("static server rejects raw, encoded, and legacy traversal before URL normalization", async t => {
  const host = await fixture(t);
  fs.mkdirSync(path.join(host.root, "nested"));
  for (const target of [
    "/../root-outside/secret.txt", "/%2e%2e/root-outside/secret.txt",
    "/nested/../../root-outside/secret.txt", "/%2e%2e%2froot-outside/secret.txt",
    "/%u002e%u002e/root-outside/secret.txt", "/%2e%2e%5croot-outside%5csecret.txt",
    "//../root-outside/secret.txt", "/nested/../index.html"
  ]) {
    const response = await request(host, target);
    assert.equal(response.status, 403, target);
    assert.equal(response.body.toString(), "Forbidden");
  }
  fs.writeFileSync(path.join(host.root, "..asset.txt"), "safe dotted filename");
  assert.equal((await request(host, "/..asset.txt")).body.toString(), "safe dotted filename");
});

test("literal-percent asset fallback retains traversal, symlink and decoding guards", async t => {
  const host = await fixture(t);
  fs.writeFileSync(path.join(host.outside, "secret%.txt"), "outside");
  fs.symlinkSync(path.join(host.outside, "secret%.txt"), path.join(host.root, "alias%.txt"));
  for (const target of ["/%2e%2e/root-outside/secret%.txt", "/alias%.txt", "/nested/%2e%2e/asset%.txt"]) {
    assert.equal((await request(host, target)).status, 403, target);
  }
  fs.writeFileSync(path.join(host.root, "literal%2e%2e%.txt"), "literal escaped name");
  assert.equal((await request(host, "/literal%252e%252e%.txt")).body.toString(), "literal escaped name");
  assert.equal((await request(host, "/missing%.txt")).status, 400);
  assert.equal((await request(host, "/%C3%28%.txt")).status, 400);
});

test("static server rejects file, directory, and index symlinks escaping the root", async t => {
  const host = await fixture(t);
  fs.symlinkSync(path.join(host.outside, "secret.txt"), path.join(host.root, "secret-link.txt"));
  fs.symlinkSync(host.outside, path.join(host.root, "outside-link"), "dir");
  fs.symlinkSync("outside-link", path.join(host.root, "chained-link"), "dir");
  fs.mkdirSync(path.join(host.root, "unsafe-index"));
  fs.symlinkSync(path.join(host.outside, "secret.txt"), path.join(host.root, "unsafe-index", "index.html"));
  for (const target of ["/secret-link.txt", "/outside-link", "/outside-link/secret.txt", "/chained-link/secret.txt", "/unsafe-index/"]) {
    const response = await request(host, target);
    assert.equal(response.status, 403, target);
    assert.equal(response.body.toString(), "Forbidden");
  }
});

test("static server allows in-root file/directory symlinks and a symlinked root", async t => {
  const host = await fixture(t, { rootSymlink: true });
  fs.symlinkSync("media.dat", path.join(host.root, "audio.ogg"));
  fs.mkdirSync(path.join(host.root, "nested"));
  fs.symlinkSync("../index.html", path.join(host.root, "nested", "index.html"));
  fs.symlinkSync("nested", path.join(host.root, "alias"), "dir");
  const audio = await request(host, "/audio.ogg", { headers: { Range: "bytes=2-4" } });
  assert.equal(audio.status, 206);
  assert.equal(audio.headers["content-type"], "audio/ogg");
  assert.equal(audio.body.toString(), "234");
  for (const target of ["/alias", "/alias/", "/alias/index.html"]) {
    const response = await request(host, target);
    assert.equal(response.status, 200, target);
    assert.equal(response.body.toString(), "<html>game</html>");
  }
});

test("static server handles missing files, missing indexes, and broken symlinks", async t => {
  const host = await fixture(t);
  fs.mkdirSync(path.join(host.root, "empty-directory"));
  fs.symlinkSync("missing.txt", path.join(host.root, "broken-link"));
  fs.symlinkSync("loop-link", path.join(host.root, "loop-link"));
  for (const target of ["/missing.txt", "/empty-directory/", "/media.dat/child", "/broken-link"]) {
    const response = await request(host, target);
    assert.equal(response.status, 404, target);
    assert.equal(response.body.toString(), "Not found");
  }
  assert.equal((await request(host, "/loop-link")).status, 403);
});

test("static server supports closed, open, and suffix byte ranges with clamped ends", async t => {
  const host = await fixture(t);
  const cases = [
    ["bytes=0-0", "0", "bytes 0-0/10"],
    ["bytes=2-5", "2345", "bytes 2-5/10"],
    ["bytes=6-", "6789", "bytes 6-9/10"],
    ["bytes=-3", "789", "bytes 7-9/10"],
    ["bytes=8-99", "89", "bytes 8-9/10"],
    ["bytes=-99", "0123456789", "bytes 0-9/10"],
    ["bytes=0-999999999999999999999999", "0123456789", "bytes 0-9/10"],
    ["bytes=-999999999999999999999999", "0123456789", "bytes 0-9/10"]
  ];
  for (const [range, body, contentRange] of cases) {
    const response = await request(host, "/media.dat", { headers: { Range: range } });
    assert.equal(response.status, 206, range);
    assert.equal(response.body.toString(), body, range);
    assert.equal(response.headers["content-range"], contentRange);
    assert.equal(Number(response.headers["content-length"]), Buffer.byteLength(body));
    assert.equal(response.headers["accept-ranges"], "bytes");
  }
});

test("static server returns 416 and the file size for invalid/unsatisfiable ranges", async t => {
  const host = await fixture(t);
  for (const range of [
    "bytes=10-", "bytes=99-100", "bytes=5-2", "bytes=-0", "bytes=-",
    "bytes=one-two", "bytes=0-1,4-5", "items=0-1", "bytes=0-1junk",
    "bytes=1.5-2", "bytes=999999999999999999999999-"
  ]) {
    const response = await request(host, "/media.dat", { headers: { Range: range } });
    assert.equal(response.status, 416, range);
    assert.equal(response.headers["content-range"], "bytes */10");
    assert.equal(response.headers["content-length"], "0");
    assert.equal(response.body.length, 0);
  }
  const complete = await request(host, "/media.dat");
  assert.equal(complete.status, 200);
  assert.equal(complete.body.toString(), "0123456789");
  assert.equal(complete.headers["content-range"], undefined);
});

test("static server serves empty files but rejects every byte range on them", async t => {
  const host = await fixture(t);
  fs.writeFileSync(path.join(host.root, "empty.dat"), "");
  const response = await request(host, "/empty.dat");
  assert.equal(response.status, 200);
  assert.equal(response.headers["content-length"], "0");
  assert.equal(response.body.length, 0);
  for (const range of ["bytes=0-", "bytes=0-0", "bytes=-1"]) {
    const partial = await request(host, "/empty.dat", { headers: { Range: range } });
    assert.equal(partial.status, 416);
    assert.equal(partial.headers["content-range"], "bytes */0");
    assert.equal(partial.body.length, 0);
  }
});

test("static server HEAD sends GET metadata without a body and ignores Range", async t => {
  const host = await fixture(t);
  const get = await request(host, "/media.dat");
  for (const headers of [{}, { Range: "bytes=2-4" }, { Range: "bytes=99-" }]) {
    const response = await request(host, "/media.dat", { method: "HEAD", headers });
    assert.equal(response.status, 200);
    for (const header of ["content-type", "content-length", "accept-ranges", "cache-control"]) {
      assert.equal(response.headers[header], get.headers[header], header);
    }
    assert.equal(response.headers["content-range"], undefined);
    assert.equal(response.body.length, 0);
  }
  for (const [target, status] of [["/", 200], ["/missing.txt", 404], ["/%GG", 400], ["/../secret.txt", 403]]) {
    const response = await request(host, target, { method: "HEAD" });
    assert.equal(response.status, status, target);
    assert.equal(response.body.length, 0);
  }
});

test("static server rejects methods other than GET and HEAD", async t => {
  const host = await fixture(t);
  const response = await request(host, "/media.dat", { method: "POST" });
  assert.equal(response.status, 405);
  assert.equal(response.headers.allow, "GET, HEAD");
  assert.equal(response.body.toString(), "Method Not Allowed");
});

test("static server streams large binary assets and survives an aborted download", async t => {
  const host = await fixture(t);
  const data = Buffer.alloc(4 * 1024 * 1024);
  for (let i = 0; i < data.length; i++) data[i] = i % 251;
  fs.writeFileSync(path.join(host.root, "large.bin"), data);
  const response = await request(host, "/large.bin");
  assert.equal(response.status, 200);
  assert.equal(Number(response.headers["content-length"]), data.length);
  assert.deepEqual(response.body, data);
  await new Promise((resolve, reject) => {
    const req = http.get({ hostname: "127.0.0.1", port: host.port, path: "/large.bin", agent: false }, res => {
      res.once("error", reject);
      res.once("data", chunk => {
        assert.ok(chunk.length < data.length);
        res.removeListener("error", reject);
        res.destroy();
        req.destroy();
        resolve();
      });
    });
    req.once("error", reject);
    req.setTimeout(5000, () => req.destroy(new Error("HTTP request timed out")));
  });
  assert.equal((await request(host, "/media.dat")).body.toString(), "0123456789");
});

test("static server handles asynchronous stream errors with correct error headers", async t => {
  const host = await fixture(t);
  const originalOpen = fs.promises.open;
  t.mock.method(fs.promises, "open", async (...args) => {
    const file = await originalOpen(...args);
    if (path.basename(args[0]) === "media.dat") {
      const originalStream = file.createReadStream.bind(file);
      t.mock.method(file, "createReadStream", options => {
        const stream = originalStream(options);
        stream.once("resume", () => stream.destroy(new Error("Injected disk read error")));
        return stream;
      });
    }
    return file;
  });
  const response = await request(host, "/media.dat", { headers: { Range: "bytes=0-1" } });
  assert.equal(response.status, 500);
  assert.equal(response.body.toString(), "Internal error");
  assert.equal(response.headers["content-type"], "text/plain; charset=utf-8");
  assert.equal(Number(response.headers["content-length"]), response.body.length);
  assert.equal(response.headers["content-range"], undefined);
  assert.equal((await request(host, "/")).status, 200);
});

test("static server aborts partial responses on late read errors and closes the file", async t => {
  const host = await fixture(t);
  fs.writeFileSync(path.join(host.root, "failed.bin"), Buffer.alloc(512 * 1024, 42));
  const originalOpen = fs.promises.open;
  let failedFile;
  let failedStream;
  t.mock.method(fs.promises, "open", async (...args) => {
    const file = await originalOpen(...args);
    if (path.basename(args[0]) === "failed.bin") {
      failedFile = file;
      const originalStream = file.createReadStream.bind(file);
      t.mock.method(file, "createReadStream", options => {
        failedStream = originalStream(options);
        failedStream.once("data", () => failedStream.destroy(new Error("Injected late disk read error")));
        return failedStream;
      });
    }
    return file;
  });
  await assert.rejects(request(host, "/failed.bin"), { code: "ECONNRESET" });
  assert.equal(failedStream.destroyed, true);
  assert.equal(failedFile.fd, -1);
  assert.equal((await request(host, "/")).status, 200);
});

test("static server rejects inaccessible or non-directory roots before listening", async t => {
  const host = await fixture(t);
  await assert.rejects(createStaticServer(path.join(host.root, "missing")), { code: "ENOENT" });
  await assert.rejects(createStaticServer(path.join(host.root, "media.dat")), /root must be a directory/);
});

test("static server rejects actual asynchronous listen errors", { timeout: 5000 }, async t => {
  const host = await fixture(t);
  const originalListen = http.Server.prototype.listen;
  t.mock.method(http.Server.prototype, "listen", function (port, address) {
    assert.equal(port, 0);
    assert.equal(address, "127.0.0.1");
    // Force a real collision with an existing ephemeral loopback listener.
    return originalListen.call(this, host.port, address);
  });
  await assert.rejects(createStaticServer(host.root), { code: "EADDRINUSE" });
});
