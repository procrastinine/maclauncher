const ARM64 = 0x0100000c, X64 = 0x01000007;

function image({ cpu = ARM64, little = true, wide = !!(cpu & 0x01000000), fileType = 6,
  dependencies = ["/usr/lib/libSystem.B.dylib"], installName = "@rpath/libfixture.dylib",
  runPaths = [], platform = 1, minimumOS = 0x000d0000, legacyVersion = false,
  symbols = [], extraCommands = [] } = {}) {
  const write = (bytes, value, offset) => little ? bytes.writeUInt32LE(value, offset) : bytes.writeUInt32BE(value, offset);
  const commands = [], alignment = wide ? 8 : 4;
  const command = (kind, size) => {
    const bytes = Buffer.alloc(size); write(bytes, kind, 0); write(bytes, size, 4); commands.push(bytes); return bytes;
  };
  const stringCommand = (kind, value, minimum) => {
    const text = Buffer.from(value + "\0"), size = Math.ceil((minimum + text.length) / alignment) * alignment;
    const bytes = command(kind, size); write(bytes, minimum, 8); text.copy(bytes, minimum); return bytes;
  };
  if (platform != null) {
    const build = command(legacyVersion ? 0x24 : 0x32, legacyVersion ? 16 : 24);
    if (legacyVersion) { write(build, minimumOS, 8); write(build, 0x001b0001, 12); }
    else { write(build, platform, 8); write(build, minimumOS, 12); write(build, 0x001b0001, 16); }
  }
  if (installName != null) stringCommand(0xd, installName, 24);
  for (const item of dependencies) stringCommand(typeof item === "string" ? 0xc : item.kind,
    typeof item === "string" ? item : item.path, 24);
  for (const value of runPaths) stringCommand(0x8000001c, value, 12);
  const symbolCommand = symbols.length ? command(2, 24) : null;
  commands.push(...extraCommands);
  const headerSize = wide ? 32 : 28;
  const commandBytes = Buffer.concat(commands), header = Buffer.alloc(headerSize);
  write(header, wide ? 0xfeedfacf : 0xfeedface, 0); write(header, cpu, 4); write(header, fileType, 12);
  write(header, commands.length, 16); write(header, commandBytes.length, 20);
  let records = Buffer.alloc(0), names = Buffer.alloc(0);
  if (symbolCommand) {
    const stride = wide ? 16 : 12;
    records = Buffer.alloc(stride * symbols.length); const strings = [Buffer.from([0])]; let nameOffset = 1;
    symbols.forEach((name, i) => {
      const bytes = Buffer.from("_" + name + "\0");
      write(records, nameOffset, i * stride); records[i * stride + 4] = 0x0f; records[i * stride + 5] = 1;
      strings.push(bytes); nameOffset += bytes.length;
    });
    names = Buffer.concat(strings);
    write(symbolCommand, headerSize + commandBytes.length, 8); write(symbolCommand, symbols.length, 12);
    write(symbolCommand, headerSize + commandBytes.length + records.length, 16); write(symbolCommand, names.length, 20);
  }
  return Buffer.concat([header, ...commands, records, names]);
}

function universal(slices, { little = false, wide = false } = {}) {
  const stride = wide ? 32 : 20, table = Buffer.alloc(8 + slices.length * stride);
  const write = (value, offset) => little ? table.writeUInt32LE(value, offset) : table.writeUInt32BE(value, offset);
  const write64 = (value, offset) => little ? table.writeBigUInt64LE(BigInt(value), offset) : table.writeBigUInt64BE(BigInt(value), offset);
  write(wide ? 0xcafebabf : 0xcafebabe, 0); write(slices.length, 4);
  let offset = Math.ceil(table.length / 8) * 8;
  const parts = [table, Buffer.alloc(offset - table.length)];
  slices.forEach(({ bytes, cpu, subtype = 0 }, i) => {
    const entry = 8 + i * stride; write(cpu, entry); write(subtype, entry + 4);
    if (wide) { write64(offset, entry + 8); write64(bytes.length, entry + 16); write(3, entry + 24); }
    else { write(offset, entry + 8); write(bytes.length, entry + 12); write(3, entry + 16); }
    const padding = (8 - bytes.length % 8) % 8;
    parts.push(bytes, Buffer.alloc(padding)); offset += bytes.length + padding;
  });
  return Buffer.concat(parts);
}

module.exports = { ARM64, X64, image, universal };
