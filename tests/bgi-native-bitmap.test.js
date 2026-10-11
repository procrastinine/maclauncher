const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");

let root, binary;
test.before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bgi-bitmap-")); binary = path.join(root, "decode");
  const driver = path.join(root, "decode.c");
  fs.writeFileSync(driver, `#include "raw-bitmap.h"
#include <stdio.h>
#include <stdlib.h>
int main(int n,char**a){if(n!=2)return 2;FILE*f=fopen(a[1],"rb");if(!f)return 2;
if(fseek(f,0,SEEK_END))return 2;long z=ftell(f);if(z<0||z>64*1024*1024||fseek(f,0,SEEK_SET))return 2;
unsigned char*b=malloc(z?z:1);if(!b||fread(b,1,z,f)!=(size_t)z)return 2;fclose(f);MLBGI_RawBitmap image={0};
int ok=MLBGI_DecodeRawBitmap(b,z,&image);free(b);if(!ok)return 2;
printf("%u %u\\n",image.width,image.height);fwrite(image.rgba,4,(size_t)image.width*image.height,stdout);free(image.rgba);return 0;}
`);
  const build = spawnSync("clang", ["-std=c11", "-fsanitize=address,undefined", "-I", path.resolve("src/modules/bgi/native"),
    path.resolve("src/modules/bgi/native/raw-bitmap.c"), driver, "-o", binary], { encoding: "utf8", timeout: 30000 });
  assert.ifError(build.error); assert.equal(build.status, 0, build.stderr);
});
test.after(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });
function image(width, height, bits, pixels, extra = {}) {
  const header = Buffer.alloc(16); header.writeUInt16LE(width); header.writeUInt16LE(height, 2); header.writeUInt32LE(bits, 4);
  if (extra.reserved) header.writeUInt32LE(extra.reserved, 8);
  return Buffer.concat([header, Buffer.from(pixels)]);
}
function decode(bytes) {
  const file = path.join(root, "fixture.bin"); fs.writeFileSync(file, bytes);
  return spawnSync(binary, [file], { timeout: 10000, env: { ...process.env, ASAN_OPTIONS: "detect_leaks=0", UBSAN_OPTIONS: "halt_on_error=1" } });
}
test("native BGI raw bitmaps decode tightly packed BGR rows with opaque alpha", () => {
  const value = image(3, 1, 24, [1, 2, 3, 16, 32, 64, 255, 128, 0]);
  const result = decode(value); assert.equal(result.status, 0, result.stderr.toString());
  assert.deepEqual(result.stdout, Buffer.concat([Buffer.from("3 1\n"), Buffer.from([3, 2, 1, 255, 64, 32, 16, 255, 0, 128, 255, 255])]));
});
test("native BGI raw bitmaps preserve BGRA transparency and row ordering", () => {
  const value = image(1, 2, 32, [10, 20, 30, 0, 100, 110, 120, 191]);
  const result = decode(value); assert.equal(result.status, 0, result.stderr.toString());
  assert.deepEqual(result.stdout, Buffer.concat([Buffer.from("1 2\n"), Buffer.from([30, 20, 10, 0, 120, 110, 100, 191])]));
});
test("native BGI bitmap variants and malformed sizes fail before allocating or reading pixels", () => {
  for (const bytes of [Buffer.alloc(15), image(0, 1, 24, []), image(8193, 1, 24, []), image(65535, 65535, 32, []),
    image(1, 1, 16, [1, 2]), image(1, 1, 24, [1, 2]), image(1, 1, 24, [1, 2, 3, 4]), image(1, 1, 32, [1, 2, 3, 4], { reserved: 1 })]) {
    const result = decode(bytes); assert.equal(result.status, 2, result.stderr.toString());
    assert.doesNotMatch(result.stderr.toString(), /runtime error|AddressSanitizer/);
  }
});
