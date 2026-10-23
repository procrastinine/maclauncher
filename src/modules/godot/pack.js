const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const Writable = require("../shared/writable-input");
const MAGIC = Buffer.from("GDPC"), MAX_DIRECTORY = 8 * 1024 * 1024, MAX_ENTRIES = 65536;
const utf8 = bytes => new TextDecoder("utf-8", {fatal: true}).decode(bytes);
function integer(value) {const result = Number(value);if (!Number.isSafeInteger(result) || result < 0) throw Error("Invalid Godot pack offset.");return result;}
function exact(fd, position, length) {
  const bytes = Buffer.alloc(length);let done = 0;
  while (done < length) {const n = fs.readSync(fd, bytes, done, length - done, position + done);if (!n) throw Error("Godot pack is truncated.");done += n;}
  return bytes;
}
function location(fd, {offset = 0, size} = {}) {
  const stat = fs.fstatSync(fd);offset = integer(offset);size = integer(size ?? stat.size - offset);
  if (!stat.isFile() || size < 20 || offset > stat.size - size || !exact(fd, offset, 4).equals(MAGIC)) throw Error("Invalid Godot pack header.");
  return {offset, size, stat};
}
// Godot's normal --main-pack loader discovers this trailer and preserves the
// executable-relative offsets stored by embedded exporters.
function hasTrailer(file, options) {
  let fd;
  try {
    fd = fs.openSync(file, "r");const {offset, size, stat} = location(fd, options);
    if (stat.size < 12) return false;
    const tail = exact(fd, stat.size - 12, 12);
    return tail.subarray(8).equals(MAGIC) && integer(tail.readBigUInt64LE()) === size && stat.size - size - 12 === offset;
  } catch {return false;} finally {if (fd !== undefined) fs.closeSync(fd);}
}
function directory(fd, options) {
  const source = location(fd, options), {offset, size} = source;
  let position = offset, consumed = 0, cache = Buffer.alloc(0), cacheStart = -1;
  function take(length) {
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_DIRECTORY || consumed + length > MAX_DIRECTORY || position > offset + size - length) throw Error("Godot pack directory exceeds its bounds.");
    if (position < cacheStart || position + length > cacheStart + cache.length) {
      cacheStart = position;cache = exact(fd, position, Math.min(Math.max(65536, length), offset + size - position));
    }
    const result = cache.subarray(position - cacheStart, position - cacheStart + length);position += length;consumed += length;return result;
  }
  const u32 = () => take(4).readUInt32LE(), u64 = () => integer(take(8).readBigUInt64LE());
  take(4);const version = u32(), engineMajor = u32();take(8);
  let base = 0, basePosition = null;
  if (version === 1) take(64);
  else if (version === 2 || version === 3) {
    const flags = u32();if (flags & ~2) throw Error("Encrypted or sparse Godot pack directories are not supported.");
    basePosition = position - offset;base = u64();if (version === 3 || flags & 2) base += offset;
    if (version === 3) {const start = u64();if (start < position - offset || start >= size) throw Error("Invalid Godot pack directory offset.");position = offset + start;}
    else take(64);
  } else throw Error("Unsupported Godot pack directory version.");
  const countPosition = position, count = u32();if (count > MAX_ENTRIES) throw Error("Godot pack contains too many directory entries.");
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    const directoryPosition = position;
    const length = u32();if (!length || length > 4096) throw Error("Invalid Godot resource path.");
    const name = utf8(take(length)).replace(/\0+$/, "").replace(/^res:\/\//, "");
    if (!name || /[\x00-\x1f\x7f\\]/.test(name) || name.startsWith("/") || name.split("/").some(part => !part || part === "." || part === "..") || entries.has(name)) throw Error("Invalid Godot resource path.");
    const offsetPosition = position - offset, start = u64() + base, lengthBytes = u64(), md5 = Buffer.from(take(16)), flags = version >= 2 ? u32() : 0;
    if (!Number.isSafeInteger(start) || start < offset || start > offset + size - lengthBytes) throw Error("Godot resource lies outside its pack.");
    entries.set(name, {name, offset: start, size: lengthBytes, flags, md5, offsetPosition, directoryPosition, directoryLength: position - directoryPosition});
  }
  return {...source, version, engineMajor, basePosition, countPosition, entries};
}
function open(file, options, callback) {const fd = fs.openSync(file, "r");try {return callback(fd, directory(fd, options));} finally {fs.closeSync(fd);}}
function readEntry(fd, entry, maximum) {
  if (!entry || entry.flags || entry.size > maximum) return null;
  const bytes = exact(fd, entry.offset, entry.size);
  if (entry.md5.some(value => value !== 0) && !crypto.createHash("md5").update(bytes).digest().equals(entry.md5)) return null;
  return bytes;
}
// Section-only exports cannot be opened through the standard trailer loader.
// Project them to a standalone pack, rebasing both v1 absolute offsets and v2/3
// file-base offsets. The publisher executable is never changed.
function project(file, target, options, root) {
  Writable.assertOwnDirectory(root, path.dirname(target));
  const temporary = target + "." + crypto.randomUUID();
  try {
    open(file, options, (sourceFd, pack) => {
      const output = fs.openSync(temporary, "wx", 0o600);
      try {
        const chunk = Buffer.alloc(Math.min(1024 * 1024, pack.size));let done = 0;
        while (done < pack.size) {
          const length = Math.min(chunk.length, pack.size - done), read = fs.readSync(sourceFd, chunk, 0, length, pack.offset + done);
          if (!read) throw Error("Godot pack is truncated.");fs.writeSync(output, chunk, 0, read, done);done += read;
        }
        const value = Buffer.alloc(8);
        if (pack.basePosition !== null) {value.writeBigUInt64LE(0n);fs.writeSync(output, value, 0, 8, pack.basePosition);}
        for (const entry of pack.entries.values()) {value.writeBigUInt64LE(BigInt(entry.offset - pack.offset));fs.writeSync(output, value, 0, 8, entry.offsetPosition);}
        const after = fs.fstatSync(sourceFd);
        if (after.size !== pack.stat.size || after.mtimeMs !== pack.stat.mtimeMs) throw Error("Godot pack changed during preparation.");
      } finally {fs.closeSync(output);}
    });
    fs.renameSync(temporary, target);
  } finally {fs.rmSync(temporary, {force: true});}
  return target;
}
// Removing directory rows leaves every payload at its original physical offset.
// The private clone can then use filesystem fallback for runtime-owned API DLLs
// without changing the publisher pack or duplicating its asset payload on APFS.
function withoutEntries(file, target, options, omit, root) {
  Writable.assertOwnDirectory(root, path.dirname(target));const temporary = target + "." + crypto.randomUUID();
  try {
    open(file, options, (source, pack) => {
      fs.copyFileSync(file, temporary, fs.constants.COPYFILE_FICLONE);fs.chmodSync(temporary, 0o600);
      const output = fs.openSync(temporary, "r+");
      try {
        const kept = [...pack.entries.values()].filter(entry => !omit(entry.name)), count = Buffer.alloc(4);count.writeUInt32LE(kept.length);
        fs.writeSync(output, count, 0, 4, pack.countPosition);let position = pack.countPosition + 4;
        for (const entry of kept) {const bytes = exact(source, entry.directoryPosition, entry.directoryLength);fs.writeSync(output, bytes, 0, bytes.length, position);position += bytes.length;}
        const after = fs.fstatSync(source);if (after.size !== pack.stat.size || after.mtimeMs !== pack.stat.mtimeMs) throw Error("Godot pack changed during preparation.");
      } finally {fs.closeSync(output);}
    });
    fs.renameSync(temporary, target);return target;
  } finally {fs.rmSync(temporary, {force: true});}
}
function scripting(file, options) {
  try {
    return open(file, options, (fd, pack) => {
      if (pack.engineMajor !== 3) return null;
      // Managed exports can carry assemblies beside the PCK rather than inside
      // it. Treat their conventional containers and all ambiguous cases as Mono.
      const adjacent = fs.readdirSync(path.dirname(file), {withFileTypes: true});
      if (adjacent.length > 256) return null;
      if (adjacent.some(item => /^(?:\.mono|GodotSharp|data_.+)$|\.(?:csproj|sln|dll)$/i.test(item.name))) return "mono";
      const names = [...pack.entries.keys()];
      if (names.some(name => /(?:^|\/)\.mono(?:\/|$)|\.(?:cs|cs\.remap|csproj|sln|dll)$/i.test(name))) return "mono";
      const config = readEntry(fd, pack.entries.get("project.binary"), 1024 * 1024);
      if (!config || config.length < 8 || config.toString("ascii", 0, 4) !== "ECFG") return null;
      let position = 8;const count = config.readUInt32LE(4);if (count > 16384) return null;
      for (let i = 0; i < count; i++) {
        if (position > config.length - 4) return null;
        const length = config.readUInt32LE(position);position += 4;
        if (!length || length > 4096 || position > config.length - length - 4) return null;
        position += length;const valueLength = config.readUInt32LE(position);position += 4;
        if (valueLength < 4 || position > config.length - valueLength) return null;position += valueLength;
      }
      if (position !== config.length) return null;
      if (/(?:mono\/|dotnet|csharp|C#)/i.test(config.toString("utf8"))) return "mono";
      return names.some(name => /\.(?:gd|gdc|gde)$/i.test(name)) ? "gdscript" : null;
    });
  } catch {return null;}
}
module.exports = {hasTrailer, open, readEntry, project, scripting, withoutEntries};
