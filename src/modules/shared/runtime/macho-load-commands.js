const fs = require("node:fs");
const path = require("node:path");
const { TextDecoder } = require("node:util");

// Format constants: Apple's mach-o/loader.h and mach-o/fat.h. No executable or
// developer tool is invoked. Only bounded headers/load commands are read.
const CPUS = new Map([[0x0100000c, "arm64"], [0x01000007, "x86_64"], [7, "i386"],
  [12, "arm"], [18, "ppc"], [0x01000012, "ppc64"]]);
const CPU_NAMES = new Map([...CPUS].map(([cpu, name]) => [name, cpu]));
CPU_NAMES.set("x64", 0x01000007); CPU_NAMES.set("ia32", 7);
const LIMITS = Object.freeze({ slices: 32, commands: 8192, commandBytes: 4 * 1024 * 1024,
  readBytes: 16 * 1024 * 1024, pathBytes: 4096, buildTools: 128 });
const utf8 = new TextDecoder("utf-8", { fatal: true });
const DYLIBS = new Map([[0xc, "load"], [0x80000018, "weak"], [0x8000001f, "reexport"],
  [0x20, "lazy"], [0x80000023, "upward"]]);

function fail(message, code = "MACHO_MALFORMED") {
  const error = new Error(`Mach-O load commands: ${message}`); error.code = code; throw error;
}
function abort(signal) {
  if (!signal?.aborted) return;
  const error = new Error("Mach-O inspection cancelled."); error.name = "AbortError";
  error.code = "ABORT_ERR"; throw error;
}
function range(offset, size, length, label) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0 || offset > length - size)
    fail(`Invalid ${label} range.`);
}
function bound(value, maximum, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) fail(`${label} exceeds its inspection limit.`, "MACHO_LIMIT");
  return value;
}
function version(value) { return `${value >>> 16}.${(value >>> 8) & 255}.${value & 255}`; }
function identity(stat) { return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(":"); }

