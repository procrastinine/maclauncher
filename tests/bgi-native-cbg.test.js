const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const { cbg } = require("./helpers/bgi-cbg-fixture.cjs");
const Overlay = require("../src/modules/bgi/native/versions/modern-vm-v3/source-overlay");
const Base = require("../src/modules/bgi/native/source-overlay");

let directory, driver, priorDriver;
test.before(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "bgi-cbg-"));
  const source = path.join(directory, "driver.c");
  fs.writeFileSync(source, `#include "cbg-bitmap.h"
#include <stdio.h>
#include <stdlib.h>
int main(int argc,char**argv){if(argc!=2)return 2;FILE*f=fopen(argv[1],"rb");if(!f)return 2;
if(fseek(f,0,SEEK_END))return 2;long n=ftell(f);if(n<0||n>32*1024*1024||fseek(f,0,SEEK_SET))return 2;
unsigned char*b=malloc(n?n:1);if(!b||fread(b,1,n,f)!=(size_t)n)return 2;fclose(f);
MLBGI_CbgBitmap image={0};int okay=MLBGI_DecodeCbgV2(b,n,&image);free(b);if(!okay)return 2;
printf("%u %u %d\\n",image.width,image.height,image.hasAlpha);fwrite(image.rgba,4,(size_t)image.width*image.height,stdout);free(image.rgba);return 0;}
`);
  const native = path.resolve("src/modules/bgi/native");
  for (const [name, codec] of [["v3", path.join(native, "versions/modern-vm-v3/cbg-bitmap.c")], ["v2", path.join(native, "cbg-bitmap.c")]]) {
    const binary = path.join(directory, name);
    const build = spawnSync("clang", ["-std=c11", "-O1", "-fsanitize=address,undefined", "-fno-omit-frame-pointer", "-I", native,
      codec, source, "-o", binary], { encoding: "utf8", timeout: 30000 });
    assert.ifError(build.error); assert.equal(build.status, 0, build.stderr);
    if (name === "v3") driver = binary; else priorDriver = binary;
  }
});
test.after(() => { if (directory) fs.rmSync(directory, { recursive: true, force: true }); });

function decode(bytes, binary = driver) {
  const file = path.join(directory, "image.bin"); fs.writeFileSync(file, bytes);
  const run = spawnSync(binary, [file], { timeout: 10000, maxBuffer: 40 * 1024 * 1024,
    env: { ...process.env, ASAN_OPTIONS: "detect_leaks=0", UBSAN_OPTIONS: "halt_on_error=1" } });
  assert.ifError(run.error); assert.doesNotMatch(run.stderr.toString(), /runtime error|AddressSanitizer/);
  return run;
}

test("CBG2 accepts a skipped row prefix overlapping metadata while keeping entropy outside it", () => {
  for (const options of [{}, { alias: 4 }, { width: 9, height: 9, alias: 1 }, { nonAlphaWord: 0 }]) {
    const value = cbg(options), run = decode(value.bytes);
    assert.equal(run.status, 0, run.stderr.toString());
    const headerEnd = run.stdout.indexOf(10), pixels = run.stdout.subarray(headerEnd + 1);
    assert.equal(run.stdout.subarray(0, headerEnd).toString(), `${value.width} ${value.height} 0`);
    assert.equal(pixels.length, value.width * value.height * 4);
    for (let i = 0; i < pixels.length; i += 4) assert.deepEqual([...pixels.subarray(i, i + 4)], [128, 128, 128, 255]);
  }
  assert.equal(decode(cbg({ alias: 4 }).bytes, priorDriver).status, 2);
  assert.equal(decode(cbg().bytes, priorDriver).status, 0);
});

