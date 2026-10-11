const test = require("node:test"), assert = require("node:assert/strict");
const zlib = require("node:zlib");
const Encoding = require("../src/modules/catsystem2/encoding");
const FrontEnd = require("../src/modules/catsystem2/frontend-script");

test("CatSystem2 CP932 preserves ASCII controls and Windows symbols across host ICU versions", () => {
  const ascii = Buffer.from(Array.from({ length: 128 }, (_, i) => i));
  assert.deepEqual([...Encoding.decode(ascii)].map(c => c.charCodeAt(0)), [...ascii]);
  assert.equal(Encoding.decode(Buffer.from("82a081608161817c", "hex")), "あ～∥－");
  assert.equal(Encoding.decode(Buffer.from([0xa1, 0xdf])), "｡ﾟ");
  assert.equal(Encoding.decode(Buffer.from("f040f9fc", "hex")), "\ue000\ue757");
});

test("CatSystem2 CP932 rejects undefined single bytes and malformed double-byte syntax", () => {
  for (const hex of ["80", "a0", "fd", "fe", "ff", "81", "817f", "8120", "81ff", "8540"])
    assert.throws(() => Encoding.decode(Buffer.from(hex, "hex")), /CP932/);
});

test("FES UTF-8 inference is deterministic where a host converter accepts undefined CP932 bytes", async () => {
  const raw = Buffer.from("#START\ntext \u3000\n"), payload = zlib.deflateSync(raw), bytes = Buffer.alloc(16 + payload.length);
  bytes.write("FES\0"); bytes.writeUInt32LE(payload.length, 4); bytes.writeUInt32LE(raw.length, 8); payload.copy(bytes, 16);
  const result = await FrontEnd.inspectFrontEndScript(bytes);
  assert.equal(result.sourceEncoding, "UTF-8"); assert.equal(result.text, raw.toString());
  assert.equal(result.encodingSource, "inferred-valid-UTF8-after-CP932-rejection");
  assert.equal(result.rawBase64, raw.toString("base64")); assert.equal(result.runtimeEncodingProven, false);
});
