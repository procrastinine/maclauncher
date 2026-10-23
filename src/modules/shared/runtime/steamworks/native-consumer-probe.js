const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_READ_BUDGET = 2 * 1024 * 1024;
const MAX_SYMBOLS = 16384;
const cache = new Map();
const aliases = new Set(["steam_api", "steam_api.dll", "steam_api64.dll", "libsteam_api.dylib", "libsteam_api64.dylib", "libsteam_api.so"]);
function steamLibrary(name) {
  return aliases.has(String(name).replace(/\\/g, "/").split("/").pop().toLowerCase());
}
function steamSymbol(name) {
  return /^_?(?:Steam(?:API|Internal)_[A-Za-z0-9_]+|SteamClient|SteamGameServer(?:Client|_[A-Za-z0-9_]+)?)(?:@\d+)?$/.test(name);
}
function invalid(message, code = "STEAM_PROBE_INVALID") {
  const error = new Error(message); error.code = code; return error;
}
function identity(stat, realPath) {
  return Object.fromEntries([["realPath", realPath], ...["dev", "ino", "size", "mtimeNs", "ctimeNs"].map(key => [key, String(stat[key])])]);
}
function reader(fd, size, budget) {
  let bytesRead = 0;
  const ranges = [];
  function read(offset, length) {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset > size - length)
      throw invalid("Native import metadata is outside file-backed bytes.");
    const previous = ranges.find(item => offset >= item.offset && offset + length <= item.offset + item.bytes.length);
    if (previous) return previous.bytes.subarray(offset - previous.offset, offset - previous.offset + length);
    if (bytesRead + length > budget) throw invalid("Native Steam import inspection exceeds its read budget.", "STEAM_PROBE_LIMIT");
    const bytes = Buffer.alloc(length);
    if (fs.readSync(fd, bytes, 0, length, offset) !== length) throw invalid("Truncated native import metadata.");
    bytesRead += length;
    if (ranges.length < 512) ranges.push({ offset, bytes });
    return bytes;
  }
  function string(offset, limit = 4096) {
    let output = "";
    for (let count = 0; count < limit; count += 64) {
      const length = Math.min(64, limit - count, size - offset - count);
      if (length <= 0) throw invalid("Unterminated native import name.");
      const bytes = read(offset + count, length), end = bytes.indexOf(0);
      const part = end < 0 ? bytes : bytes.subarray(0, end);
      if ([...part].some(byte => byte < 0x20 || byte > 0x7e)) throw invalid("Native import name is not bounded ASCII.");
      output += part.toString("ascii");
      if (end >= 0) return output;
    }
    throw invalid("Native import name exceeds supported bounds.", "STEAM_PROBE_LIMIT");
  }
  return { read, string, size, get bytesRead() { return bytesRead; } };
}
function inspectPe(io) {
  const dos = io.read(0, 64), pe = dos.readUInt32LE(60), coff = io.read(pe, 24);
  if (coff.readUInt32LE(0) !== 0x4550) throw invalid("Invalid PE signature.");
  const machine = coff.readUInt16LE(4), count = coff.readUInt16LE(6), optionalSize = coff.readUInt16LE(20);
  if (!count || count > 96 || optionalSize < 96 || optionalSize > 4096) throw invalid("Invalid PE import headers.");
  const optional = io.read(pe + 24, optionalSize), magic = optional.readUInt16LE(0);
  const directoryOffset = magic === 0x10b ? 96 : magic === 0x20b ? 112 : -1;
  if (directoryOffset < 0 || optionalSize < directoryOffset) throw invalid("Unsupported PE optional header.");
  const directoryCount = optional.readUInt32LE(directoryOffset - 4);
  if (directoryCount > 64 || directoryOffset + directoryCount * 8 > optional.length) throw invalid("Invalid PE data directories.");
  const sections = io.read(pe + 24 + optionalSize, count * 40), headerSize = optional.readUInt32LE(60);
  function offset(rva, length = 1) {
    if (!Number.isInteger(rva) || rva < 0 || rva > 0xffffffff) throw invalid("Invalid PE import RVA.");
    if (rva < headerSize && rva <= io.size - length) return rva;
    for (let i = 0; i < count; i++) {
      const start = sections.readUInt32LE(i * 40 + 12), size = sections.readUInt32LE(i * 40 + 16), raw = sections.readUInt32LE(i * 40 + 20);
      if (rva >= start && rva - start <= size - length && raw + rva - start <= io.size - length) return raw + rva - start;
    }
    throw invalid("PE import RVA is outside a file-backed section.");
  }
  const pointerSize = magic === 0x20b ? 8 : 4;
  const imageBase = magic === 0x20b ? Number(optional.readBigUInt64LE(24)) : optional.readUInt32LE(28);
  if (!Number.isSafeInteger(imageBase)) throw invalid("Unsupported PE image address.");
  const dependencies = [], steamDependencies = [];
  function thunks(table) {
    const result = [];
    for (let index = 0; index <= MAX_SYMBOLS; index++) {
      if (index === MAX_SYMBOLS) throw invalid("PE imports exceed supported bounds.", "STEAM_PROBE_LIMIT");
      const bytes = io.read(offset(table + index * pointerSize, pointerSize), pointerSize);
      const value = pointerSize === 8 ? bytes.readBigUInt64LE(0) : BigInt(bytes.readUInt32LE(0));
      if (value === 0n) return result;
      if (value & (1n << BigInt(pointerSize * 8 - 1))) continue; // Ordinals are not guessed as Steam symbols.
      if (value > 0xffffffffn) throw invalid("PE import name RVA exceeds supported bounds.");
      const nameOffset = offset(Number(value), 3);
      const name = io.string(nameOffset + 2, 512);
      if (steamSymbol(name)) result.push(name);
    }
  }
  for (const [index, kind, width] of [[1, "pe-import", 20], [13, "pe-delay-import", 32]]) {
    if (directoryCount <= index) continue;
    const rva = optional.readUInt32LE(directoryOffset + index * 8), size = optional.readUInt32LE(directoryOffset + index * 8 + 4);
    if (!rva && !size) continue;
    if (!rva || size < width || size > 128 * 1024) throw invalid("Invalid PE import directory.");
    let terminated = false;
    for (let cursor = 0; cursor + width <= size; cursor += width) {
      const row = io.read(offset(rva + cursor, width), width);
      if (row.every(byte => byte === 0)) { terminated = true; break; }
      const convert = value => {
        const result = index === 13 && !(row.readUInt32LE(0) & 1) ? value - imageBase : value;
        if (!Number.isSafeInteger(result) || result < 0 || result > 0xffffffff) throw invalid("Invalid delayed PE import address.");
        return result;
      };
      if (index === 13 && row.readUInt32LE(0) > 1) throw invalid("Unsupported delayed PE import attributes.");
      const library = io.string(offset(convert(row.readUInt32LE(index === 13 ? 4 : 12))), 512);
      dependencies.push({ library, kind });
      if (!steamLibrary(library)) continue; // Expensive thunk checks only follow actual Steam dependencies.
      const table = convert(row.readUInt32LE(index === 13 ? 16 : 0) || row.readUInt32LE(index === 13 ? 12 : 16));
      if (!table) throw invalid("Steam PE import lacks a function table.");
      const symbols = [...new Set(thunks(table))];
      if (symbols.length) steamDependencies.push({ library, kind, symbols });
    }
    if (!terminated) throw invalid("PE import directory has no bounded terminator.");
  }
  const architecture = ({ 0x14c: "x86", 0x8664: "x86_64", 0xaa64: "arm64" })[machine] || "unknown";
  return { format: "pe", architecture, architectures: [architecture], dependencies, steamDependencies };
}
function inspectMachOImage(io, base, length) {
  const header = io.read(base, Math.min(32, length)), magic = header.readUInt32LE(0);
  const little = magic === 0xfeedface || magic === 0xfeedfacf;
  const big = magic === 0xcefaedfe || magic === 0xcffaedfe;
  if (!little && !big) throw invalid("Invalid Mach-O slice header.");
  const is64 = magic === 0xfeedfacf || magic === 0xcffaedfe, headerSize = is64 ? 32 : 28;
  if (header.length < headerSize) throw invalid("Truncated Mach-O header.");
  const u32 = (bytes, offset) => little ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset);
  const cpu = u32(header, 4), commandCount = u32(header, 16), commandSize = u32(header, 20);
  const architecture = ({ 7: "x86", 0x01000007: "x86_64", 12: "arm", 0x0100000c: "arm64" })[cpu] || "unknown";
  if (commandCount > 4096 || commandSize > 4 * 1024 * 1024 || headerSize + commandSize > length)
    throw invalid("Mach-O load commands exceed file-backed bounds.");
  const commands = io.read(base + headerSize, commandSize), dependencies = [], ordinals = [];
  let cursor = 0, symtab = null;
  const loads = new Map([[0xc, "macho-load"], [0x80000018, "macho-weak-load"], [0x8000001f, "macho-reexport"], [0x20, "macho-lazy-load"], [0x80000023, "macho-upward-load"]]);
  for (let i = 0; i < commandCount; i++) {
    if (cursor + 8 > commands.length) throw invalid("Truncated Mach-O load command.");
    const kind = u32(commands, cursor), size = u32(commands, cursor + 4);
    if (size < 8 || cursor + size > commands.length || size % (is64 ? 8 : 4)) throw invalid("Invalid Mach-O load command size.");
    if (loads.has(kind)) {
      if (size < 24) throw invalid("Truncated Mach-O library command.");
      const nameOffset = u32(commands, cursor + 8);
      if (nameOffset < 24 || nameOffset >= size) throw invalid("Invalid Mach-O library name offset.");
      const start = cursor + nameOffset, end = commands.indexOf(0, start);
      if (end < start || end >= cursor + size || end - start > 4096) throw invalid("Unterminated Mach-O library dependency.");
      const library = commands.toString("utf8", start, end);
      if (!library || /[\0\r\n]/.test(library)) throw invalid("Invalid Mach-O dependency name.");
      const dependency = { library, kind: loads.get(kind), symbols: [] };
      dependencies.push({ library, kind: dependency.kind }); ordinals.push(dependency);
    }
    if (kind === 2) {
      if (size !== 24 || symtab) throw invalid("Invalid or duplicate Mach-O symbol table.");
      symtab = { offset: u32(commands, cursor + 8), count: u32(commands, cursor + 12), strings: u32(commands, cursor + 16), stringSize: u32(commands, cursor + 20) };
    }
    cursor += size;
  }
  if (cursor !== commands.length) throw invalid("Mach-O load command count and size disagree.");
  const steamDependencies = ordinals.filter(item => steamLibrary(item.library));
  // A declared native Steam load is loader evidence even in a stripped image.
  // Symbol inspection strengthens that evidence without scanning arbitrary text.
  if (steamDependencies.length && symtab) {
    const width = is64 ? 16 : 12;
    if (symtab.count > 1000000 || symtab.offset > length - symtab.count * width || symtab.strings > length - symtab.stringSize)
      throw invalid("Mach-O import symbols exceed their slice bounds.");
    let observed = 0;
    for (let first = 0; first < symtab.count; first += 2048) {
      const count = Math.min(2048, symtab.count - first), rows = io.read(base + symtab.offset + first * width, count * width);
      for (let index = 0; index < count; index++) {
        const offset = index * width, type = rows[offset + 4];
        if ((type & 0xe0) || (type & 0x0e) || !(type & 1)) continue;
        const description = little ? rows.readUInt16LE(offset + 6) : rows.readUInt16BE(offset + 6);
        const ordinal = description >>> 8, dependency = ordinals[ordinal - 1];
        if (!dependency || !steamLibrary(dependency.library)) continue;
        if (++observed > MAX_SYMBOLS) throw invalid("Mach-O Steam imports exceed supported bounds.", "STEAM_PROBE_LIMIT");
        const stringIndex = u32(rows, offset);
        if (!stringIndex || stringIndex >= symtab.stringSize) throw invalid("Invalid Mach-O imported symbol name.");
        const name = io.string(base + symtab.strings + stringIndex, Math.min(512, symtab.stringSize - stringIndex));
        if (steamSymbol(name)) dependency.symbols.push(name); // Keep its exact native spelling.
      }
    }
  }
  return { architecture, dependencies, steamDependencies: steamDependencies.map(item => ({ ...item, symbols: [...new Set(item.symbols)] })) };
}
function inspectMachO(io, requested) {
  const magic = io.read(0, 8).readUInt32BE(0), fat = [0xcafebabe, 0xcafebabf, 0xbebafeca, 0xbfbafeca].includes(magic);
  if (!fat) {
    const image = inspectMachOImage(io, 0, io.size);
    if (requested && image.architecture !== requested) throw invalid("Native consumer lacks the requested CPU slice.");
    return { format: "mach-o", architecture: image.architecture, architectures: [image.architecture], images: [image], ...image };
  }
  const big = magic === 0xcafebabe || magic === 0xcafebabf, is64 = magic === 0xcafebabf || magic === 0xbfbafeca;
  const header = io.read(0, 8), count = big ? header.readUInt32BE(4) : header.readUInt32LE(4);
  if (!count || count > 32) throw invalid("Invalid universal Mach-O slice count.");
  const width = is64 ? 32 : 20, table = io.read(8, count * width), ranges = [], images = [];
  const u32 = offset => big ? table.readUInt32BE(offset) : table.readUInt32LE(offset);
  const u64 = offset => Number(big ? table.readBigUInt64BE(offset) : table.readBigUInt64LE(offset));
  const architectures = [];
  for (let index = 0; index < count; index++) {
    const start = index * width, cpu = u32(start), architecture = ({ 7: "x86", 0x01000007: "x86_64", 12: "arm", 0x0100000c: "arm64" })[cpu] || "unknown";
    const offset = is64 ? u64(start + 8) : u32(start + 8), size = is64 ? u64(start + 16) : u32(start + 12), align = u32(start + (is64 ? 24 : 16));
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 8 + table.length || size < 28 || offset > io.size - size || align > 31 || offset % 2 ** align ||
      ranges.some(range => offset < range.end && offset + size > range.start) || architectures.includes(architecture))
      throw invalid("Invalid or overlapping universal Mach-O slice.");
    ranges.push({ start: offset, end: offset + size }); architectures.push(architecture);
    if (!requested || requested === architecture) {
      const image = inspectMachOImage(io, offset, size);
      if (image.architecture !== architecture) throw invalid("Universal Mach-O slice CPU and header disagree.");
      images.push(image);
    }
  }
  if (!images.length) throw invalid("Native consumer lacks the requested CPU slice.");
  return { format: "mach-o", architecture: requested || (images.length === 1 ? images[0].architecture : null), architectures, images,
    dependencies: images.flatMap(image => image.dependencies.map(item => ({ ...item, architecture: image.architecture }))),
    steamDependencies: images.flatMap(image => image.steamDependencies.map(item => ({ ...item, architecture: image.architecture }))) };
}

