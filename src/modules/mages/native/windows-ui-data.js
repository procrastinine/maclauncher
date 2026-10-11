const fs = require("node:fs");
const crypto = require("node:crypto");

const LIMITS = Object.freeze({ sections: 32, executableBytes: 4 * 1024 * 1024,
  totalBytes: 5 * 1024 * 1024, regions: 128, coordinate: 1 << 20 });
const ABI = "windows-sc3-input-v1";

function validateRegions(regions) {
  if (!Array.isArray(regions) || !regions.length || regions.length > LIMITS.regions)
    throw new Error("Windows input regions exceed their bounds.");
  const ids = new Map();
  for (const region of regions) {
    const values = [region.id, region.parentId, region.relative, region.x, region.y,
      region.width, region.height, region.events];
    if (values.some(value => !Number.isInteger(value)) || region.id < 0 || region.id > 65535 ||
        region.parentId < 0 || region.parentId > 65535 || ![0, 1].includes(region.relative) ||
        Math.abs(region.x) > LIMITS.coordinate || Math.abs(region.y) > LIMITS.coordinate ||
        region.width < 0 || region.height < 0 || region.width > LIMITS.coordinate || region.height > LIMITS.coordinate ||
        region.events < 0 || region.events > 0xfff || ids.has(region.id))
      throw new Error("Windows input region data is invalid or ambiguous.");
    ids.set(region.id, region);
  }
  function position(region, ancestors = []) {
    if (ancestors.includes(region.id)) throw new Error("Windows input regions have a parent cycle.");
    if (!region.relative) return { x: region.x, y: region.y };
    const parent = ids.get(region.parentId);
    if (!parent) throw new Error("Windows input region parent is missing.");
    if (parent.relative) throw new Error("Nested Windows input region coordinates are unsupported.");
    const base = position(parent, [...ancestors, region.id]);
    const point = { x: base.x + region.x, y: base.y + region.y };
    if (Math.abs(point.x) > LIMITS.coordinate || Math.abs(point.y) > LIMITS.coordinate)
      throw new Error("Windows input region coordinates exceed their bounds.");
    return point;
  }
  for (const region of regions) position(region);
  return regions;
}