function inspect(readRange, size, { architecture, signal } = {}) {
  abort(signal);
  let bytesRead = 0;
  const read = (offset, count) => {
    abort(signal); range(offset, count, size, "file");
    bytesRead = bound(bytesRead + count, LIMITS.readBytes, "Total bytes read");
    const result = readRange(offset, count);
    if (!Buffer.isBuffer(result) || result.length !== count) fail("Truncated file range.");
    return result;
  };
  if (size < 28) fail("Truncated Mach-O header.");
  const magic = read(0, 8).readUInt32BE(0);
  const fat64 = magic === 0xcafebabf || magic === 0xbfbafeca;
  const fat32 = magic === 0xcafebabe || magic === 0xbebafeca;
  let slices;
  if (fat32 || fat64) {
    const little = magic === 0xbebafeca || magic === 0xbfbafeca;
    const count = bound(little ? read(0, 8).readUInt32LE(4) : read(0, 8).readUInt32BE(4), LIMITS.slices, "Universal slice count");
    if (!count) fail("Empty universal header.");
    const stride = fat64 ? 32 : 20, tableEnd = 8 + count * stride;
    const table = read(8, count * stride);
    const u32 = offset => little ? table.readUInt32LE(offset) : table.readUInt32BE(offset);
    const u64 = offset => Number(little ? table.readBigUInt64LE(offset) : table.readBigUInt64BE(offset));
    slices = [];
    for (let i = 0; i < count; i += 1) {
      const entry = i * stride, cpu = u32(entry), subtype = u32(entry + 4);
      const offset = fat64 ? u64(entry + 8) : u32(entry + 8), length = fat64 ? u64(entry + 16) : u32(entry + 12);
      const alignment = u32(entry + (fat64 ? 24 : 16));
      range(offset, length, size, "universal slice");
      if (offset < tableEnd || length < 28 || alignment > 52 || offset % (2 ** alignment) !== 0 || fat64 && u32(entry + 28) !== 0)
        fail("Invalid universal slice alignment or bounds.");
      if (slices.some(slice => offset < slice.offset + slice.size && slice.offset < offset + length)) fail("Overlapping universal slices.");
      if (slices.some(slice => slice.cpu === cpu && slice.subtype === subtype)) fail("Duplicate universal architecture.", "MACHO_ARCH");
      slices.push({ offset, size: length, cpu, subtype });
    }
  } else slices = [{ offset: 0, size, cpu: null, subtype: null }];
  const requested = architecture == null ? null : CPU_NAMES.get(architecture);
  if (architecture != null && requested == null) fail("Unsupported requested architecture.", "MACHO_ARCH");
  if (requested != null && (fat32 || fat64)) {
    const selected = slices.filter(slice => slice.cpu === requested);
    if (selected.length !== 1) fail(selected.length ? "The requested architecture is ambiguous." : "The requested architecture is absent.", "MACHO_ARCH");
    slices = selected;
  }
  const images = slices.map(slice => {
    const initial = read(slice.offset, 28), marker = initial.readUInt32BE(0);
    const little = marker === 0xcefaedfe || marker === 0xcffaedfe;
    const wide = marker === 0xfeedfacf || marker === 0xcffaedfe;
    if (!little && marker !== 0xfeedface && marker !== 0xfeedfacf) fail("File is not Mach-O.");
    const u32 = (data, offset) => little ? data.readUInt32LE(offset) : data.readUInt32BE(offset);
    const cpu = u32(initial, 4), subtype = u32(initial, 8), fileType = u32(initial, 12);
    if (slice.cpu != null && (slice.cpu !== cpu || slice.subtype !== subtype) || requested != null && requested !== cpu)
      fail("The Mach-O header does not match its selected architecture.", "MACHO_ARCH");
    if (wide !== !!(cpu & 0x01000000)) fail("CPU and Mach-O word size disagree.", "MACHO_ARCH");
    const headerSize = wide ? 32 : 28;
    range(0, headerSize, slice.size, "Mach-O header");
    const count = bound(u32(initial, 16), LIMITS.commands, "Load command count");
    const length = bound(u32(initial, 20), LIMITS.commandBytes, "Load command bytes");
    range(headerSize, length, slice.size, "load commands");
    if (length < count * 8) fail("Load command count exceeds its byte range.");
    const commands = read(slice.offset + headerSize, length), dependencies = [], runPaths = [], builds = [], dyldEnvironment = [];
    let position = 0, installName = null, dynamicLinker = null;
    const commandPath = (command, offset, minimum) => {
      if (offset < minimum || offset >= command.length) fail("Invalid load-command path offset.");
      const end = command.indexOf(0, offset);
      if (end === -1) fail("Unterminated load-command path.");
      bound(end - offset, LIMITS.pathBytes, "Load-command path");
      if (end === offset || command.subarray(end + 1).some(byte => byte !== 0)) fail("Empty path or nonzero string padding.");
      let value; try { value = utf8.decode(command.subarray(offset, end)); } catch { fail("Invalid UTF-8 load-command path."); }
      if (/[\x00-\x1f\x7f]/.test(value)) fail("Invalid control character in a load-command path.");
      return value;
    };
    for (let i = 0; i < count; i += 1) {
      abort(signal); range(position, 8, commands.length, "load command");
      const kind = u32(commands, position), commandSize = u32(commands, position + 4);
      if (commandSize < 8 || commandSize % (wide ? 8 : 4) !== 0) fail("Invalid load-command size or alignment.");
      range(position, commandSize, commands.length, "load command");
      const command = commands.subarray(position, position + commandSize);
      if (DYLIBS.has(kind) || kind === 0xd) {
        if (commandSize < 24) fail("Truncated dylib command.");
        const name = commandPath(command, u32(command, 8), 24);
        const record = { path: name, kind: DYLIBS.get(kind) || "id", currentVersion: version(u32(command, 16)), compatibilityVersion: version(u32(command, 20)) };
        if (kind === 0xd) { if (installName) fail("Duplicate dylib install name."); installName = record; }
        else dependencies.push(record);
      } else if (kind === 0x8000001c) {
        if (commandSize < 12) fail("Truncated RPATH command.");
        runPaths.push(commandPath(command, u32(command, 8), 12));
      } else if (kind === 0xe || kind === 0x27) {
        if (commandSize < 12) fail("Truncated dynamic-loader command.");
        const value = commandPath(command, u32(command, 8), 12);
        if (kind === 0xe) { if (dynamicLinker) fail("Duplicate dynamic-loader path."); dynamicLinker = value; }
        else dyldEnvironment.push(value);
      } else if (kind === 0x32) {
        if (commandSize < 24) fail("Truncated build-version command.");
        const tools = bound(u32(command, 20), LIMITS.buildTools, "Build tool count");
        if (commandSize !== 24 + tools * 8) fail("Build tool count does not match its command size.");
        builds.push({ platform: u32(command, 8), minimumOS: version(u32(command, 12)), sdkVersion: version(u32(command, 16)) });
      } else if ([0x24, 0x25, 0x2f, 0x30].includes(kind)) {
        if (commandSize !== 16) fail("Invalid minimum-version command.");
        builds.push({ platform: new Map([[0x24, 1], [0x25, 2], [0x2f, 3], [0x30, 4]]).get(kind),
          minimumOS: version(u32(command, 8)), sdkVersion: version(u32(command, 12)) });
      }
      position += commandSize;
    }
    if (position !== commands.length) fail("Trailing bytes outside the declared load commands.");
    if (builds.length > 1 && builds.some(build => build.platform !== builds[0].platform || build.minimumOS !== builds[0].minimumOS))
      fail("Conflicting native platform or deployment versions.");
    const build = builds[0];
    return { architecture: CPUS.get(cpu) || `cpu-${cpu.toString(16)}`, cpuType: cpu, cpuSubtype: subtype,
      fileType, wordSize: wide ? 64 : 32, endianness: little ? "little" : "big",
      platform: build?.platform ?? null, minimumMacOS: build?.platform === 1 ? build.minimumOS : null,
      minimumOS: build?.minimumOS ?? null, sdkVersion: build?.sdkVersion ?? null,
      installName, dependencies, runPaths, dynamicLinker, dyldEnvironment };
  });
  abort(signal);
  return { architectures: images.map(image => image.architecture), slices: images, bytesRead };
}