test("CBG2 RGB and alpha streams retain analytic color, crop and per-pixel transparency", () => {
  for (const bpp of [24, 32]) {
    const value = cbg({ bpp, alias: 4 }), run = decode(value.bytes);
    assert.equal(run.status, 0, run.stderr.toString());
    const headerEnd = run.stdout.indexOf(10), pixels = run.stdout.subarray(headerEnd + 1);
    assert.equal(run.stdout.subarray(0, headerEnd).toString(), `${value.width} ${value.height} ${Number(bpp === 32)}`);
    for (let y = 0; y < value.height; y++) for (let x = 0; x < value.width; x++) {
      const at = (y * value.width + x) * 4, original = y * value.paddedWidth + x;
      assert.deepEqual([...pixels.subarray(at, at + 3)], [128, 128, 128]);
      assert.equal(pixels[at + 3], bpp === 32 ? (original * 17 + (original >>> 3)) & 255 : 255);
    }
  }
});

test("CBG2 rejects payload overlap, invalid sizes, trees, versions and alpha backreferences", () => {
  const cases = [];
  function altered(options, change) { const value = cbg(options), bytes = Buffer.from(value.bytes); change(bytes, value); cases.push(bytes); }
  altered({ alias: 4 }, (b, v) => b.writeUInt32LE(v.endTable - 176 - v.prefix - 1, v.offsetTableAt));
  altered({}, (b, v) => b.writeUInt32LE(0xfffffffe, v.offsetTableAt));
  altered({}, (b, v) => b.writeUInt32LE(v.endTable - 176 - 1, v.offsetTableAt + 4));
  altered({}, (b, v) => b.writeUInt32LE(b.readUInt32LE(v.offsetTableAt), v.offsetTableAt + 4));
  altered({}, b => { b[48] ^= 1; });
  altered({}, b => b.writeUInt16LE(3, 46));
  altered({}, b => b.writeUInt32LE(16, 20));
  altered({}, b => { b.writeUInt16LE(8192, 16); b.writeUInt16LE(8192, 18); });
  altered({ alias: 4 }, (b, v) => { b[v.endTable] ^= 1; });
  altered({ alias: 4 }, (b, v) => { b[v.endTable + 2] |= 0x80; });
  altered({ bpp: 32 }, (b, v) => b.writeUInt32LE(v.endTable - 177, v.offsetTableAt + v.rows * 4));
  altered({ bpp: 32 }, (b, v) => b.writeUInt32LE(2, 176 + b.readUInt32LE(v.offsetTableAt + v.rows * 4)));
  altered({ bpp: 32 }, (b, v) => { const at = 176 + b.readUInt32LE(v.offsetTableAt + v.rows * 4); b[at + 4] = 1; b.writeUInt16LE(0, at + 5); });
  const valid = cbg({ alias: 4 }).bytes; cases.push(valid.subarray(0, valid.length - 1));
  for (const bytes of cases) assert.equal(decode(bytes).status, 2);
});

test("BGI v3 stages a distinct guarded codec/probe version without changing v2 or upstream inputs", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bgi-cbg-stage-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceRoot = path.resolve("src/external/openbgi"), destination = path.join(root, "source");
  const receipt = Overlay.stageSource({ sourceRoot, destination });
  assert.equal(receipt.version, "0.0.1-build734-mac-vm-v3");
  assert.equal(receipt.parentVersion, Base.VERSION);
  assert.equal(Overlay.sha256(fs.readFileSync(path.join(destination, "src/cbg-bitmap.c"))),
    Overlay.sha256(fs.readFileSync(path.resolve("src/modules/bgi/native/versions/modern-vm-v3/cbg-bitmap.c"))));
  assert.match(fs.readFileSync(path.join(destination, "src/main.c"), "utf8"), /0\.0\.1-build734-mac-vm-v3/);
  assert.doesNotThrow(() => Overlay.verifyBase());
  const oldStage = path.join(root, "parent"); Base.stageSource({ sourceRoot, destination: oldStage });
  const codecBefore = fs.readFileSync(path.join(oldStage, "src/cbg-bitmap.c"));
  fs.appendFileSync(path.join(oldStage, "src/main.c"), "\n");
  assert.throws(() => Overlay.applyCodec(oldStage), /source context changed/);
  assert.deepEqual(fs.readFileSync(path.join(oldStage, "src/cbg-bitmap.c")), codecBefore);
});
