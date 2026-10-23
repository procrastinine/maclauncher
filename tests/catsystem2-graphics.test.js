const test = require("node:test"), assert = require("node:assert/strict"), zlib = require("node:zlib");
const HG = require("../src/modules/catsystem2/image-hg3");

function tag(name, data, last = false) {
  const head = Buffer.alloc(16); head.write(name); head.writeUInt32LE(last ? 0 : 16 + data.length, 8); head.writeUInt32LE(data.length, 12);
  return Buffer.concat([head, data]);
}
function frame({ id = 0, width = 1, height = 1, bpp = 32, offsetX = 4, offsetY = 5,
  data = Buffer.from([0, 0, 0, 80]), commands = Buffer.from([9, 1]), imageTags, last = true } = {}) {
  const std = Buffer.alloc(40); std.writeUInt32LE(width); std.writeUInt32LE(height, 4); std.writeUInt32LE(bpp, 8);
  std.writeInt32LE(offsetX, 12); std.writeInt32LE(offsetY, 16); std.writeUInt32LE(100, 20); std.writeUInt32LE(80, 24); std.writeUInt32LE(1, 28);
  if (!imageTags) imageTags = [{ name: "img0000", payload: slice({ height, data, commands }) }];
  const body = Buffer.concat([tag("stdinfo", std), ...imageTags.map((item, index) => tag(item.name, item.payload, index === imageTags.length - 1))]);
  const header = Buffer.alloc(8); header.writeUInt32LE(last ? 0 : body.length + 8); header.writeUInt32LE(id, 4);
  return Buffer.concat([header, body]);
}
function slice({ row = 0, height = 1, data = Buffer.from([0, 0, 0, 80]), commands = Buffer.from([9, 1]) } = {}) {
  const pixels = zlib.deflateSync(data), cmd = zlib.deflateSync(commands), header = Buffer.alloc(24);
  header.writeUInt32LE(row); header.writeUInt32LE(height, 4); header.writeUInt32LE(pixels.length, 8); header.writeUInt32LE(data.length, 12);
  header.writeUInt32LE(cmd.length, 16); header.writeUInt32LE(commands.length, 20); return Buffer.concat([header, pixels, cmd]);
}
function image(...frames) { const header = Buffer.alloc(12); header.write("HG-3"); header.writeUInt32LE(12, 4); header.writeUInt32LE(0x300, 8); return Buffer.concat([header, ...frames]); }

