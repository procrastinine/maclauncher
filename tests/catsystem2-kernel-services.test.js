const test = require("node:test"), assert = require("node:assert/strict");
const { KernelMachine } = require("../src/modules/catsystem2/runtime/kernel-vm"), { createKernelServices } = require("../src/modules/catsystem2/runtime/kernel-services");
const { formatKernelString, formatKernelBytes } = require("../src/modules/catsystem2/runtime/kernel-format"), Encoding = require("../src/modules/catsystem2/encoding");
const args = (...values) => { const result = Buffer.alloc(values.length * 4); values.forEach((value, i) => result.writeUInt32LE(value >>> 0, i * 4)); return result; };
function machine(host) { return new KernelMachine({ version: 2, code: Buffer.from([0x3b]), memory: Buffer.alloc(4096), globalsBytes: 512 }, { externalMemory: host.externalMemory }); }
const call = (host, vm, id, ...values) => host.nativeCalls.get(id)({ machine: vm, arguments: args(...values) });
test("KCS literal feature queries are version gated and never install native device handlers", () => {
  const host = createKernelServices({ taskId: 1, engineVersion: "2.6.1.76" }); assert.deepEqual(call(host, null, 925), { value: 1 });
  assert.throws(() => call(createKernelServices({ taskId: 1, engineVersion: "2.6.1.75" }), null, 925), /query is unsupported/);
  assert.throws(() => call(host, null, 925, 1), /argument layout/); assert.equal(host.nativeCalls.has(926), false);
});
test("KCS authored flags and partially established preferences never fabricate unknown fields", () => {
  const preferences = require("../src/modules/catsystem2/runtime/preferences").defaultRecords({ engineVersion: "2.6.1.76" });
  const host = createKernelServices({ taskId: 1, flagCount: 1024, preferenceRecords: preferences, soundConfig: {} }), vm = machine(host);
  assert.equal(call(host, vm, 789).value, 1024); call(host, vm, 209, 1024); call(host, vm, 211, 900, -3); assert.equal(host.state.variables[900], -3);
  assert.throws(() => call(host, vm, 211, 1024, 1), /region/); assert.equal(call(host, vm, 938).value, 1);
  assert.equal(call(host, vm, 210, 900).value, -3); assert.equal(call(host, vm, 210, 1024).value, 0);
  assert.equal(call(host, vm, 210, 0xffffffff).value, 0); assert.equal(host.state.variables.length, 1024);
  assert.equal(call(createKernelServices({ taskId: 1 }), vm, 210, 0).value, 0);
  call(host, vm, 359, 0x80000100, 0x80002000, 0x80002100, 0x80002200);
  assert.equal(vm.resolve(0x80002000).bytes.readUInt32LE(0x2000), 4);
  assert.throws(() => vm.resolve(0x8000200c), /preference field is unsupported/);
  const target = { value: 0x8000200c, tag: 3 }; vm.store(target, 37); assert.equal(vm.resolve(target.value).bytes.readUInt32LE(0x200c), 37);
  assert.throws(() => call(host, vm, 359, 0x80004000, 0x80007000, 0x80007100, 0), /external output/);
  assert.equal(host.flags.subarray(0x4000, 0x4000 + 5628).some(Boolean), false);
  assert.throws(() => require("../src/modules/catsystem2/runtime/preferences").defaultRecords({ engineVersion: "4.01" }), /version is unsupported/);
});
test("KCS task factories and plane services preserve authored geometry and isolate sessions", () => {
  const { createTaskRegistry } = require("../src/modules/catsystem2/runtime/tasks"), { OFFSET } = require("../src/modules/catsystem2/runtime/motion-vm");
  const tasks = createTaskRegistry(), other = createTaskRegistry(), host = createKernelServices({ taskId: 1, taskRegistry: tasks }), vm = machine(host);
  Buffer.from("plane\0").copy(vm.memory, 80); const id = call(host, vm, 66, 2, 1, 80).value, plane = tasks.lookup(id, "plane");
  assert.equal(id, 2); assert.equal(other.tasks.size, 1); assert.equal(plane.parent, 1);
  const dimensions = args(id, 0, 0, 0); dimensions.writeFloatLE(1280, 4); dimensions.writeFloatLE(720, 8);
  host.nativeCalls.get(79)({ arguments: dimensions }); assert.deepEqual([plane.width, plane.height], [1280, 720]);
  plane.bytes.writeFloatLE(12, OFFSET.base); plane.bytes.writeFloatLE(34, OFFSET.base + 4);
  const priority = args(id, 0); priority.writeFloatLE(62000, 4); host.nativeCalls.get(88)({ arguments: priority });
  assert.deepEqual([0, 4, 8].map(offset => plane.bytes.readFloatLE(OFFSET.base + offset)), [12, 34, 62000]);
  const base = args(id, 0, 0, 0); base.writeFloatLE(640, 4); base.writeFloatLE(360, 8); host.nativeCalls.get(85)({ arguments: base });
  assert.deepEqual([0, 4, 8].map(offset => plane.bytes.readFloatLE(OFFSET.base + offset)), [640, 360, 62000]);
  base.writeFloatLE(NaN, 8); assert.throws(() => host.nativeCalls.get(85)({ arguments: base }), /base profile/);
  assert.equal(plane.bytes.readFloatLE(OFFSET.base + 4), 360); base.writeFloatLE(360, 8); base.writeUInt32LE(1, 12);
  assert.throws(() => host.nativeCalls.get(85)({ arguments: base }), /base profile/);
  const position = args(id, 0, 0, 0, 1); position.writeFloatLE(50, 4); position.writeFloatLE(-12, 8); position.writeFloatLE(7, 12);
  host.nativeCalls.get(84)({ arguments: position });
  assert.deepEqual([0, 4, 8].map(offset => plane.bytes.readFloatLE(OFFSET.position + offset)), [50, -12, 7]); assert.equal(plane.positionMode, 1);
  position.writeUInt32LE(2, 16); assert.throws(() => host.nativeCalls.get(84)({ arguments: position }), /position profile/);
  assert.equal(plane.bytes.readFloatLE(OFFSET.position), 50);
  position.writeUInt32LE(0, 16); plane.motion = {}; assert.throws(() => host.nativeCalls.get(84)({ arguments: position }), /evaluated plane/); delete plane.motion;
  const scale = args(id, 0, 0, 0, 0); scale.writeFloatLE(0.5, 4); scale.writeFloatLE(2, 8); scale.writeFloatLE(1, 12);
  host.nativeCalls.get(101)({ arguments: scale }); assert.deepEqual([0, 4, 8].map(offset => plane.bytes.readFloatLE(OFFSET.scale + offset)), [0.5, 2, 1]);
  const savedScale = Buffer.from(plane.bytes); scale.writeFloatLE(NaN, 12); assert.throws(() => host.nativeCalls.get(101)({ arguments: scale }), /scale profile/); assert.deepEqual(plane.bytes, savedScale);
  assert.equal(plane.visible, true); call(host, vm, 92, id, 0); assert.equal(plane.visible, false); call(host, vm, 92, id, 1); assert.equal(plane.visible, true);
  call(host, vm, 100, id, 0xff123456, 1); assert.equal(plane.fillColor, 0xff123456); assert.equal(plane.fillEnabled, true);
  call(host, vm, 100, id, 0, 0); assert.equal(plane.fillEnabled, false);
  assert.throws(() => call(host, vm, 100, id, 0, 2), /mode/); assert.deepEqual(call(host, vm, 100, 0, 0, 1), {});
  const button = call(host, vm, 66, 6, id, 80).value; assert.equal(tasks.lookup(button).kind, "button");
  call(host, vm, 104, button, 5, 7, 1280, 720, 10000, button); assert.deepEqual(tasks.lookup(button).inputRegion, { x: 5, y: 7, width: 1280, height: 720, priority: 10000, receiver: button });
  assert.equal(call(host, vm, 105, button, 256).value, 0); call(host, vm, 848, button, 0); call(host, vm, 849, button, 0);
  assert.equal(tasks.buttonInput(button).options87, 0); assert.equal(tasks.buttonInput(button).options99, 0);
  assert.throws(() => call(host, vm, 848, button, 1), /option is unsupported/);
  assert.throws(() => call(host, vm, 104, button, 0, 0, 1280, 720, 10000, 65530), /handle/);
  dimensions.writeUInt32LE(1, 12); assert.throws(() => host.nativeCalls.get(79)({ arguments: dimensions }), /rectangle mode/);
  priority.writeFloatLE(NaN, 4); assert.throws(() => host.nativeCalls.get(88)({ arguments: priority }), /priority/);
  assert.throws(() => call(host, vm, 66, 8, 1, 80), /type 8 is unsupported/);
  assert.throws(() => call(host, vm, 66, 2, 65500, 80), /handle/);
  tasks.remove(id); assert.throws(() => tasks.lookup(id), /handle/);
});
test("KCS image-list allocation controls retain authored values and reject oversized state", () => {
  const tasks = require("../src/modules/catsystem2/runtime/tasks").createTaskRegistry(), list = tasks.create(15, 1, "images");
  const host = createKernelServices({ taskId: 1, taskRegistry: tasks }), vm = machine(host);
  call(host, vm, 260, list.id, 0, 4096); assert.deepEqual(tasks.lookup(list.id).allocationMode, [0, 4096]);
  assert.throws(() => call(host, vm, 260, list.id, 0xffffffff, 0), /controls exceed/); assert.deepEqual(list.allocationMode, [0, 4096]);
  assert.throws(() => call(host, vm, 260, 1, 0, 0), /handle/);
  assert.throws(() => call(host, vm, 342, list.id), /initialized dimensions/);
  call(host, vm, 256, list.id, 1280, 720); call(host, vm, 342, list.id);
  assert.equal(list.renderGeneration, 1); assert.equal(list.bitmap.allocatedBytes, 0); assert.deepEqual([...list.bitmap.pixel(100, 50)], [0, 0, 0, 0]);
  list.textures.set(1, {}); assert.throws(() => call(host, vm, 342, list.id), /populated/); assert.equal(list.renderGeneration, 1);
});
test("KCS matrix initialization writes a complete identity within its explicit destination", () => {
  const host = createKernelServices({ taskId: 1 }), vm = machine(host);
  vm.memory.fill(0xa7, 127, 193); const original = Buffer.from(vm.memory);
  assert.deepEqual(call(host, vm, 207, 128), {});
  assert.deepEqual([...Array(16)].map((_, index) => vm.memory.readFloatLE(128 + index * 4)), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  assert.deepEqual(vm.memory.subarray(0, 128), original.subarray(0, 128)); assert.deepEqual(vm.memory.subarray(192), original.subarray(192));
  const unchanged = Buffer.from(vm.memory);
  assert.throws(() => call(host, vm, 207, 4070), /range/); assert.deepEqual(vm.memory, unchanged);
  assert.throws(() => call(host, vm, 207, 0), /global matrix stack/); assert.throws(() => call(host, vm, 207, 128, 0), /argument layout/);
});
test("KCS plane matrix setters preserve the original source and reject invalid state atomically", () => {
  const tasks = require("../src/modules/catsystem2/runtime/tasks").createTaskRegistry(), plane = tasks.create(2, 1, "plane");
  const host = createKernelServices({ taskId: 1, taskRegistry: tasks }), vm = machine(host);
  call(host, vm, 207, 128); const source = Buffer.from(vm.memory.subarray(128, 192)), original = Buffer.from(plane.bytes);
  call(host, vm, 344, plane.id, 128, 0); assert.deepEqual(plane.bytes.subarray(0x24, 0x64), source);
  assert.deepEqual(plane.bytes.subarray(0, 0x24), original.subarray(0, 0x24)); assert.deepEqual(plane.bytes.subarray(0x64), original.subarray(0x64)); assert.deepEqual(vm.memory.subarray(128, 192), source);
  const before = Buffer.from(plane.bytes); vm.memory.writeFloatLE(Infinity, 128);
  assert.throws(() => call(host, vm, 344, plane.id, 128, 0), /matrix profile/); assert.deepEqual(plane.bytes, before);
  assert.throws(() => call(host, vm, 344, plane.id, 4070, 0), /range/); assert.deepEqual(plane.bytes, before);
});
test("KCS plane rectangle queries report local extents and preflight every output", () => {
  const tasks = require("../src/modules/catsystem2/runtime/tasks").createTaskRegistry(), plane = tasks.create(2, 1, "plane");
  const host = createKernelServices({ taskId: 1, taskRegistry: tasks }), vm = machine(host); tasks.initializePlane(plane.id, 1280, 720);
  tasks.base(plane.id, 640, 360, 0); tasks.position(plane.id, 512, 288, 0, 0); vm.memory.fill(0xa9, 124, 148);
  call(host, vm, 345, plane.id, 128, 132, 136, 140);
  assert.deepEqual([128, 132, 136, 140].map(address => vm.memory.readFloatLE(address)), [0, 0, 1280, 720]);
  assert.equal(vm.memory.readUInt32LE(124), 0xa9a9a9a9); assert.equal(vm.memory.readUInt32LE(144), 0xa9a9a9a9);
  const before = Buffer.from(vm.memory); assert.throws(() => call(host, vm, 345, plane.id, 128, 132, 136, 4095), /range/); assert.deepEqual(vm.memory, before);
});
test("KCS plane creation retains a bounded independent backing surface without claiming initial pixels", () => {
  const tasks = require("../src/modules/catsystem2/runtime/tasks").createTaskRegistry(), a = tasks.create(2, 1, "a"), b = tasks.create(2, 1, "b");
  const host = createKernelServices({ taskId: 1, taskRegistry: tasks });
  const callPlane = (id, width, height) => { const values = args(id, 0, 0); values.writeFloatLE(width, 4); values.writeFloatLE(height, 8); return host.nativeCalls.get(78)({ arguments: values }); };
  assert.deepEqual(callPlane(a.id, 1280, 720), {}); assert.deepEqual([a.width, a.height], [1280, 720]);
  assert.deepEqual(call(host, null, 402, a.id, 0), {}); assert.equal(a.blendMode, 0);
  assert.throws(() => call(host, null, 402, a.id, 1), /blend mode/); assert.equal(a.blendMode, 0);
  assert.deepEqual(call(host, null, 466, a.id, 0), {}); assert.equal(a.presentationMode, 0);
  assert.throws(() => call(host, null, 466, a.id, 1), /mode is unsupported/); assert.equal(a.presentationMode, 0);
  assert.throws(() => call(host, null, 466, b.id, 0), /allocated surface/);
  assert.equal(a.surfaceBitmap.allocatedBytes, 0); assert.equal(a.surfacePixelsKnown, false); assert.equal(a.surfaceGeneration, 1); assert.equal(b.surfaceBitmap, undefined);
  const retained = a.surfaceBitmap; retained.fill(0, 0, 2, 2, 0xff203040); assert.ok(retained.allocatedBytes > 0);
  assert.throws(() => callPlane(a.id, NaN, 20), /bitmap layout/); assert.equal(a.surfaceBitmap, retained);
  assert.throws(() => callPlane(a.id, 16384, 16384), /bitmap layout/); assert.equal(a.surfaceBitmap, retained);
  callPlane(a.id, 64, 32); assert.notEqual(a.surfaceBitmap, retained); assert.equal(retained.allocatedBytes, 0); assert.equal(a.surfaceGeneration, 2);
  callPlane(b.id, 0, 0); assert.equal(b.surfaceBitmap, null); assert.equal(b.surfacePixelsKnown, true); assert.deepEqual(tasks.planeRectangle(b.id), [0, 0, 0, 0]);
  call(host, null, 466, b.id, 0); tasks.fillPlane(b.id, 0xffffffff, 1); assert.equal(b.fillEnabled, true);
  assert.throws(() => callPlane(b.id, -1, 1), /bitmap layout/); assert.deepEqual(tasks.planeRectangle(b.id), [0, 0, 0, 0]);
  assert.deepEqual(callPlane(0, 0, 0), {}); assert.throws(() => callPlane(1, 32, 32), /handle/);
});
test("KCS byte string services preserve CP932 pairs, native compare order and bounded writes", () => {
  const host = createKernelServices({ taskId: 1 }), vm = machine(host);
  Buffer.from("A\0").copy(vm.memory, 64); Buffer.from("b\0").copy(vm.memory, 80);
  assert.deepEqual(call(host, vm, 21, 64, 80), { value: 1 }); Buffer.from("a\0").copy(vm.memory, 80); assert.equal(call(host, vm, 21, 64, 80).value, 0);
  Encoding.encode("//表\\A///b\\\0").copy(vm.memory, 128); Buffer.from("/\\\0").copy(vm.memory, 256);
  call(host, vm, 276, 800, 128); assert.equal(host.state.strings.get(800), "//表\\A///b\\"); assert.throws(() => call(host, vm, 276, 1024, 128), /limit/);
  assert.deepEqual(call(host, vm, 277, 800, 800), { value: 1 }); assert.equal(vm.string(800), "//表\\A///b\\");
  vm.memory.fill(9, 850, 854); assert.deepEqual(call(host, vm, 277, 801, 850), { value: 0 }); assert.deepEqual([...vm.memory.subarray(850, 854)], [0, 9, 9, 9]);
  assert.throws(() => call(host, vm, 277, 800, 4094), /range/); assert.throws(() => call(host, vm, 277, 1024, 800), /limit/);
  const source = Buffer.from(vm.memory.subarray(128, 160)); call(host, vm, 41, 300, 128, 256);
  assert.deepEqual(vm.memory.subarray(300, 311), Encoding.encode("表\0A\0b\0\0\0\0\0")); assert.deepEqual(vm.memory.subarray(128, 160), source);
  vm.memory.fill(9, 380, 396); call(host, vm, 36, 384, 258, 8); assert.deepEqual([...vm.memory.subarray(380, 396)], [9, 9, 9, 9, 2, 2, 2, 2, 2, 2, 2, 2, 9, 9, 9, 9]);
  const end = Buffer.from(vm.memory.subarray(4080)); assert.throws(() => call(host, vm, 36, 4094, 0, 8), /range/); assert.deepEqual(vm.memory.subarray(4080), end);
});
test("KCS host viewport/string services use authored dimensions and preserve overlapping source bytes", () => {
  const host = createKernelServices({ taskId: 2, canvas: { width: 800, height: 600 } }), vm = machine(host);
  call(host, vm, 8, 0, 4); assert.equal(vm.memory.readUInt32LE(0), 800); assert.equal(vm.memory.readUInt32LE(4), 600);
  Encoding.encode("場面").copy(vm.memory, 80); assert.deepEqual(call(host, vm, 13, 82, 80), { value: 82 });
  assert.equal(vm.string(82), "場面"); assert.equal(vm.memory.readUInt16LE(86), 0);
  assert.throws(() => call(host, vm, 13, 4094, 82), /range/);
  const missing = createKernelServices({ taskId: 2 }); assert.throws(() => call(missing, vm, 8, 0, 4), /authored startup/);
});
test("KCS string concatenation retains CP932 bytes, overlapping sources and formatted values", () => {
  const host = createKernelServices({ taskId: 1 }), vm = machine(host);
  Encoding.encode("語\0").copy(vm.memory, 64); assert.deepEqual(call(host, vm, 15, 64, 64), { value: 64 });
  assert.equal(vm.string(64), "語語"); assert.equal(vm.memory.readUInt16LE(68), 0);
  Buffer.from("%d[G256]\0").copy(vm.memory, 128); vm.memory.writeInt32LE(-42, 256);
  assert.deepEqual(call(host, vm, 16, 64, 128), { value: 64 }); assert.equal(vm.string(64), "語語-42");
  Encoding.encode("語\0").copy(vm.memory, 4092); const before = Buffer.from(vm.memory);
  assert.throws(() => call(host, vm, 15, 4092, 64), /range/); assert.deepEqual(vm.memory, before);
});
test("KCS frame queries use the supplied authored clock and reject absent or invalid host timing", () => {
  let frame = 684;
  const host = createKernelServices({ taskId: 1, getFrame: () => frame }), vm = machine(host);
  assert.equal(call(host, vm, 5).value, 684); frame++; assert.equal(call(host, vm, 5).value, 685);
  for (const value of [-1, NaN, 0.5, 1000001]) { frame = value; assert.throws(() => call(host, vm, 5), /clock exceeds/); }
  assert.throws(() => call(createKernelServices({ taskId: 1 }), vm, 5), /clock is unavailable/);
});
test("KCS auto-selection reads its actual startup profile and rejects a missing provider", () => {
  const startupOptions = require("../src/modules/catsystem2/runtime/startup-options").parseStartupOptions({ engineVersion: "2.6.1.76",
    document: require("../src/modules/catsystem2/startup").parseXml(Buffer.from("<document><GAME><autoselect>1</autoselect></GAME></document>")) });
  const host = createKernelServices({ taskId: 1, startupOptions }), vm = machine(host); assert.deepEqual(call(host, vm, 999), { value: 1 });
  assert.throws(() => call(createKernelServices({ taskId: 1 }), vm, 999), /options are unavailable/);
  assert.throws(() => call(host, vm, 999, 0), /argument layout/);
});
test("KCS pointer queries retain native authored coordinates and reject invalid state without partial writes", () => {
  let pointer = { x: 1200, y: -5 }; const host = createKernelServices({ taskId: 1, getPointer: () => pointer }), vm = machine(host);
  assert.deepEqual(call(host, vm, 739, 128, 132), {}); assert.deepEqual([vm.memory.readInt32LE(128), vm.memory.readInt32LE(132)], [1200, -5]);
  const before = Buffer.from(vm.memory); assert.throws(() => call(host, vm, 739, 128, 4094), /range/); assert.deepEqual(vm.memory, before);
  for (const value of [null, { x: NaN, y: 1 }, { x: 0.5, y: 1 }, { x: 1048577, y: 1 }]) { pointer = value; assert.throws(() => call(host, vm, 739, 128, 132), /coordinates/); assert.deepEqual(vm.memory, before); }
  assert.throws(() => call(createKernelServices({ taskId: 1 }), vm, 739, 128, 132), /state is unavailable/);
});
test("KCS CG handles have bounded task-local lifetimes and reject stale handles", () => {
  const host = createKernelServices({ taskId: 1 }), other = createKernelServices({ taskId: 2 }), vm = machine(host);
  const first = call(host, vm, 419).value, second = call(host, vm, 419).value;
  assert.notEqual(first, second); assert.ok(first > 0);
  assert.throws(() => call(other, vm, 421, first), /handle is invalid/);
  assert.deepEqual(call(host, vm, 421, first), {});
  assert.deepEqual(call(host, vm, 420, first), {});
  assert.throws(() => call(host, vm, 421, first), /handle is invalid/);
  assert.throws(() => call(host, vm, 420, first), /handle is invalid/);
  assert.deepEqual(call(host, vm, 421, 0), {}); assert.deepEqual(call(host, vm, 420, 0), {});
  for (let index = 1; index < 256; index++) call(host, vm, 419);
  assert.throws(() => call(host, vm, 419), /session limit/);
  call(host, vm, 420, second); assert.ok(call(host, vm, 419).value > second);
  assert.throws(() => call(host, vm, 419, 1), /argument layout/);
});
test("KCS dictionary allocation is bounded, session-local and distinct from other native handles", () => {
  const host = createKernelServices({ taskId: 1 }), other = createKernelServices({ taskId: 2 }), vm = machine(host);
  const dictionary = call(host, vm, 894).value, cg = call(host, vm, 419).value;
  assert.notEqual(dictionary, cg); assert.throws(() => call(host, vm, 895, cg), /handle is invalid/);
  assert.throws(() => call(other, vm, 895, dictionary), /handle is invalid/); call(host, vm, 895, dictionary);
  assert.throws(() => call(host, vm, 895, dictionary), /handle is invalid/); assert.deepEqual(call(host, vm, 895, 0), {});
  for (let index = 0; index < 256; index++) call(host, vm, 894); assert.throws(() => call(host, vm, 894), /session limit/);
});
test("KCS float dictionary bindings preserve exact stored bits and native shared lifetime", () => {
  const host = createKernelServices({ taskId: 1, engineVersion: "2.6.1.76" }), vm = machine(host), id = call(host, vm, 885).value;
  Buffer.from("float\0").copy(vm.memory, 80);
  for (const bits of [0xbf900000, 0x80000000, 0x7fc12345, 0x7f800000]) {
    call(host, vm, 887, id, 80, bits); assert.equal(call(host, vm, 888, id, 80).value >>> 0, bits);
    assert.equal(call(host, vm, 897, id, 80).value >>> 0, bits);
  }
  call(host, vm, 889, id); assert.equal(call(host, vm, 888, id, 80).value, 0);
  call(host, vm, 886, id); assert.throws(() => call(host, vm, 888, id, 80), /handle is invalid/);
  assert.deepEqual(call(host, vm, 886, 0), {}); assert.deepEqual(call(host, vm, 887, 0, 0xffffffff, 0), {});
  assert.throws(() => call(createKernelServices({ taskId: 1, engineVersion: "2.6.1.75" }), vm, 885), /version is unsupported/);
  assert.throws(() => call(host, vm, 885, 1), /argument layout/);
});
test("KCS M2 dictionary transfer validates original handles without creating a model", () => {
  const tasks = require("../src/modules/catsystem2/runtime/tasks").createTaskRegistry({ engineVersion: "2.6.1.76" });
  const host = createKernelServices({ taskId: 1, engineVersion: "2.6.1.76", taskRegistry: tasks }), vm = machine(host);
  const target = tasks.create(54, 1, "m2"), dictionary = call(host, vm, 894).value;
  Buffer.from("value\0").copy(vm.memory, 80); call(host, vm, 896, dictionary, 80, 3);
  assert.deepEqual(call(host, vm, 921, target.id, dictionary), {}); assert.equal(target.m2.model, null);
  assert.equal(call(host, vm, 897, dictionary, 80).value, 3);
  assert.throws(() => call(host, vm, 921, target.id, 419), /handle is invalid/);
  assert.throws(() => call(host, vm, 921, 999, dictionary), /handle is absent/);
  assert.deepEqual(call(host, vm, 921, 999, 0), {}); assert.throws(() => call(host, vm, 921, target.id), /argument layout/);
});
test("KCS dictionaries preserve formatted byte keys, native signed values and overwrite/reset semantics", () => {
  const host = createKernelServices({ taskId: 1 }), vm = machine(host), id = call(host, vm, 894).value;
  Encoding.encode("語%d[G256]\0").copy(vm.memory, 64); Encoding.encode("語7\0").copy(vm.memory, 128); vm.memory.writeUInt32LE(7, 256);
  call(host, vm, 896, id, 64, -9); assert.deepEqual(call(host, vm, 897, id, 128), { value: -9 });
  call(host, vm, 896, id, 128, 55); assert.equal(call(host, vm, 897, id, 64).value, 55);
  Buffer.from("Case\0").copy(vm.memory, 300); Buffer.from("case\0").copy(vm.memory, 320); call(host, vm, 896, id, 300, 3);
  assert.equal(call(host, vm, 897, id, 320).value, 0); call(host, vm, 898, id); assert.equal(call(host, vm, 897, id, 300).value, 0);
  for (let index = 0; index < 4096; index++) { Buffer.from(index + "\0").copy(vm.memory, 400); call(host, vm, 896, id, 400, index); }
  Buffer.from("overflow\0").copy(vm.memory, 400); assert.throws(() => call(host, vm, 896, id, 400, 1), /session limit/);
  call(host, vm, 898, id); call(host, vm, 896, id, 300, -1); assert.equal(call(host, vm, 897, id, 300).value, -1);
  assert.deepEqual(call(host, vm, 896, 0, 0xffffffff, 7), {}); assert.deepEqual(call(host, vm, 897, 0, 0xffffffff), { value: 0 });
  call(host, vm, 895, id); assert.throws(() => call(host, vm, 897, id, 300), /handle is invalid/);
});
test("KCS CG-list loading validates original format and provider extents without changing source bytes", async () => {
  const list = Buffer.alloc(12 + 72 + 64 + 12); list.writeUInt32LE(1, 8); list.write("group", 16); list.writeUInt32LE(1, 80); list.write("image", 84);
  const original = Buffer.from(list), reads = [];
  const host = createKernelServices({ taskId: 1, readAsset: async (filename, options) => { reads.push({ filename, options }); return list; } }), vm = machine(host);
  Buffer.from("config.int/cglist.dat\0").copy(vm.memory, 64);
  const id = call(host, vm, 419).value; assert.deepEqual(await call(host, vm, 458, id, 64), {});
  assert.deepEqual(reads, [{ filename: "config.int/cglist.dat", options: { maximumBytes: 4 * 1024 * 1024 } }]); assert.deepEqual(list, original);
  const absent = createKernelServices({ taskId: 1 }); await assert.rejects(call(absent, vm, 458, call(absent, vm, 419).value, 64), /asset provider/);
  list.writeUInt32LE(0xffffffff, 80); await assert.rejects(call(host, vm, 458, id, 64), /extents/);
  assert.deepEqual(await call(host, vm, 458, 0, 0xffffffff), {});
  await assert.rejects(call(host, vm, 458, id + 1, 64), /handle is invalid/);
});
test("KCS flag range outputs preserve signed absent values and reject invalid destinations atomically", () => {
  const flagRanges = require("../src/modules/catsystem2/runtime/flag-ranges").parseFlagRanges({ engineVersion: "2.6.1.76", flagCount: 2048,
    document: require("../src/modules/catsystem2/startup").parseXml(Buffer.from("<document><GAME><flag/></GAME></document>")) });
  const host = createKernelServices({ taskId: 1, flagRanges }), vm = machine(host);
  assert.deepEqual(call(host, vm, 790, 0, 0, 128, 132), { value: 1 }); assert.equal(vm.memory.readInt32LE(128), 0); assert.equal(vm.memory.readInt32LE(132), 512);
  assert.deepEqual(call(host, vm, 790, 0xffffffff, 7, 128, 132), { value: 1 }); assert.equal(vm.memory.readInt32LE(128), -1); assert.equal(vm.memory.readInt32LE(132), -1);
  const before = Buffer.from(vm.memory); assert.deepEqual(call(host, vm, 790, 0, 8, 128, 132), { value: 0 }); assert.deepEqual(vm.memory, before);
  assert.throws(() => call(host, vm, 790, 0, 0, 128, 4094), /range/); assert.deepEqual(vm.memory, before);
  assert.throws(() => call(createKernelServices({ taskId: 1 }), vm, 790, 0, 0, 128, 132), /startup settings/);
});
test("KCS G/L/H formatted strings preserve CP932 bytes, signed values and bounded recursion", () => {
  const host = createKernelServices({ taskId: 1 }), vm = machine(host); vm.argumentBase = 512;
  Encoding.encode("場面%02d[L12]/%x[H8]/%s[G80]/%%/%LANG%").copy(vm.memory, 32); vm.memory.writeInt32LE(7, 524); host.flags.writeUInt32LE(255, 8);
  Encoding.encode("語").copy(vm.memory, 80);
  assert.equal(formatKernelString(vm, 32), "場面07/ff/語/%/%LANG%");
  assert.deepEqual(formatKernelBytes(vm, 32), Encoding.encode("場面07/ff/語/%/%LANG%"));
  Buffer.from("%s[G120]\0").copy(vm.memory, 120); assert.throws(() => formatKernelString(vm, 120), /recursion/);
  Buffer.from("%n[G0]\0").copy(vm.memory, 200); assert.throws(() => formatKernelString(vm, 200), /unsupported/);
});
test("KCS XML handles and queries use original assets, defaults and actual bounded output strings", async () => {
  const reads = [], host = createKernelServices({ taskId: 1, readAsset: async name => {
    reads.push(name); return Buffer.from("<document><planes><p07><x>42</x></p07></planes><label>選択</label></document>");
  } }), vm = machine(host); Buffer.from("config.int/layout.xml\0").copy(vm.memory, 64);
  const record = await call(host, vm, 590, 64); assert.equal(record.value, 1); assert.deepEqual(reads, ["config.int/layout.xml"]);
  vm.memory.writeInt32LE(7, 400); Buffer.from("planes/p%02d[G400]/x\0").copy(vm.memory, 100);
  assert.deepEqual(call(host, vm, 592, 1, 99, 100), { value: 42 }); Buffer.from("missing\0").copy(vm.memory, 160);
  assert.deepEqual(call(host, vm, 592, 1, -5, 160), { value: 0xfffffffb });
  Encoding.encode("retained\0").copy(vm.memory, 200); assert.deepEqual(call(host, vm, 593, 1, 200, 160), {}); assert.equal(vm.string(200), "retained");
  Buffer.from("label\0").copy(vm.memory, 180); call(host, vm, 593, 1, 200, 180); assert.equal(vm.string(200), "選択");
  call(host, vm, 591, 1); assert.throws(() => call(host, vm, 592, 1, 0, 100), /handle/);
});
test("KCS optional name tables distinguish actual file absence from an unsupported present format", async () => {
  let present = false; const files = [], host = createKernelServices({ taskId: 1, assetExists: async filename => { files.push(filename); return present; } }), vm = machine(host);
  Buffer.from("config.int/tone.tbl\0").copy(vm.memory, 64);
  assert.deepEqual(await call(host, vm, 594, 64), { value: 0 }); assert.deepEqual(files, ["config.int/tone.tbl"]);
  present = true; await assert.rejects(call(host, vm, 594, 64), /format is unsupported/);
  assert.deepEqual(call(host, vm, 595, 0), {}); assert.throws(() => call(host, vm, 595, 1), /handle/);
  const before = Buffer.from(vm.memory);
  for (const id of [596, 597]) { assert.deepEqual(call(host, vm, id, 0, 64, 0xffffffff, 0xffffffff, 0xffffffff), { value: 0 }); assert.throws(() => call(host, vm, id, 1, 64, 128, 132, 136), /handle/); }
  assert.deepEqual(vm.memory, before);
  await assert.rejects(call(createKernelServices({ taskId: 1, assetExists: async () => undefined }), vm, 594, 64), /invalid existence result/);
  await assert.rejects(call(createKernelServices({ taskId: 1 }), vm, 594, 64), /asset provider/);
});
test("KCS authored loop points are validated and retained for the audio host", async () => {
  const host = createKernelServices({ taskId: 1, readAsset: async () => Buffer.from('"music.ogg" 40 900\n"full.ogg" -1 -1\n') }), vm = machine(host);
  Buffer.from("sound.int/LoopPoint.txt\0").copy(vm.memory, 64); await call(host, vm, 400, 19, 64);
  assert.deepEqual(host.state.loopPoints.get("music.ogg"), { start: 40, end: 900 }); assert.deepEqual(host.state.loopPoints.get("full.ogg"), { start: -1, end: -1 });
});
test("KCS fresh-state loading follows actual save absence and rejects malformed existing records", async () => {
  const reads = [], host = createKernelServices({ taskId: 1, readStoredData: async name => { reads.push(name); return null; } }), vm = machine(host);
  Buffer.from("savegen.dat\0").copy(vm.memory, 64); assert.deepEqual(await call(host, vm, 247, 64), { value: 0 }); assert.deepEqual(reads, ["savegen.dat"]);
  assert.deepEqual(call(host, vm, 248, 0), {}); assert.throws(() => call(host, vm, 248, 123), /handle/);
  const original = Buffer.from("CSS\0stored"), stored = createKernelServices({ taskId: 1, readStoredData: async () => original });
  await assert.rejects(call(stored, vm, 247, 64), /stored-data header/); assert.deepEqual(original, Buffer.from("CSS\0stored"));
  await assert.rejects(call(createKernelServices({ taskId: 1 }), vm, 247, 64), /save provider/);
});
test("KCS stored flag records preserve authored slices and reject invalid tasks and ranges", () => {
  const host = createKernelServices({ taskId: 1 }), vm = machine(host); call(host, vm, 209, 4);
  [8, -9, 123, -2147483648].forEach((value, index) => call(host, vm, 211, index, value));
  const handle = call(host, vm, 238, 36000).value;
  assert.deepEqual(call(host, vm, 240, handle, 7, 1, 1, 2), { value: 1 });
  assert.deepEqual([...host.dataRecords.lookup(handle).records.get(7)], [...Buffer.from([247, 255, 255, 255, 123, 0, 0, 0])]);
  assert.throws(() => call(host, vm, 240, handle, 7, 2, 0, 1), /original task/);
  assert.throws(() => call(host, vm, 240, handle, 7, 1, 3, 2), /bounded variable/);
  assert.throws(() => call(host, vm, 240, handle, 7, 1, 0, 0xffffffff), /bounded variable/);
  assert.deepEqual(call(host, vm, 240, 0, 7, 1, 0, 4), { value: 0 });
  Encoding.encode("記録\0").copy(vm.memory, 128); const original = Buffer.from(vm.memory.subarray(128, 133));
  assert.deepEqual(call(host, vm, 244, handle, 9, 5, 128), { value: 1 }); assert.deepEqual(host.dataRecords.lookup(handle).records.get(9), original);
  vm.memory.fill(0, 128, 133); assert.deepEqual(host.dataRecords.lookup(handle).records.get(9), original);
  assert.throws(() => call(host, vm, 244, handle, 9, 16777217, 0), /limit/); assert.throws(() => call(host, vm, 244, handle, 9, 3, 4094), /range/);
  assert.equal(host.dataRecords.lookup(handle).records.size, 2); call(host, vm, 469, handle, 7); call(host, vm, 469, handle, 9); assert.equal(host.dataRecords.lookup(handle).records.size, 0);
  call(host, vm, 246, handle); assert.throws(() => host.dataRecords.lookup(handle), /absent/);
});
test("KCS saved containers use the actual writer result and preserve their version and records", async () => {
  let saved; const host = createKernelServices({ taskId: 1, writeStoredData: async (name, bytes) => { saved = { name, bytes }; return true; } }), vm = machine(host);
  Buffer.from("savegen.dat\0").copy(vm.memory, 64); Buffer.from("record").copy(vm.memory, 128);
  const handle = call(host, vm, 238, 36000).value; call(host, vm, 244, handle, 20, 6, 128);
  assert.deepEqual(await call(host, vm, 245, handle, 64), { value: 1 }); assert.equal(saved.name, "savegen.dat");
  const decoded = await require("../src/modules/catsystem2/runtime/data-records").decodeStoredData(saved.bytes); assert.equal(decoded.version, 36000); assert.deepEqual(decoded.records.get(20), Buffer.from("record"));
  await assert.rejects(call(createKernelServices({ taskId: 1 }), vm, 245, handle, 64), /save writer/);
  assert.deepEqual(await call(host, vm, 245, 0, 64), { value: 0 });
});
test("KCS child hosts share established external and game state without sharing interpreter stacks", () => {
  const tasks = require("../src/modules/catsystem2/runtime/tasks").createTaskRegistry(), root = createKernelServices({ taskId: 1, taskRegistry: tasks }), rootVm = machine(root);
  call(root, rootVm, 209, 32); root.flags.writeUInt32LE(7, 8); root.memory.known.fill(0, 16, 20);
  const task = tasks.create(12, 1, "child"), child = createKernelServices({ taskId: task.id, taskRegistry: tasks, sharedMemory: root.memory, sharedState: root.state }), childVm = machine(child);
  assert.equal(childVm.resolve(0x80000008).bytes.readUInt32LE(8), 7); assert.throws(() => childVm.resolve(0x80000010), /field is unsupported/);
  childVm.store({ tag: 3, value: 0x80000010 }, 99); assert.equal(rootVm.resolve(0x80000010).bytes.readUInt32LE(16), 99);
  call(child, childVm, 209, 32); call(child, childVm, 211, 3, 44); assert.equal(root.state.variables[3], 44);
  assert.throws(() => call(child, childVm, 209, 16), /child flag region disagrees/); assert.equal(root.state.variables.length, 32);
  Buffer.from("shared\0").copy(childVm.memory, 80); call(child, childVm, 276, 4, 80); assert.equal(root.state.strings.get(4), "shared");
  childVm.memory.writeUInt32LE(123, 0); assert.equal(rootVm.memory.readUInt32LE(0), 0);
  const other = createKernelServices({ taskId: 1 }); assert.equal(other.flags.readUInt32LE(8), 0); assert.equal(other.state.strings.size, 0);
  assert.throws(() => createKernelServices({ taskId: task.id, sharedMemory: { bytes: root.flags, known: Buffer.alloc(2) } }), /shared external memory/);
  assert.throws(() => createKernelServices({ taskId: task.id, sharedState: { variables: null, strings: new Map() } }), /shared game state/);
});
test("KCS child exit, front-end local initialization and removal retain actual task state", async () => {
  const tasks = require("../src/modules/catsystem2/runtime/tasks").createTaskRegistry(), exits = [], changes = [], removed = [];
  const child = tasks.create(12, 1, "child"), screen = tasks.create(34, child.id, "menu");
  const host = createKernelServices({ taskId: child.id, taskRegistry: tasks, onExitCode: value => exits.push(value), frontEnd: { setLocal: (...values) => changes.push(values), dispose: async id => removed.push(id) } }), vm = machine(host);
  await call(host, vm, 453, -2); assert.equal(tasks.lookup(child.id).exitCode, -2); assert.deepEqual(exits, [-2]);
  call(host, vm, 645, screen.id, 0, 1); assert.deepEqual(changes, [[screen.id, 0, 1]]);
  assert.throws(() => call(host, vm, 645, child.id, 0, 1), /handle/); await call(host, vm, 67, screen.id);
  assert.deepEqual(removed, [screen.id]); assert.equal(tasks.tasks.has(screen.id), false); assert.equal(tasks.tasks.has(child.id), true);
  await assert.rejects(call(host, vm, 67, child.id), /kernel task removal is unsupported/);
  assert.throws(() => call(host, vm, 645, 65530, 0, 1), /handle/);
});
test("KCS external screen callbacks retain formatted names and reject stale or wrong task handles", async () => {
  const tasks=require("../src/modules/catsystem2/runtime/tasks").createTaskRegistry(),screen=tasks.create(34,1,"screen"),other=tasks.create(6,1,"button"),calls=[];
  const host=createKernelServices({taskId:1,taskRegistry:tasks,frontEnd:{callBlock:async(...values)=>{calls.push(values);return false;}}}),vm=machine(host);
  Buffer.from("QUERY_%d[G256]\0").copy(vm.memory,64);Buffer.from("item\0").copy(vm.memory,96);vm.memory.writeInt32LE(7,256);
  assert.deepEqual(await call(host,vm,630,screen.id,64,96,1),{});assert.deepEqual(calls,[[screen.id,"QUERY_7","item",1]]);
  await assert.rejects(call(host,vm,630,other.id,64,96,0),/handle/);tasks.remove(screen.id);
  await assert.rejects(call(host,vm,630,screen.id,64,96,0),/handle/);assert.equal(calls.length,1);
  await assert.rejects(call(createKernelServices({taskId:1}),vm,630,0,0,0,0),/callbacks are unavailable/);
});
test("KCS reads the actual signed screen local without copying another script's region", () => {
  const tasks=require("../src/modules/catsystem2/runtime/tasks").createTaskRegistry(),a=tasks.create(34,1,"a"),b=tasks.create(34,1,"b"),reads=[];
  const host=createKernelServices({taskId:1,taskRegistry:tasks,frontEnd:{getLocal:(id,index)=>{reads.push([id,index]);return id===a.id?-37:21;}}}),vm=machine(host);
  assert.deepEqual(call(host,vm,646,a.id,9),{value:-37});assert.deepEqual(call(host,vm,646,b.id,9),{value:21});
  for(const index of [512,0xffffffff])assert.throws(()=>call(host,vm,646,a.id,index),/local index exceeds/);
  assert.equal(reads.length,2);tasks.remove(a.id);assert.throws(()=>call(host,vm,646,a.id,9),/handle/);
  assert.throws(()=>call(createKernelServices({taskId:1}),vm,646,b.id,9),/locals are unavailable/);
});
test("KCS native sizing queries use explicit windowed state and reject unknown fullscreen values", () => {
  let state={windowed:true};const host=createKernelServices({taskId:1,getWindowState:()=>state}),vm=machine(host);
  assert.deepEqual(call(host,vm,741),{value:0});state={windowed:false};assert.throws(()=>call(host,vm,741),/fullscreen sizing profile/);
  for(const invalid of [null,{}, {windowed:0}]){state=invalid;assert.throws(()=>call(host,vm,741),/state is invalid/);}
  assert.throws(()=>call(createKernelServices({taskId:1}),vm,741),/state is unavailable/);
  assert.throws(()=>call(host,vm,741,1),/argument layout/);
});
