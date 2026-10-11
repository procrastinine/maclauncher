const test = require("node:test"), assert = require("node:assert/strict");
const { createTaskRegistry } = require("../src/modules/catsystem2/runtime/tasks");
test("M2 task construction retains an unloaded model and independent native defaults", () => {
  const tasks = createTaskRegistry({ engineVersion: "2.6.1.76" }), a = tasks.create(54, 1, "a"), b = tasks.create(54, 1, "b");
  assert.equal(a.kind, "m2-plane"); assert.equal(a.m2.model, null); assert.equal(a.m2.player, null);
  assert.equal(a.m2.gain, 0.5); assert.equal(a.m2.primaryColor, 0xffffffff); assert.equal(a.m2.secondaryColor, 0xffffffff);
  assert.deepEqual(a.m2.tone, [100, 100, 100]); a.m2.tone[0] = 37; assert.equal(b.m2.tone[0], 100);
  tasks.priority(a.id, 7); tasks.base(a.id, 12, 24, 0); tasks.position(a.id, 8, 16, 0, 0); tasks.scale(a.id, 1, 1, 1, 0); tasks.display(a.id, 0);
  assert.equal(a.visible, false); assert.equal(b.visible, true); assert.equal(a.m2.model, null);
  tasks.remove(a.id); assert.throws(() => tasks.lookup(a.id), /handle/); assert.equal(tasks.lookup(b.id), b);
});
test("M2 task availability is gated by the exact engine version without model loading services", () => {
  for (const engineVersion of [undefined, "2.6.1.75", "2.7.0"]) assert.throws(() => createTaskRegistry({ engineVersion }).create(54, 1, "m2"), /version/);
  const tasks = createTaskRegistry({ engineVersion: "2.6.1.76" }); assert.throws(() => tasks.create(54, 99, "m2"), /handle/); assert.equal(tasks.tasks.size, 1);
});
test("M2 variable messages preserve the real unloaded branch and reject loaded players", () => {
  const tasks = createTaskRegistry({ engineVersion: "2.6.1.76" }), task = tasks.create(54, 1, "m2"), before = structuredClone(task.m2);
  const values = new Map([["766172", 0x3f800000]]); tasks.applyM2Variables(task.id, values);
  assert.deepEqual(task.m2, before); assert.equal(values.size, 1);
  assert.throws(() => tasks.applyM2Variables(1, values), /incompatible/);
  assert.throws(() => tasks.applyM2Variables(task.id, new Map([...Array(4097)].map((_, i) => [i, i]))), /limit/);
  task.m2.player = {}; assert.throws(() => tasks.applyM2Variables(task.id, values), /player is unsupported/);
  task.m2.player = null; task.m2.model = {}; assert.throws(() => tasks.applyM2Variables(task.id, values), /player is unsupported/);
});
