const assert = require("node:assert/strict");
const { EventEmitter, getEventListeners } = require("node:events");
const fs = require("node:fs");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { PassThrough, Readable } = require("node:stream");
const test = require("node:test");
const zlib = require("node:zlib");
const { downloadToFile, fetchUrlBuffer, isAbortError } = require("../src/modules/shared/runtime/download-utils");
const { DownloadManager } = require("../src/modules/shared/runtime/download-manager");
const Releases = require("../src/modules/shared/runtime/github-releases");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-hardening-download-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

// Exercise real file streams without contacting any remote or local server.
function mockRequests(t, responseFactory) {
  let requests = 0;
  t.mock.method(https, "get", (url, options, callback) => {
    requests += 1;
    const response = responseFactory(url, requests);
    response.statusCode ??= 200;
    response.headers ??= {};
    const request = new EventEmitter();
    request.end = () => {};
    request.destroy = error => {
      response.destroy(error);
      process.nextTick(() => request.emit("error", error));
    };
    response.once("close", () => request.emit("close"));
    process.nextTick(() => callback(response));
    return request;
  });
  return () => requests;
}

test("failed download to a directory preserves that directory and its contents", async t => {
  const root = fixture(t);
  const destination = path.join(root, "runtime.zip");
  fs.mkdirSync(destination);
  fs.writeFileSync(path.join(destination, "keep.txt"), "keep");
  mockRequests(t, () => Readable.from([Buffer.from("archive")]));
  await assert.rejects(downloadToFile("https://example.invalid/runtime", destination));
  assert.equal(fs.readFileSync(path.join(destination, "keep.txt"), "utf8"), "keep");
  assert.deepEqual(fs.readdirSync(root), ["runtime.zip"]);
});

