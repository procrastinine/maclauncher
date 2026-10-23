const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { writeZipArchive } = require("./helpers/zip-fixture");
const Zip = require("../src/modules/shared/runtime/zip");

function executable(t, prefixBytes, comment = Buffer.alloc(0)) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-prefixed-zip-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "Example.exe");
  const prefix = Buffer.alloc(prefixBytes); prefix.write("MZ");
  writeZipArchive(file, [
    { name: "builder_config.json", data: "{}" },
    { name: "tyrano/plugins/kag/kag.js", data: 'TYRANO_ENGINE_VERSION = "5.10";' },
    { name: "index.html", data: "<html></html>" }
  ], { prefix, comment });
  return file;
}

function verifyTyranoExe(filePath, expectedBase) {
  const result = Zip.readZipEntries(filePath);
  assert.ok(result);
  assert.equal(result.info.zipBase, expectedBase);
  assert.deepEqual(result.entries.map(entry => entry.name), [
    "builder_config.json", "tyrano/plugins/kag/kag.js", "index.html"
  ]);
}

test("zip EOCD scan reads a Tyrano central directory after an executable prefix", t => {
  verifyTyranoExe(executable(t, 512), 512);
});

test("zip EOCD scan ignores a footer-shaped sequence inside an archive comment", t => {
  const comment = Buffer.alloc(64, 0x58), fakeFooter = Buffer.alloc(22);
  fakeFooter.writeUInt32LE(0x06054b50); fakeFooter.copy(comment, 16);
  verifyTyranoExe(executable(t, 4096, comment), 4096);
});

test("ZIP64 reads more than 65535 classes with a prefix and extensible directory record", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-zip64-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "converted.jar"), count = 65536, bytes = Buffer.from("cafebabe", "hex");
  writeZipArchive(file, Array.from({ length: count }, (_, index) => ({ name: `app/Class${index}.class`, data: bytes })),
    { prefix: Buffer.alloc(512), zip64Extension: Buffer.alloc(12) });
  const archive = Zip.readZipEntries(file);
  assert.equal(archive.info.entries, count);
  assert.equal(archive.entries.length, count);
  assert.equal(archive.info.zipBase, 512);
  assert.deepEqual(Zip.readZipEntryBuffer(file, `app/Class${count - 1}.class`), bytes);
  const classic = path.join(root, "classic-limit.jar");
  writeZipArchive(classic, Array.from({ length: 65535 }, (_, index) => ({ name: `Class${index}.class` })), { zip64: false });
  assert.equal(Zip.readZipEntries(classic).entries.length, 65535);
});

test("ZIP64 entry metadata preserves offsets and rejects unsafe or out-of-file directory bounds", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-zip64-bounds-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "entry.zip");
  writeZipArchive(file, [{ name: "sample.class", data: "class bytes" }], { zip64: true, zip64Entries: true });
  assert.equal(Zip.readZipEntryBuffer(file, "sample.class").toString(), "class bytes");
  const original = fs.readFileSync(file), record = original.length - 22 - 20 - 56;
  for (const [offset, value] of [[record + 32, 2n ** 60n], [record + 40, BigInt(original.length)],
    [record + 48, BigInt(original.length)], [original.length - 22 - 20 + 8, BigInt(original.length)]]) {
    const invalid = Buffer.from(original); invalid.writeBigUInt64LE(value, offset); fs.writeFileSync(file, invalid);
    assert.equal(Zip.readZipEntries(file), null);
  }
});
