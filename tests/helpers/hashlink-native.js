// Bounded Mach-O fixtures contain only constant signature getters. They are
// inspected as bytes and are never loaded as executable code.
function nativeLibrary(signatures = { native_function: "P_v" }, { optimization = "release", type = 6 } = {}) {
  const names = Object.keys(signatures), data = Buffer.alloc(8192), commands = 72 + 160 + 24;
  data.writeUInt32LE(0xfeedfacf); data.writeUInt32LE(0x01000007, 4); data.writeUInt32LE(type, 12);
  data.writeUInt32LE(2, 16); data.writeUInt32LE(commands, 20);
  const segment = 32; data.writeUInt32LE(0x19, segment); data.writeUInt32LE(232, segment + 4);
  data.write("__TEXT", segment + 8); data.writeBigUInt64LE(8192n, segment + 24); data.writeBigUInt64LE(8192n, segment + 40);
  data.writeUInt32LE(5, segment + 56); data.writeUInt32LE(5, segment + 60); data.writeUInt32LE(2, segment + 64);
  const section = (cursor, name, offset, size, flags) => {
    data.write(name, cursor); data.write("__TEXT", cursor + 16); data.writeBigUInt64LE(BigInt(offset), cursor + 32);
    data.writeBigUInt64LE(BigInt(size), cursor + 40); data.writeUInt32LE(offset, cursor + 48); data.writeUInt32LE(flags, cursor + 64);
  };
  section(104, "__text", 512, 1024, 0x80000400); section(184, "__cstring", 2048, 2048, 2);
  const symtab = 264; data.writeUInt32LE(2, symtab); data.writeUInt32LE(24, symtab + 4); data.writeUInt32LE(4096, symtab + 8);
  data.writeUInt32LE(names.length, symtab + 12); data.writeUInt32LE(6144, symtab + 16); data.writeUInt32LE(2048, symtab + 20);
  let string = 1, constant = 2048;
  names.forEach((name, i) => {
    const getter = 512 + i * 64, signature = signatures[name], symbol = Buffer.from("_hlp_" + name + "\0");
    const record = 4096 + i * 16; data.writeUInt32LE(string, record); data[record + 4] = 0x0f; data[record + 5] = 1;
    data.writeBigUInt64LE(BigInt(getter), record + 8); symbol.copy(data, 6144 + string); string += symbol.length;
    Buffer.from(signature + "\0").copy(data, constant);
    let cursor = getter; Buffer.from([0x55, 0x48, 0x89, 0xe5]).copy(data, cursor); cursor += 4;
    if (optimization === "debug") { Buffer.from([0x48, 0x89, 0x7d, 0xf8, 0x48, 0x8b, 0x45, 0xf8]).copy(data, cursor); cursor += 8; }
    Buffer.from([0x48, 0x8d, optimization === "debug" ? 0x0d : 0x05]).copy(data, cursor);
    data.writeInt32LE(constant - cursor - 7, cursor + 3); cursor += 7;
    Buffer.from([0x48, 0x89, optimization === "debug" ? 0x08 : 0x07]).copy(data, cursor); cursor += 3;
    Buffer.from([0x48, 0x8d, 0x05]).copy(data, cursor); data.writeInt32LE(1500 - cursor - 7, cursor + 3); cursor += 7;
    Buffer.from([0x5d, 0xc3]).copy(data, cursor); constant += Buffer.byteLength(signature) + 1;
  });
  return data;
}
module.exports = { nativeLibrary };
