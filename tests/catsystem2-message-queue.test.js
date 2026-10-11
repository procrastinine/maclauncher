const test = require("node:test"), assert = require("node:assert/strict");
const { KernelMachine } = require("../src/modules/catsystem2/runtime/kernel-vm"), { createKernelServices } = require("../src/modules/catsystem2/runtime/kernel-services");
const { createMessageQueue } = require("../src/modules/catsystem2/runtime/message-queue");
const operand = (tag, value) => { const bytes = Buffer.alloc(5); bytes[0] = tag; bytes.writeUInt32LE(value >>> 0, 1); return bytes; };
test("KCS receives actual four-word messages before resuming its authored continuation", async () => {
  const host = createKernelServices({ taskId: 1 });
  const code = Buffer.concat([Buffer.from([0x25]), operand(6, 64), Buffer.from([0x2b]), operand(3, 71), operand(3, 4), Buffer.from([0x26]), operand(3, 32), Buffer.from([0x3b])]);
  const vm = new KernelMachine({ version: 2, code, memory: Buffer.alloc(256), globalsBytes: 128 }, { nativeCalls: host.nativeCalls });
  assert.equal((await vm.run()).yielded, true); const stopped = vm.instructions;
  assert.deepEqual(await vm.run(), { yielded: true, reason: "message" }); assert.equal(vm.instructions, stopped); assert.equal(vm.memory.readUInt32LE(32), 0);
  assert.equal(host.messages.deliver(vm), false); host.messages.enqueue([-1, 0xffff0006, 7, 8]); assert.equal(host.messages.deliver(vm), true);
  assert.deepEqual([0, 4, 8, 12].map(offset => vm.memory.readUInt32LE(64 + offset)), [0xffffffff, 0xffff0006, 7, 8]);
  assert.equal((await vm.run()).halted, true); assert.equal(vm.memory.readUInt32LE(32), 1); assert.equal(host.messages.size, 0);
  assert.throws(() => vm.resumeMessage([1, 2, 3, 4]), /pending receive/);
});
test("KCS normal frames resume an unfulfilled receive with zero and retain the message destination", async () => {
  const host = createKernelServices({ taskId: 1 }), memory = Buffer.alloc(256); memory.fill(7, 64, 80);
  const code = Buffer.concat([Buffer.from([0x25]), operand(6, 64), Buffer.from([0x2b]), operand(3, 71), operand(3, 4), Buffer.from([0x26]), operand(3, 32), Buffer.from([0x3b])]);
  const vm = new KernelMachine({ version: 2, code, memory, globalsBytes: 128 }, { nativeCalls: host.nativeCalls });
  await vm.run(); vm.resumeFrame(); assert.equal(vm.memory.readUInt32LE(128), 0); assert.deepEqual(vm.memory.subarray(64, 80), Buffer.alloc(16, 7));
  await vm.run(); assert.equal(vm.memory.readUInt32LE(32), 0); assert.throws(() => vm.resumeFrame(), /pending receive/);
});
test("KCS queues preserve FIFO and game isolation while rejecting overflow and invalid words", () => {
  const queue = createMessageQueue(), other = createMessageQueue(); for (let index = 0; index < 512; index++) queue.enqueue([0, index, 0, 0]);
  assert.equal(queue.size, 512); assert.equal(other.size, 0); assert.throws(() => queue.enqueue([0, 513, 0, 0]), /limit/);
  assert.throws(() => other.enqueue([0, 1]), /four-word/); assert.throws(() => other.enqueue([0, 1, Infinity, 0]), /four-word/);
  const delivered = []; const machine = { suspended: { kind: "message" }, resumeMessage: record => delivered.push(record[1]) };
  queue.deliver(machine); queue.deliver(machine); assert.deepEqual(delivered, [0, 1]); assert.equal(queue.size, 510);
});
