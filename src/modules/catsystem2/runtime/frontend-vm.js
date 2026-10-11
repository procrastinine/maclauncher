const { parseFrontEnd } = require("../frontend-parser");
const { parseExpression, evaluateExpression } = require("../frontend-expression");

const LIMITS = Object.freeze({ instructionsPerFrame: 100000, callDepth: 128, events: 512, frames: 1000000, strings: 1024, stringBytes: 8192 });
const blockName = name => typeof name === "string" && /^[A-Za-z_][A-Za-z0-9_.]*$/.test(name);

/** Compile only authored control flow; commands remain explicit host operations. */
function compileFrontEnd(program) {
  if (typeof program === "string") program = parseFrontEnd(program);
  if (!(program?.blocks instanceof Map) || !program.blocks.has("START")) throw new Error("A bounded authored FES program is required.");
  const blocks = new Map();
  for (const [name, block] of program.blocks) {
    const instructions = [], conditionals = [];
    for (const statement of block.statements) {
      const source = statement.source, words = statement.words, match = /^if\s*\((.*)\)\s*$/.exec(source);
      if (match) {
        const instruction = { kind: "if", expression: parseExpression(match[1]), line: statement.line, target: null };
        conditionals.push({ instruction, otherwise: null }); instructions.push(instruction);
      } else if (source === "else") {
        const conditional = conditionals.at(-1);
        if (!conditional || conditional.otherwise) throw new Error(`Unmatched FES else at line ${statement.line}.`);
        conditional.instruction.target = instructions.length + 1;
        const instruction = { kind: "jump", line: statement.line, target: null }; conditional.otherwise = instruction; instructions.push(instruction);
      } else if (source === "endif") {
        const conditional = conditionals.pop(); if (!conditional) throw new Error(`Unmatched FES endif at line ${statement.line}.`);
        (conditional.otherwise || conditional.instruction).target = instructions.length;
      } else if (/^[\\$]/.test(source)) instructions.push({ kind: "expression", expression: parseExpression(source), line: statement.line });
      else instructions.push({ kind: "command", words, source, line: statement.line });
    }
    if (conditionals.length) throw new Error(`Incomplete FES conditional in block ${name}.`);
    blocks.set(name, { name, instructions });
  }
  return { ...program, blocks };
}

