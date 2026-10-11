const Animation = require("../animation");
const PROFILE = "ANM-frame-jump-2.6.1.76", LIMITS = Object.freeze({ frames: 1000000, instructionsPerFrame: 4096 });

/** Literal frame/delay/jump timelines, independently scoped from KCS motion. */
class ImageAnimation {
  constructor(program, { engineVersion, signal } = {}) {
    if (engineVersion !== "2.6.1.76" || program?.format !== "ANM" || program.parserVersion !== Animation.VERSION || !Array.isArray(program.timelines) ||
        !program.timelines.length || program.timelines.length > Animation.LIMITS.timelines || program.timelineCount !== program.timelines.length ||
        program.timelines.some(timeline => !Number.isInteger(timeline.command) || !Array.isArray(timeline.parameters) || timeline.parameters.length !== Animation.COUNTS[timeline.command]))
      throw new Error("This ANM execution profile is unsupported.");
    this.program = program; this.signal = signal; this.reset(0);
  }
  reset(startFrame) {
    if (!Number.isSafeInteger(startFrame) || startFrame < 0 || startFrame > LIMITS.frames) throw new Error("ANM start frame exceeds its range.");
    this.startFrame = startFrame; this.lastFrame = startFrame - 1; this.untilFrame = startFrame; this.pc = 0; this.frameId = -1; this.done = false;
  }
  value(parameter) {
    if (!parameter || ![0,2].includes(parameter.type) || !Number.isSafeInteger(parameter.value)) throw new Error("ANM variable parameters are unsupported."); return parameter.value;
  }
  duration(parameters) {
    const from = this.value(parameters[0]), to = this.value(parameters[1]);
    if (from !== to || from < 0 || from > LIMITS.frames) throw new Error("This ANM duration range is unsupported."); return from;
  }
  tick(frame) {
    this.signal?.throwIfAborted();
    if (!Number.isSafeInteger(frame) || frame < this.lastFrame || frame < this.startFrame || frame > LIMITS.frames) throw new Error("ANM frame sequence exceeds its range.");
    this.lastFrame = frame; let instructions = 0;
    while (!this.done && frame >= this.untilFrame) {
      this.signal?.throwIfAborted(); if (++instructions > LIMITS.instructionsPerFrame) throw new Error("ANM control flow exceeds its frame instruction limit.");
      if (this.pc === this.program.timelines.length) { this.done = true; break; }
      const timeline = this.program.timelines[this.pc++];
      if (!timeline) throw new Error("ANM program position exceeds its timeline table.");
      if (timeline.command === 0) {
        const id = this.value(timeline.parameters[0]); if (id < -1 || id > 0x7fffffff) throw new Error("ANM image ID exceeds its range.");
        this.frameId = id; this.untilFrame += this.duration(timeline.parameters.slice(1));
      } else if (timeline.command === 15) this.untilFrame += this.duration(timeline.parameters);
      else if (timeline.command === 3) {
        const target = this.value(timeline.parameters[0]); if (target < 0 || target >= this.program.timelines.length) throw new Error("ANM jump exceeds its timeline table."); this.pc = target;
      } else throw new Error(`ANM command ${timeline.command} is unsupported by this execution profile.`);
    }
    return { frameId: this.frameId, done: this.done };
  }
}
module.exports = { PROFILE, LIMITS, ImageAnimation };
