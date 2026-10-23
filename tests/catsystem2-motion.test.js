const test = require("node:test"), assert = require("node:assert/strict");
const { MotionMachine, OFFSET } = require("../src/modules/catsystem2/runtime/motion-vm");
const literal = (value, tag = 3) => { const result = Buffer.alloc(5); result[0] = tag; result.writeUInt32LE(value >>> 0, 1); return result; };
const op = (opcode, ...args) => Buffer.concat([Buffer.from([opcode]), ...args]);
const program = code => ({ version: 2, code, memory: Buffer.alloc(1024), globalsBytes: 0 });
test("KCS motion namespace evaluates authored parameters into object state and completes independently", async () => {
  const code = Buffer.concat([op(0x15, literal(0x8000000c, 0x14), literal(0x8000009c, 0x14)), op(0x2b, literal(38), literal(0)), Buffer.from([0x3b])]);
  const first = new MotionMachine(program(code), { parameters: [45] }), second = new MotionMachine(program(code), { parameters: [90] });
  await Promise.all([first.tick(0), second.tick(0)]); assert.equal(first.bytes.readFloatLE(OFFSET.base), 45); assert.equal(second.bytes.readFloatLE(OFFSET.base), 90);
  assert.equal(first.done, true); assert.equal(second.done, true); assert.equal(first.bytes[OFFSET.alpha], 255);
});
test("KCS motion evaluators restart at each authored frame while retaining object data and reject unknown services", async () => {
  const frame = literal(0x80000090, 0x13), target = literal(0x80000073, 0x11);
  const machine = new MotionMachine(program(Buffer.concat([op(0x15, target, frame), Buffer.from([0x3b])])));
  await machine.tick(2); assert.equal(machine.bytes[OFFSET.alpha], 2); await machine.tick(9); assert.equal(machine.bytes[OFFSET.alpha], 9); assert.equal(machine.done, false);
  assert.equal(machine.bytes.readUInt32LE(OFFSET.color) & 0xffffff, 0xffffff);
  await assert.rejects(() => machine.tick(8), /monotonic/);
  const unknown = new MotionMachine(program(op(0x2b, literal(777), literal(0)))); await assert.rejects(() => unknown.tick(0), /unsupported/);
});