function parseWindowsUiData(read, size) {
  let total = 0;
  const bounded = (offset, length) => {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 ||
        length > size - offset || (total += length) > LIMITS.totalBytes)
      throw new Error("Windows input metadata exceeds its read bounds.");
    const bytes = read(offset, length);
    if (!Buffer.isBuffer(bytes) || bytes.length !== length) throw new Error("Windows input metadata is truncated.");
    return bytes;
  };
  const dos = bounded(0, 64), peOffset = dos.readUInt32LE(60);
  if (dos.readUInt16LE(0) !== 0x5a4d || peOffset < 64 || peOffset > 1024 * 1024)
    throw new Error("Windows input metadata requires a PE executable.");
  const pe = bounded(peOffset, 24), count = pe.readUInt16LE(6), optionalSize = pe.readUInt16LE(20);
  if (pe.readUInt32LE(0) !== 0x4550 || pe.readUInt16LE(4) !== 0x14c || !count ||
      count > LIMITS.sections || optionalSize < 96 || optionalSize > 4096)
    throw new Error("This Windows input ABI requires a 32-bit x86 PE executable.");
  const optional = bounded(peOffset + 24, optionalSize);
  if (optional.readUInt16LE(0) !== 0x10b) throw new Error("Windows input PE format is unsupported.");
  const imageBase = optional.readUInt32LE(28), sectionData = bounded(peOffset + 24 + optionalSize, count * 40);
  const sections = [];
  for (let offset = 0; offset < sectionData.length; offset += 40) {
    const section = { address: imageBase + sectionData.readUInt32LE(offset + 12),
      bytes: sectionData.readUInt32LE(offset + 16), offset: sectionData.readUInt32LE(offset + 20),
      executable: Boolean(sectionData.readUInt32LE(offset + 36) & 0x20000000) };
    if (section.address > 0xffffffff || section.bytes > size - section.offset)
      throw new Error("Windows input PE section exceeds its file.");
    sections.push(section);
  }
  const atVA = (address, length) => {
    const matches = sections.filter(section => address >= section.address &&
      address - section.address <= section.bytes && length <= section.bytes - (address - section.address));
    if (matches.length !== 1) throw new Error("Windows input pointer is unmapped or ambiguous.");
    return bounded(matches[0].offset + address - matches[0].address, length);
  };
  const matches = (bytes, pattern) => {
    const found = [];
    const firstUnknown = pattern.indexOf(null), prefix = Buffer.from(pattern.slice(0, firstUnknown < 0 ? pattern.length : firstUnknown));
    for (let offset = bytes.indexOf(prefix); offset >= 0 && offset <= bytes.length - pattern.length;
      offset = bytes.indexOf(prefix, offset + 1)) {
      if (pattern.every((value, index) => value === null || bytes[offset + index] === value)) found.push(offset);
      if (found.length > 128) throw new Error("Windows input instruction layouts are ambiguous.");
    }
    return found;
  };
  // This dispatch layout distinguishes the system, graphics and user opcode
  // groups. Addresses come from the original PE, including relocated images.
  const pattern = [0x83, 0xe0, 0x7f, 0x83, 0xe8, 0, 0x74, null, 0x48, 0x74, null,
    0x83, 0xe8, 0x0f, 0x75, null, 0x8b, 4, 0x8d, null, null, null, null];
  const tables = [];
  let executableBytes = 0;
  for (const section of sections.filter(section => section.executable)) {
    if ((executableBytes += section.bytes) > LIMITS.executableBytes)
      throw new Error("Windows input executable code exceeds its scan bound.");
    const bytes = bounded(section.offset, section.bytes);
    for (const offset of matches(bytes, pattern)) tables.push(bytes.readUInt32LE(offset + 19));
  }
  if (tables.length !== 1) throw new Error("The Windows SC3 input dispatch is missing or ambiguous.");
  const handler = atVA(tables[0] + 0x3f * 4, 4).readUInt32LE(0);
  const handlerBytes = atVA(handler, 64), jumps = matches(handlerBytes, [0xff, 0x24, 0x95, null, null, null, null]);
  if (jumps.length !== 1) throw new Error("Windows SC3 input operation table is unsupported.");
  const operationTable = handlerBytes.readUInt32LE(jumps[0] + 3);
  const operation = mode => {
    const stub = atVA(operationTable + mode * 4, 4).readUInt32LE(0), bytes = atVA(stub, 6);
    if (bytes[0] !== 0x5d || bytes[1] !== 0xe9) throw new Error("Windows input operation target is unsupported.");
    return stub + 6 + bytes.readInt32LE(2);
  };
  const enableVA = operation(13), disableVA = operation(14), enable = atVA(enableVA, 53), disable = atVA(disableVA, 37);
  const exact = (bytes, offset, hex) => bytes.subarray(offset, offset + hex.length / 2).equals(Buffer.from(hex, "hex"));
  const call = (bytes, base, offset) => {
    if (bytes[offset] !== 0xe8) throw new Error("Windows input operation call is unsupported.");
    return base + offset + 5 + bytes.readInt32LE(offset + 1);
  };
  if (enable[0] !== 0x68 || !exact(enable, 5, "6a00c705") || !exact(enable, 13, "00000000") ||
      !exact(enable, 22, "6a016a00") || !exact(enable, 31, "6a006a01") || !exact(enable, 40, "6a006a03") ||
      !exact(enable, 49, "83c420c3") || !exact(disable, 0, "6a006a00c705") ||
      !exact(disable, 10, "00000000") || !exact(disable, 19, "6a00") || !exact(disable, 26, "6a00") ||
      !exact(disable, 33, "83c410c3") || call(enable, enableVA, 26) !== call(disable, disableVA, 14))
    throw new Error("Windows input bank operations do not match this ABI.");
  const registerVA = call(enable, enableVA, 17), registration = atVA(registerVA, 23);
  if (!exact(registration, 0, "558bec8b4d0883f928730a8b450c89048d") || registration[21] !== 0x5d || registration[22] !== 0xc3)
    throw new Error("Windows input region registration is unsupported.");
  const bankControlVA = call(enable, enableVA, 26), bankControl = atVA(bankControlVA, 23);
  if (!exact(bankControl, 0, "558bec8b4d0883f928730a8b450c89048d") || bankControl[21] !== 0x5d || bankControl[22] !== 0xc3)
    throw new Error("Windows input bank control is unsupported.");
  const selectorContract = (setVA, restoreVA) => {
    const set = atVA(setVA, 29), restore = atVA(restoreVA, 20);
    if (!exact(set, 0, "558bec8b450c8b0d") || !exact(set, 12, "890c85") ||
        !exact(set, 19, "8b4508a3") || !exact(set, 27, "5dc3") ||
        !exact(restore, 0, "558bec8b45088b0485") || restore[13] !== 0xa3 || !exact(restore, 18, "5dc3") ||
        set.readUInt32LE(8) !== set.readUInt32LE(23) || set.readUInt32LE(8) !== restore.readUInt32LE(14) ||
        set.readUInt32LE(15) !== restore.readUInt32LE(9))
      throw new Error("Windows input selector save and restore do not match this ABI.");
    return { set: setVA, restore: restoreVA, state: set.readUInt32LE(8), saved: set.readUInt32LE(15) };
  };
  const leftSelector = selectorContract(call(enable, enableVA, 35), call(disable, disableVA, 28));
  const rightSelector = selectorContract(call(enable, enableVA, 44), call(disable, disableVA, 21));
  if (leftSelector.state === rightSelector.state || leftSelector.saved === rightSelector.saved)
    throw new Error("Windows input mouse selectors are ambiguous.");
  const regionsVA = enable.readUInt32LE(1), regions = [];
  let terminated = false;
  for (let index = 0; index <= LIMITS.regions; index++) {
    const bytes = atVA(regionsVA + index * 32, 32), id = bytes.readInt32LE(0);
    if (id === -1) { terminated = true; break; }
    regions.push({ id, parentId: bytes.readInt32LE(4), relative: bytes.readInt32LE(8), x: bytes.readInt32LE(12),
      y: bytes.readInt32LE(16), width: bytes.readInt32LE(20), height: bytes.readInt32LE(24), events: bytes.readUInt32LE(28) });
  }
  if (!terminated) throw new Error("Windows input region table has no bounded terminator.");
  validateRegions(regions);
  const descriptorSha256 = crypto.createHash("sha256").update(JSON.stringify(regions)).digest("hex");
  return { abi: ABI, schemaVersion: 1, bankId: 0, regions, descriptorSha256, bytesRead: total,
    selectors: { enabledLeft: 1, enabledRight: 3, savedSlot: 0 },
    originalOperations: { handler, operationTable, enable: enableVA, disable: disableVA,
      registration: registerVA, bankControl: bankControlVA, leftSelector, rightSelector } };
}

