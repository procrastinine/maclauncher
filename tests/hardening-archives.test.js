const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const Asar = require("../src/modules/shared/runtime/asar");
const Zip = require("../src/modules/shared/runtime/zip");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-hardening-archive-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeAsar(file, files, body = Buffer.alloc(0)) {
  const json = Buffer.from(JSON.stringify({ files }));
  const paddedLength = Math.ceil(json.length / 4) * 4;
  const header = Buffer.alloc(16 + paddedLength);
  header.writeUInt32LE(4, 0);
  header.writeUInt32LE(paddedLength + 8, 4);
  header.writeUInt32LE(paddedLength + 4, 8);
  header.writeUInt32LE(json.length, 12);
  json.copy(header, 16);
  fs.writeFileSync(file, Buffer.concat([header, body]));
}

test("ASAR traversal is rejected before any archive files are written", t => {
  const root = fixture(t);
  const archive = path.join(root, "game.asar");
  const destination = path.join(root, "extract");
  writeAsar(archive, { "safe.txt": { size: 1, offset: "0" }, "../outside.txt": { size: 1, offset: "0" } }, Buffer.from("x"));
  assert.throws(() => Asar.extractAsar(archive, destination), /path|name/i);
  assert.equal(fs.existsSync(path.join(root, "outside.txt")), false);
  assert.equal(fs.existsSync(path.join(destination, "safe.txt")), false);
});

test("ASAR extraction cannot write through existing directory or file symlinks", t => {
  const root = fixture(t);
  const archive = path.join(root, "game.asar");
  const destination = path.join(root, "extract");
  const outside = path.join(root, "outside");
  fs.mkdirSync(destination);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "save.txt"), "original");
  fs.symlinkSync(outside, path.join(destination, "linked"));
  writeAsar(archive, { linked: { files: { "save.txt": { size: 1, offset: "0" } } } }, Buffer.from("x"));
  assert.throws(() => Asar.extractAsar(archive, destination), /symlink|symbolic/i);
  assert.equal(fs.readFileSync(path.join(outside, "save.txt"), "utf8"), "original");
  fs.symlinkSync(path.join(outside, "save.txt"), path.join(destination, "save.txt"));
  writeAsar(archive, { "save.txt": { size: 1, offset: "0" } }, Buffer.from("x"));
  assert.throws(() => Asar.extractAsar(archive, destination), /symlink|symbolic/i);
  assert.equal(fs.readFileSync(path.join(outside, "save.txt"), "utf8"), "original");
});

test("ASAR truncated file ranges are rejected instead of padded with zero bytes", t => {
  const root = fixture(t);
  const archive = path.join(root, "game.asar");
  const destination = path.join(root, "extract");
  writeAsar(archive, { "index.html": { size: 8, offset: "0" } }, Buffer.from("short"));
  assert.throws(() => Asar.extractAsar(archive, destination), /range|truncated|size/i);
  assert.equal(fs.existsSync(path.join(destination, "index.html")), false);
});

test("ASAR malformed offsets and oversized headers fail before allocating file buffers", t => {
  const root = fixture(t);
  const archive = path.join(root, "game.asar");
  for (const offset of ["-1", "invalid", "0.5", "9007199254740992"]) {
    writeAsar(archive, { "file.txt": { size: 1, offset } }, Buffer.from("x"));
    assert.throws(() => Asar.extractAsar(archive, path.join(root, "extract")), /offset|range/i);
  }
  const header = Buffer.alloc(16);
  header.writeUInt32LE(32, 4);
  header.writeUInt32LE(64, 12);
  fs.writeFileSync(archive, header);
  const allocate = Buffer.alloc;
  t.mock.method(Buffer, "alloc", size => {
    assert.ok(size <= 16, "must validate archive header size before allocation");
    return allocate(size);
  });
  assert.throws(() => Asar.readAsarHeader(archive), /header|size/i);
});

test("ASAR nested and empty packed files still extract byte-for-byte", t => {
  const root = fixture(t);
  const archive = path.join(root, "game.asar");
  const destination = path.join(root, "extract");
  writeAsar(archive, { www: { files: { "index.html": { size: 3, offset: "0" }, empty: { size: 0, offset: "3" } } } }, Buffer.from([0, 255, 42]));
  assert.equal(Asar.extractAsar(archive, destination), true);
  assert.deepEqual(fs.readFileSync(path.join(destination, "www", "index.html")), Buffer.from([0, 255, 42]));
  assert.equal(fs.statSync(path.join(destination, "www", "empty")).size, 0);
});

function makeZip(body, comment = Buffer.alloc(0), prefix = Buffer.alloc(0)) {
  const name = Buffer.from("main.lua");
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(body.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(body.length, 24);
  central.writeUInt16LE(name.length, 28);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + name.length, 12);
  eocd.writeUInt32LE(local.length + name.length + body.length, 16);
  eocd.writeUInt16LE(comment.length, 20);
  return Buffer.concat([prefix, local, name, body, central, name, eocd, comment]);
}

test("ZIP footer scan ignores false EOCD signatures inside archive comments", t => {
  const root = fixture(t);
  const file = path.join(root, "game.exe");
  const comment = Buffer.alloc(40);
  comment.writeUInt32LE(0x06054b50, 0);
  fs.writeFileSync(file, makeZip(Buffer.from("return 42"), comment, Buffer.from("MZ-prefix")));
  const archive = Zip.readZipEntries(file);
  assert.equal(archive.info.zipBase, 9);
  assert.deepEqual(archive.entries.map(entry => entry.name), ["main.lua"]);
  assert.equal(Zip.readZipEntryBuffer(file, "main.lua").toString(), "return 42");
});

test("ZIP entry reader returns an empty buffer for a valid empty stored file", t => {
  const root = fixture(t);
  const file = path.join(root, "game.love");
  fs.writeFileSync(file, makeZip(Buffer.alloc(0)));
  assert.deepEqual(Zip.readZipEntryBuffer(file, "main.lua"), Buffer.alloc(0));
});