test("HG-3 lossless decoding restores signed pixels, channel order and authored canvas offsets without changing input", async () => {
  // One opaque red B,G,R,A pixel has normalized byte planes 00 00 00 50.
  // The independently specified LSB-first copy/length/run command is 09 01.
  const bytes = image(frame()), before = Buffer.from(bytes), meta = HG.inspectHg3(bytes), result = await HG.decodeFrame(bytes);
  assert.equal(meta.frames[0].encoding, "lossless"); assert.deepEqual(result.rgba, Buffer.from([255, 0, 0, 255]));
  assert.deepEqual([result.canvasWidth, result.canvasHeight, result.offsetX, result.offsetY], [100, 80, 4, 5]);
  assert.equal(result.bpp, 32); assert.deepEqual(bytes, before);
  // A zero-run of three bytes followed by a one-byte copy produces the same planes.
  const compact = image(frame({ data: Buffer.from([80]), commands: Buffer.from([0x88, 0x03]) }));
  assert.deepEqual((await HG.decodeFrame(compact)).rgba, result.rgba);
});
test("HG-3 independently specified two-row pixels verify horizontal/vertical delta filters and vertical orientation", async () => {
  const data = Buffer.from([0,0,64,65, 0,0,27,92, 133,170,133,112, 34,0,34,34]);
  const result = await HG.decodeFrame(image(frame({ width: 2, height: 2, data, commands: Buffer.from([0x21,0x40,0]) })));
  assert.deepEqual(result.rgba, Buffer.from([10,20,30,40, 20,30,40,50, 1,2,3,4, 5,6,7,8]));
});
test("HG-3 preserves duplicate frame IDs and requires an index instead of choosing an arbitrary generation", async () => {
  const bytes = image(frame({ id: 9, last: false }), frame({ id: 9 })), info = HG.inspectHg3(bytes);
  assert.equal(info.frames.length, 2); assert.deepEqual(info.ambiguousFrameIds, [9]);
  await assert.rejects(() => HG.decodeFrame(bytes, { frameId: 9 }), /ambiguous/);
  assert.equal((await HG.decodeFrame(bytes, { frameIndex: 1, frameId: 9 })).frameIndex, 1);
  await assert.rejects(() => HG.decodeFrame(bytes, { frameIndex: 1, frameId: 3 }), /disagree/);
});
test("HG-3 terminated tag names accept original post-NUL padding but reject invalid names and structural escapes", () => {
  const bytes = image(frame({imageTags:[{name:"img0000",payload:slice()},{name:"cptype",payload:Buffer.alloc(4)}]}));
  bytes[bytes.length - 13] = 0xff; assert.equal(HG.inspectHg3(bytes).frames.length, 1);
  for (const change of [b => b[1] |= 0x80, b => b[20] |= 0x80, b => b.writeUInt32LE(16, 4), b => b.writeUInt32LE(0x301, 8), b => b.writeUInt32LE(1, 12),
    b => b.writeUInt32LE(16, 28), b => b.writeUInt32LE(0xffffffff, 32), b => b[20] = 33,
    b => b.writeUInt32LE(0xffffffff, 36), b => b.writeUInt32LE(16, 44), b => b.writeInt32LE(0x7fffffff, 48)]) {
    const bad = image(frame()); change(bad); assert.throws(() => HG.inspectHg3(bad), /HG-3/);
  }
});
test("HG-3 rejects malformed compressed lengths, output/run overruns, trailing data and cancellation", async () => {
  for (const options of [ { data: Buffer.from([0,0,0,80,1]) }, { commands: Buffer.from([9]) },
    { commands: Buffer.from([9,1,0]) }, { commands: Buffer.from([9,0x81]) }, { commands: Buffer.from([9,3]) },
    { commands: Buffer.from([0xff]) }, { commands: Buffer.alloc(8) } ])
    await assert.rejects(() => HG.decodeFrame(image(frame(options))), /HG-3/);
  const payload = slice(); payload[payload.length - 1] ^= 1;
  await assert.rejects(() => HG.decodeFrame(image(frame({ imageTags: [{ name: "img0000", payload }] }))), /corrupt/);
  const declared = slice(); declared.writeUInt32LE(0xffffffff, 20);
  await assert.rejects(() => HG.decodeFrame(image(frame({ imageTags: [{ name: "img0000", payload: declared }] }))), /extents/);
  const trailing = slice(); trailing.writeUInt32LE(trailing.readUInt32LE(16) + 1, 16);
  await assert.rejects(() => HG.decodeFrame(image(frame({ imageTags: [{ name: "img0000", payload: Buffer.concat([trailing, Buffer.from([0])]) }] }))), /extents/);
  const abort = new AbortController(); abort.abort(); await assert.rejects(() => HG.decodeFrame(image(frame()), {}, { signal: abort.signal }), { name: "AbortError" });
});
test("HG-3 assembles nonoverlapping bottom-up slices and rejects missing/overlapping rows", async () => {
  const red = slice({ row: 0 }), blue = slice({ row: 1, data: Buffer.from([0,0,0,65]) });
  const images = [{name:"img0000",payload:red},{name:"img0001",payload:blue}];
  const result = await HG.decodeFrame(image(frame({height:2,imageTags:images})));
  assert.deepEqual(result.rgba, Buffer.from([0,0,255,255, 255,0,0,255]));
  await assert.rejects(() => HG.decodeFrame(image(frame({height:2,imageTags:images.slice(0,1)}))), /missing rows/);
  await assert.rejects(() => HG.decodeFrame(image(frame({height:2,imageTags:[images[0],images[0]]}))), /overlap/);
});
test("HG-3 raster callback is bounded and applies an exact alpha mask without silently accepting unknown encodings", async () => {
  const jpg = Buffer.from([0xff,0xd8,0xff,0xd9]), mask = zlib.deflateSync(Buffer.from([127])), alpha = Buffer.alloc(8);
  alpha.writeUInt32LE(mask.length); alpha.writeUInt32LE(1,4);
  const bytes = image(frame({imageTags:[{name:"img_jpg",payload:jpg},{name:"img_al",payload:Buffer.concat([alpha,mask])}]}));
  await assert.rejects(() => HG.decodeFrame(bytes), /unavailable/);
  const result = await HG.decodeFrame(bytes, {}, { decodeRaster: async (input, request) => {
    assert.deepEqual(input,jpg); assert.equal(request.encoding,"jpeg"); assert.equal(request.width,1); return Buffer.from([1,2,3,255]);
  } });
  assert.deepEqual(result.rgba,Buffer.from([1,2,3,127]));
  await assert.rejects(() => HG.decodeFrame(bytes, {}, {decodeRaster:async()=>Buffer.alloc(3)}), /dimensions disagree/);
  await assert.rejects(() => HG.decodeFrame(image(frame({imageTags:[{name:"img_jpa",payload:jpg}]}))), /unavailable/);
});

module.exports = { tag, frame, image, slice };
