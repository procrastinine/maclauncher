const fs = require("node:fs");
const path = require("node:path");
const Package = require("./package");

const SELF_MAGICS = new Set([0x1d3d154f, 0xeef51454]);
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative === "" || relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
};
function readBytes(file, offset, size, detection) {
  if (detection?.readBytes) return detection.readBytes(file, offset, size);
  const fd = fs.openSync(file, "r"), bytes = Buffer.alloc(size);
  try { return bytes.subarray(0, fs.readSync(fd, bytes, 0, size, offset)); } finally { fs.closeSync(fd); }
}
function inspectBinary(file, detection) {
  try {
    const stat = detection?.stat ? detection.stat(file) : fs.statSync(file);
    if (!stat?.isFile() || stat.size < 64) return null;
    const header = readBytes(file, 0, 64, detection);
    if (!header || header.length < 64) return null;
    if (SELF_MAGICS.has(header.readUInt32LE(0))) return { format: "self", sourceKind: "PS5 SELF", bytes: stat.size };
    if (!header.subarray(0, 4).equals(Buffer.from([127,69,76,70])) || header[4] !== 2 || header[5] !== 1 || header[6] !== 1 ||
        header.readUInt16LE(18) !== 62 || ![0xfe00,0xfe04,0xfe10].includes(header.readUInt16LE(16)) ||
        header.readUInt16LE(52) !== 64 || header.readUInt16LE(54) !== 56 || !header.readUInt16LE(56)) return null;
    return { format: "elf", sourceKind: "PS5 ELF", bytes: stat.size };
  } catch { return null; }
}
function readParameters(file, detection) {
  try {
    const stat = detection?.stat ? detection.stat(file) : fs.statSync(file);
    if (!stat?.isFile() || !stat.size || stat.size > 128 * 1024) return null;
    const bytes = readBytes(file, 0, stat.size, detection), value = JSON.parse(bytes.toString("utf8"));
    if (!/^PPSA\d{5}$/.test(value.titleId || "") || !value.localizedParameters || typeof value.localizedParameters !== "object") return null;
    const localized = value.localizedParameters, language = localized.defaultLanguage || value.defaultLanguage;
    const title = localized[language]?.titleName || localized["en-US"]?.titleName || Object.values(localized).find(row => row?.titleName)?.titleName;
    if (typeof title !== "string" || !title.trim() || title.length > 1024) return null;
    return { title: title.trim(), titleId: value.titleId, contentVersion: value.contentVersion || null, sdkVersion: value.sdkVersion || null };
  } catch { return null; }
}
function executableCandidates(root, context) {
  if (context.stat?.isFile()) return [context.inputPath];
  const standard = ["eboot.elf", "eboot.bin", "eboot.self"];
  let other = [];
  try { other = fs.readdirSync(root, { withFileTypes: true }).filter(item => item.isFile() && !standard.includes(item.name))
    .map(item => item.name).sort().slice(0, 256); } catch {}
  return [...standard, ...other].map(name => path.join(root, name));
}
function detectGame(context) {
  if (!context || context.isAppBundle) return null;
  const root = context.rootDir;
  if (context.stat?.isFile()) {
    const archive = Package.inspect(context.inputPath, context.detection, readBytes);
    if (archive) return { moduleId: "anyps5", engine: "anyps5", gameType: "ps5", runtimeId: "inspection",
      gamePath: context.inputPath, contentRootDir: root, name: path.basename(context.inputPath, path.extname(context.inputPath)),
      moduleData: archive, detectionEvidence: [{ type: "ps5-package", path: context.inputPath, format: "pkg" }] };
  }
  const roots = [root];
  if (context.stat?.isFile() && path.dirname(root) !== root) roots.push(path.dirname(root));
  for (const containerRoot of roots) {
  let actualRoot; try { actualRoot = fs.realpathSync(containerRoot); } catch { continue; }
  const layouts = [{ programRoot: containerRoot, assetRoot: containerRoot, inputLayout: "unpacked" },
    { programRoot: path.join(containerRoot, "source"), assetRoot: path.join(containerRoot, "app0"), inputLayout: "anyps5-prepared" }];
  for (const layout of layouts) {
    const parameterPath = path.join(layout.assetRoot, "sce_sys", "param.json");
    try { if (!inside(actualRoot, fs.realpathSync(parameterPath)) || !inside(actualRoot, fs.realpathSync(layout.programRoot))) continue; } catch { continue; }
    const parameters = readParameters(parameterPath, context.detection);
    if (!parameters) continue;
    const candidates = executableCandidates(layout.programRoot, context);
    for (const executablePath of candidates) {
    let program;
    try { if (!inside(fs.realpathSync(layout.programRoot), fs.realpathSync(executablePath))) continue; program = inspectBinary(executablePath,context.detection); } catch { continue; }
    if (!program) continue;
    return { moduleId: "anyps5", engine: "anyps5", gameType: "ps5", runtimeId: "anyps5", gamePath: containerRoot,
      contentRootDir: containerRoot, name: parameters.title,
      moduleData: { ...program, ...parameters, executablePath, parameterPath, inputLayout: layout.inputLayout,
        detectedVersion: parameters.contentVersion, detectedVersionSource: "sce_sys/param.json" },
      detectionEvidence: [{ type: "ps5-program", path: executablePath, format: program.format },
        { type: "ps5-metadata", path: parameterPath, titleId: parameters.titleId }] };
    }
  }
  }
  return null;
}
module.exports = { detectGame, inspectBinary, readParameters, readBytes, inside, SELF_MAGICS };