/** Frame-bound FES interpreter. Each instance owns its screen, calls and input. */
class FrontEndMachine {
  constructor(program, { globals, strings, host = {}, signal, trace, random = Math.random } = {}) {
    this.program = compileFrontEnd(program); this.blocks = this.program.blocks;
    if (globals && (!(globals instanceof Int32Array) || globals.length < 1 || globals.length > 65536)) throw new Error("FES requires a bounded authored global flag region.");
    if (strings && (!(strings instanceof Map) || strings.size > LIMITS.strings)) throw new Error("FES string storage is invalid.");
    this.globals = globals || new Int32Array(1024); this.locals = new Int32Array(512); this.strings = strings || new Map();
    this.host = host; this.signal = signal; this.trace = trace; this.random = random;
    this.frame = -1; this.frameOrigin = 0; this.active = "START"; this.cursor = { block: "START", pc: 0 }; this.calls = [];
    this.waiting = null; this.events = []; this.currentObject = null; this.exitCode = null; this.ended = false; this.instructions = 0; this.inFrame = false;
    this.mouse = { x: 0, y: 0, left: 0, right: 0 }; this.focus = null; this.keySkip = "on";
    this.childExitCode = -1;
  }
  context() {
    return { globals: this.globals, locals: this.locals, current: () => this.currentObject?.index ?? 0,
      resolveName: (name, index) => {
        const system = { _FRAME_: this.frame - this.frameOrigin, _EXITCODE_: this.childExitCode, _MOUSE_X_: this.mouse.x, _MOUSE_Y_: this.mouse.y,
          _CLICK_L_: this.mouse.left, _CLICK_R_: this.mouse.right };
        if (Object.hasOwn(system, name)) { if (index != null) throw new Error("FES system variable cannot have an index."); return system[name]; }
        const object = this.host.resolveObject?.(name, index, this.currentObject);
        if (!object || !Number.isInteger(object.handle) || object.handle <= 0) throw new Error(`Unsupported FES identifier ${name}.`); return object.handle;
      } };
  }
  value(source) { return evaluateExpression(parseExpression(source), this.context()); }
  string(source) {
    if (typeof source !== "string" || source.length > LIMITS.stringBytes) throw new Error("FES string exceeds its length limit.");
    if (source.startsWith('"')) { if (!source.endsWith('"')) throw new Error("Incomplete FES string."); return source.slice(1, -1); }
    const variable = /^\$str(\d+)$/.exec(source);
    if (variable) { const index = Number(variable[1]); if (index >= LIMITS.strings) throw new Error("FES string index exceeds its region."); return this.strings.get(index) ?? ""; }
    return source;
  }
  queueEvent(object, event) {
    if (!object || !Number.isSafeInteger(object.index) || !/^[A-Z_]+$/.test(event) || this.events.length >= LIMITS.events) throw new Error("Invalid or excessive FES input event.");
    this.events.push({ object, event });
  }
  stop() { this.ended = true; this.events = []; this.waiting = null; }
  block(name) { if (!blockName(name) || !this.blocks.has(name)) throw new Error(`FES block ${name} is absent.`); return this.blocks.get(name); }
  switchBlock(name, event = false) {
    this.block(name); this.active = name;
    if (event) this.eventNext = name;
    else { this.cursor = { block: name, pc: 0 }; this.calls = []; this.waiting = null; }
  }
  async tick(frame, input = {}) {
    if (this.inFrame) throw new Error("FES frame evaluation is already running.");
    if (!Number.isSafeInteger(frame) || frame !== this.frame + 1 || frame > LIMITS.frames) throw new Error("FES frame sequence exceeds its limit.");
    if (this.ended) return { done: true, exitCode: this.exitCode };
    this.signal?.throwIfAborted(); this.inFrame = true; this.frame = frame; this.instructions = 0;
    try {
      if (input.mouse) {
        const { x, y, left = 0, right = 0 } = input.mouse;
        if (![x, y, left, right].every(Number.isSafeInteger)) throw new Error("Invalid FES pointer state."); this.mouse = { x, y, left, right };
      } else { this.mouse.left = 0; this.mouse.right = 0; }
      await this.host.tick?.(frame, this, input);
      while (this.events.length && !this.ended) await this.event(this.events.shift());
      if (this.waiting) {
        const wait = this.waiting;
        if (wait.kind === "frames" && frame < wait.until || wait.kind === "objects" && await this.host.isBusy?.(wait.targets, this)) {
          await this.host.present?.(this); return { done: false, waiting: true };
        }
        this.waiting = null;
      }
      await this.run(false);
      await this.host.present?.(this);
      return { done: this.ended, exitCode: this.exitCode, active: this.active, waiting: Boolean(this.waiting) };
    } finally { this.inFrame = false; }
  }
  async event({ object, event }) {
    const saved = { cursor: this.cursor, calls: this.calls, currentObject: this.currentObject };
    this.currentObject = object; this.eventNext = null;
    try {
      for (const group of [object.defaultHandler, object.group].filter(Boolean)) {
        const name = `${group}.${event}`; if (!this.blocks.has(name)) continue;
        this.cursor = { block: name, pc: 0 }; this.calls = []; await this.run(true);
        if (this.ended) break;
      }
    } finally {
      this.currentObject = saved.currentObject;
      if (this.eventNext) { this.cursor = { block: this.eventNext, pc: 0 }; this.calls = []; this.waiting = null; }
      else { this.cursor = saved.cursor; this.calls = saved.calls; }
    }
  }
  async invokeBlock(name, object = null) {
    this.signal?.throwIfAborted();
    if (!blockName(name) || name.length > 63 || this.inFrame || this.ended || this.frame < 0)
      throw new Error("This external FES callback state is unsupported.");
    // Native external callbacks are optional authored labels. An absent
    // label restores the caller's scope without executing another block.
    if (!this.blocks.has(name)) return false;
    const saved = { cursor: this.cursor, calls: this.calls, currentObject: this.currentObject, eventNext: this.eventNext };
    this.inFrame = true; this.currentObject = object; this.eventNext = null; this.cursor = { block: name, pc: 0 }; this.calls = [];
    try { await this.run(true); return true; }
    finally {
      this.inFrame = false; this.currentObject = saved.currentObject;
      if (this.eventNext) { this.cursor = { block: this.eventNext, pc: 0 }; this.calls = []; this.waiting = null; }
      else { this.cursor = saved.cursor; this.calls = saved.calls; }
      this.eventNext = saved.eventNext;
    }
  }
  async run(event) {
    while (!this.ended) {
      this.signal?.throwIfAborted();
      if (++this.instructions > LIMITS.instructionsPerFrame) throw new Error("FES control flow exceeds its frame instruction limit.");
      const block = this.block(this.cursor.block), instruction = block.instructions[this.cursor.pc++];
      if (!instruction) {
        if (this.calls.length) { this.cursor = this.calls.pop(); continue; }
        if (!event) this.cursor = { block: this.active, pc: 0 }; return;
      }
      this.trace?.({ frame: this.frame, block: block.name, line: instruction.line, kind: instruction.kind });
      if (instruction.kind === "if") { if (!evaluateExpression(instruction.expression, this.context())) this.cursor.pc = instruction.target; }
      else if (instruction.kind === "jump") this.cursor.pc = instruction.target;
      else if (instruction.kind === "expression") evaluateExpression(instruction.expression, this.context());
      else if (await this.command(instruction.words, event, instruction)) return;
    }
  }
  async command(words, event, instruction) {
    const [name, ...args] = words, size = (minimum, maximum = minimum) => {
      if (args.length < minimum || args.length > maximum) throw new Error(`Unsupported FES ${name} arguments at line ${instruction.line}.`);
    };
    if (name === "next") {
      size(1); if (this.calls.length) throw new Error("FES next in a subroutine is unsupported."); this.switchBlock(args[0], event); if (event) return true;
    } else if (name === "call") {
      size(1); this.block(args[0]); if (this.calls.length >= LIMITS.callDepth) throw new Error("FES calls exceed their depth limit.");
      this.calls.push(this.cursor); this.cursor = { block: args[0], pc: 0 };
    } else if (name === "break") {
      size(0); if (!this.calls.length) throw new Error("FES break requires a subroutine."); this.cursor = this.calls.pop();
    } else if (name === "wait") {
      size(0, 1); if (event) throw new Error("FES events cannot wait for a frame.");
      const targets = args.length ? this.host.resolveTargets?.(args[0], this.currentObject) : null;
      if (args.length && !targets) {
        const frames = this.value(args[0]); if (frames < 0 || frames > LIMITS.frames) throw new Error("FES wait duration exceeds its limit.");
        this.waiting = { kind: "frames", until: this.frame + Math.max(1, frames) };
      } else {
        if (typeof this.host.isBusy !== "function") throw new Error("FES motion completion is unavailable."); this.waiting = { kind: "objects", targets };
      }
      return true;
    } else if (name === "exit") {
      size(0, 1); const code = args.length ? this.value(args[0]) : 0;
      this.exitCode = code; await this.host.exit?.(this.exitCode, this);
    }
    else if (name === "rand") {
      size(3); const destination = this.value(args[0]), minimum = this.value(args[1]), maximum = this.value(args[2]), random = this.random();
      if (destination < 0 || destination >= this.globals.length || minimum > maximum || !Number.isFinite(random) || random < 0 || random >= 1) throw new Error("Invalid FES random range.");
      this.globals[destination] = Math.floor(random * (maximum - minimum + 1)) + minimum;
    } else if (name === "reset_frame") { size(0); this.frameOrigin = this.frame; }
    else if (name === "keyskip") { size(1); if (!["on", "off", "cont", "0", "1"].includes(args[0])) throw new Error("Unsupported FES key-skip mode."); this.keySkip = args[0]; }
    else {
      const result = await this.host.command?.(name, args, this, instruction);
      if (result && typeof result === "object") {
        if (result.yield !== true || Object.keys(result).length !== 1 || event) throw new Error("This FES host suspension is unsupported.");
        this.waiting = { kind: "frames", until: this.frame + 1 }; return true;
      }
      if (result !== true) throw new Error(`Unsupported FES command ${name} at line ${instruction.line}.`);
    }
    return false;
  }
}
module.exports = { LIMITS, compileFrontEnd, FrontEndMachine };