function readMachOLoadCommands(file, options = {}) {
  abort(options.signal);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile()) fail("Native input is not a regular file.");
    const size = Number(before.size);
    if (!Number.isSafeInteger(size)) fail("Native file size exceeds the supported range.", "MACHO_LIMIT");
    const result = inspect((offset, length) => {
      const data = Buffer.alloc(length); let position = 0;
      while (position < length) {
        abort(options.signal);
        const read = fs.readSync(fd, data, position, length - position, offset + position);
        if (read <= 0) fail("Truncated file range.");
        position += read;
      }
      return data;
    }, size, options);
    if (identity(before) !== identity(fs.fstatSync(fd, { bigint: true }))) fail("Native file changed during inspection.", "MACHO_CHANGED");
    return result;
  } finally { fs.closeSync(fd); }
}
function parseMachOLoadCommands(bytes, options = {}) {
  if (!Buffer.isBuffer(bytes)) throw new TypeError("Mach-O input must be a Buffer.");
  return inspect((offset, length) => bytes.subarray(offset, offset + length), bytes.length, options);
}
function systemPath(value) {
  return typeof value === "string" && (value.startsWith("/usr/lib/") || value.startsWith("/System/Library/")) &&
    path.posix.normalize(value) === value && !value.includes("\\");
}
function assertSystemLibraryClosure(info, { fileType, installName, maximumMacOS } = {}) {
  if (!Array.isArray(info?.slices) || !info.slices.length) fail("Native image metadata is missing.");
  const parseVersion = value => {
    if (typeof value !== "string" || !/^\d{1,3}(?:\.\d{1,3}){0,2}$/.test(value)) fail("Invalid macOS version requirement.", "MACHO_PLATFORM");
    return value.split(".").map(Number).concat([0, 0]).slice(0, 3);
  };
  const maximum = maximumMacOS == null ? null : parseVersion(maximumMacOS);
  for (const image of info.slices) {
    if (fileType != null && image.fileType !== fileType) fail("Unexpected native file type.", "MACHO_TYPE");
    if (image.platform !== 1 || !image.minimumMacOS || parseVersion(image.minimumMacOS)[0] === 0) fail("A macOS deployment version is required.", "MACHO_PLATFORM");
    if (maximum) {
      const actual = parseVersion(image.minimumMacOS);
      const mismatch = actual.findIndex((value, index) => value !== maximum[index]);
      if (mismatch !== -1 && actual[mismatch] > maximum[mismatch]) fail(`The native image requires macOS ${image.minimumMacOS}.`, "MACHO_MACOS_VERSION");
    }
    if (installName != null && image.installName?.path !== installName) fail("Unexpected native library install name.", "MACHO_CLOSURE");
    if (image.dependencies.some(library => !systemPath(library.path))) fail("The native image has an unbundled library dependency.", "MACHO_CLOSURE");
    if (image.dynamicLinker && !systemPath(image.dynamicLinker) || image.dyldEnvironment.length)
      fail("The native image overrides its dynamic-loader environment.", "MACHO_CLOSURE");
    for (const value of image.runPaths) {
      // Relative runpaths are unused by a system-only closure. Reject external
      // absolute search roots and malformed tokens rather than depending on a
      // developer's library installation.
      if (!systemPath(value) && !/^@(loader|executable)_path(?:\/[^\x00-\x1f\\]+)?$/.test(value))
        fail("The native image has an external library search path.", "MACHO_CLOSURE");
    }
  }
  return info;
}

module.exports = { LIMITS, readMachOLoadCommands, parseMachOLoadCommands, assertSystemLibraryClosure };
