// Small authored PE resource fixture, following the Win32 VERSIONINFO layout.
// No executable code is included and no fixture needs to run a Windows binary.
const align4 = value => Math.ceil(value / 4) * 4;

function versionBlock(key, value = Buffer.alloc(0), children = [], type = 0) {
  const encoded = Buffer.from(key + "\0", "utf16le"), valueOffset = align4(6 + encoded.length);
  let length = align4(valueOffset + value.length);
  for (const child of children) length = align4(length + child.length);
  const block = Buffer.alloc(length);
  block.writeUInt16LE(length); block.writeUInt16LE(type ? value.length / 2 : value.length, 2); block.writeUInt16LE(type, 4);
  encoded.copy(block, 6); value.copy(block, valueOffset);
  let cursor = align4(valueOffset + value.length);
  for (const child of children) { child.copy(block, cursor); cursor = align4(cursor + child.length); }
  return block;
}

function versionResource({ fileVersion = [1, 5, 7, 23], productVersion = [2, 0, 4, 6], strings = { ProductName: "AI5WIN", FileDescription: "Original AI5WIN interpreter" }, flags = 3, mask = 1 } = {}) {
  const fixed = Buffer.alloc(52);
  fixed.writeUInt32LE(0xfeef04bd); fixed.writeUInt32LE(0x10000, 4);
  for (const [position, version] of [[8, fileVersion], [16, productVersion]]) {
    fixed.writeUInt32LE(((version[0] * 65536) + version[1]) >>> 0, position);
    fixed.writeUInt32LE(((version[2] * 65536) + version[3]) >>> 0, position + 4);
  }
  fixed.writeUInt32LE(mask >>> 0, 24); fixed.writeUInt32LE(flags >>> 0, 28);
  const entries = Object.entries(strings).map(([key, value]) => versionBlock(key, Buffer.from(value + "\0", "utf16le"), [], 1));
  return versionBlock("VS_VERSION_INFO", fixed, [versionBlock("StringFileInfo", Buffer.alloc(0), [versionBlock("040904b0", Buffer.alloc(0), entries)])]);
}

function peFixture({ is64 = false, version = versionResource(), largeIcon = false } = {}) {
  const peOffset = 0x80, optionalLength = is64 ? 240 : 224, raw = 0x400, blob = 0x100, rva = 0x2000;
  const resourceSize = largeIcon ? 0x18000 : 0x1000;
  const bytes = Buffer.alloc(raw + resourceSize);
  bytes.writeUInt16LE(0x5a4d); bytes.writeUInt32LE(peOffset, 60);
  bytes.writeUInt32LE(0x4550, peOffset); bytes.writeUInt16LE(is64 ? 0x8664 : 0x14c, peOffset + 4);
  bytes.writeUInt16LE(1, peOffset + 6); bytes.writeUInt16LE(optionalLength, peOffset + 20);
  const optional = peOffset + 24, directories = optional + (is64 ? 112 : 96);
  bytes.writeUInt16LE(is64 ? 0x20b : 0x10b, optional); bytes.writeUInt32LE(16, directories - 4);
  bytes.writeUInt32LE(rva, directories + 16); bytes.writeUInt32LE(resourceSize, directories + 20);
  const section = optional + optionalLength;
  bytes.write(".rsrc", section); bytes.writeUInt32LE(resourceSize, section + 8); bytes.writeUInt32LE(rva, section + 12);
  bytes.writeUInt32LE(resourceSize, section + 16); bytes.writeUInt32LE(raw, section + 20);
  bytes.writeUInt16LE(largeIcon ? 2 : 1, raw + 14);
  bytes.writeUInt32LE(16, raw + 16); bytes.writeUInt32LE(0x80000030, raw + 20);
  if (largeIcon) { bytes.writeUInt32LE(3, raw + 24); bytes.writeUInt32LE(0x80001000, raw + 28); bytes.fill(0x71, raw + 0x1000); }
  bytes.writeUInt16LE(1, raw + 0x30 + 14); bytes.writeUInt32LE(1, raw + 0x30 + 16); bytes.writeUInt32LE(0x80000050, raw + 0x30 + 20);
  bytes.writeUInt16LE(1, raw + 0x50 + 14); bytes.writeUInt32LE(1033, raw + 0x50 + 16); bytes.writeUInt32LE(0x80, raw + 0x50 + 20);
  bytes.writeUInt32LE(rva + blob, raw + 0x80); bytes.writeUInt32LE(version.length, raw + 0x84);
  version.copy(bytes, raw + blob);
  return { bytes, raw, peOffset, optional, directories, section, blob: raw + blob };
}

module.exports = { versionBlock, versionResource, peFixture };
