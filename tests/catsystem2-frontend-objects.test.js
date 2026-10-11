const test = require("node:test"), assert = require("node:assert/strict");
const { parseFrontEnd } = require("../src/modules/catsystem2/frontend-parser");
const { FrontEndMachine } = require("../src/modules/catsystem2/runtime/frontend-vm");
const { FrontEndObjects } = require("../src/modules/catsystem2/runtime/frontend-objects");
const { OFFSET } = require("../src/modules/catsystem2/runtime/motion-vm");
const source = `#DEFINE
PLANE plane
BUTTON button[2]
#OBJECT SIZE POS PRI DISP
plane 100,60 10,20 5000 1
#OBJECT FILE ID.0 ID.1 PL PRI DISP ENABLE
button screen_%LANG% 10 11 plane 100 1 1
#START
next WAIT
#WAIT
#button.PUSH_L
@ setid 1
exit @`;
function components(options = {}) {
  const frames = [], program = parseFrontEnd(source), objects = new FrontEndObjects(program, { canvas: { width: 100, height: 60 }, language: "en",
    loadFrame: async (name, id) => { frames.push([name, id]); return { rgbaPath: "/cache/image.rgba", rgba: Buffer.from([255,255,255,0,255,255,255,255]), width: 2, height: 1, offsetX: 5, offsetY: 6, frameId: id }; }, ...options });
  const vm = new FrontEndMachine(program, { host: { tick: (...args) => objects.tick(...args), isBusy: (...args) => objects.isBusy(...args),
    resolveObject: (...args) => objects.resolveObject(...args), resolveTargets: (...args) => objects.resolveTargets(...args), command: (...args) => objects.command(...args) } });
  return { objects, vm, frames };
}
test("FES image banks use authored IDs, cropped geometry, plane alpha and actual pixel hit tests", async () => {
  const { objects, vm, frames } = components(); await vm.tick(0);
  let layers = await objects.layers(); assert.equal(layers[0].x, 15); assert.equal(layers[0].y, 26); assert.equal(frames[0][0], "screen_en");
  assert.equal(await objects.hitTest(15,26), null); const button = await objects.hitTest(16,26); assert.equal(button.id, "button[1]");
  vm.queueEvent(button, "PUSH_L"); assert.equal((await vm.tick(1)).exitCode, 1); assert.equal(button.selected, 1);
  const plane = objects.objects.get("plane"); plane.bytes[OFFSET.alpha] = 128; layers = await objects.layers(); assert.equal(layers[0].opacity, 128/255);
  plane.visible = false; assert.equal(await objects.hitTest(16,26), null);
});
test("FES object definitions reject unsupported types, attributes, transforms and image IDs", async () => {
  assert.throws(() => new FrontEndObjects(parseFrontEnd("#DEFINE\nPARTICLE effect\n#START"), { canvas: { width: 10, height: 10 } }), /type PARTICLE/);
  const { objects, vm } = components(); await vm.tick(0);
  await assert.rejects(objects.command("button", ["setid", "8"], vm), /entry is absent/);
  objects.objects.get("plane").bytes.writeFloatLE(2, OFFSET.scale); await assert.rejects(objects.layers(), /unsupported rendering/);
});
test("FES empty text/external surfaces and hidden save panels require no fabricated image or font", async () => {
  const source = "#DEFINE\nPLANE plane\nSTRING8 label\nDIFIMAGE external\nSAVEPANEL saved\nIMAGE placeholder\n#OBJECT SIZE DISP\nplane 20,10 1\n#OBJECT SIZE PARENT DISP\nlabel 20,10 plane 1\n#OBJECT PL DISP\nexternal plane 1\nsaved plane 0\nplaceholder plane 0\n#START";
  const program = parseFrontEnd(source), objects = new FrontEndObjects(program, { engineVersion: "2.6.1.76", canvas: { width: 20, height: 10 }, loadFrame: async () => { throw new Error("must not read a hidden placeholder"); } });
  const vm = new FrontEndMachine(program); await objects.prepare(vm); assert.deepEqual(await objects.layers(), []);
  await assert.rejects(objects.command("label", ["str", '"authored"'], vm), /text command str is unsupported/);
  objects.resolveObject("saved").visible = true; await assert.rejects(objects.layers(), /save-panel rendering is unsupported/);
  assert.throws(() => new FrontEndObjects(program, { engineVersion: "2.5", canvas: { width: 20, height: 10 } }), /STRING8 profile/);
});
test("FES direct-image selection differs from authored ID tables and retains the empty -1 selection", async () => {
  const program = parseFrontEnd("#DEFINE\nIMAGE icon\n#OBJECT FILE IDN DISP\nicon bank -1 1\n#START"), calls = [];
  const objects = new FrontEndObjects(program, { engineVersion: "2.6.1.76", canvas: { width: 20, height: 10 },
    loadFrame: async (...args) => { calls.push(args); return { width: 1, height: 1, rgbaPath: "/cache/pixel", frameId: args[1], offsetX: 0, offsetY: 0 }; } });
  const vm = new FrontEndMachine(program); await objects.prepare(vm); assert.deepEqual(await objects.layers(), []); assert.deepEqual(calls, []);
  await objects.command("icon", ["setid", "17"], vm); assert.equal((await objects.layers())[0].frameId, 17); assert.deepEqual(calls, [["bank", 17]]);
  await objects.command("icon", ["setid", "-1"], vm); assert.deepEqual(await objects.layers(), []);
  await assert.rejects(objects.command("icon", ["setid", "-2"], vm), /image table entry/);
});
test("recognized object verbs retain empty-target semantics without accepting unknown operations", async () => {
  const program = parseFrontEnd("#DEFINE\nPLANE panel\n#OBJECT SIZE DISP\npanel 20,10 1\n#START"), objects = new FrontEndObjects(program, { engineVersion: "2.6.1.76", canvas: { width: 20, height: 10 } }), vm = new FrontEndMachine(program);
  await objects.prepare(vm);
  assert.equal(await objects.command("optional", ["disp", "0"], vm), true); assert.equal(await objects.command("optional", ["enable", "1"], vm), true);
  assert.equal(await objects.command("optional", ["stop"], vm), true); assert.equal(await objects.command("optional", ["unknown", "1"], vm), false);
  assert.equal(await objects.command("unknown_global", ["1"], vm), false);
  await assert.rejects(objects.command("optional", ["blend", "256"], vm), /exceeds its range/);
  await assert.rejects(objects.command("optional", ["disp", "1", "2"], vm), /arguments/);
  const panel = objects.resolveObject("panel"); panel.motions = [{ machine: { done: false } }]; await objects.command("panel", ["stop"], vm); assert.deepEqual(panel.motions, []);
  const older = new FrontEndObjects(program, { engineVersion: "2.5", canvas: { width: 20, height: 10 } }); assert.equal(await older.command("optional", ["disp", "0"], vm), false);
});
