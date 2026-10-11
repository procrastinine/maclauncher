const test = require("node:test"), assert = require("node:assert/strict");
const { FrontEndMachine } = require("../src/modules/catsystem2/runtime/frontend-vm");
const { parseFrontEnd } = require("../src/modules/catsystem2/frontend-parser");
const { FrontEndObjects } = require("../src/modules/catsystem2/runtime/frontend-objects");
const { imageGeometry } = require("../src/modules/catsystem2/runtime/frontend-geometry");
const { OFFSET } = require("../src/modules/catsystem2/runtime/motion-vm");
const options = { engineVersion: "2.6.1.76" };
const frame = { frameId: 21, width: 40, height: 12, canvasWidth: 100, canvasHeight: 60, offsetX: 7, offsetY: -3 };

test("FES referenced layout retains cropped dimensions, original offsets and shared string filenames", async () => {
  const source = "#DEFINE\nPLANE parent\nPLANE panel\nIMAGE icon\n#OBJECT SIZE POS DISP\nparent 100,60 8,9 1\n#OBJECT SIZE2 POS2 PARENT DISP\npanel $str7:21 $str7:21 parent 1\n#OBJECT FILE ID.0 PL DISP\nicon $str7 21 panel 1\n#START";
  const program = parseFrontEnd(source), strings = new Map([[7, "layout"]]), reads = [];
  const objects = new FrontEndObjects(program, { ...options, canvas: { width: 100, height: 60 }, describeFrame: async (...args) => { reads.push(args); return frame; },
    loadFrame: async (name, id) => { assert.equal(name, "layout"); assert.equal(id, 21); return { ...frame, rgbaPath: "/cache/frame.rgba" }; } });
  const machine = new FrontEndMachine(program, { strings }); await objects.prepare(machine);
  const panel = objects.resolveObject("panel"); assert.equal(panel.width, 40); assert.equal(panel.height, 12);
  assert.equal(panel.bytes.readFloatLE(OFFSET.position), 7); assert.equal(panel.bytes.readFloatLE(OFFSET.position + 4), -3);
  assert.deepEqual(reads, [["layout", 21, { allowMissing: true }], ["layout", 21, { allowMissing: true }]]); assert.equal(strings.get(7), "layout");
  const layers = await objects.layers(); assert.equal(layers[0].x, 22); assert.equal(layers[0].y, 3);
});

test("absent optional SIZE2/POS2 references keep zero geometry and do not fabricate plane content", async () => {
  const source = "#DEFINE\nPLANE plane\nIMAGE mask\n#OBJECT SIZE2 POS2 DISP\nplane optional:10 optional:10 1\n#OBJECT FILE PL DISP MASK\nmask optional plane 1 4\n#START", program = parseFrontEnd(source);
  const objects = new FrontEndObjects(program, { ...options, canvas: { width: 100, height: 60 }, describeFrame: async (name, id, options) => {
    assert.equal(name, "optional"); assert.equal(id, 10); assert.equal(options.allowMissing, true); return null;
  }, loadFrame: async () => { throw new Error("an empty referenced plane must not load its mask"); } });
  await objects.prepare(new FrontEndMachine(program)); const plane = objects.resolveObject("plane");
  assert.equal(plane.width, 0); assert.equal(plane.height, 0); assert.equal(plane.bytes.readFloatLE(OFFSET.position), 0); assert.deepEqual(await objects.layers(), []);
});

test("FES image-reference layout rejects unavailable profiles, malformed references and invalid metadata", async () => {
  const machine = new FrontEndMachine(parseFrontEnd("#START")), services = { ...options, machine, describeFrame: async () => frame };
  for (const source of ["", ":21", "layout:", "layout:21:22", "layout:-1", "layout:" + "9".repeat(20), "x".repeat(127) + ":21"])
    await assert.rejects(imageGeometry(source, services), /FES|expression/);
  await assert.rejects(imageGeometry("layout:21", { ...services, engineVersion: "2.5" }), /profile or service/);
  for (const change of [{ frameId: 22 }, { width: 0 }, { width: 8192, height: 8192 }, { offsetX: Infinity }])
    await assert.rejects(imageGeometry("layout:21", { ...services, describeFrame: async () => ({ ...frame, ...change }) }), /geometry is invalid/);
  await assert.rejects(imageGeometry("layout:21", { ...services, describeFrame: async () => { throw new Error("HG-3 frame ID is ambiguous"); } }), /ambiguous/);
});
