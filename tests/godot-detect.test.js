const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const Detect = require("../src/modules/godot/detect");
const { pack, settings } = require("./helpers/godot-pack");

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

// A customized engine's standalone pack: one of Godot's layouts under another
// magic and pack format version.
function customPack(version, { magic = "FORK", packVersion = 77, flags = 0 } = {}) {
  const value = pack({ "project.binary": settings({ "application/config/name": "Fork" }), "main.gdc": Buffer.from("GDSC") },
    { version, flags, offset: 0, trailer: false, fileBase: version >= 2 ? 16 : 0 });
  value.buffer.write(magic, 0, "ascii"); value.buffer.writeUInt32LE(packVersion, 4);
  return value.buffer;
}

// A small Wwise sound bank package: AKPK header, empty language and bank maps,
// one streamed file with a small ID, then its RIFF data.
function soundBankPackage() {
  const header = Buffer.alloc(56); header.write("AKPK", 0, "ascii");
  header.writeUInt32LE(48, 4); header.writeUInt32LE(1, 8); header.writeUInt32LE(4, 12); header.writeUInt32LE(4, 16); header.writeUInt32LE(24, 20);
  header.writeUInt32LE(1, 32); header.writeUInt32LE(1000, 36); header.writeUInt32LE(1, 40); header.writeUInt32LE(2048, 44); header.writeUInt32LE(56, 48);
  const data = Buffer.alloc(2048); for (let i = 0; i < data.length; i++) data[i] = (i * 73 + 41) & 0xff;
  data.write("RIFF", 0, "ascii"); data.writeUInt32LE(2040, 4); data.write("WAVEfmt ", 8, "ascii");
  return Buffer.concat([header, data]);
}

function detectFile(file) {
  return Detect.detectGame({ rootDir: path.dirname(file), inputPath: file, stat: fs.statSync(file) });
}

test("customized-engine packs are recognized through Godot's inline and directory-offset layouts", t => {
  const root = makeTempDir("maclauncher-godot-custom-"); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [version, flags] of [[1, 0], [2, 0], [2, 2], [3, 0]]) {
    const file = path.join(root, `v${version}-${flags}.pck`); fs.writeFileSync(file, customPack(version, { flags }));
    const expected = version === 1 ? { detectedVersion: "3.5.0", detectedMajor: 3, detectedMinor: 5 } : { detectedVersion: "4.5.0", detectedMajor: 4, detectedMinor: 5 };
    assert.deepEqual(Detect.detectPackVersion(file), { ...expected, detectedSource: "custom engine pack header", packCustomMagic: true }, file);
    assert.equal(detectFile(file).moduleData.packCustomMagic, true, file);
  }
  // A standard pack is not marked as customized.
  const standard = path.join(root, "standard.pck"); fs.writeFileSync(standard, pack({ "project.binary": settings({}) }, { offset: 0, trailer: false }).buffer);
  assert.equal(Detect.detectPackVersion(standard).packCustomMagic, undefined);
});

test("a pack-like file without a readable Godot directory is not a customized Godot pack", t => {
  const root = makeTempDir("maclauncher-godot-custom-"); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (name, bytes) => { const file = path.join(root, name); fs.writeFileSync(file, bytes); return file; };
  const soundBank = write("Sounds.pck", soundBankPackage());
  assert.equal(Detect.detectPackVersion(soundBank), null);
  assert.equal(detectFile(soundBank), null);
  // The same pack fails once its first row is unsafe, lies outside the pack or is encrypted.
  const unsafe = customPack(3), rowPath = unsafe.indexOf("res://project.binary"); unsafe.write("res://../ject.binary", rowPath, "ascii");
  const outside = customPack(1), rowData = 84 + 8 + Buffer.byteLength("res://project.binary"); outside.writeBigUInt64LE(BigInt(outside.length), rowData);
  for (const [name, bytes] of [["unsafe.pck", unsafe], ["outside.pck", outside], ["encrypted.pck", customPack(3, { flags: 1 })]]) {
    assert.equal(Detect.detectPackVersion(write(name, bytes)), null, name);
  }
});

test("a release folder's Godot export one folder down is found, preferring its Windows executable", t => {
  const root = makeTempDir("maclauncher-godot-release-"); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const release = path.join(root, "Release"), game = path.join(release, "game"); fs.mkdirSync(game, { recursive: true });
  const exportTo = directory => {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "Game.pck"), pack({ "project.binary": settings({}) }, { offset: 0, trailer: false }).buffer);
    fs.writeFileSync(path.join(directory, "Game.x86_64"), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]));
    fs.writeFileSync(path.join(directory, "Game.exe"), Buffer.from("MZ"));
  };
  fs.writeFileSync(path.join(release, "Launcher.exe"), Buffer.from("MZ launcher"));
  exportTo(game);
  const detected = Detect.detectGame({ rootDir: release, inputPath: release, stat: fs.statSync(release) });
  assert.equal(detected.gamePath, release);
  assert.equal(detected.moduleData.packagedType, "exe-sibling-pck");
  assert.equal(detected.moduleData.packagedPath, path.join(game, "Game.exe"));
  assert.equal(detected.moduleData.packPath, path.join(game, "Game.pck"));
  // A second export with its own pack is ambiguous, and a deeper one is out of reach.
  exportTo(path.join(release, "demo"));
  assert.equal(Detect.detectGame({ rootDir: release, inputPath: release, stat: fs.statSync(release) }), null);
  const deep = path.join(root, "Deep"); exportTo(path.join(deep, "bin", "game"));
  assert.equal(Detect.detectGame({ rootDir: deep, inputPath: deep, stat: fs.statSync(deep) }), null);
});
