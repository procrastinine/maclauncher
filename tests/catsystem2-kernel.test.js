const test = require("node:test"), assert = require("node:assert/strict"), zlib = require("node:zlib");
const Kernel = require("../src/modules/catsystem2/kernel-script");
function program({ code = Buffer.from([0x3b]), text = Buffer.from("entry\0"), destination = 0, memory = 16, stack = 32 } = {}) {
  const strings = Buffer.alloc(8 + text.length); strings.writeUInt32LE(8); strings.writeUInt32LE(destination, 4); text.copy(strings, 8);
  const decoded = Buffer.concat([code, strings]), payload = zlib.deflateSync(decoded), header = Buffer.alloc(52);
  header.write("KCS\0"); header.writeUInt32LE(2, 4); header.writeUInt32LE(52, 12); header.writeUInt32LE(code.length, 16);
  header.writeUInt32LE(52 + code.length, 20); header.writeUInt32LE(1, 24); header.writeUInt32LE(strings.length, 28);
  header.writeUInt32LE(memory, 32); header.writeUInt32LE(stack, 36); header.writeUInt32LE(52 + decoded.length, 40);
  header.writeUInt32LE(decoded.length * 2, 48); return Buffer.concat([header, payload]);
}
test("KCS v2 validates compressed code and copies authored strings into bounded initial memory", async () => {
  const bytes = program(), before = Buffer.from(bytes), result = await Kernel.inspectKernelScript(bytes);
  assert.equal(result.version, 2); assert.equal(result.stringCount, 1); assert.equal(result.strings[0].text, "entry");
  assert.equal(result.memory.length, 48); assert.equal(result.memory.subarray(0, 6).toString(), "entry\0");
  assert.deepEqual(result.code, Buffer.from([0x3b])); assert.deepEqual(bytes, before); assert.equal(result.executionSupported, false);
});
test("KCS rejects unknown versions, forged extents, oversized memory, trailing zlib data and escaping initializers", async () => {
  for (const corrupt of [b => b.writeUInt32LE(3, 4), b => b.writeUInt32LE(1, 8), b => b.writeUInt32LE(53, 12),
    b => b.writeUInt32LE(999, 20), b => b.writeUInt32LE(0xffffffff, 24), b => b.writeUInt32LE(0xffffffff, 32), b => b.writeUInt32LE(1, 44)]) {
    const bytes = program(); corrupt(bytes); await assert.rejects(() => Kernel.inspectKernelScript(bytes), /KCS/);
  }
  await assert.rejects(() => Kernel.inspectKernelScript(Buffer.concat([program(), Buffer.from("tail")])), /extents/);
  await assert.rejects(() => Kernel.inspectKernelScript(program({ destination: 14 })), /range/);
  await assert.rejects(() => Kernel.inspectKernelScript(program({ text: Buffer.from("unterminated") })), /range/);
});
module.exports = { program };
