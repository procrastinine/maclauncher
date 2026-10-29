const fs = require("node:fs");
const path = require("node:path");

const MAX_TABLE_BYTES = 2 * 1024 * 1024;
const CONTAINERS = /\.(?:nsp|nsz|xci|xcz|hfs0)$/i;
function inside(root, file) {
  const relative = path.relative(root, file);
  return relative === "" || relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
}
function stat(file, detection) {
  try { return detection?.stat ? detection.stat(file) : fs.statSync(file); } catch { return null; }
}
function readBytes(file, offset, size, detection) {
  if (detection?.readBytes) return detection.readBytes(file, offset, size);
  const fd = fs.openSync(file, "r"), bytes = Buffer.alloc(size);
  try { return bytes.subarray(0, fs.readSync(fd, bytes, 0, size, offset)); } finally { fs.closeSync(fd); }
}
function entries(directory, detection) {
  try { return detection?.readdir ? detection.readdir(directory) : fs.readdirSync(directory, { withFileTypes: true }); } catch { return []; }
}
function partition(file, header, size, detection) {
  const format = header.toString("ascii", 0, 4), stride = format === "HFS0" ? 64 : 24;
  const count = header.readUInt32LE(4), stringsSize = header.readUInt32LE(8), tableSize = count * stride + stringsSize;
  if (!count || count > 65536 || !stringsSize || tableSize > MAX_TABLE_BYTES || tableSize > size - 16) return null;
  const table = readBytes(file, 16, tableSize, detection);
  if (table.length !== tableSize) return null;
  const strings = table.subarray(count * stride), names = [], dataSize = BigInt(size - 16 - tableSize);
  for (let index = 0; index < count; index++) {
    const at = index * stride, offset = table.readBigUInt64LE(at), bytes = table.readBigUInt64LE(at + 8), nameOffset = table.readUInt32LE(at + 16);
    if (offset > dataSize || bytes > dataSize - offset || nameOffset >= strings.length) return null;
    const end = strings.indexOf(0, nameOffset);
    if (end < 0 || end - nameOffset > 4096) return null;
    const name = strings.toString("utf8", nameOffset, end);
    if (!name || /[\0\\/]/.test(name) || name === "." || name === "..") return null;
    names.push(name);
  }
  const ticket = names.find(name => /^[a-f0-9]{32}\.tik$/i.test(name));
  const compressed = path.extname(file).toLowerCase() === ".nsz";
  return { format: format === "PFS0" ? compressed ? "nsz" : "nsp" : "hfs0", sourceKind: format === "PFS0" ? compressed ? "Switch NSZ" : "Switch NSP" : "Switch HFS0", fileCount: count,
    titleId: ticket ? ticket.slice(0, 16).toUpperCase() : null, inspectionOnly: format !== "PFS0", canDecompile: format === "PFS0" };
}
function inspectBinary(file, detection) {
  try {
    const observed = stat(file, detection);
    if (!observed?.isFile() || observed.size < 0x40) return null;
    const header = readBytes(file, 0, Math.min(observed.size, 0x400), detection);
    const result = { inputPath: file, bytes: observed.size };
    if (header.toString("ascii", 0, 4) === "NSO0") {
      if (header.length < 0x100 || !header.readUInt32LE(0x18)) return null;
      const flags = header.readUInt32LE(0xc);
      for (let index = 0; index < 3; index++) {
        const at = 0x10 + index * 16, offset = header.readUInt32LE(at), size = header.readUInt32LE(at + 8);
        const stored = flags & (1 << index) ? header.readUInt32LE(0x60 + index * 4) : size;
        if (size && (!stored || offset < 0x100 || offset > observed.size || stored > observed.size - offset)) return null;
      }
      return { ...result, format: "nso", sourceKind: "Switch NSO", buildId: header.subarray(0x40, 0x60).toString("hex"), inspectionOnly: true, canDecompile: true };
    }
    if (header.toString("ascii", 0x10, 0x14) === "NRO0") {
      const size = header.readUInt32LE(0x18);
      if (size < 0x80 || size > observed.size || header.length < 0x80 || !header.readUInt32LE(0x24)) return null;
      for (let at = 0x20; at <= 0x30; at += 8) {
        const offset = header.readUInt32LE(at), bytes = header.readUInt32LE(at + 4);
        if (bytes && (offset < 0x80 || offset > size || bytes > size - offset)) return null;
      }
      return { ...result, format: "nro", sourceKind: "Switch NRO", inspectionOnly: true, canDecompile: false };
    }
    if (["PFS0", "HFS0"].includes(header.toString("ascii", 0, 4))) {
      const details = partition(file, header, observed.size, detection);
      return details && { ...result, ...details, titleId: details.titleId || /\[([a-f0-9]{16})\]/i.exec(path.basename(file))?.[1]?.toUpperCase() || null };
    }
    if (header.length >= 0x140 && header.toString("ascii", 0x100, 0x104) === "HEAD") {
      const offset = header.readBigUInt64LE(0x130);
      if (offset < 0x200n || offset > BigInt(observed.size - 16)) return null;
      if (readBytes(file, Number(offset), 4, detection)?.toString("ascii") !== "HFS0") return null;
      const compressed = path.extname(file).toLowerCase() === ".xcz";
      return { ...result, format: compressed ? "xcz" : "xci", sourceKind: compressed ? "Switch XCZ" : "Switch XCI", inspectionOnly: false, canDecompile: true };
    }
    return null;
  } catch { return null; }
}
function extracted(directory, detection) {
  const names = entries(directory, detection), exefs = names.find(item => item.isDirectory() && item.name.toLowerCase() === "exefs"),
    romfs = names.find(item => item.isDirectory() && item.name.toLowerCase() === "romfs");
  if (!exefs || !romfs) return null;
  const executable = path.join(directory, exefs.name, "main"), program = inspectBinary(executable, detection);
  if (program?.format !== "nso") return null;
  return { ...program, inputPath: directory, executablePath: executable, format: "extracted", sourceKind: "Switch ExeFS / RomFS", inspectionOnly: true, canDecompile: true };
}
function detectGame(context) {
  if (!context || context.isAppBundle) return null;
  let sourceRoot = context.rootDir, program;
  if (context.stat?.isDirectory()) {
    program = extracted(sourceRoot, context.detection);
    if (!program) {
      const candidates = entries(sourceRoot, context.detection).filter(item => item.isFile() && CONTAINERS.test(item.name));
      if (!candidates.length || candidates.length > 32) return null;
      const containers = candidates.map(item => inspectBinary(path.join(sourceRoot, item.name), context.detection));
      if (containers.some(item => !item || item.inspectionOnly)) return null;
      program = containers.length === 1 ? containers[0] : { format: "collection", sourceKind: "Switch packages", inputPath: sourceRoot, inspectionOnly: false, canDecompile: true, fileCount: containers.length };
    }
  } else if (context.stat?.isFile()) {
    program = inspectBinary(context.inputPath, context.detection);
    if (program?.format === "nso" && path.basename(sourceRoot).toLowerCase() === "exefs") {
      const complete = extracted(path.dirname(sourceRoot), context.detection);
      if (complete?.executablePath === context.inputPath) { program = complete; sourceRoot = path.dirname(sourceRoot); }
    }
  }
  if (!program) return null;
  try {
    const root = fs.realpathSync(sourceRoot);
    if (!inside(root, fs.realpathSync(program.inputPath)) || program.executablePath && !inside(root, fs.realpathSync(program.executablePath))) return null;
  } catch { return null; }
  return { moduleId: "nxnative", engine: "nxnative", gameType: "switch", runtimeId: program.inspectionOnly ? "inspection" : "nxnative", gamePath: program.inputPath,
    contentRootDir: sourceRoot, name: path.basename(program.inputPath, path.extname(program.inputPath)), moduleData: program,
    detectionEvidence: [{ type: "switch-program", path: program.inputPath, format: program.format }] };
}
module.exports = { detectGame, inspectBinary, extracted, readBytes, inside, stat, MAX_TABLE_BYTES };
