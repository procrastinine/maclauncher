const test = require("node:test"), assert = require("node:assert/strict");
const { createFrontEndSound } = require("../src/modules/catsystem2/runtime/frontend-sound");
const { FrontEndMachine } = require("../src/modules/catsystem2/runtime/frontend-vm");
const { parseFrontEnd } = require("../src/modules/catsystem2/frontend-parser");
const { FrontEndObjects } = require("../src/modules/catsystem2/runtime/frontend-objects");
function components() {
  const bytes = Buffer.from("OggS-original"), preserved = Buffer.from(bytes), requests = [], operations = [], part = { play: 0, mute: 0, mastervol: 100, int: "voice_a" };
  let completed, stopped = 0;
  const sound = createFrontEndSound({ registry: { read: async (type, name) => { requests.push([type, name]); return bytes; } },
    soundConfig: { master: { volume: 80, play: 1, mute: 0 }, soundFor: () => part }, cache: { get: async input => { assert.equal(input, bytes); return { file: "/cache/audio.wav" }; } },
    output: { start: async input => { operations.push(input); completed = input.onFinished; return { active: true, stop: async () => { stopped++; }, setGain: async gain => operations.push({ gain }) }; } } });
  const object = { type: "SOUND", id: "voice", group: "voice", index: 0, soundGroup: "voice" }, machine = new FrontEndMachine("#START\n#voice.STOP\n$8=1");
  return { sound, object, machine, bytes, preserved, requests, operations, finish: () => completed(), stopped: () => stopped };
}
test("FES PCM playback retains authored gains, loops, permission override and actual completion events", async () => {
  const { sound, object, machine, bytes, preserved, requests, operations, finish, stopped } = components();
  await sound.command(object, "blend", ["70"], machine); await sound.command(object, "load", ["A_line"], machine);
  await sound.command(object, "play", ["1", "0"], machine); assert.equal(operations.length, 0);
  await sound.command(object, "play", ["1", "0", "1"], machine); assert.equal(operations[0].loops, 1); assert.ok(Math.abs(operations[0].gain - 0.56) < 1e-12);
  assert.equal(sound.isBusy(object), true); await sound.command(object, "blend", ["50"], machine); assert.equal(operations[1].gain, 0.4);
  finish(); assert.equal(sound.isBusy(object), false); assert.equal(machine.globals[8], 0); await machine.tick(0); assert.equal(machine.globals[8], 1);
  assert.equal(stopped(), 0); assert.deepEqual(requests, [["voice_a", "A_line"]]); assert.deepEqual(bytes, preserved); await sound.close();
});
test("FES disposed audio obeys the end flag and session shutdown always releases its own controls", async () => {
  const { sound, object, machine, stopped } = components(); await sound.command(object, "load", ["A_line"], machine);
  await sound.command(object, "play", ["1", "0", "1"], machine); await sound.dispose({ objects: new Map([[object.id, object]]) }); assert.equal(stopped(), 0);
  await sound.close(); assert.equal(stopped(), 1); assert.equal(sound.states.size, 0);
  const other = components(); await other.sound.command(other.object, "load", ["A_line"], other.machine);
  await other.sound.command(other.object, "play", ["1", "1", "1"], other.machine); await other.sound.dispose({ objects: new Map([[other.object.id, other.object]]) }); assert.equal(other.stopped(), 1);
  await assert.rejects(other.sound.command(other.object, "blend", ["255"], other.machine), /range/); await other.sound.close();
});
test("authored sound tables register enabled tracks lazily and play the selected original resource", async () => {
  const { sound, machine, part, requests, operations, bytes, preserved } = components();
  // A separate sound table uses the same actual playback service and retains
  // its own entry/selection state. Registration decodes no tracks.
  const program = parseFrontEnd("#DEFINE\nSNDTABLE music\n#OBJECT SIZE TYPE CHANNEL STYPE\nmusic 3 0 31 0\n#START");
  const objects = new FrontEndObjects(program, { canvas: { width: 20, height: 10 }, sound }), object = objects.objects.get("music");
  for (const [index, file, enabled] of [[0,"BGM_first",0],[1,"BGM_next",1],[2,"BGM_last",1]]) await sound.command(object,"sndtbl",[String(index),file,String(enabled)],machine);
  await sound.command(object,"setid",["0"],machine); await sound.command(object,"getid",["9"],machine); assert.equal(machine.globals[9],1); assert.deepEqual(requests,[]);
  await sound.command(object,"crossfade",["0"],machine); await sound.command(object,"play",["1","1","1"],machine); assert.deepEqual(requests,[["voice_a","BGM_next"]]);
  await sound.command(object,"setid",["2"],machine); await sound.command(object,"play",["1","1","1"],machine); assert.equal(requests.at(-1)[1],"BGM_last"); assert.equal(operations.length,2);
  for (const args of [["3","BGM_bad","1"],["0","BGM_bad","2"],["0","A".repeat(32),"1"]]) await assert.rejects(sound.command(object,"sndtbl",args,machine),/range/);
  await assert.rejects(sound.command(object,"crossfade",["1","60"],machine),/unsupported/); assert.deepEqual(bytes,preserved); await sound.close();
});
test("authored audio motions update real playback gain on their frames and let general waits finish during looped audio", async () => {
  const { sound, operations } = components(), { OFFSET } = require("../src/modules/catsystem2/runtime/motion-vm");
  const literal = (value, tag = 3) => { const bytes = Buffer.alloc(5); bytes[0] = tag; bytes.writeUInt32LE(value >>> 0, 1); return bytes; };
  const op = (opcode, ...args) => Buffer.concat([Buffer.from([opcode]), ...args]);
  const prefix = Buffer.concat([op(0x15, literal(0x80000073, 0x11), literal(0x80000090, 0x13)),
    op(0x11, literal(0x80000090, 0x13), literal(2))]);
  const skip = op(0x27, literal(prefix.length + 6 + 11)), complete = op(0x2b, literal(38), literal(0));
  const motion = { version: 2, code: Buffer.concat([prefix, skip, complete, Buffer.from([0x3b])]), memory: Buffer.alloc(1024), globalsBytes: 0 };
  const source = "#SUBCOMMAND\noneshot fade linear :\n#DEFINE\nSOUND music\n#OBJECT FILE\nmusic BGM_track\n#START\nmusic play 0 1 1\nmusic fade\nwait\n$9=1\nnext IDLE\n#IDLE";
  const objects = new FrontEndObjects(parseFrontEnd(source), { canvas: { width: 20, height: 10 }, sound, loadMotion: async name => { assert.equal(name, "linear"); return motion; } });
  const machine = new FrontEndMachine(source, { host: { resolveTargets: objects.resolveTargets.bind(objects), isBusy: objects.isBusy.bind(objects),
    tick: (frame, vm, input) => objects.tick(frame, vm, input), command: objects.command.bind(objects) } });
  await machine.tick(0); assert.equal(machine.globals[9], 0); assert.equal(operations[0].gain, 0.8); assert.equal(operations[1].gain, 0);
  await machine.tick(1); assert.equal(machine.globals[9], 0); assert.equal(operations[2].gain, 0.008);
  await machine.tick(2); assert.equal(machine.globals[9], 1); assert.equal(operations[3].gain, 0.016);
  const object = objects.objects.get("music"); assert.equal(object.bytes[OFFSET.alpha], 2);
  assert.equal(await objects.isBusy(), false); assert.equal(await objects.isBusy([object]), true);
  assert.equal(sound.isBusy(object), true); await sound.close();
});
test("audio motions reject changes outside their proven volume field before altering sound state", async () => {
  const { sound, machine, operations } = components(), { OFFSET } = require("../src/modules/catsystem2/runtime/motion-vm");
  const objects = new FrontEndObjects(parseFrontEnd("#DEFINE\nSOUND voice\n#START"), { canvas: { width: 20, height: 10 }, sound }), object = objects.objects.get("voice");
  await sound.command(object, "blend", ["60"], machine);
  const initial = sound.motionState(object), changed = Buffer.from(initial); changed[OFFSET.alpha] = 20; changed[OFFSET.position] = 1;
  await assert.rejects(sound.applyMotion(object, initial, changed), /unsupported audio fields/);
  assert.equal(sound.states.get(object).volume, 60); assert.deepEqual(operations, []);
  const excessive = Buffer.from(initial); excessive[OFFSET.alpha] = 101;
  await assert.rejects(sound.applyMotion(object, initial, excessive), /range/); assert.equal(sound.states.get(object).volume, 60);
  await assert.rejects(sound.applyMotion(object, initial, excessive.subarray(1)), /extent/);
  await sound.close();
});
