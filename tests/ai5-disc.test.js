const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), cp = require("node:child_process");
const Disc = require("../src/modules/ai5/disc"), Inspect = require("../src/modules/ai5/inspect");
const { archiveFixture } = require("./helpers/ai5-fixture"), { isoFixture } = require("./helpers/iso-fixture");

function temporary(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai5-disc-")); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
function create(root, fixture) { const file = path.join(root, "GAME.bin"); fs.writeFileSync(file, fixture.bytes); return file; }

test("AI5 reads ISO9660 and raw2352 original ranges without extracting archives", t => {
  const root = temporary(t), payload = Buffer.from(Array.from({ length: 6500 }, (_, i) => i & 255));
  for (const raw of [false, true]) {
    const fixture = isoFixture({ raw, files: { "BG.ARC": payload } }), file = create(root, fixture), image = Disc.openImage(file);
    try { const item = image.entries.find(item => item.name === "BG.ARC"); assert.deepEqual(image.read(item.extent * 2048 + 1900, 4500), payload.subarray(1900, 6400)); assert.equal(image.sectorBytes, raw ? 2352 : 2048); assert.equal(image.entries.length, 3); }
    finally { image.close(); }
  }
});

test("AI5 rejects malformed, cyclic, ambiguous and out-of-image ISO metadata", t => {
  const root = temporary(t);
  const mutations = [
    f => { f.bytes[f.blockOffset(16) + 1] = 0; },
    f => { f.bytes.writeUInt32LE(99999, f.blockOffset(16) + 80); f.bytes.writeUInt32BE(99999, f.blockOffset(16) + 84); },
    f => { const at = f.root + 68; f.bytes.writeUInt32LE(20, at + 2); f.bytes.writeUInt32BE(20, at + 6); },
    f => { f.bytes[f.root + 68 + 25] |= 0x80; },
    f => { f.bytes[f.directory + 68] = 2; },
    f => { f.bytes.writeUInt32BE(9999, f.directory + 68 + 6); },
    f => { f.bytes[f.directory + 68 + 33] = 47; }
  ];
  for (const mutation of mutations) { const fixture = isoFixture(); mutation(fixture); assert.throws(() => Disc.openImage(create(root, fixture)), /ISO|disc/); }
});

test("AI5 selects a disc directory by embedded profile and creates only tiny descriptors and mutable save seeds", t => {
  const root = temporary(t), arc = archiveFixture().bytes, fixture = isoFixture({ raw: true, files: { "BG.ARC": arc, "MES.ARC": arc, "MUSIC.ARC": arc, "FLAG00": Buffer.alloc(8192, 7) } });
  create(root, fixture); fs.writeFileSync(path.join(root, "zMES.ARC"), arc);
  fs.writeFileSync(path.join(root, "AI5ENG.INI"), "[CONFIG]\nTITLE=YU-NO - The Girl that Chants Love at the Edge of the World\n[FILE]\nbARCMES=1\nARCMESNAME=zMES.ARC\nbARCBGM=1\nARCBGMNAME=MUSIC.ARC\n");
  const data = Inspect.inspectGame(root), disc = Disc.matchingData(root, "yuno-eng");
  assert.equal(disc.originalProfile, "yuno"); assert.equal(disc.directory, "GAME"); assert.equal(Disc.matchingData(root, "isaku"), null);
  const privateRoot = path.join(root, "private"), saves = path.join(privateRoot, "saves"); fs.mkdirSync(saves, { recursive: true });
  const resources = Disc.prepareResources(root, data, "yuno-eng", privateRoot, saves, disc);
  assert.equal(resources.descriptors.length, 3); assert.ok(resources.descriptors.every(item => item.descriptorBytes < 512));
  assert.equal(resources.references.find(item => item.type === "bgm").forceArchive, true);
  assert.equal(resources.env.MACLAUNCHER_AI5_MES_BASE, path.join(privateRoot, "disc/mes.ARC"));
  assert.equal(fs.readFileSync(path.join(saves, "FLAG00"))[0], 7);
  fs.writeFileSync(path.join(saves, "FLAG00"), "player progress"); Disc.prepareResources(root, data, "yuno-eng", privateRoot, saves, disc);
  assert.equal(fs.readFileSync(path.join(saves, "FLAG00"), "utf8"), "player progress");
  fs.rmSync(path.join(saves, "FLAG00")); fs.writeFileSync(path.join(root, "FLAG00"), "original portable player progress");
  Disc.prepareResources(root, data, "yuno-eng", privateRoot, saves, disc);
  assert.equal(fs.existsSync(path.join(saves, "FLAG00")), false, "native first access must seed the original portable save rather than overwrite it with disc defaults");
  fs.writeFileSync(path.join(root, "SECOND.iso"), fixture.bytes); assert.throws(() => Disc.matchingData(root, "yuno-eng"), /ambiguous/);
});

test("native AI5 funopen stream reads and seeks the original raw image and rejects invalid descriptors", { skip: process.platform !== "darwin" }, t => {
  const root = temporary(t), payload = Buffer.from(Array.from({ length: 6500 }, (_, i) => (i * 13) & 255)), fixture = isoFixture({ raw: true, files: { "BG.ARC": payload } }), imagePath = create(root, fixture);
  const owned = path.join(root, "private"), descriptor = path.join(owned, "bg.ARC"); fs.mkdirSync(owned);
  Disc.writeDescriptor(descriptor, { imagePath, sectorBytes: 2352, dataOffset: 16 }, fixture.positions["BG.ARC"]);
  const source = path.join(root, "stream.c"), executable = path.join(root, "stream");
  fs.writeFileSync(source, '#include <stdio.h>\n#define file_open_utf8 fopen\n#include "' + path.resolve(__dirname, "../src/modules/ai5/runtime/macos-disc.h") + '"\nint main(int argc,char **argv) { bool virtual_file; FILE *f=maclauncher_ai5_archive_open(argv[1],&virtual_file); if(!f||!virtual_file)return 2; if(fseek(f,0,SEEK_END)||ftell(f)!=6500||fseek(f,1900,SEEK_SET))return 3; char b[4500]; if(fread(b,sizeof(b),1,f)!=1)return 4; fwrite(b,sizeof(b),1,stdout); fclose(f); return 0; }\n');
  cp.execFileSync("/usr/bin/clang", ["-std=c11", source, "-o", executable], { timeout: 30000 });
  const env = { ...process.env, MACLAUNCHER_AI5_RESOURCE_DIR: owned };
  assert.deepEqual(cp.execFileSync(executable, [descriptor], { env }), payload.subarray(1900, 6400));
  const before = fs.readFileSync(imagePath); fs.writeFileSync(descriptor, "invalid descriptor");
  assert.equal(cp.spawnSync(executable, [descriptor], { env }).status, 2);
  assert.deepEqual(fs.readFileSync(imagePath), before);
});