/** Import evidence only. A module decides whether this binary is executed by its selected native runtime. */
function inspectNativeSteamConsumer(filePath, { architecture, maxReadBytes = DEFAULT_READ_BUDGET, useCache = true } = {}) {
  if (!path.isAbsolute(filePath || "") || !Number.isInteger(maxReadBytes) || maxReadBytes < 4096 || maxReadBytes > 32 * 1024 * 1024)
    throw new Error("An absolute native consumer path and bounded read budget are required.");
  const requested = architecture === "x64" ? "x86_64" : architecture;
  if (requested && !["x86", "x86_64", "arm", "arm64"].includes(requested)) throw new Error("Choose an explicit supported native consumer CPU.");
  const realPath = fs.realpathSync(filePath), fd = fs.openSync(realPath, "r");
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size < 4n || before.size > BigInt(Number.MAX_SAFE_INTEGER)) throw invalid("Native consumer is not a regular executable image.");
    const fileIdentity = identity(before, realPath), key = JSON.stringify([fileIdentity, requested, maxReadBytes]);
    if (useCache && cache.has(key)) return structuredClone(cache.get(key));
    const io = reader(fd, Number(before.size), maxReadBytes), prefix = io.read(0, 4);
    let result;
    if (prefix.toString("ascii", 0, 2) === "MZ") result = inspectPe(io);
    else if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xcafebabf, 0xbebafeca, 0xbfbafeca].includes(prefix.readUInt32LE(0)))
      result = inspectMachO(io, requested);
    else result = { format: "unknown", architecture: null, architectures: [], dependencies: [], steamDependencies: [] };
    const after = identity(fs.fstatSync(fd, { bigint: true }), realPath);
    if (JSON.stringify(after) !== JSON.stringify(fileIdentity)) throw invalid("Native consumer changed while its imports were inspected.");
    const symbols = [...new Set(result.steamDependencies.flatMap(item => item.symbols))];
    const descriptor = { ...result, inspected: result.format !== "unknown", requiresSteamApi: result.steamDependencies.length > 0,
      consumerKind: "native", interfaces: [], interfacesKnown: false, symbols,
      aliases: [...new Set(result.steamDependencies.map(item => item.library))], filePath: realPath, fileIdentity,
      evidence: result.steamDependencies.map(item => ({ kind: item.kind, filePath: realPath, library: item.library, symbols: item.symbols, architecture: item.architecture || result.architecture })),
      bytesRead: io.bytesRead };
    if (useCache) { cache.set(key, structuredClone(descriptor)); if (cache.size > 128) cache.delete(cache.keys().next().value); }
    return descriptor;
  } finally { fs.closeSync(fd); }
}
function clearProbeCache() { cache.clear(); }
module.exports = { DEFAULT_READ_BUDGET, steamLibrary, steamSymbol, inspectNativeSteamConsumer, clearProbeCache };
