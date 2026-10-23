const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { EventEmitter } = require("node:events"), { PassThrough } = require("node:stream");
const Raster = require("../src/modules/catsystem2/runtime/coretext-raster"), { createTextCache } = require("../src/modules/catsystem2/runtime/text-cache");
const font = Buffer.alloc(20), request = { width: 2, height: 2, fontSize: 24, margin: [0, 0, 0, 0], color: [30, 60, 90], lineSpacing: 0, letterSpacing: 0, shadow: "none", alignment: "left", text: "A" };
const helper = { version: Raster.VERSION, protocolVersion: 1, executablePath: "/included/coretext", binarySha256: "a".repeat(64), systemVersion: "13.0.1" };
const receipt = { schemaVersion: 1, protocolVersion: "CSTR1", width: 2, height: 2, rgbaBytes: 16, glyphs: 1, lines: 1, consumedUtf16: 1, clipped: false, endX: 1, endY: 0 };
function packet(record = receipt, pixels = Buffer.alloc(16)) { const text = Buffer.from(JSON.stringify(record)), header = Buffer.alloc(12); header.write("CSTR"); header.writeUInt32LE(text.length, 4); header.writeUInt32LE(pixels.length, 8); return Buffer.concat([header, text, pixels]); }

test("text renderer accepts only bounded explicit UTF-8 layout and validates native geometry/metrics", () => {
  const original = Buffer.from(font), input = Raster.encodeRequest(request, font); assert.equal(input.toString("ascii", 0, 4), "CSTR");
  assert.deepEqual(font, original); assert.deepEqual(Raster.inspectRaster(packet(), request).rgba, Buffer.alloc(16));
  for (const change of [{ shadow: "outline" }, { text: "a\t" }, { text: "\ud800" }, { text: "\\ruby" }, { margin: [1, 0, 1, 0] }, { width: 65535 }, { optional: true }])
    assert.throws(() => Raster.encodeRequest({ ...request, ...change }, font), /unsupported|UTF-8/);
  for (const change of [{ protocolVersion: "CSTR2" }, { width: 3 }, { glyphs: -1 }, { clipped: 1 }, { consumedUtf16: 5 }, { endX: Infinity }, { ignored: true }])
    assert.throws(() => Raster.inspectRaster(packet({ ...receipt, ...change }), request), /geometry or metrics/);
  assert.throws(() => Raster.inspectRaster(Buffer.concat([packet(), Buffer.from([0])]), request), /lengths disagree/);
});

test("text renderer waits for its child's close and rejects partial pixels after native failure", async () => {
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
  let completed = false; const pending = Raster.renderText(helper, request, font, { spawnChild: () => child }).then(() => { completed = true; });
  child.stdout.emit("data", packet()); await new Promise(resolve => setImmediate(resolve)); assert.equal(completed, false);
  child.emit("close", 0); await pending; assert.equal(completed, true);
  const failed = new EventEmitter(); failed.stdin = new PassThrough(); failed.stdout = new PassThrough(); failed.stderr = new PassThrough(); failed.kill = () => {};
  const rejected = assert.rejects(Raster.renderText(helper, request, font, { spawnChild: () => failed }), /corrupt or unsupported/);
  failed.stdout.emit("data", packet()); failed.emit("close", 3); await rejected;
});

test("derived text cache reuses pixels, preserves source fonts and isolates font/platform identities", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cat-text-cache-")); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let renders = 0; const render = async () => { renders++; return Raster.inspectRaster(packet(), request); };
  const cache = await createTextCache({ cacheRoot: directory, helper, render, arch: "arm64" }), before = Buffer.from(font);
  const first = await cache.get(font, request), second = await cache.get(font, request); assert.equal(first.reused, false); assert.equal(second.reused, true); assert.equal(renders, 1); assert.deepEqual(font, before);
  const changedFont = Buffer.from(font); changedFont[0] = 1; const other = await cache.get(changedFont, request); assert.notEqual(other.key, first.key); assert.equal(other.rgbaPath, first.rgbaPath);
  const nextSystem = await createTextCache({ cacheRoot: directory, helper: { ...helper, systemVersion: "14.0" }, render, arch: "arm64" });
  assert.notEqual((await nextSystem.get(font, request)).key, first.key);
  const metadata = JSON.parse(fs.readFileSync(path.join(directory, "font-text", first.key + ".json"))); assert.equal(Object.hasOwn(metadata.identity.layout, "text"), false);
  fs.writeFileSync(first.rgbaPath, Buffer.alloc(16, 1)); await assert.rejects(cache.get(font, request), /pixels changed/);
});

test("text cache rejects escaping files and aborted work without original/font copies", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cat-text-cache-")); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const cache = await createTextCache({ cacheRoot: directory, helper, arch: "arm64", render: async () => Raster.inspectRaster(packet(), request) });
  const first = await cache.get(font, request), target = path.join(directory, "outside"); fs.writeFileSync(target, Buffer.alloc(16)); fs.unlinkSync(first.rgbaPath); fs.symlinkSync(target, first.rgbaPath);
  await assert.rejects(cache.get(font, request), { code: "ELOOP" });
  const abort = new AbortController(); abort.abort(); const cancelled = await createTextCache({ cacheRoot: path.join(directory, "cancelled"), helper, signal: abort.signal, arch: "arm64" });
  await assert.rejects(cancelled.get(font, request), { name: "AbortError" }); assert.deepEqual(fs.readdirSync(path.join(directory, "cancelled", "font-text")), []);
});
