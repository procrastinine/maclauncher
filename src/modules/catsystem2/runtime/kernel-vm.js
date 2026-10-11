const Encoding = require("../encoding");
const LIMITS = Object.freeze({ instructions: 10000000, stepsPerTurn: 2048, callDepth: 256, stringBytes: 1024 * 1024 });
const WORD = 4;
function float(bits) { const bytes = Buffer.alloc(4); bytes.writeUInt32LE(bits >>> 0); return bytes.readFloatLE(); }
function bits(value) { const bytes = Buffer.alloc(4); bytes.writeFloatLE(value); return bytes.readUInt32LE(); }

/** Owned KCS v2 interpreter. Native calls require explicitly implemented bindings. */
class KernelMachine {
  constructor(program, { nativeCalls = new Map(), externalMemory, signal, trace } = {}) {
    if (program?.version !== 2 || !Buffer.isBuffer(program.code) || !Buffer.isBuffer(program.memory)) throw new Error("A validated KCS v2 program is required.");
    this.code = program.code; this.memory = Buffer.from(program.memory); this.globalsBytes = program.globalsBytes;
    this.pc = 0; this.sp = this.localBase = this.argumentBase = program.globalsBytes;
    this.nativeCalls = nativeCalls; this.externalMemory = externalMemory; this.signal = signal; this.trace = trace;
    this.callDepth = 0; this.instructions = 0; this.halted = false; this.register = 0;
    this.suspended = null;
  }
  fail(message) { throw new Error(`KCS ${message} at byte ${this.instructionPc ?? this.pc}.`); }
  readCodeWord() {
    if (this.pc < 0 || this.pc > this.code.length - WORD) this.fail("operand exceeds its code range");
    const value = this.code.readUInt32LE(this.pc); this.pc += WORD; return value;
  }
  resolve(address, length = WORD, { write = false } = {}) {
    address >>>= 0;
    if (!Number.isSafeInteger(length) || length < 0) this.fail("memory extent is invalid");
    if (address & 0x80000000) {
      const range = this.externalMemory?.(address & 0x7fffffff, length);
      if (!range || !Buffer.isBuffer(range.bytes) || !Number.isSafeInteger(range.offset) || range.offset < 0 || range.offset > range.bytes.length - length)
        this.fail("external memory is unavailable or out of range");
      if (!write && range.readable && !range.readable(range.offset, length)) this.fail("host preference field is unsupported");
      return range;
    }
    if (!Number.isSafeInteger(length) || length < 0 || address > this.memory.length - length) this.fail("memory address exceeds its range");
    return { bytes: this.memory, offset: address };
  }
  stackTop(value) {
    if (!Number.isSafeInteger(value) || value < this.globalsBytes || value > this.memory.length) this.fail("stack exceeds its bounded memory");
    this.sp = value;
  }
  push(value) { this.resolve(this.sp); this.memory.writeUInt32LE(value >>> 0, this.sp); this.stackTop(this.sp + WORD); }
  pop() { this.stackTop(this.sp - WORD); return this.memory.readUInt32LE(this.sp); }
  operand({ address = false, pointer = false, consumeOnly = false, word = false } = {}) {
    if (this.pc >= this.code.length) this.fail("operand tag exceeds its code range");
    const tag = this.code[this.pc++], encoded = this.readCodeWord();
    if (![1, 2, 3, 4].includes(tag & 15) && !(pointer && (tag & 15) === 6)) this.fail("operand type is unsupported");
    if (consumeOnly) return { tag, value: encoded };
    let value = tag & 0x40 ? this.pop() : encoded;
    if (address) return { tag, value };
    if (tag & 0x10) {
      const type = tag & 15, size = word || tag & 0x80 ? WORD : type === 1 ? 1 : type === 2 ? 2 : WORD;
      const range = this.resolve(value, size), { bytes, offset } = range;
      value = size === 1 ? tag & 0x20 ? bytes.readInt8(offset) : bytes[offset] : size === 2 ? tag & 0x20 ? bytes.readInt16LE(offset) : bytes.readUInt16LE(offset) : bytes.readUInt32LE(offset);
    }
    return { tag, value: value >>> 0 };
  }
  store(target, value) {
    const type = target.tag & 15, size = type === 1 ? 1 : type === 2 ? 2 : WORD;
    const range = this.resolve(target.value, size, { write: true }), { bytes, offset } = range;
    if (size === 1) bytes[offset] = value & 255;
    else if (size === 2) bytes.writeUInt16LE(value & 0xffff, offset);
    else bytes.writeUInt32LE(value >>> 0, offset);
    range.didWrite?.(offset, size);
  }
  writeBytes(address, bytes) {
    if (!Buffer.isBuffer(bytes)) this.fail("native output requires bounded bytes");
    const range = this.resolve(address, bytes.length, { write: true }); bytes.copy(range.bytes, range.offset); range.didWrite?.(range.offset, bytes.length);
  }
  waitMessage(address) {
    if (this.suspended) this.fail("message wait is already pending"); this.resolve(address, 16, { write: true });
    this.suspended = { kind: "message", address: address >>> 0 };
  }
  resumeMessage(words) {
    this.signal?.throwIfAborted();
    if (this.suspended?.kind !== "message" || !Array.isArray(words) || words.length !== 4 || words.some(value => !Number.isInteger(value) || value < 0 || value > 0xffffffff))
      this.fail("message result or pending receive is invalid");
    this.resolve(this.sp, WORD); const bytes = Buffer.alloc(16); words.forEach((value, index) => bytes.writeUInt32LE(value, index * WORD));
    this.writeBytes(this.suspended.address, bytes); this.push(1); this.suspended = null;
  }
  resumeFrame() {
    this.signal?.throwIfAborted();
    if (this.suspended?.kind !== "message") this.fail("frame continuation requires a pending receive");
    // The original per-frame entry returns zero from an unfulfilled receive.
    // Its destination record stays intact; lifecycle messages use resumeMessage.
    this.resolve(this.sp, WORD); this.push(0); this.suspended = null;
  }
  jump(target) { if (!Number.isInteger(target) || target < 0 || target >= this.code.length) this.fail("jump target exceeds its code range"); this.pc = target; }
  stringBytes(address) {
    const { bytes, offset } = this.resolve(address, 1), end = bytes.indexOf(0, offset);
    if (end < offset || end - offset > LIMITS.stringBytes) this.fail("string is unterminated or oversized");
    this.resolve(address, end - offset + 1); return bytes.subarray(offset, end);
  }
  string(address) { return Encoding.decode(this.stringBytes(address)); }
  number(operand, signed = false) { return operand.tag & 4 ? float(operand.value) : signed || operand.tag & 0x20 ? operand.value | 0 : operand.value; }
  binary(opcode) {
    const a = this.operand(), b = this.operand(), signed = !!((a.tag | b.tag) & 0x20), floating = !!((a.tag | b.tag) & 4);
    const left = this.number(a, signed), right = this.number(b, signed); let result;
    switch (opcode) {
      case 1: result = left + right; break; case 2: result = left - right; break; case 3: result = floating ? left * right : Math.imul(left, right); break;
      case 4: if (!right) this.fail("division by zero"); result = floating ? left / right : Math.trunc(left / right); break;
      case 5: if (!right) this.fail("remainder by zero"); result = left % right; break;
      case 6: result = left & right; break; case 7: result = left | right; break; case 9: result = left ^ right; break;
      case 10: result = left << (right & 31); break; case 11: result = signed ? left >> (right & 31) : left >>> (right & 31); break;
      case 13: result = !!left && !!right; break; case 14: result = !!left || !!right; break;
      case 15: result = left > right; break; case 16: result = left < right; break; case 17: result = left >= right; break;
      case 18: result = left <= right; break; case 19: result = left === right; break; case 20: result = left !== right; break;
      default: this.fail(`unsupported arithmetic opcode 0x${opcode.toString(16)}`);
    }
    this.push(floating && opcode <= 4 ? bits(result) : Number(result));
  }
  async step() {
    this.signal?.throwIfAborted();
    if (this.suspended) this.fail("execution requires a message result");
    if (this.halted) return { halted: true };
    if (++this.instructions > LIMITS.instructions || this.pc >= this.code.length) this.fail("instruction budget or program extent exceeded");
    this.instructionPc = this.pc; const opcode = this.code[this.pc++];
    this.trace?.({ pc: this.instructionPc, opcode, stackBytes: this.sp - this.globalsBytes, callDepth: this.callDepth });
    if (opcode >= 1 && opcode <= 20 && opcode !== 8 && opcode !== 12) { this.binary(opcode); return {}; }
    switch (opcode) {
      case 8: this.push(~this.operand().value); break;
      case 12: this.push(Number(this.operand().value === 0)); break;
      case 0x15: { const target = this.operand({ address: true }); this.store(target, this.operand().value); break; }
      case 0x16: case 0x17: case 0x18: case 0x19: {
        const target = this.operand({ address: true }), type = target.tag & 15, size = type === 1 ? 1 : type === 2 ? 2 : WORD;
        const range = this.resolve(target.value, WORD), raw = size === 1 ? range.bytes[range.offset] : size === 2 ? range.bytes.readUInt16LE(range.offset) : range.bytes.readUInt32LE(range.offset);
        const previous = range.bytes.readUInt32LE(range.offset), delta = opcode === 0x16 || opcode === 0x18 ? 1 : -1;
        this.store(target, type === 4 ? bits(float(raw) + delta) : raw + delta);
        this.push(opcode >= 0x18 ? previous : range.bytes.readUInt32LE(range.offset)); break;
      }
      case 0x1a: { const operand = this.operand(); this.push(operand.tag & 4 ? bits(-float(operand.value)) : -operand.value); break; }
      case 0x1f: {
        const target = this.operand({ address: true }), operand = this.operand(), range = this.resolve(target.value, WORD);
        const previous = range.bytes.readUInt32LE(range.offset);
        const result = (target.tag | operand.tag) & 4 ? bits(Math.fround(float(previous) - float(operand.value))) : (previous - operand.value) >>> 0;
        if (target.tag & 0x80) {
          const output = Buffer.alloc(WORD); output.writeUInt32LE(result); this.writeBytes(target.value, output);
        } else this.store(target, result);
        this.push(result); break;
      }
      case 0x25: {
        // A value already produced on the stack is retained. Only a pointer
        // dereference replaces it; the original instruction never discards a
        // computed argument merely because its tag carries the stack bit.
        const tag = this.code[this.pc];
        if (tag & 0x40 && !(tag & 0x10)) this.operand({ consumeOnly: true, pointer: true });
        else this.push(this.operand({ word: true, pointer: true }).value);
        break;
      }
      case 0x26: { const target = this.operand({ address: true }); this.store(target, this.pop()); break; }
      case 0x27: case 0x28: { const target = this.operand().value, condition = this.pop(); if (!!condition === (opcode === 0x28)) this.jump(target); this.stackTop(this.localBase); break; }
      case 0x29: this.jump(this.operand().value); this.stackTop(this.localBase); break;
      case 0x2a: {
        const target = this.operand().value, argumentsBytes = this.operand().value;
        if (argumentsBytes % WORD || argumentsBytes > this.sp - this.localBase || ++this.callDepth > LIMITS.callDepth) this.fail("call arguments or depth exceed their bounds");
        this.push(this.pc); this.push(this.argumentBase); this.push(this.localBase);
        this.localBase = this.sp; this.argumentBase = this.sp - argumentsBytes - 12; this.jump(target); break;
      }
      case 0x2b: {
        const id = this.operand().value, argumentsBytes = this.operand().value;
        if (argumentsBytes % WORD || argumentsBytes > this.sp - this.localBase) this.fail("native call arguments exceed the frame");
        const binding = this.nativeCalls.get(id);
        if (typeof binding !== "function") this.fail(`native service ${id} is unsupported`);
        this.stackTop(this.sp - argumentsBytes);
        const argumentsView = this.memory.subarray(this.sp, this.sp + argumentsBytes), result = await binding({ machine: this, arguments: argumentsView });
        if (!result || typeof result !== "object" || result.value != null && !Number.isFinite(result.value)) this.fail("native service returned an invalid result");
        if (result.value != null) this.push(result.value);
        return { yielded: !!result.yielded, nativeId: id };
      }
      case 0x2c: {
        const returnBytes = this.operand().value, argumentsBytes = this.operand().value;
        if (!this.callDepth || returnBytes % WORD || argumentsBytes % WORD || returnBytes > this.sp - this.localBase) this.fail("return exceeds its frame");
        const saved = Buffer.from(this.memory.subarray(this.sp - returnBytes, this.sp));
        this.stackTop(this.argumentBase + argumentsBytes + 12);
        this.localBase = this.pop(); this.argumentBase = this.pop(); this.jump(this.pop());
        this.stackTop(this.sp - argumentsBytes); saved.copy(this.memory, this.sp); this.stackTop(this.sp + returnBytes); this.callDepth--; break;
      }
      case 0x2e: this.push(this.operand({ address: true, pointer: true }).value); break;
      case 0x2f: {
        const pointer=this.operand({address:true,pointer:true}), range=this.resolve(pointer.value,WORD);
        this.push(range.bytes.readUInt32LE(range.offset)); break;
      }
      case 0x31: this.localBase += this.operand().value; this.stackTop(this.localBase); break;
      case 0x32: this.localBase -= this.operand().value; this.stackTop(this.localBase); break;
      case 0x33: this.register = this.pop(); break;
      case 0x34: { const value = this.operand().value, target = this.operand().value; if (value === this.register) this.jump(target); break; }
      case 0x35: { const first = this.operand().value, last = this.operand().value, target = this.operand().value;
        if (this.register >= Math.min(first, last) && this.register <= Math.max(first, last)) this.jump(target); break; }
      case 0x36: this.push(bits(this.operand().value)); break;
      case 0x37: this.push(bits(this.operand().value | 0)); break;
      case 0x38: {
        const value = float(this.operand().value);
        if (!Number.isFinite(value) || value < 0 || value >= 0x100000000) this.fail("unsigned floating conversion is outside its qualified range");
        this.push(Math.trunc(value)); break;
      }
      case 0x39: {
        const value = float(this.operand().value);
        this.push(!Number.isFinite(value) || value < -0x80000000 || value >= 0x80000000 ? 0x80000000 : Math.trunc(value)); break;
      }
      case 0x3b: this.halted = true; return { halted: true };
      case 0x3c: this.stackTop(this.localBase); break;
      case 0x3d: this.push(this.argumentBase + this.operand().value); break;
      case 0x3e: {
        const base = this.operand({ address: true, pointer: true }); let address = base.value;
        if (base.tag & 0x10) { const range = this.resolve(address); address = range.bytes.readUInt32LE(range.offset); }
        this.push(address + this.operand().value); break;
      }
      default: this.fail(`opcode 0x${opcode.toString(16).padStart(2, "0")} is unsupported`);
    }
    return {};
  }
  async run() {
    if (this.suspended) return { yielded: true, reason: "message" };
    while (!this.halted) {
      for (let steps = 0; steps < LIMITS.stepsPerTurn && !this.halted; steps++) {
        const result = await this.step(); if (result.yielded) return result;
      }
      if (!this.halted) await new Promise(resolve => setImmediate(resolve));
    }
    return { halted: true };
  }
  resetFrame() {
    if (this.suspended) this.fail("pending message execution cannot restart");
    this.pc = 0; this.sp = this.localBase = this.argumentBase = this.globalsBytes;
    this.callDepth = 0; this.halted = false;
  }
}
module.exports = { LIMITS, KernelMachine, float, bits };
