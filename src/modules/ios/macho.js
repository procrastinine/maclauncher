// Mach-O load-command adaptation. Constants/layouts are defined by Apple's
// <mach-o/loader.h> and <mach-o/fat.h>; executable instructions stay unchanged.
const ARM64 = 0x0100000c;
const MAGICS = new Set([0xfeedfacf, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca]);
function isMachO(bytes) { return bytes.length >= 4 && MAGICS.has(bytes.readUInt32LE(0)); }
function armSlice(input) {
  if (input.length < 32) throw new Error("Truncated Mach-O executable.");
  if (input.readUInt32LE(0) === 0xfeedfacf) return input;
  const magic = input.readUInt32BE(0), little = magic === 0xbebafeca || magic === 0xbfbafeca;
  if (![0xcafebabe, 0xcafebabf, 0xbebafeca, 0xbfbafeca].includes(magic)) throw new Error("Unsupported executable format.");
  const wide = magic === 0xcafebabf || magic === 0xbfbafeca;
  const u32 = p => little ? input.readUInt32LE(p) : input.readUInt32BE(p);
  const u64 = p => Number(little ? input.readBigUInt64LE(p) : input.readBigUInt64BE(p));
  const count = u32(4), size = wide ? 32 : 20;
  if (!count || count > 32 || 8 + count * size > input.length) throw new Error("Invalid universal executable header.");
  let selected;
  for (let i = 0; i < count; i++) {
    const p = 8 + i * size, offset = wide ? u64(p + 8) : u32(p + 8), length = wide ? u64(p + 16) : u32(p + 12);
    if (!Number.isSafeInteger(offset + length) || offset < 8 + count * size || length < 32 || offset + length > input.length) throw new Error("Invalid universal executable slice.");
    if (u32(p) === ARM64 && (u32(p + 4) & 0xffffff) === 0) selected = input.subarray(offset, offset + length);
  }
  if (!selected) throw new Error("The IPA needs a standard ARM64 executable; ARM64e-only and Intel apps are unsupported.");
  return selected;
}
function inspect(input) {
  const bytes = armSlice(input);
  if (bytes.readUInt32LE(0) !== 0xfeedfacf || bytes.readUInt32LE(4) !== ARM64 || (bytes.readUInt32LE(8) & 0xffffff) !== 0) throw new Error("The IPA needs a standard ARM64 executable.");
  const count = bytes.readUInt32LE(16), length = bytes.readUInt32LE(20);
  if (!count || count > 4096 || length > 16 * 1024 * 1024 || 32 + length > bytes.length) throw new Error("Invalid Mach-O load commands.");
  const commands = []; let p = 32, firstData = bytes.length, encrypted = false;
  for (let i = 0; i < count; i++) {
    if (p + 8 > 32 + length) throw new Error("Truncated Mach-O load command.");
    const cmd = bytes.readUInt32LE(p), size = bytes.readUInt32LE(p + 4);
    if (size < 8 || size % 4 || p + size > 32 + length) throw new Error("Invalid Mach-O command length.");
    if (cmd === 0x21 || cmd === 0x2c) {
      if (size < (cmd === 0x2c ? 24 : 20)) throw new Error("Invalid encryption command.");
      encrypted ||= bytes.readUInt32LE(p + 16) !== 0;
    }
    if (cmd === 0x19) {
      if (size < 72) throw new Error("Invalid segment command.");
      const sections = bytes.readUInt32LE(p + 64);
      if (sections > 16384 || 72 + sections * 80 > size) throw new Error("Invalid Mach-O section table.");
      const segmentOffset = Number(bytes.readBigUInt64LE(p + 40));
      if (segmentOffset > 0) firstData = Math.min(firstData, segmentOffset);
      for (let s = 0; s < sections; s++) {
        const q = p + 72 + 80 * s, type = bytes.readUInt32LE(q + 64) & 0xff;
        const offset = bytes.readUInt32LE(q + 48), dataSize = Number(bytes.readBigUInt64LE(q + 40));
        if (![1, 0xc, 0x12].includes(type) && dataSize) {
          if (offset < 32 + length || !Number.isSafeInteger(offset + dataSize) || offset + dataSize > bytes.length) throw new Error("Invalid Mach-O section range.");
          firstData = Math.min(firstData, offset);
        }
      }
    }
    commands.push({ cmd, bytes: bytes.subarray(p, p + size) }); p += size;
  }
  if (p !== 32 + length || firstData < p || firstData > bytes.length) throw new Error("Invalid Mach-O header layout.");
  return { bytes, commands, firstData, encrypted, fileType: bytes.readUInt32LE(12) };
}
function dylib(command, name) {
  const encoded = Buffer.from(name + "\0"), size = Math.ceil((24 + encoded.length) / 8) * 8;
  const result = Buffer.alloc(size); command?.copy(result, 0, 0, 24);
  result.writeUInt32LE(0xc, 0); result.writeUInt32LE(size, 4); result.writeUInt32LE(24, 8); encoded.copy(result, 24);
  return result;
}
function convert(input, { inject } = {}) {
  const info = inspect(input);
  if (info.encrypted) throw new Error("Encrypted IPA executables cannot be prepared. An unencrypted application is required.");
  const commands = []; let version = false, alreadyInjected = false;
  for (const { cmd, bytes } of info.commands) {
    if ([0x24, 0x25, 0x2f, 0x30, 0x32].includes(cmd)) {
      if (!version) {
        const build = Buffer.alloc(24); [0x32, 24, 6, 0xb0000, 0xe0000, 0].forEach((v, i) => build.writeUInt32LE(v, i * 4));
        commands.push(build); version = true;
      }
    } else if ([0xc, 0x80000018, 0x8000001f, 0x80000023].includes(cmd)) {
      if (bytes.length < 24) throw new Error("Invalid dynamic library command.");
      const offset = bytes.readUInt32LE(8), end = bytes.indexOf(0, offset);
      if (offset < 24 || end < offset) throw new Error("Invalid dynamic library name.");
      const name = bytes.toString("utf8", offset, end);
      alreadyInjected ||= name === inject;
      if (name === "@rpath/libswiftUIKit.dylib") {
        const replaced = dylib(bytes, "/System/iOSSupport/usr/lib/swift/libswiftUIKit.dylib"); replaced.writeUInt32LE(cmd, 0); commands.push(replaced);
      } else commands.push(bytes);
    } else commands.push(bytes);
  }
  if (!version) throw new Error("Executable has no supported Apple platform command.");
  if (inject && !alreadyInjected) commands.push(dylib(null, inject));
  const header = Buffer.concat(commands), oldEnd = 32 + info.bytes.readUInt32LE(20), end = 32 + header.length;
  if (end > info.firstData || (end > oldEnd && info.bytes.subarray(oldEnd, end).some(value => value !== 0))) throw new Error("Executable has insufficient load-command padding for PlayTools.");
  const result = Buffer.from(info.bytes); result.fill(0, 32, Math.max(oldEnd, end)); header.copy(result, 32);
  result.writeUInt32LE(commands.length, 16); result.writeUInt32LE(header.length, 20);
  return result;
}
module.exports = { isMachO, inspect, convert };
