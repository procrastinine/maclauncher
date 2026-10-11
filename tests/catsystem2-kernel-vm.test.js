const test = require("node:test"), assert = require("node:assert/strict");
const { KernelMachine } = require("../src/modules/catsystem2/runtime/kernel-vm");
const literal = value => { const bytes = Buffer.alloc(5); bytes[0] = 3; bytes.writeUInt32LE(value >>> 0, 1); return bytes; };
const op = (id, ...args) => Buffer.concat([Buffer.from([id]), ...args]);
const fixture = code => ({ version: 2, code, memory: Buffer.alloc(256), globalsBytes: 16 });

test("KCS integer expressions, stores and initialized memory are isolated across concurrent machines", async () => {
  const target = Buffer.from(literal(0)); target[0] = 0x33;
  const popped = Buffer.from(literal(0)); popped[0] = 0x43;
  const program = fixture(Buffer.concat([op(1, literal(7), literal(9)), op(0x15, target, popped), Buffer.from([0x3b])]));
  const first = new KernelMachine(program), second = new KernelMachine(program);
  await Promise.all([first.run(), second.run()]);
  assert.equal(first.memory.readUInt32LE(0), 16); assert.equal(second.memory.readUInt32LE(0), 16);
  first.memory.writeUInt32LE(77, 0); assert.equal(second.memory.readUInt32LE(0), 16); assert.equal(program.memory.readUInt32LE(0), 0);
});

test("KCS authored internal calls allocate locals, return values and restore caller frames", async () => {
  const prefix = Buffer.concat([op(0x2a, literal(20), literal(0)), Buffer.from([0x3b])]);
  const code = Buffer.concat([prefix, Buffer.alloc(20 - prefix.length), op(0x31, literal(4)), op(0x25, literal(77)), op(0x2c, literal(4), literal(0))]);
  const machine = new KernelMachine(fixture(code)); await machine.run();
  assert.equal(machine.halted, true); assert.equal(machine.callDepth, 0); assert.equal(machine.pop(), 77); assert.equal(machine.sp, 16);
});

test("KCS native service calls receive actual arguments, can await input and resume deterministically", async () => {
  const code = Buffer.concat([op(0x25, literal(42)), op(0x2b, literal(12), literal(4)), Buffer.from([0x3b])]);
  const machine = new KernelMachine(fixture(code), { nativeCalls: new Map([[12, async ({ arguments: args }) => {
    assert.equal(args.readUInt32LE(0), 42); await new Promise(resolve => setImmediate(resolve)); return { value: 99, yielded: true };
  }]]) });
  const yielded = await machine.run(); assert.equal(yielded.yielded, true); assert.equal(machine.halted, false);
  assert.deepEqual(await machine.run(), { halted: true }); assert.equal(machine.pop(), 99);
});

test("KCS computed call arguments stay on the stack and pointer operations preserve exact logical addresses", async () => {
  const retained = Buffer.from(literal(0)); retained[0] = 0xe1;
  const pointer = Buffer.from(literal(0x80000020)); pointer[0] = 0x86;
  const code = Buffer.concat([op(0x3e, pointer, literal(8)), op(0x25, retained), op(0x25, literal(7)), op(0x2b, literal(22), literal(8)), Buffer.from([0x3b])]);
  const machine = new KernelMachine(fixture(code), { nativeCalls: new Map([[22, ({ arguments: args }) => {
    assert.equal(args.readUInt32LE(0), 0x80000028); assert.equal(args.readUInt32LE(4), 7); return {};
  }]]) });
  await machine.run(); assert.equal(machine.sp, 16);
});

