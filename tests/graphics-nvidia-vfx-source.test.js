// Required first: it replaces the network functions before modules load.
const Harness = require("./helpers/future-upstream.cjs");
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const Source = require("../src/modules/shared/reshade/neural/nvidia-vfx-source"), Zip = require("../src/modules/shared/runtime/zip");
const { writeZipArchive } = require("./helpers/zip-fixture");
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

// A wheel with one deflated model entry, served in byte ranges by its publisher.
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nvidia-vfx-")));
  t.after(() => { Harness.network.routes = null; fs.rmSync(root, { recursive: true, force: true }); });
  const model = Buffer.alloc(256 * 1024); for (let index = 0; index < model.length; index++) model[index] = index * 7 % 251;
  const wheel = path.join(root, "nvidia_vfx-1.0.0-py3-none-any.whl"), entry = "nvidia/vfx/models/model.bin";
  writeZipArchive(wheel, [{ name: "nvidia/vfx/__init__.py", data: "" }, { name: entry, data: model, deflate: true }]);
  const bytes = fs.readFileSync(wheel), fd = fs.openSync(wheel, "r");
  let rows; try { rows = Zip.readCentralDirectory(fd, Zip.findZipEocd(fd)); } finally { fs.closeSync(fd); }
  const listed = rows.find(row => row.name === entry), url = "https://pypi.nvidia.com/nvidia-vfx/nvidia_vfx-1.0.0-py3-none-any.whl";
  const row = { transport: "nvidia-vfx-entry", url, file: "model.bin", bytes: model.length, sha256: sha(model),
    archive: { entry, method: 8, bytes: bytes.length, offset: listed.localHeaderOffset, compressedBytes: listed.compressedSize, sha256: sha(bytes) } };
  const ranges = [];
  const serve = served => (_url, { headers = {} } = {}) => {
    const [, begin, end] = /^bytes=(\d+)-(\d+)$/.exec(headers.Range).map(Number); ranges.push([begin, end]);
    return { status: 206, headers: { "content-range": `bytes ${begin}-${end}/${served.length}` }, body: served.subarray(begin, end + 1) };
  };
  return { root, model, bytes, row, ranges, serve };
}

test("a declared NVIDIA wheel entry is read in byte ranges and checked against its model identity", async t => {
  const f = fixture(t), target = path.join(f.root, "model.bin");
  Harness.network.routes = { [f.row.url]: f.serve(f.bytes) };
  const result = await Source.downloadEntry(f.row, target);
  assert.deepEqual(fs.readFileSync(target), f.model);
  assert.equal(result.sha256, f.row.sha256);
  assert.ok(f.ranges.every(([begin, end]) => end - begin < 4 << 20), "every request is bounded");
  assert.ok(f.ranges.every(([begin]) => begin >= f.row.archive.offset), "only the declared entry is read");
});

test("a changed NVIDIA wheel or model entry installs nothing and names the entry", async t => {
  const f = fixture(t);
  // The publisher replaced the wheel: its size no longer matches the declared offsets.
  Harness.network.routes = { [f.row.url]: f.serve(Buffer.concat([f.bytes, Buffer.from("appended")])) };
  await assert.rejects(Source.downloadEntry(f.row, path.join(f.root, "replaced.bin")), /NVIDIA package changed/);
  assert.equal(fs.existsSync(path.join(f.root, "replaced.bin")), false);
  Harness.network.routes = { [f.row.url]: f.serve(f.bytes) };
  await assert.rejects(Source.downloadEntry({ ...f.row, sha256: "0".repeat(64) }, path.join(f.root, "other.bin")),
    /NVIDIA model entry nvidia\/vfx\/models\/model\.bin is not the selected model/);
  assert.equal(fs.existsSync(path.join(f.root, "other.bin")), false);
  // A publisher that does not answer byte ranges cannot provide the entry.
  Harness.network.routes = { [f.row.url]: f.bytes };
  await assert.rejects(Source.downloadEntry(f.row, path.join(f.root, "whole.bin")), /could not be read in parts/);
});
