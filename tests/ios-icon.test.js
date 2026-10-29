const test = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("node:zlib");
const Images = require("../src/core/icon-utils");
const { normalizePng } = require("../src/modules/ios/icon");
const signature = Buffer.from("89504e470d0a1a0a", "hex");
function chunk(type, data) {
  const bytes = Buffer.alloc(data.length + 12);
  bytes.writeUInt32BE(data.length); bytes.write(type, 4); data.copy(bytes, 8);
  bytes.writeUInt32BE(Images.crc32(bytes.subarray(4, -4)), bytes.length - 4);
  return bytes;
}
function fixture({ channels = 4, filter = 0, invalidFilter = false } = {}) {
  const width = 3, height = 3, stride = width * channels;
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = channels === 4 ? 6 : 2;
  const pixels = Buffer.from(Array.from({ length: height }, () => channels === 4 ?
    [10, 20, 40, 255, 16, 32, 64, 128, 0, 0, 0, 0] : [10, 20, 40, 16, 32, 64, 2, 3, 4]).flat());
  const rows = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    rows[y * (stride + 1)] = invalidFilter ? 5 : filter;
    for (let x = 0; x < stride; x++) {
      const at = y * stride + x, a = x >= channels ? pixels[at - channels] : 0;
      const b = y ? pixels[at - stride] : 0, c = y && x >= channels ? pixels[at - stride - channels] : 0;
      let predictor = 0;
      if (filter === 1) predictor = a;
      if (filter === 2) predictor = b;
      if (filter === 3) predictor = Math.floor((a + b) / 2);
      if (filter === 4) {
        const distances = [a, b, c].map(v => Math.abs(a + b - c - v));
        predictor = [a, b, c][distances.indexOf(Math.min(...distances))];
      }
      rows[y * (stride + 1) + x + 1] = (pixels[at] - predictor) & 255;
    }
  }
  const data = zlib.deflateRawSync(rows), middle = Math.ceil(data.length / 2);
  return Buffer.concat([signature, chunk("CgBI", Buffer.from([0x40, 0, 0, 0])), chunk("IHDR", header),
    chunk("IDAT", data.subarray(0, middle)), chunk("IDAT", data.subarray(middle)), chunk("IEND", Buffer.alloc(0))]);
}
test("CgBI icons decode every PNG filter, split raw IDAT, BGR and premultiplied BGRA", () => {
  for (const channels of [3, 4]) for (let filter = 0; filter <= 4; filter++) {
    const output = normalizePng(fixture({ channels, filter }));
    assert.ok(Images.isSupportedImageBuffer(output));
    assert.equal(output.readUInt32BE(16), 3); assert.equal(output.readUInt32BE(20), 3);
    assert.equal(output.includes(Buffer.from("CgBI")), false);
    const rows = zlib.inflateSync(output.subarray(41, output.length - 16));
    const expected = channels === 4 ? [40, 20, 10, 255, 128, 64, 32, 128, 0, 0, 0, 0] :
      [40, 20, 10, 255, 64, 32, 16, 255, 4, 3, 2, 255];
    for (let y = 0; y < 3; y++) assert.deepEqual([...rows.subarray(y * 13, (y + 1) * 13)], [0, ...expected]);
  }
});
test("standard PNG icons remain byte-identical and malformed icons fall back", () => {
  const png = Images.encodePngBitmap({ width: 1, height: 1, buffer: Buffer.from([2, 4, 8, 128]) });
  assert.equal(normalizePng(png), png);
  assert.equal(normalizePng(fixture({ invalidFilter: true })), null);
  const corrupt = fixture(); corrupt[corrupt.length - 1] ^= 1;
  for (const bytes of [Buffer.alloc(0), fixture().subarray(0, 40), corrupt]) assert.equal(normalizePng(bytes), null);
});