test("KCS native argument pushes preserve typed logical pointers without treating them as floats", async () => {
  const pointer = Buffer.from(literal(0x80000120)); pointer[0] = 0x86;
  const code = Buffer.concat([op(0x25,pointer),op(0x2b,literal(23),literal(4)),Buffer.from([0x3b])]);
  const machine = new KernelMachine(fixture(code), { nativeCalls: new Map([[23,({arguments:args})=>{assert.equal(args.readUInt32LE(),0x80000120);return{};}]]) });
  await machine.run(); assert.equal(machine.sp,16);
});
test("KCS pointer loads read whole logical words and preserve local/external source regions", async () => {
  const narrow=Buffer.from(literal(4));narrow[0]=1;
  const external=Buffer.alloc(32);external.writeUInt32LE(0xfedcba98,8);const original=Buffer.from(external);
  const stacked=Buffer.from(literal(0));stacked[0]=0x86|0x40;
  const program=fixture(Buffer.concat([op(0x2f,narrow),op(0x2e,literal(0x80000008)),op(0x2f,stacked),Buffer.from([0x3b])]));
  program.memory.writeUInt32LE(0xff010203,4);const before=Buffer.from(program.memory);
  const machine=new KernelMachine(program,{externalMemory:(address,length)=>({bytes:external,offset:address,readable:()=>true})});await machine.run();
  assert.equal(machine.pop(),0xfedcba98);assert.equal(machine.pop(),0xff010203);assert.deepEqual(program.memory,before);assert.deepEqual(external,original);
  assert.deepEqual(machine.memory.subarray(0,program.globalsBytes),before.subarray(0,program.globalsBytes));
  for(const pointer of [literal(254),literal(0x8000001f)])await assert.rejects(new KernelMachine(fixture(op(0x2f,pointer)),{externalMemory:address=>({bytes:external,offset:address})}).run(),/range/);
  await assert.rejects(new KernelMachine(fixture(op(0x2f,literal(0x80000008))),{externalMemory:address=>({bytes:external,offset:address,readable:()=>false})}).run(),/preference field is unsupported/);
});

test("KCS prefix/postfix mutations and switch branches preserve old/new values and caller memory", async () => {
  const target = Buffer.from(literal(0)); target[0] = 0x33;
  const skip = 41;
  const code = Buffer.concat([op(0x15, target, literal(9)), op(0x18, target), Buffer.from([0x33]),
    op(0x34, literal(9), literal(skip)), op(0x29, literal(0xffffff)), Buffer.alloc(skip - 35), op(0x17, target), Buffer.from([0x3b])]);
  const machine = new KernelMachine(fixture(code)); await machine.run();
  assert.equal(machine.memory.readUInt32LE(0), 9); assert.equal(machine.register, 9); assert.equal(machine.pop(), 9);
});
test("KCS subtract assignments preserve native whole-word reads, typed writes and expression results", async () => {
  const target = (address, tag) => { const value = literal(address); value[0] = tag; return value; };
  const typed = (value, tag) => target(value, tag);
  const program = fixture(Buffer.concat([op(0x1f, target(0, 0x33), literal(27)), op(0x1f, target(4, 1), literal(1)),
    op(0x1f, target(8, 0x81), literal(1)), op(0x1f, target(12, 4), typed(0x3fa00000, 4)), Buffer.from([0x3b])]));
  program.memory.writeInt32LE(-5, 0); program.memory.writeUInt32LE(0x12340000, 4); program.memory.writeUInt32LE(0x23450000, 8); program.memory.writeFloatLE(-2.75, 12);
  const original = Buffer.from(program.memory), machine = new KernelMachine(program); await machine.run();
  assert.equal(machine.memory.readInt32LE(0), -32); assert.equal(machine.memory.readUInt32LE(4), 0x123400ff);
  assert.equal(machine.memory.readUInt32LE(8), 0x2344ffff); assert.equal(machine.memory.readFloatLE(12), -4);
  assert.deepEqual([machine.pop(), machine.pop(), machine.pop(), machine.pop()], [0xc0800000, 0x2344ffff, 0x1233ffff, 0xffffffe0]);
  assert.deepEqual(program.memory, original);
  await assert.rejects(new KernelMachine(fixture(op(0x1f, target(254, 1), literal(1)))).run(), /range/);
  const external = Buffer.alloc(16, 7), before = Buffer.from(external);
  await assert.rejects(new KernelMachine(fixture(op(0x1f, target(0x80000000, 3), literal(1))), {
    externalMemory: () => ({ bytes: external, offset: 0, readable: () => false }) }).run(), /field is unsupported/);
  assert.deepEqual(external, before);
});

test("KCS unsupported instructions/services and malformed operand or memory ranges stop explicitly", async () => {
  for (const code of [Buffer.from([0x45]), op(0x2b, literal(999), literal(0)), op(0x25, Buffer.from([5, 0, 0, 0, 0])),
    op(0x25, Buffer.from([0x33, 0xff, 0xff, 0xff, 0x7f])), Buffer.from([0x25, 3]), op(0x29, literal(0xffffff))]) {
    await assert.rejects(() => new KernelMachine(fixture(code)).run(), /KCS/);
  }
  const signal = AbortSignal.abort(new Error("Cancelled"));
  await assert.rejects(() => new KernelMachine(fixture(Buffer.from([0x3b])), { signal }).run(), /Cancelled/);
});
