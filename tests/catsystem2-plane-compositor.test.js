const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const Plane = require("../src/modules/catsystem2/runtime/plane-compositor"), { createImageCache } = require("../src/modules/catsystem2/runtime/image-cache");
const { parseFrontEnd } = require("../src/modules/catsystem2/frontend-parser"), { FrontEndObjects } = require("../src/modules/catsystem2/runtime/frontend-objects");
const { FrontEndMachine } = require("../src/modules/catsystem2/runtime/frontend-vm");
const layer = (rgba, fields = {}) => ({ rgba: Buffer.from(rgba), width: rgba.length / 4, height: 1, x: 0, y: 0, alpha: 255, mask: 0, ...fields });
const request = (layers, fields = {}) => ({ engineVersion: "2.6.1.76", width: 3, height: 1, layers, ...fields });

test("FES MASK4 multiplies destination alpha without drawing mask RGB or changing original pixels", () => {
  const original = layer([10,20,30,255,40,50,60,128,70,80,90,64]), mask = layer([255,0,0,128,0,255,0,0,0,0,255,255], { mask: 4 });
  const before = [Buffer.from(original.rgba), Buffer.from(mask.rgba)], rendered = Plane.composePlane(request([original, mask]));
  assert.deepEqual([...rendered.rgba], [10,20,30,128,40,50,60,0,70,80,90,64]);
  assert.deepEqual(original.rgba, before[0]); assert.deepEqual(mask.rgba, before[1]);
  // All byte pairs, including exact 255*255, follow the bounded fixed-point rule.
  for (let destination = 0; destination < 256; destination++) for (let source = 0; source < 256; source++)
    assert.equal(Plane.maskedAlpha(destination, source), Math.floor(((destination + 1) * (source + 1) - 1) / 256));
});
test("plane clipping, authored order and straight alpha preserve each independent surface", () => {
  const base = layer([100,0,0,255,100,0,0,255,100,0,0,255]), above = layer([0,0,200,128,0,200,0,255], { x: -1 });
  assert.deepEqual([...Plane.composePlane(request([base, above])).rgba], [0,200,0,255,100,0,0,255,100,0,0,255]);
  const mixed = Plane.composePlane(request([base, layer([0,0,200,128], { x: 1 })]));
  assert.deepEqual([...mixed.rgba.subarray(4,8)], [50,0,100,255]);
  const maskFirst = Plane.composePlane(request([layer([0,0,0,0], { mask: 4 }), base])); assert.deepEqual(maskFirst.rgba, base.rgba);
  const sparse = Plane.composePlane(request([layer([7,8,9,200], { x: 2 })])); assert.deepEqual([...sparse.rgba], [0,0,0,0,0,0,0,0,7,8,9,200]);
});
test("unknown masks, changed profiles, fractional transforms, bad pixels and cancelled surfaces fail explicitly", () => {
  assert.throws(() => Plane.composePlane(request([layer([1,2,3,4], { mask: 3 })])), /unsupported/);
  assert.throws(() => Plane.composePlane(request([layer([1,2,3,4], { mask: 4, alpha: 128 })])), /unsupported/);
  assert.throws(() => Plane.composePlane(request([], { engineVersion: "2.6.2" })), /unsupported/);
  assert.throws(() => Plane.composePlane(request([layer([1,2,3,4], { x: .5 })])), /unsupported/);
  assert.throws(() => Plane.composePlane(request([layer([1,2,3,4], { width: 2 })])), /unsupported/);
  assert.throws(() => Plane.composePlane(request([], { width: 8192, height: 8192 })), /unsupported/);
  const controller = new AbortController(); controller.abort(); assert.throws(() => Plane.composePlane(request([]), { signal: controller.signal }), /abort/i);
});
test("derived plane pixels reuse one private cache entry and detect warm tampering", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "catsystem-plane-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cache = await createImageCache({ cacheRoot: root, registry: { locate() {}, read() {} } }); t.after(cache.close);
  const input = request([layer([1,2,3,255])]), first = await cache.composePlane(input), second = await cache.composePlane(input);
  assert.equal(first, second); assert.deepEqual(fs.readFileSync(first.rgbaPath), first.rgba); assert.equal(fs.readdirSync(path.dirname(first.rgbaPath)).length, 1);
  fs.writeFileSync(first.rgbaPath, Buffer.alloc(first.rgba.length)); await assert.rejects(cache.composePlane(input), /cache was modified/);
});
test("FES masked planes emit the composed surface and retain strict separate-parent and mask guards", async () => {
  const source = "#DEFINE\nPLANE parent\nPLANE plane\nIMAGE base\nIMAGE mask\n#OBJECT SIZE POS DISP\nparent 3,1 2,3 1\n#OBJECT SIZE POS DISP PARENT\nplane 3,1 4,5 1 parent\n#OBJECT FILE ID.0 PL DISP PRI\nbase picture 0 plane 1 10\n#OBJECT FILE ID.0 PL DISP PRI MASK\nmask cutout 0 plane 1 20 4\n#START";
  const program = parseFrontEnd(source), requests = [], objects = new FrontEndObjects(program, { engineVersion: "2.6.1.76", canvas: { width: 20, height: 10 },
    loadFrame: async name => ({ ...layer(name === "picture" ? [30,20,10,255] : [100,200,50,128]), frameId: 0, offsetX: 0, offsetY: 0 }),
    composePlane: async input => { requests.push(input); return { ...Plane.composePlane(input), rgbaPath: "/cache/composed.rgba" }; } });
  await objects.prepare(new FrontEndMachine(program)); const output = await objects.layers();
  assert.equal(output.length, 1); assert.equal(output[0].id, "plane"); assert.equal(output[0].x, 6); assert.equal(output[0].y, 8);
  assert.deepEqual([...Plane.composePlane(requests[0]).rgba.subarray(0,4)], [30,20,10,128]);
  objects.resolveObject("base").parent = objects.resolveObject("parent"); await assert.rejects(objects.layers(), /separate image parents/);
  assert.throws(() => new FrontEndObjects(parseFrontEnd(source.replace("20 4", "20 3")), { engineVersion: "2.6.1.76", canvas: { width: 20, height: 10 } }), /mask profile/);
});
