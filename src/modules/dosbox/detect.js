const fs = require("node:fs");
const path = require("node:path");

const PROGRAM = /\.(?:exe|com|bat)$/i;
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative === "" || relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
};
function inspectDosProgram(file, detection, { includeForeign = false } = {}) {
  const extension = path.extname(file).toLowerCase();
  if (!PROGRAM.test(file)) return null;
  let stat;
  try { stat = detection?.stat ? detection.stat(file) : fs.statSync(file); } catch { return null; }
  if (!stat?.isFile() || !stat.size) return null;
  const read = (offset, size) => {
    if (detection?.readBytes) return detection.readBytes(file, offset, Math.min(size, stat.size - offset));
    const data = Buffer.alloc(Math.min(size, stat.size - offset)), fd = fs.openSync(file, "r");
    try { fs.readSync(fd, data, 0, data.length, offset); } finally { fs.closeSync(fd); }
    return data;
  };
  const header = read(0, 64);
  if (!header) return null;
  const result = { executablePath: file, format: extension.slice(1), bytes: stat.size, sourceKind: "DOS program" };
  if (extension === ".bat") {
    const text = read(0, Math.min(stat.size, 65536));
    if (!text || text.includes(0) || text.subarray(0, 2).toString() === "#!") return null;
    return { ...result, sourceKind: "DOS batch file" };
  }
  if (extension === ".com") {
    if (header.subarray(0, 2).toString() !== "MZ") {
      if (stat.size > 65280 || header.subarray(0, 2).toString() === "#!" || header.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70]))) return null;
      return { ...result, sourceKind: "DOS COM executable", bits: 16 };
    }
  }
  if (header.length < 28 || header.toString("ascii", 0, 2) !== "MZ") return null;
  const lastPageBytes = header.readUInt16LE(2), pages = header.readUInt16LE(4), headerBytes = header.readUInt16LE(8) * 16;
  const imageBytes = pages * 512 - (lastPageBytes ? 512 - lastPageBytes : 0);
  if (!pages || lastPageBytes > 511 || headerBytes < 28 || headerBytes > imageBytes || imageBytes > stat.size) return null;
  let bits = 16, sourceKind = "DOS MZ executable";
  if (header.length >= 64) {
    const offset = header.readUInt32LE(0x3c);
    if (offset >= 64 && offset <= stat.size - 4) {
      const signature = read(offset, 12);
      if (signature.toString("ascii", 0, 4) === "PE\0\0" || signature.toString("ascii", 0, 2) === "NE")
        return includeForeign ? { ...result, foreign: true, format: "windows" } : null;
      if (["LE", "LX"].includes(signature.toString("ascii", 0, 2))) {
        if (signature.length < 12 || signature.readUInt16LE(10) !== 3) return null;
        bits = 32; sourceKind = "DOS extender executable";
      }
    }
  }
  return { ...result, format: "exe", sourceKind, bits, headerBytes, imageBytes, relocationCount: header.readUInt16LE(6),
    initialCS: header.readUInt16LE(22), initialIP: header.readUInt16LE(20), initialSS: header.readUInt16LE(14), initialSP: header.readUInt16LE(16) };
}
function detectGame(context) {
  if (!context || context.isAppBundle) return null;
  const root = context.rootDir;
  let canonicalRoot; try { canonicalRoot = fs.realpathSync(root); } catch { return null; }
  const inspect = (file, includeForeign = false) => {
    try { if (!inside(canonicalRoot, fs.realpathSync(file))) return null; } catch { return null; }
    const program = inspectDosProgram(file, context.detection, { includeForeign });
    if (program?.format === "bat") {
      let bytes;
      if (context.detection?.readBytes) bytes = context.detection.readBytes(file, 0, Math.min(program.bytes, 65536));
      else {
        bytes = Buffer.alloc(Math.min(program.bytes, 65536)); const fd = fs.openSync(file, "r");
        try { fs.readSync(fd, bytes, 0, bytes.length, 0); } finally { fs.closeSync(fd); }
      }
      if (!bytes) return null;
      const text = bytes.toString("latin1");
      if (/(?:^|\s)(?:powershell|pwsh|setlocal|endlocal|pushd|popd|start)(?:\s|$)|%~|\b(?:cmd|wscript|cscript)\.exe\b/im.test(text)) return null;
      const entries = context.detection?.readdir ? context.detection.readdir(path.dirname(file)) : fs.readdirSync(path.dirname(file), { withFileTypes: true });
      const target = entries.filter(item => item.isFile() && /\.(?:exe|com)$/i.test(item.name)).some(item => {
        const stem = path.basename(item.name, path.extname(item.name)).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return new RegExp(`(?:^|[\\s\\\\/])${stem}(?:\\.(?:exe|com))?(?=[\\s\\r\\n]|$)`, "im").test(text) &&
          inspectDosProgram(path.join(path.dirname(file), item.name), context.detection);
      });
      if (!target) return null;
    }
    return program;
  };
  let program;
  if (context.stat?.isFile()) program = inspect(context.inputPath);
  else if (context.stat?.isDirectory()) {
    const entries = context.detection?.readdir ? context.detection.readdir(root) : fs.readdirSync(root, { withFileTypes: true });
    const candidates = entries.filter(item => (item.isFile() || item.isSymbolicLink()) && PROGRAM.test(item.name))
      .map(item => inspect(path.join(root, item.name), true)).filter(Boolean);
    const programs = candidates.filter(item => !item.foreign);
    if (programs.length && candidates.some(item => item.foreign)) throw Object.assign(new Error("DOS and Windows programs were found. Select the game's executable or batch launcher."), { code: "DETECTION_CONFLICT" });
    if (programs.length > 1) throw Object.assign(new Error("Several DOS programs were found. Select the game's EXE, COM or BAT file."), { code: "DETECTION_CONFLICT" });
    program = programs[0];
  }
  if (!program) return null;
  return { moduleId: "dosbox", engine: "dosbox", gameType: "dos", runtimeId: "dosbox-staging", gamePath: root,
    contentRootDir: root, name: path.basename(program.executablePath, path.extname(program.executablePath)), moduleData: program,
    detectionEvidence: [{ type: "dos-program", path: program.executablePath, format: program.format, bits: program.bits }] };
}
module.exports = { inspectDosProgram, detectGame, inside, PROGRAM };
