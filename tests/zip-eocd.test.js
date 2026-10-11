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