function inspectWindowsUiData(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size < 256) throw new Error("Windows input metadata requires a regular executable.");
    const result = parseWindowsUiData((offset, length) => {
      const bytes = Buffer.alloc(length);
      if (fs.readSync(fd, bytes, 0, length, offset) !== length) throw new Error("Windows input metadata changed during reading.");
      return bytes;
    }, before.size);
    const after = fs.fstatSync(fd);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
      throw new Error("Windows input executable changed during inspection.");
    return { ...result, source: { size: before.size, mtimeMs: before.mtimeMs, ctimeMs: before.ctimeMs } };
  } finally { fs.closeSync(fd); }
}

function luaInputData(data) {
  if (data?.abi !== ABI || data.schemaVersion !== 1 || data.bankId !== 0) throw new Error("Windows input metadata version is unsupported.");
  validateRegions(data.regions);
  if (data.descriptorSha256 !== crypto.createHash("sha256").update(JSON.stringify(data.regions)).digest("hex"))
    throw new Error("Windows input descriptor checksum changed.");
  return "root.WindowsUiInput = { Version = 1, Bank0 = {\n" + data.regions.map(region =>
    `  { Id = ${region.id}, ParentId = ${region.parentId}, Relative = ${region.relative}, X = ${region.x}, Y = ${region.y}, Width = ${region.width}, Height = ${region.height}, Events = ${region.events} },`).join("\n") + "\n} };\n";
}

module.exports = { ABI, LIMITS, validateRegions, parseWindowsUiData, inspectWindowsUiData, luaInputData };
