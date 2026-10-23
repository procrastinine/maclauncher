// A bounded class-file reader. It reports explicit bytecode calls; it never
// loads classes or treats a string naming Steam as proof of a native consumer.
const PREFIX = "com/codedisaster/steamworks/";
const error = message => Object.assign(new Error(message), { code: "JAVA_STEAM_CLASS_INVALID" });

function inspectClass(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 10 || bytes.length > 1024 * 1024 || bytes.readUInt32BE(0) !== 0xcafebabe) {
    throw error("Invalid or oversized Java class.");
  }
  let offset = 8;
  const need = count => { if (!Number.isSafeInteger(count) || count < 0 || offset + count > bytes.length) throw error("Truncated Java class."); };
  const u1 = () => { need(1); return bytes[offset++]; };
  const u2 = () => { need(2); const value = bytes.readUInt16BE(offset); offset += 2; return value; };
  const u4 = () => { need(4); const value = bytes.readUInt32BE(offset); offset += 4; return value; };
  const count = u2(), pool = new Array(count);
  if (count < 1) throw error("Invalid Java constant pool.");
  for (let index = 1; index < count; index++) {
    const tag = u1();
    if (tag === 1) {
      const length = u2(); need(length);
      pool[index] = { tag, text: bytes.toString("utf8", offset, offset + length) }; offset += length;
    } else if (tag === 3) { need(4); pool[index] = { tag, value: bytes.readInt32BE(offset) }; offset += 4; }
    else if (tag === 4) { need(4); offset += 4; pool[index] = { tag }; }
    else if (tag === 5 || tag === 6) { need(8); offset += 8; pool[index] = { tag }; if (++index >= count) throw error("Invalid wide constant."); }
    else if ([7, 8, 16, 19, 20].includes(tag)) pool[index] = { tag, value: u2() };
    else if ([9, 10, 11, 12, 17, 18].includes(tag)) pool[index] = { tag, a: u2(), b: u2() };
    else if (tag === 15) pool[index] = { tag, kind: u1(), value: u2() };
    else throw error("Unsupported Java constant pool tag.");
  }
  const text = index => { if (pool[index]?.tag !== 1) throw error("Invalid Java string reference."); return pool[index].text; };
  const className = index => { if (pool[index]?.tag !== 7) throw error("Invalid Java class reference."); return text(pool[index].value); };
  function method(index) {
    const item = pool[index];
    if (!item || ![10, 11].includes(item.tag) || pool[item.b]?.tag !== 12) throw error("Invalid Java method reference.");
    return { owner: className(item.a), name: text(pool[item.b].a), descriptor: text(pool[item.b].b) };
  }
  u2(); const name = className(u2()); u2();
  const interfaces = u2(); need(interfaces * 2); offset += interfaces * 2;
  const calls = [], appIds = [];
  const attributes = (number, visit) => {
    for (let index = 0; index < number; index++) {
      const name = text(u2()), length = u4(); need(length);
      const end = offset + length;
      if (visit) visit(name, end);
      offset = end;
    }
  };
  function code(end, methodName) {
    u2(); u2(); const length = u4(); need(length);
    if (length > 65535 || offset + length > end) throw error("Invalid Java bytecode length.");
    const start = offset, finish = offset + length;
    let position = 0, previousInteger = null;
    const branches = new Set(), localCalls = [];
    const requireCode = (at, length) => { if (at < 0 || at + length > finish - start) throw error("Truncated Java instruction."); };
    const lengths = new Uint8Array(202).fill(1);
    for (const value of [16, 18, 21, 22, 23, 24, 25, 54, 55, 56, 57, 58, 169, 188]) lengths[value] = 2;
    for (const value of [17, 19, 20, 132, ...Array.from({ length: 17 }, (_, i) => 153 + i), ...Array.from({ length: 8 }, (_, i) => 178 + i), 187, 189, 192, 193, 198, 199]) lengths[value] = 3;
    lengths[185] = 5; lengths[186] = 5; lengths[197] = 4; lengths[200] = 5; lengths[201] = 5;
    while (position < length) {
      const at = position, opcode = bytes[start + at];
      if (opcode > 201) throw error("Invalid Java opcode.");
      let size = lengths[opcode], integer = null;
      if (opcode === 170 || opcode === 171) {
        const aligned = (at + 4) & ~3;
        requireCode(aligned, opcode === 170 ? 12 : 8);
        branches.add(at + bytes.readInt32BE(start + aligned));
        const count = opcode === 170 ? bytes.readInt32BE(start + aligned + 8) - bytes.readInt32BE(start + aligned + 4) + 1 : bytes.readInt32BE(start + aligned + 4);
        if (count < 0 || count > 8192) throw error("Invalid Java switch table.");
        const base = aligned + (opcode === 170 ? 12 : 8), stride = opcode === 170 ? 4 : 8;
        requireCode(base, count * stride);
        for (let index = 0; index < count; index++) branches.add(at + bytes.readInt32BE(start + base + index * stride + stride - 4));
        size = base + count * stride - at;
      } else if (opcode === 196) {
        requireCode(at, 2); const wide = bytes[start + at + 1];
        if (![21, 22, 23, 24, 25, 54, 55, 56, 57, 58, 132, 169].includes(wide)) throw error("Invalid wide Java instruction.");
        size = wide === 132 ? 6 : 4;
      }
      requireCode(at, size);
      if (opcode >= 2 && opcode <= 8) integer = opcode - 3;
      else if (opcode === 16) integer = bytes.readInt8(start + at + 1);
      else if (opcode === 17) integer = bytes.readInt16BE(start + at + 1);
      else if (opcode === 18 || opcode === 19) {
        const index = opcode === 18 ? bytes[start + at + 1] : bytes.readUInt16BE(start + at + 1);
        if (pool[index]?.tag === 3) integer = pool[index].value;
      }
      if (opcode >= 182 && opcode <= 185) {
        const call = method(bytes.readUInt16BE(start + at + 1));
        if (call.owner.startsWith(PREFIX)) {
          const item = { ...call, method: methodName, offset: at }; calls.push(item);
          if (opcode === 184 && call.owner === PREFIX + "SteamAPI" && call.name === "restartAppIfNecessary" && call.descriptor === "(I)Z" && previousInteger?.end === at && previousInteger.value > 0) {
            localCalls.push({ value: previousInteger.value, className: name, method: methodName, offset: at, literalOffset: previousInteger.offset });
          }
        }
      }
      if (opcode >= 153 && opcode <= 168 || opcode === 198 || opcode === 199) branches.add(at + bytes.readInt16BE(start + at + 1));
      else if (opcode === 200 || opcode === 201) branches.add(at + bytes.readInt32BE(start + at + 1));
      previousInteger = integer === null ? null : { value: integer, offset: at, end: at + size };
      position += size;
    }
    offset = finish;
    const exceptions = u2(); need(exceptions * 8);
    for (let index = 0; index < exceptions; index++) { u2(); u2(); branches.add(u2()); u2(); }
    attributes(u2());
    if (offset !== end || [...branches].some(target => target < 0 || target >= length)) throw error("Invalid Java bytecode attributes or branch.");
    // A branch/handler directly to the call could have a different stack value.
    appIds.push(...localCalls.filter(item => !branches.has(item.offset)));
  }
  const fields = u2();
  for (let index = 0; index < fields; index++) { u2(); text(u2()); text(u2()); attributes(u2()); }
  const methods = u2();
  for (let index = 0; index < methods; index++) {
    u2(); const methodName = text(u2()); text(u2());
    attributes(u2(), (name, end) => { if (name === "Code") code(end, methodName); });
  }
  attributes(u2());
  if (offset !== bytes.length) throw error("Unexpected Java class data.");
  return { name, major: bytes.readUInt16BE(6), calls, appIds };
}

module.exports = { PREFIX, inspectClass };
