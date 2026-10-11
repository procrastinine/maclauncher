const { versionResource, peFixture: versionPeFixture } = require("./pe-fixture");

function peFixture({ base = 0x400000, duplicateDispatch = false } = {}) {
  const bytes = Buffer.alloc(0x1600), text = 0x200, data = 0xe00;
  bytes.writeUInt16LE(0x5a4d); bytes.writeUInt32LE(0x80, 60);
  bytes.writeUInt32LE(0x4550, 0x80); bytes.writeUInt16LE(0x14c, 0x84);
  bytes.writeUInt16LE(2, 0x86); bytes.writeUInt16LE(224, 0x94);
  bytes.writeUInt16LE(0x10b, 0x98); bytes.writeUInt32LE(base, 0x98 + 28);
  const sections = 0x98 + 224;
  for (const [index, rva, offset, length, flags] of [[0, 0x1000, text, 0xc00, 0x60000020], [1, 0x3000, data, 0x800, 0x40000040]]) {
    const at = sections + index * 40;
    bytes.writeUInt32LE(rva, at + 12); bytes.writeUInt32LE(length, at + 16);
    bytes.writeUInt32LE(offset, at + 20); bytes.writeUInt32LE(flags, at + 36);
  }
  const address = offset => base + (offset >= data ? 0x3000 + offset - data : 0x1000 + offset - text);
  const dispatch = Buffer.from("83e07f83e800740948741c83e80f75418b048d00000000", "hex");
  dispatch.writeUInt32LE(address(data), 19); dispatch.copy(bytes, text);
  if (duplicateDispatch) dispatch.copy(bytes, text + 50);
  const handler = text + 0x100, table = data + 0x200;
  bytes.writeUInt32LE(address(handler), data + 0x3f * 4);
  Buffer.from("558becff249500000000", "hex").copy(bytes, handler);
  bytes.writeUInt32LE(address(table), handler + 6);
  const enableStub = text + 0x150, disableStub = text + 0x160, enable = text + 0x200, disable = text + 0x300;
  bytes.writeUInt32LE(address(enableStub), table + 13 * 4);
  bytes.writeUInt32LE(address(disableStub), table + 14 * 4);
  function jump(stub, target) { bytes[stub] = 0x5d; bytes[stub + 1] = 0xe9; bytes.writeInt32LE(address(target) - address(stub) - 6, stub + 2); }
  jump(enableStub, enable); jump(disableStub, disable);
  const regionTable = data + 0x400, register = text + 0x400, setEnabled = text + 0x450;
  Buffer.from("68000000006a00c7050000000000000000e8000000006a016a00e8000000006a006a01e8000000006a006a03e80000000083c420c3", "hex").copy(bytes, enable);
  bytes.writeUInt32LE(address(regionTable), enable + 1);
  function call(from, target) { bytes.writeInt32LE(address(target) - address(from) - 5, from + 1); }
  call(enable + 17, register); call(enable + 26, setEnabled); call(enable + 35, text + 0x500); call(enable + 44, text + 0x540);
  Buffer.from("6a006a00c7050000000000000000e8000000006a00e8000000006a00e80000000083c410c3", "hex").copy(bytes, disable);
  call(disable + 14, setEnabled); call(disable + 21, text + 0x5a0); call(disable + 28, text + 0x580);
  Buffer.from("558bec8b4d0883f928730a8b450c89048d000000005dc3", "hex").copy(bytes, register);
  Buffer.from("558bec8b4d0883f928730a8b450c89048d000000005dc3", "hex").copy(bytes, setEnabled);
  for (const [set, restore, state, saved] of [[text + 0x500, text + 0x580, address(data + 0x700), address(data + 0x710)],
    [text + 0x540, text + 0x5a0, address(data + 0x720), address(data + 0x730)]]) {
    const select = Buffer.from("558bec8b450c8b0d00000000890c85000000008b4508a3000000005dc3", "hex");
    select.writeUInt32LE(state, 8); select.writeUInt32LE(saved, 15); select.writeUInt32LE(state, 23); select.copy(bytes, set);
    const recover = Buffer.from("558bec8b45088b048500000000a3000000005dc3", "hex");
    recover.writeUInt32LE(saved, 9); recover.writeUInt32LE(state, 14); recover.copy(bytes, restore);
  }
  for (const [index, fields] of [[0, [0, 65535, 0, 0, 0, 960, 540, 0x608]], [1, [3, 0, 1, 20, 30, 40, 50, 9]]])
    fields.forEach((value, field) => bytes.writeInt32LE(value, regionTable + index * 32 + field * 4));
  bytes.writeInt32LE(-1, regionTable + 64);
  return { bytes, enable, disable, regionTable, handler, table, sections, register };
}

function withVersion(bytes) {
  const resource = versionPeFixture({ version: versionResource({ strings: { ProductName: "Steins;Gate", CompanyName: "MAGES." } }) });
  const combined = Buffer.concat([bytes, resource.bytes.subarray(resource.raw)]), third = 0x98 + 224 + 80;
  combined.writeUInt16LE(3, 0x86); combined.writeUInt32LE(16, 0x98 + 92);
  combined.writeUInt32LE(0x5000, 0x98 + 112); combined.writeUInt32LE(0x1000, 0x98 + 116);
  combined.write(".rsrc", third); combined.writeUInt32LE(0x1000, third + 8); combined.writeUInt32LE(0x5000, third + 12);
  combined.writeUInt32LE(0x1000, third + 16); combined.writeUInt32LE(bytes.length, third + 20);
  combined.writeUInt32LE(0x40000040, third + 36); combined.writeUInt32LE(0x5100, bytes.length + 0x80);
  return combined;
}

module.exports = { peFixture, withVersion };
