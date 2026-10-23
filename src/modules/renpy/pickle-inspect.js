const { TextDecoder } = require("node:util");

// Static pickle stack machine. Globals, constructors, reducers and BUILD are
// inert records, never imported, called or assigned to a JavaScript prototype.
// RPA indexes use primitiveOnly; RPYC inspection may retain inert AST records.
const DEFAULT_LIMITS = Object.freeze({ bytes: 16 * 1024 * 1024, operations: 1_000_000,
  stack: 250_000, memo: 250_000, items: 250_000, blob: 8 * 1024 * 1024 });
const MARK = Symbol("pickle mark");
const utf8 = new TextDecoder("utf-8", { fatal: true });
const fieldCache = new WeakMap();

function inspectPickle(buffer, { primitiveOnly = true, limits = {} } = {}) {
  const cap = { ...DEFAULT_LIMITS, ...limits };
  if (!Buffer.isBuffer(buffer) || buffer.length > cap.bytes) throw new Error("Pickle exceeds inspection byte limit.");
  let position = 0, operations = 0, items = 0;
  const stack = [], memo = new Map(), objects = [];
  const need = length => {
    if (!Number.isSafeInteger(length) || length < 0 || position + length > buffer.length) throw new Error("Truncated pickle data.");
  };
  const byte = () => { need(1); return buffer[position++]; };
  const uint = width => { need(width); const value = buffer.readUIntLE(position, width); position += width; return value; };
  const signed = () => { need(4); const value = buffer.readInt32LE(position); position += 4; return value; };
  const wide = () => { need(8); const value = buffer.readBigUInt64LE(position); position += 8; if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Oversized pickle length."); return Number(value); };
  const bytes = length => { if (length > cap.blob) throw new Error("Pickle blob exceeds inspection limit."); need(length); const value = buffer.subarray(position, position + length); position += length; return value; };
  const line = () => { const end = buffer.indexOf(10, position); if (end < 0 || end - position > cap.blob) throw new Error("Invalid pickle line."); const value = buffer.subarray(position, end).toString("latin1"); position = end + 1; return value; };
  const push = value => { if (stack.length >= cap.stack) throw new Error("Pickle stack exceeds inspection limit."); stack.push(value); };
  const pop = () => { if (!stack.length || stack.at(-1) === MARK) throw new Error("Invalid pickle stack."); return stack.pop(); };
  const top = () => { if (!stack.length || stack.at(-1) === MARK) throw new Error("Invalid pickle stack."); return stack.at(-1); };
  const count = amount => { items += amount; if (items > cap.items) throw new Error("Pickle collection exceeds inspection limit."); };
  const marked = () => { const index = stack.lastIndexOf(MARK); if (index < 0) throw new Error("Missing pickle mark."); const values = stack.splice(index + 1); stack.pop(); count(values.length); return values; };
  const collection = (kind, values = []) => { Object.defineProperty(values, "pickleKind", { value: kind }); return values; };
  const record = (kind, fields) => {
    if (primitiveOnly) throw new Error("Object construction is forbidden in RPA indexes.");
    const object = { pickleKind: kind, ...fields };
    objects.push(object); count(1); return object;
  };
  const put = index => { if (!Number.isSafeInteger(index) || index < 0 || index >= cap.memo) throw new Error("Pickle memo exceeds inspection limit."); memo.set(index, top()); };
  const get = index => { if (!memo.has(index)) throw new Error("Invalid pickle memo reference."); push(memo.get(index)); };
  const setItems = (target, values) => {
    if (values.length % 2) throw new Error("Invalid pickle dictionary.");
    if (!(target instanceof Map)) {
      if (primitiveOnly || !["object", "reduce"].includes(target?.pickleKind)) throw new Error("Invalid pickle dictionary.");
      target.mapping ||= new Map(); target = target.mapping;
    }
    for (let i = 0; i < values.length; i += 2) target.set(values[i], values[i + 1]);
  };
  const append = (target, values) => {
    if (!Array.isArray(target) || target.pickleKind !== "list") {
      if (primitiveOnly || !["object", "reduce"].includes(target?.pickleKind)) throw new Error("Invalid pickle list.");
      target.items ||= []; target = target.items;
    }
    count(values.length); for (const value of values) target.push(value);
  };
  while (position < buffer.length) {
    if (++operations > cap.operations) throw new Error("Pickle exceeds operation limit.");
    const opcode = byte();
    switch (opcode) {
      case 0x80: if (byte() > 5) throw new Error("Unsupported pickle protocol."); break;
      case 0x95: { const length = wide(); need(length); break; }
      case 0x2e: if (stack.length !== 1 || position !== buffer.length) throw new Error("Invalid pickle termination."); return { value: stack[0], objects, operations };
      case 0x28: push(MARK); break;
      case 0x30: pop(); break;
      case 0x31: marked(); break;
      case 0x32: push(top()); break;
      case 0x4e: push(null); break;
      case 0x88: push(true); break;
      case 0x89: push(false); break;
      case 0x49: { const value = line(); if (value === "00" || value === "01") push(value === "01"); else { if (value.length > 620) throw new Error("Pickle integer exceeds inspection limit."); if (!/^-?\d+$/.test(value)) throw new Error("Invalid pickle integer."); push(BigInt(value)); } break; }
      case 0x4a: push(signed()); break;
      case 0x4b: push(byte()); break;
      case 0x4d: push(uint(2)); break;
      case 0x4c: { const value = line().replace(/L$/, ""); if (value.length > 620) throw new Error("Pickle integer exceeds inspection limit."); if (!/^-?\d+$/.test(value)) throw new Error("Invalid pickle long."); push(BigInt(value)); break; }
      case 0x8a: case 0x8b: {
        const length = opcode === 0x8a ? byte() : uint(4);
        if (length > 256) throw new Error("Pickle integer exceeds inspection limit.");
        const value = bytes(length);
        let integer = 0n;
        for (let i = value.length - 1; i >= 0; i--) integer = (integer << 8n) | BigInt(value[i]);
        if (value.length && value.at(-1) & 128) integer -= 1n << BigInt(value.length * 8);
        push(integer); break;
      }
      case 0x46: { const value = Number(line()); if (!Number.isFinite(value)) throw new Error("Non-finite pickle float."); push(value); break; }
      case 0x47: { need(8); const value = buffer.readDoubleBE(position); position += 8; if (!Number.isFinite(value)) throw new Error("Non-finite pickle float."); push(value); break; }
      case 0x53: { const value = line(); if (!/^(['"]).*\1$/.test(value)) throw new Error("Invalid pickle byte literal."); push(Buffer.from(unescapeLegacy(value.slice(1, -1), false), "latin1")); break; }
      case 0x56: push(unescapeLegacy(line(), true)); break;
      case 0x54: case 0x42: push(Buffer.from(bytes(uint(4)))); break;
      case 0x55: case 0x43: push(Buffer.from(bytes(byte()))); break;
      case 0x8e: case 0x96: push(Buffer.from(bytes(wide()))); break;
      case 0x58: push(utf8.decode(bytes(uint(4)))); break;
      case 0x8c: push(utf8.decode(bytes(byte()))); break;
      case 0x8d: push(utf8.decode(bytes(wide()))); break;
      case 0x5d: push(collection("list")); break;
      case 0x6c: push(collection("list", marked())); break;
      case 0x61: { const value = pop(); append(top(), [value]); break; }
      case 0x65: { const values = marked(); append(top(), values); break; }
      case 0x29: push(collection("tuple")); break;
      case 0x74: push(collection("tuple", marked())); break;
      case 0x85: push(collection("tuple", [pop()])); break;
      case 0x86: { const b = pop(), a = pop(); push(collection("tuple", [a, b])); break; }
      case 0x87: { const c = pop(), b = pop(), a = pop(); push(collection("tuple", [a, b, c])); break; }
      case 0x7d: push(new Map()); break;
      case 0x64: { const values = marked(), target = new Map(); setItems(target, values); push(target); break; }
      case 0x73: { const value = pop(), key = pop(); count(2); setItems(top(), [key, value]); break; }
      case 0x75: { const values = marked(); setItems(top(), values); break; }
      case 0x8f: push(new Set()); break;
      case 0x90: { const values = marked(), target = top(); if (!(target instanceof Set)) throw new Error("Invalid pickle set."); for (const value of values) target.add(value); break; }
      case 0x91: push(new Set(marked())); break;
      case 0x70: put(Number(line())); break;
      case 0x71: put(byte()); break;
      case 0x72: put(uint(4)); break;
      case 0x94: put(memo.size); break;
      case 0x67: get(Number(line())); break;
      case 0x68: get(byte()); break;
      case 0x6a: get(uint(4)); break;
      case 0x63: push(record("global", { module: line(), name: line() })); break;
      case 0x93: { const name = pop(), module = pop(); if (typeof name !== "string" || typeof module !== "string") throw new Error("Invalid pickle global."); push(record("global", { module, name })); break; }
      case 0x81: { const args = pop(), klass = pop(); if (!Array.isArray(args)) throw new Error("Invalid pickle constructor."); push(record("object", { klass, args })); break; }
      case 0x92: { const kwargs = pop(), args = pop(), klass = pop(); if (!(kwargs instanceof Map) || !Array.isArray(args)) throw new Error("Invalid pickle constructor."); push(record("object", { klass, args, kwargs })); break; }
      case 0x52: { const args = pop(), callable = pop(); if (!Array.isArray(args)) throw new Error("Invalid pickle reducer."); push(record("reduce", { callable, args })); break; }
      case 0x62: { const state = pop(), object = top(); if (primitiveOnly || !object || !["object", "reduce"].includes(object.pickleKind)) throw new Error("Invalid pickle object state."); object.state = state; break; }
      case 0x6f: { const values = marked(); if (!values.length) throw new Error("Invalid pickle object."); push(record("object", { klass: values[0], args: values.slice(1) })); break; }
      case 0x69: { const module = line(), name = line(), args = marked(); push(record("object", { klass: record("global", { module, name }), args })); break; }
      default: throw new Error(`Unsupported pickle opcode 0x${opcode.toString(16)}.`);
    }
  }
  throw new Error("Unterminated pickle data.");
}

function unescapeLegacy(value, unicode) {
  return value.replace(/\\(?:[\\'"abfnrtv]|x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|[0-7]{1,3})/g, escape => {
    const code = escape[1], standard = { "\\": "\\", "'": "'", '"': '"', a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" };
    if (Object.hasOwn(standard, code)) return standard[code];
    if (!unicode && (code === "u" || code === "U")) return escape;
    const point = parseInt(escape.slice(/[0-7]/.test(code) ? 1 : 2), /[0-7]/.test(code) ? 8 : 16);
    if (point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) throw new Error("Invalid pickle unicode escape.");
    return String.fromCodePoint(point);
  });
}

function objectClass(value) {
  if (value?.pickleKind === "object" && value.klass?.pickleKind === "global") return `${value.klass.module}.${value.klass.name}`;
  if (value?.pickleKind === "reduce" && ["copy_reg._reconstructor", "copyreg._reconstructor"].includes(objectClassName(value.callable))) {
    return objectClassName(value.args?.[0]);
  }
  return null;
}
function objectClassName(value) { return value?.pickleKind === "global" ? `${value.module}.${value.name}` : null; }
function objectFields(value) {
  const normalize = mapping => {
    if (!fieldCache.has(mapping)) fieldCache.set(mapping, new Map([...mapping].map(([key, item]) => [Buffer.isBuffer(key) ? utf8.decode(key) : key, item])));
    return fieldCache.get(mapping);
  };
  if (value?.state instanceof Map) return normalize(value.state);
  if (Array.isArray(value?.state)) {
    if (fieldCache.has(value.state)) return fieldCache.get(value.state);
    const result = new Map();
    for (const part of value.state) if (part instanceof Map) for (const [key, item] of normalize(part)) result.set(key, item);
    fieldCache.set(value.state, result);
    return result;
  }
  return new Map();
}
function pythonSource(value, depth = 0) {
  if (depth > 16) throw new Error("Compiled Python source reference depth exceeded.");
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return utf8.decode(value);
  const klass = objectClass(value);
  if (["renpy.python.PyExpr", "renpy.ast.PyExpr"].includes(klass)) {
    const text = value.pickleKind === "reduce" ? value.args?.[2] : value.args?.[0];
    return typeof text === "string" || Buffer.isBuffer(text) ? pythonSource(text, depth + 1) : null;
  }
  if (klass === "renpy.ast.PyCode") return pythonSource(objectFields(value).get("source") ?? value.state?.[1], depth + 1);
  return null;
}

module.exports = { DEFAULT_LIMITS, inspectPickle, objectClass, objectFields, pythonSource };
