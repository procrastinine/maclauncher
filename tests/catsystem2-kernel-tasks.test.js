const test = require("node:test"), assert = require("node:assert/strict"), zlib = require("node:zlib");
const { createKernelTasks, MESSAGES } = require("../src/modules/catsystem2/runtime/kernel-tasks");
const { createTaskRegistry } = require("../src/modules/catsystem2/runtime/tasks");
const { createKernelServices } = require("../src/modules/catsystem2/runtime/kernel-services");
const { KernelMachine } = require("../src/modules/catsystem2/runtime/kernel-vm");
const literal = (value, tag = 3) => { const bytes = Buffer.alloc(5); bytes[0] = tag; bytes.writeUInt32LE(value >>> 0, 1); return bytes; };
const op = (code, ...args) => Buffer.concat([Buffer.from([code]), ...args]);
const push = value => op(0x25, literal(value));
const call = (id, bytes) => op(0x2b, literal(id), literal(bytes));
function stored(code) {
  const header = Buffer.alloc(52); header.write("KCS\0"); header.writeUInt32LE(2, 4); header.writeUInt32LE(52, 12); header.writeUInt32LE(code.length, 16);
  header.writeUInt32LE(52 + code.length, 20); header.writeUInt32LE(64, 32); header.writeUInt32LE(1024, 36);
  header.writeUInt32LE(52 + code.length, 40); header.writeUInt32LE(code.length, 48); return Buffer.concat([header, zlib.deflateSync(code)]);
}
function childProgram() {
  const prefix = Buffer.concat([call(68, 0), op(0x26, literal(32, 3)), push(2), push(99), call(211, 8), push(77), call(453, 4)]);
  return stored(Buffer.concat([prefix, push(0), call(71, 4), Buffer.from([0x3c]), op(0x29, literal(prefix.length))]));
}
function components(bytes = childProgram()) {
  const tasks = createTaskRegistry(), parent = tasks.create(34, 1, "parent"), rootHost = createKernelServices({ taskId: 1, taskRegistry: tasks });
  const args = Buffer.alloc(4); args.writeUInt32LE(8); rootHost.nativeCalls.get(209)({ arguments: args });
  const reads = [], preserved = Buffer.from(bytes), frontEnd = { scripts: new Map(), load: async () => {}, start: async () => {}, dispose: async () => {}, setLocal() {} };
  const options = { engineVersion: "2.6.1.76", tasks, rootHost, frontEnd, registry: { read: async (type, name) => { reads.push([type, name]); return bytes; } } };
  return { options, runtime: createKernelTasks(options), tasks, parent, rootHost, reads, bytes, preserved };
}
test("child KCS loading shares established state, retains distinct stacks and never invents a focus event", async () => {
  const { runtime, parent, rootHost, reads, bytes, preserved } = components(), exits = [];
  const first = await runtime.create({ parentId: parent.id, name: "child", onExitCode: code => exits.push(code) });
  assert.deepEqual(reads, [["kcs", "child"]]); assert.deepEqual(exits, [77]); assert.equal(first.task.exitCode, 77);
  assert.equal(rootHost.state.variables[2], 99); assert.equal(first.machine.memory.readUInt32LE(32), first.id);
  assert.equal(first.host.messages.size, 0); assert.equal(first.machine.suspended.kind, "message");
  assert.equal(Object.hasOwn(runtime, "activate"), false); assert.equal(Object.hasOwn(MESSAGES, "activate"), false);
  const second = await runtime.create({ parentId: parent.id, name: "another" });
  assert.notEqual(second.machine.memory, first.machine.memory); assert.notEqual(second.id, first.id);
  first.machine.memory[40] = 12; assert.equal(second.machine.memory[40], 0);
  first.host.state.strings.set(3, "shared"); assert.equal(rootHost.state.strings.get(3), "shared");
  rootHost.memory.known.fill(0, 16, 20); assert.throws(() => second.machine.resolve(0x80000010), /field is unsupported/);
  await runtime.tick(0); assert.deepEqual([...first.machine.memory.subarray(0, 16)], Array(16).fill(0));
  assert.equal(first.host.messages.size, 0); assert.deepEqual(bytes, preserved); await runtime.close();
});
test("child task shutdown delivers its actual record, removes its handles and preserves other tasks", async () => {
  const { runtime, tasks, parent } = components(), first = await runtime.create({ parentId: parent.id, name: "child" }), second = await runtime.create({ parentId: parent.id, name: "other" });
  await runtime.remove(first.id); assert.deepEqual(Array.from({ length: 4 }, (_, index) => first.machine.memory.readUInt32LE(index * 4)), [0xffffffff, 0xffff0006, 0, 0]);
  assert.equal(tasks.tasks.has(first.id), false); assert.equal(tasks.tasks.has(second.id), true); assert.equal(tasks.tasks.has(parent.id), true);
  await runtime.tick(0); await assert.rejects(runtime.tick(0), /frame sequence/);
  await runtime.close(); assert.equal(tasks.tasks.size, 2); await assert.rejects(runtime.create({ parentId: parent.id, name: "late" }), /limit/);
});
test("unknown child services and malformed source clean allocated handles instead of substituting another program", async () => {
  const unknown = components(stored(call(123456, 0)));
  await assert.rejects(unknown.runtime.create({ parentId: unknown.parent.id, name: "unknown" }), /native service 123456 is unsupported/);
  assert.equal(unknown.runtime.records.size, 0); assert.equal(unknown.tasks.tasks.size, 2); assert.deepEqual(unknown.reads, [["kcs", "unknown"]]);
  assert.deepEqual(unknown.bytes, unknown.preserved);
  const corrupt = components(Buffer.from("corrupt")); await assert.rejects(corrupt.runtime.create({ parentId: corrupt.parent.id, name: "bad" }), /signature/);
  assert.equal(corrupt.tasks.tasks.size, 2); assert.equal(corrupt.runtime.records.size, 0);
  const good = components(); assert.throws(() => createKernelTasks({ ...good.options, engineVersion: "2.6.1.75" }), /version/);
  await assert.rejects(good.runtime.create({ parentId: good.parent.id, name: "bad\0name" }), /range/);
  await assert.rejects(good.runtime.create({ parentId: 1, name: "wrong-parent" }), /handle/); assert.equal(good.tasks.tasks.size, 2);
});
test("authored message-window reset queues exact host records for root and independent child scripts", async () => {
  const { runtime, parent, rootHost, bytes, preserved } = components(), first = await runtime.create({ parentId: parent.id, name: "first" }), second = await runtime.create({ parentId: parent.id, name: "second" });
  assert.equal(rootHost.messages.size,0); runtime.resetMessageWindow();
  assert.equal(rootHost.messages.size,1); assert.equal(first.host.messages.size,1); assert.equal(second.host.messages.size,1);
  let rootRecord; assert.equal(rootHost.messages.deliver({ suspended: { kind: "message" }, resumeMessage: values => { rootRecord = values; } }),true);
  assert.deepEqual(rootRecord,[0,MESSAGES.resetMessageWindow,0,0]); await runtime.tick(0);
  for (const item of [first,second]) assert.deepEqual(Array.from({ length: 4 },(_,index) => item.machine.memory.readUInt32LE(index*4)),rootRecord);
  for (let index=0;index<512;index++) second.host.messages.enqueue([0,0,0,0]);
  assert.throws(() => runtime.resetMessageWindow(),/queue exceeds/); assert.equal(rootHost.messages.size,0); assert.equal(first.host.messages.size,0);
  // Drain the finite fixture records before the ordinary shutdown path.
  for (let index=0;index<512;index++) { assert.equal(second.host.messages.deliver(second.machine),true); await second.machine.run(); }
  assert.deepEqual(bytes,preserved); await runtime.close(); assert.throws(() => runtime.resetMessageWindow(),/closed/);
});
