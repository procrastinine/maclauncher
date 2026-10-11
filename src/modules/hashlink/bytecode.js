const fs = require("node:fs");

const MAX_BYTECODE_BYTES = 128 * 1024 * 1024;

// Reads only serialized metadata and native imports. No Haxe code is evaluated.
// The executable remains responsible for validating function bodies/opcodes.
function inspectBytecode(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 16 || buffer.length > MAX_BYTECODE_BYTES ||
    buffer.subarray(0, 3).toString("ascii") !== "HLB") throw new Error("Not a supported HashLink bytecode file.");
  let offset = 3;
  const take = count => {
    if (!Number.isSafeInteger(count) || count < 0 || count > buffer.length - offset) throw new Error("Truncated HashLink bytecode metadata.");
    const result = buffer.subarray(offset, offset + count);
    offset += count;
    return result;
  };
  const byte = () => take(1)[0];
  const index = () => {
    const value = byte();
    if (!(value & 128)) return value;
    const magnitude = value & 64 ? (value & 31) * 0x1000000 + byte() * 0x10000 + byte() * 0x100 + byte()
      : (value & 31) * 256 + byte();
    return value & 32 ? -magnitude : magnitude;
  };
  const count = () => {
    const value = index();
    if (value < 0 || value > buffer.length) throw new Error("Invalid HashLink bytecode count.");
    return value;
  };
  const version = byte();
  if (version < 2 || version > 6) throw new Error(`Unsupported HashLink bytecode version ${version}; inspected versions are 2–6.`);
  const flags = count();
  const integers = count(), floats = count(), stringCount = count();
  const bytes = version >= 5 ? count() : 0;
  const types = count(), globals = count(), nativeCount = count(), functions = count();
  const constants = version >= 4 ? count() : 0;
  const entrypoint = count();
  if (!types || !functions || entrypoint >= functions + nativeCount) throw new Error("Invalid HashLink entrypoint/type table.");
  take(integers * 4 + floats * 8);
  function readStrings(length) {
    const size = take(4).readInt32LE(0);
    const raw = take(size);
    let start = 0;
    const result = [];
    for (let i = 0; i < length; i += 1) {
      const size = count();
      if (size >= raw.length - start || raw[start + size] !== 0) throw new Error("Invalid HashLink string table.");
      result.push(raw.subarray(start, start + size).toString("utf8"));
      start += size + 1;
    }
    return result;
  }
  const strings = readStrings(stringCount);
  if (version >= 5) {
    const size = take(4).readInt32LE(0);
    take(size);
    for (let i = 0; i < bytes; i += 1) if (count() > size) throw new Error("Invalid HashLink bytes offset.");
  }
  if (flags & 1) readStrings(count());
  const typeIndex = () => {
    const value = index();
    if (value < 0 || value >= types) throw new Error("Invalid HashLink type reference.");
    return value;
  };
  const stringIndex = () => {
    const value = index();
    if (value < 0 || value >= stringCount) throw new Error("Invalid HashLink string reference.");
    return strings[value];
  };
  const typeTable = [];
  for (let i = 0; i < types; i += 1) {
    const kind = byte();
    const type = { kind }; typeTable.push(type);
    if (kind > 23) throw new Error("Unknown HashLink type kind.");
    if (kind === 10 || kind === 20) {
      const argumentsCount = byte();
      type.arguments = [];
      for (let a = 0; a < argumentsCount; a += 1) type.arguments.push(typeIndex());
      type.returns = typeIndex();
    } else if (kind === 11 || kind === 21) {
      type.name = stringIndex();
      const parent = index();
      if (parent < -1 || parent >= types) throw new Error("Invalid HashLink parent type.");
      type.parent = parent;
      count();
      const fields = count(), prototypes = count(), bindings = count();
      type.fields = [];
      for (let j = 0; j < fields; j += 1) { stringIndex(); type.fields.push(typeIndex()); }
      for (let j = 0; j < prototypes; j += 1) { stringIndex(); count(); index(); }
      for (let j = 0; j < bindings; j += 1) { count(); count(); }
    } else if (kind === 15) {
      const fields = count();
      for (let j = 0; j < fields; j += 1) { stringIndex(); typeIndex(); }
    } else if (kind === 17) type.name = stringIndex();
    else if (kind === 18) {
      stringIndex(); count();
      const constructors = count();
      for (let j = 0; j < constructors; j += 1) {
        stringIndex();
        const parameters = count();
        for (let k = 0; k < parameters; k += 1) typeIndex();
      }
    } else if ([14, 19, 22].includes(kind)) type.parameter = typeIndex();
  }
  // HashLink checks this complete legacy-FFI signature before binding a native
  // primitive. Reader version and SDL event shape alone do not describe its ABI.
  const typeCharacters = "vcsilfdbBDPOATR??X?N?S?g";
  function nativeSignature(reference, active = new Set(), depth = 0) {
    if (depth > 32 || active.has(reference)) throw new Error("Recursive HashLink native signature.");
    active.add(reference);
    const type = typeTable[reference];
    let value = typeCharacters[type.kind];
    const append = child => nativeSignature(child, active, depth + 1);
    if (type.kind === 10) value += type.arguments.map(append).join("") + "_" + append(type.returns);
    else if ([14, 19].includes(type.kind)) value += append(type.parameter);
    else if (type.kind === 11) {
      const fields = (object, parents = new Set()) => {
        if (parents.has(object) || parents.size > 32) throw new Error("Recursive HashLink native object layout.");
        parents.add(object);
        const obj = typeTable[object];
        if (obj.kind !== 11) throw new Error("Invalid HashLink native object parent.");
        const parent = obj.parent < 0 ? "" : fields(obj.parent, parents);
        return parent + obj.fields.map(append).join("");
      };
      value += fields(reference) + "_";
    } else if (type.kind === 17) {
      if (!/^[A-Za-z0-9_]+$/.test(type.name) || type.name.length > 100) throw new Error("Invalid HashLink native abstract name.");
      value += type.name + "_";
    }
    active.delete(reference);
    if (value.length > 255) throw new Error("HashLink native signature exceeds its inspection limit.");
    return value;
  }
  for (let i = 0; i < globals; i += 1) typeIndex();
  const natives = [];
  for (let i = 0; i < nativeCount; i += 1) {
    const library = stringIndex(), name = stringIndex();
    const reference = typeIndex(), type = typeTable[reference];
    if (type.kind !== 10) throw new Error("HashLink native import requires a function type.");
    const functionIndex = count();
    if (functionIndex >= functions + nativeCount) throw new Error("Invalid HashLink native function reference.");
    natives.push({ library, name, optional: library.startsWith("?"), signature: nativeSignature(reference),
      argumentTypeKinds: type.arguments?.map(reference => typeTable[reference].kind) || null,
      returnTypeKind: type.returns === undefined ? null : typeTable[type.returns].kind });
  }
  const eventLoop = natives.find(native => native.library.replace(/^\?/, "") === "sdl" && native.name === "event_loop");
  const eventArgument = eventLoop?.argumentTypeKinds?.[0];
  const nativeAbi = { sdlEventLoop: eventArgument === 11 ? "typed-event" : eventArgument === 9 ? "dynamic" : "unknown",
    source: eventLoop ? "serialized sdl@event_loop argument type" : null };
  return { version, types, globals, functions, constants, entrypoint, natives,
    nativeAbi,
    nativeLibraries: [...new Set(natives.map(native => native.library))], metadataBytes: offset,
    inspectionScope: "metadata-and-native-imports" };
}

function readBytecode(filePath) {
  const size = fs.statSync(filePath).size;
  if (size > MAX_BYTECODE_BYTES) throw new Error("HashLink bytecode exceeds the 128 MiB inspection limit.");
  return inspectBytecode(fs.readFileSync(filePath));
}

module.exports = { inspectBytecode, readBytecode, MAX_BYTECODE_BYTES };
