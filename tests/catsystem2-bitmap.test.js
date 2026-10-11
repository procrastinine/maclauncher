const test = require("node:test"), assert = require("node:assert/strict");
const { createBitmap } = require("../src/modules/catsystem2/runtime/bitmap");
test("CatSystem authored bitmap clears clip to their surface, preserve neighboring pixels and isolate sessions", () => {
  const settings = { width: 6, height: 5, tileWidth: 4, tileHeight: 3, bpp: 32 }, atlas = createBitmap(settings), other = createBitmap(settings);
  atlas.fill(0, 0, 6, 5, 0xff123456); assert.deepEqual([...atlas.pixel(5, 4)], [18, 52, 86, 255]);
  atlas.fill(-2, 1, 5, 9); assert.deepEqual([...atlas.pixel(2, 4)], [0, 0, 0, 0]); assert.deepEqual([...atlas.pixel(3, 4)], [18, 52, 86, 255]);
  assert.deepEqual([...atlas.pixel(1, 0)], [18, 52, 86, 255]); assert.deepEqual([...other.pixel(1, 0)], [0, 0, 0, 0]);
  atlas.fill(0, 0, 6, 5); assert.equal(atlas.allocatedBytes, 0); atlas.fill(20, 20, 5, 5, 0xffeeeeee); assert.equal(atlas.allocatedBytes, 0);
  assert.throws(() => atlas.fill(0, 0, 20000, 1), /bounds/); assert.throws(() => atlas.fill(0, 0, 1, -1), /bounds/);
  assert.throws(() => createBitmap({ ...settings, bpp: 16 }), /unsupported/); assert.throws(() => createBitmap({ ...settings, width: 16384, height: 16384 }), /unsupported/);
});
test("KCS default-atlas clearing preserves native argument semantics and rejects unavailable or direct surfaces", () => {
  const { createKernelServices } = require("../src/modules/catsystem2/runtime/kernel-services");
  const atlas = createBitmap({ width: 6, height: 5, tileWidth: 4, tileHeight: 3, bpp: 32 }); atlas.fill(0, 0, 6, 5, 0xffabcdef);
  const host = createKernelServices({ taskId: 1, currentBitmap: atlas }), args = Buffer.alloc(24); [0, 2, 1, 4, 4, 0xffffffff].forEach((n, i) => args.writeUInt32LE(n, i * 4));
  assert.deepEqual(host.nativeCalls.get(117)({ arguments: args }), {}); assert.deepEqual([...atlas.pixel(2, 1)], [0, 0, 0, 0]); assert.deepEqual([...atlas.pixel(1, 1)], [171, 205, 239, 255]);
  assert.throws(() => createKernelServices({ taskId: 1 }).nativeCalls.get(117)({ arguments: args }), /authored texture atlas/);
  args.writeUInt32LE(3, 0); assert.throws(() => host.nativeCalls.get(117)({ arguments: args }), /direct bitmap/);
});
