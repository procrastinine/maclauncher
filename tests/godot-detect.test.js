const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const Detect = require("../src/modules/godot/detect");

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function buildPckHeader({ packVersion = 3, major = 4, minor = 2, patch = 1 } = {}) {
  const buf = Buffer.alloc(20);
  buf.write("GDPC", 0, 4, "ascii");
  buf.writeUInt32LE(packVersion, 4);
  buf.writeUInt32LE(major, 8);
  buf.writeUInt32LE(minor, 12);
  buf.writeUInt32LE(patch, 16);
  return buf;
}

test("readPckHeader parses engine version", () => {
  const root = makeTempDir("maclauncher-godot-pck-");
  try {
    const filePath = path.join(root, "game.pck");
    fs.writeFileSync(filePath, buildPckHeader({ major: 4, minor: 1, patch: 2 }));
    const header = Detect.__test.readPckHeader(filePath, 0);
    assert.ok(header);
    assert.equal(header.engineMajor, 4);
    assert.equal(header.engineMinor, 1);
    assert.equal(header.enginePatch, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("findEmbeddedPck locates trailer offset", () => {
  const root = makeTempDir("maclauncher-godot-embed-");
  try {
    const filePath = path.join(root, "game.exe");
    const padding = Buffer.alloc(16, 0);
    const pack = Buffer.concat([buildPckHeader({ major: 3, minor: 5, patch: 0 }), Buffer.alloc(8, 1)]);
    const size = pack.length;
    const trailer = Buffer.alloc(12);
    trailer.writeBigUInt64LE(BigInt(size), 0);
    trailer.write("GDPC", 8, 4, "ascii");
    fs.writeFileSync(filePath, Buffer.concat([padding, pack, trailer]));

    const embedded = Detect.__test.findEmbeddedPck(filePath);
    assert.ok(embedded);
    assert.equal(embedded.offset, padding.length);
    assert.equal(embedded.size, size);

    const header = Detect.__test.readPckHeader(filePath, embedded.offset);
    assert.ok(header);
    assert.equal(header.engineMajor, 3);
    assert.equal(header.engineMinor, 5);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("formatDetectedVersion marks old patch versions as unknown", () => {
  assert.equal(Detect.__test.formatDetectedVersion(3, 1, 0), "3.1.x");
  assert.equal(Detect.__test.formatDetectedVersion(3, 2, 0), "3.2.0");
});
