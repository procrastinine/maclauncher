const { KernelMachine, bits } = require("./kernel-vm");
const LIMITS = Object.freeze({ frame: 1000000, parameters: 256, externalBytes: 0x4a8, objectBytes: 0x90 });
const OFFSET = Object.freeze({ vram: 0, base: 12, position: 24, scale: 0x64, color: 0x70, alpha: 0x73, frame: 0x90, active: 0x94, finish: 0x98, parameters: 0x9c });

/** KCS v2 motion task namespace; distinct from the startup-task native ABI. */
class MotionMachine {
  constructor(program, { parameters = [], initialObject, signal, trace } = {}) {
    if (program?.version !== 2 || !Array.isArray(parameters) || parameters.length > LIMITS.parameters || parameters.some(value => !Number.isFinite(value))) throw new Error("A bounded authored KCS motion program and parameters are required.");
    if (initialObject && (!Buffer.isBuffer(initialObject) || initialObject.length !== LIMITS.objectBytes)) throw new Error("KCS motion object state has an invalid extent.");
    this.bytes = Buffer.alloc(LIMITS.externalBytes); this.bytes.writeUInt32LE(1, OFFSET.active);
    if (initialObject) initialObject.copy(this.bytes);
    else { for (let offset = OFFSET.scale; offset < OFFSET.scale + 12; offset += 4) this.bytes.writeFloatLE(1, offset); this.bytes.writeUInt32LE(0xffffffff, OFFSET.color); }
    parameters.forEach((value, index) => this.bytes.writeFloatLE(value, OFFSET.parameters + index * 4));
    const size = (args, expected) => { if (args.length !== expected) throw new Error("Unsupported KCS motion service argument layout."); };
    const nativeCalls = new Map([
      // Native completion marks the motion inactive and yields this evaluator.
      [38, ({ arguments: args }) => { size(args, 0); this.bytes.writeUInt32LE(0, OFFSET.active); return { yielded: true }; }],
      [17, ({ arguments: args }) => { size(args, 4); const value = args.readFloatLE(); if (!Number.isFinite(value)) throw new Error("Invalid KCS motion rounding value."); return { value: Math.floor(Math.fround(value + 0.5)) }; }],
      [41, ({ arguments: args }) => {
        size(args, 20); const values = Array.from({ length: 5 }, (_, index) => args.readFloatLE(index * 4));
        if (values.some(value => !Number.isFinite(value))) throw new Error("Invalid KCS motion interpolation value.");
        const [from, to, start, end, frame] = values;
        const result = frame <= start ? from : frame >= end ? to : Math.fround(from + Math.fround(Math.fround(Math.fround(frame - start) / Math.fround(end - start)) * Math.fround(to - from)));
        return { value: bits(result) };
      }]
    ]);
    this.machine = new KernelMachine(program, { nativeCalls, signal, trace,
      externalMemory: (offset, length) => offset >= 0 && length >= 0 && offset <= this.bytes.length - length ? { bytes: this.bytes, offset } : null });
    this.lastFrame = -1;
  }
  get done() { return this.bytes.readUInt32LE(OFFSET.active) === 0; }
  async tick(frame) {
    if (!Number.isSafeInteger(frame) || frame < 0 || frame < this.lastFrame || frame > LIMITS.frame) throw new Error("KCS motion frame exceeds its monotonic limit.");
    if (this.done) return { done: true, bytes: this.bytes.subarray(0, LIMITS.objectBytes) };
    this.lastFrame = frame; this.bytes.writeUInt32LE(frame, OFFSET.frame); this.machine.resetFrame(); await this.machine.run();
    return { done: this.done, bytes: this.bytes.subarray(0, LIMITS.objectBytes) };
  }
  async finish() { this.bytes.writeUInt32LE(1, OFFSET.finish); return this.tick(Math.max(0, this.lastFrame)); }
}
module.exports = { LIMITS, OFFSET, MotionMachine };
