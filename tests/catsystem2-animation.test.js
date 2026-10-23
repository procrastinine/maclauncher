const test = require("node:test"), assert = require("node:assert/strict");
const Animation = require("../src/modules/catsystem2/animation");
const { ImageAnimation } = require("../src/modules/catsystem2/runtime/image-animation");
const { FrontEndObjects } = require("../src/modules/catsystem2/runtime/frontend-objects");
const { FrontEndMachine } = require("../src/modules/catsystem2/runtime/frontend-vm");
const { parseFrontEnd } = require("../src/modules/catsystem2/frontend-parser");
function bytes(timelines) {
  const result = Buffer.alloc(32 + timelines.length * 68); result.write("ANM\0", 0, "ascii"); result.writeUInt32LE(timelines.length, 8);
  timelines.forEach(([command, ...values], index) => {
    const at = 32 + index * 68; result.writeUInt32LE(command, at);
    values.forEach((value, parameter) => {
      const [type, stored] = Array.isArray(value) ? value : [0, value]; result.writeUInt32LE(type, at + 4 + parameter * 8); result.writeInt32LE(stored, at + 8 + parameter * 8);
    });
  }); return result;
}
const program = timelines => Animation.inspectAnimation(bytes(timelines));
test("ANM parsing retains parameter roles and rejects malformed lengths, headers and unused fields", () => {
  const original = bytes([[0, 17, 2, 2], [3, [2, 0]]]), before = Buffer.from(original), parsed = Animation.inspectAnimation(original);
  assert.equal(parsed.timelineCount, 2); assert.deepEqual(parsed.timelines[1].parameters, [{ type: 2, value: 0 }]); assert.deepEqual(original, before);
  assert.ok(Object.isFrozen(parsed.timelines[0].parameters));
  for (const invalid of [original.subarray(0,31), original.subarray(0,-1), Buffer.concat([original, Buffer.from([0])]), bytes([])])
    assert.throws(() => Animation.inspectAnimation(invalid), /header|bounds/);
  for (const [at, value] of [[4,1],[12,1],[32,18],[36,3],[60,1]]) {
    const invalid = Buffer.from(original); invalid.writeUInt32LE(value, at); assert.throws(() => Animation.inspectAnimation(invalid), /unsupported/);
  }
  assert.throws(() => Animation.inspectAnimation(bytes([[0,[1,64],2,2]])), /parameter/);
});
test("ANM literal timelines retain authored durations, delay and repeat timing", () => {
  const vm = new ImageAnimation(program([[0,4,2,2],[15,1,1],[0,9,3,3],[3,0]]), { engineVersion: "2.6.1.76" }); vm.reset(10);
  assert.deepEqual(Array.from({ length: 13 }, (_, index) => vm.tick(10 + index).frameId), [4,4,4,9,9,9,4,4,4,9,9,9,4]);
  assert.equal(vm.done, false);
  const finite = new ImageAnimation(program([[0,7,2,2],[0,-1,1,1]]), { engineVersion: "2.6.1.76" });
  assert.equal(finite.tick(0).frameId, 7); assert.equal(finite.tick(2).frameId, -1); assert.deepEqual(finite.tick(3), { frameId: -1, done: true });
});
test("ANM execution rejects unknown operations, variables, random duration, corrupt jumps and unbounded loops", () => {
  assert.throws(() => new ImageAnimation(program([[0,1,1,1]]), { engineVersion: "2.6.0" }), /profile/);
  for (const timelines of [[[1,0,1,1]], [[0,[1,1],1,1]], [[0,1,1,2]], [[3,1]], [[3,0]], [[0,-2,1,1]]])
    assert.throws(() => new ImageAnimation(program(timelines), { engineVersion: "2.6.1.76" }).tick(0), /unsupported|limit|range|table/);
  const controller = new AbortController(), vm = new ImageAnimation(program([[0,1,2,2]]), { engineVersion: "2.6.1.76", signal: controller.signal });
  vm.tick(1); assert.throws(() => vm.tick(0), /sequence/); assert.throws(() => vm.tick(1000001), /sequence/);
  controller.abort(); assert.throws(() => vm.tick(2), /abort/i);
});
test("FES image animation loads lazily, updates raw frame IDs and preserves stopped images", async () => {
  const fes = parseFrontEnd("#DEFINE\nIMAGE icon\n#OBJECT FILE IDN DISP\nicon sprites -1 1\n#START"), reads = [], ids = [];
  const objects = new FrontEndObjects(fes, { engineVersion: "2.6.1.76", canvas: { width: 20, height: 10 },
    loadAnimation: async name => { reads.push(name); return program([[0,5,2,2],[0,8,2,2],[3,0]]); },
    loadFrame: async (name, id) => { ids.push(id); return { rgbaPath: "/cache/pixel.rgba", rgba: Buffer.alloc(4,255), width: 1, height: 1, frameId: id, offsetX: 0, offsetY: 0 }; } });
  const vm = new FrontEndMachine(fes); await objects.prepare(vm); await vm.tick(0); await objects.command("icon", ["anm","0"], vm);
  await objects.command("icon", ["setanm","authored"], vm); assert.deepEqual(reads, []); assert.deepEqual(await objects.layers(), []);
  await objects.command("icon", ["anm","1"], vm); assert.equal((await objects.layers())[0].frameId, 5);
  await objects.tick(2,vm); assert.equal((await objects.layers())[0].frameId, 8);
  await assert.rejects(objects.command("icon", ["setid","4"], vm), /during animation/);
  await objects.command("icon", ["anm","0"], vm); await objects.tick(10,vm); assert.equal((await objects.layers())[0].frameId, 8);
  await objects.command("icon", ["setid","-1"], vm); assert.deepEqual(await objects.layers(), []); assert.deepEqual(ids, [5,8]);
  await assert.rejects(objects.command("icon", ["anm","2"], vm), /mode/); await assert.rejects(objects.command("icon", ["setanm","../escape"], vm), /path/);
});