test("canceled download preserves the existing destination and closes before cleanup", async t => {
  const root = fixture(t);
  const destination = path.join(root, "runtime.zip");
  fs.writeFileSync(destination, "installed archive");
  const controller = new AbortController();
  const response = new PassThrough();
  mockRequests(t, () => response);
  const pending = downloadToFile("https://example.invalid/runtime", destination, {
    signal: controller.signal,
    onProgress: () => controller.abort()
  });
  const rejected = assert.rejects(pending, isAbortError);
  response.write("partial");
  await rejected;
  assert.equal(fs.readFileSync(destination, "utf8"), "installed archive");
  assert.deepEqual(fs.readdirSync(root), ["runtime.zip"]);
  assert.equal(response.destroyed, true);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("abort during asynchronous file opening leaves no late-created partial file", async t => {
  const root = fixture(t);
  const controller = new AbortController();
  const createWriteStream = fs.createWriteStream;
  t.mock.method(fs, "createWriteStream", (...args) => {
    const stream = createWriteStream(...args);
    controller.abort();
    return stream;
  });
  mockRequests(t, () => Readable.from([Buffer.from("archive")]));
  await assert.rejects(downloadToFile("https://example.invalid/runtime", path.join(root, "runtime.zip"), {
    signal: controller.signal
  }), isAbortError);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(fs.readdirSync(root), []);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("download completes across relative redirects with exact bytes and progress", async t => {
  const root = fixture(t);
  const destination = path.join(root, "runtime.zip");
  const progress = [];
  const controller = new AbortController();
  const requestCount = mockRequests(t, (url, index) => {
    const response = Readable.from(index === 1 ? [] : [Buffer.from("runtime")]);
    if (index === 1) {
      response.statusCode = 302;
      response.headers = { location: "/archive.zip" };
    } else {
      assert.equal(url, "https://example.invalid/archive.zip");
      response.headers = { "content-length": "7" };
    }
    return response;
  });
  assert.deepEqual(await downloadToFile("https://example.invalid/runtime", destination, {
    signal: controller.signal,
    onProgress: value => progress.push(value)
  }), { downloaded: 7, total: 7 });
  assert.equal(fs.readFileSync(destination, "utf8"), "runtime");
  assert.deepEqual(fs.readdirSync(root), ["runtime.zip"]);
  assert.deepEqual(progress.at(-1), { downloaded: 7, total: 7 });
  assert.equal(requestCount(), 2);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("buffer fetch releases abort listeners after every completed response", async t => {
  const controller = new AbortController();
  mockRequests(t, () => Readable.from([Buffer.from("catalog")]));
  for (let i = 0; i < 12; i += 1) {
    const result = await fetchUrlBuffer("https://example.invalid/catalog", { signal: controller.signal });
    assert.equal(result.body.toString(), "catalog");
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  }
});

test("premature response closure rejects file and buffer downloads and removes partial files", async t => {
  const root = fixture(t);
  mockRequests(t, () => {
    const response = new PassThrough();
    response.once("data", () => process.nextTick(() => response.destroy()));
    response.write("incomplete archive");
    return response;
  });
  await assert.rejects(downloadToFile("https://example.invalid/runtime", path.join(root, "runtime.zip")), /premature close/i);
  assert.deepEqual(fs.readdirSync(root), []);
  await assert.rejects(fetchUrlBuffer("https://example.invalid/catalog"), /premature close/i);
});

test("pre-aborted downloads never create a request or a destination file", async t => {
  const root = fixture(t);
  const controller = new AbortController();
  controller.abort();
  const requestCount = mockRequests(t, () => Readable.from([]));
  await assert.rejects(downloadToFile("https://example.invalid/runtime", path.join(root, "runtime.zip"), {
    signal: controller.signal
  }), isAbortError);
  await assert.rejects(fetchUrlBuffer("https://example.invalid/catalog", { signal: controller.signal }), isAbortError);
  assert.equal(requestCount(), 0);
  assert.deepEqual(fs.readdirSync(root), []);
});

test("HTTP failures retain their status code and leave existing files untouched", async t => {
  const root = fixture(t);
  const destination = path.join(root, "runtime.zip");
  fs.writeFileSync(destination, "installed archive");
  mockRequests(t, () => {
    const response = Readable.from([Buffer.from("not found")]);
    response.statusCode = 404;
    return response;
  });
  await assert.rejects(downloadToFile("https://example.invalid/runtime", destination), error => error.statusCode === 404);
  assert.equal(fs.readFileSync(destination, "utf8"), "installed archive");
  assert.deepEqual(fs.readdirSync(root), ["runtime.zip"]);
});

test("GitHub release catalogs reject prematurely closed responses instead of hanging", async t => {
  mockRequests(t, () => {
    const response = new PassThrough();
    response.once("data", () => process.nextTick(() => response.destroy()));
    response.write("[");
    return response;
  });
  let deadline;
  t.after(() => clearTimeout(deadline));
  await assert.rejects(Promise.race([
    Releases.fetchGithubReleases({ owner: "example", repo: "runtime" }),
    new Promise((resolve, reject) => { deadline = setTimeout(() => reject(new Error("Catalog stayed pending")), 1000); })
  ]), /premature close/i);
});

test("pre-aborted GitHub release fetches never create a request", async t => {
  const controller = new AbortController();
  controller.abort();
  const requestCount = mockRequests(t, () => Readable.from([Buffer.from("[]")]));
  await assert.rejects(Releases.fetchGithubReleases({ owner: "example", repo: "runtime", signal: controller.signal }), isAbortError);
  assert.equal(requestCount(), 0);
});

test("GitHub release fetching preserves compressed pagination and release filtering", async t => {
  const requestCount = mockRequests(t, (url, index) => {
    const releases = index === 1
      ? [{ tag_name: "v2.0.0" }, { tag_name: "v3.0.0-beta", prerelease: true }]
      : [{ tag_name: "v1.0.0" }, { tag_name: "draft", draft: true }];
    const response = Readable.from([zlib.gzipSync(Buffer.from(JSON.stringify(releases)))]);
    response.headers = { "content-encoding": "gzip" };
    if (index === 1) response.headers.link = '<https://api.github.com/repos/example/runtime/releases?page=2>; rel="next"';
    return response;
  });
  const releases = await Releases.fetchGithubReleases({ owner: "example", repo: "runtime" });
  assert.deepEqual(releases.map(release => release.tag_name), ["v2.0.0", "v1.0.0"]);
  assert.equal(requestCount(), 2);
});

test("synchronous runner failures clear tasks and allow a retry", async () => {
  const manager = new DownloadManager();
  await assert.rejects(manager.runTask({ dedupeKey: "runtime" }, () => { throw new Error("bad metadata"); }), /bad metadata/);
  assert.deepEqual(manager.list(), []);
  assert.equal(await manager.runTask({ dedupeKey: "runtime" }, () => "retried"), "retried");
});

test("unknown download totals stay unknown", async () => {
  const manager = new DownloadManager();
  let finish;
  const pending = manager.runTask({}, ({ onProgress }) => {
    onProgress({ downloaded: 1, total: null });
    return new Promise(resolve => { finish = resolve; });
  });
  assert.equal(manager.list()[0].total, null);
  finish();
  await pending;
});

test("cancel keeps the dedupe key occupied until the runner finishes cleanup", async () => {
  const manager = new DownloadManager();
  let finish;
  const first = manager.runTask({ dedupeKey: "runtime" }, () => new Promise(resolve => { finish = resolve; }));
  const rejected = assert.rejects(first, isAbortError);
  manager.cancel(manager.list()[0].id);
  const second = manager.runTask({ dedupeKey: "runtime" }, () => { throw new Error("overlapping install"); });
  second.catch(() => {});
  finish("ignored cancellation");
  await rejected;
  assert.strictEqual(second, first);
  assert.deepEqual(manager.list(), []);
});
