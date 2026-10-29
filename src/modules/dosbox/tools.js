const fs = require("node:fs");
const path = require("node:path");
const Native = require("../shared/decompilation/native");
const { getUiServices } = require("../shared/ui-services");
const { throwIfAborted } = require("../shared/runtime/download-utils");
const { gameDirectory } = require("./prepare");
const { inside, inspectDosProgram } = require("./detect");

function resolveProgram(entry) {
  const executable = entry.moduleData?.executablePath;
  if (!path.isAbsolute(executable || "")) throw new Error("A DOS program is required for inspection.");
  const sourceRoot = fs.realpathSync(entry.contentRootDir || entry.gamePath);
  if (!inside(sourceRoot, fs.realpathSync(executable))) throw new Error("The DOS program must stay inside the imported folder.");
  const program = inspectDosProgram(executable);
  if (!program) throw new Error("The DOS program is missing or invalid.");
  return { ...program, sourceRoot };
}

function scriptPreview(bytes) {
  return Array.from(bytes.subarray(0, 65536), byte => byte >= 32 && byte <= 126 || [9, 10, 13].includes(byte)
    ? String.fromCharCode(byte) : "\\x" + byte.toString(16).padStart(2, "0")).join("");
}

function inspectExecutable(entry, _payload, context) {
  throwIfAborted(context.signal);
  const program = resolveProgram(entry), root = gameDirectory(entry, context);
  const files = fs.readdirSync(program.sourceRoot, { withFileTypes: true }).filter(item => item.isFile()).map(item => item.name).sort();
  fs.mkdirSync(root, { recursive: true });
  const outputRoot = fs.mkdtempSync(path.join(root, "program-inspection-"));
  try {
    const result = { ...program, fileCount: files.length, files, outputRoot };
    if (program.format === "bat") {
      const source = path.join(outputRoot, "source.bat");
      fs.copyFileSync(program.executablePath, source, fs.constants.COPYFILE_EXCL);
      const fd = fs.openSync(source, "r"), bytes = Buffer.alloc(Math.min(program.bytes, 65536));
      try { fs.readSync(fd, bytes, 0, bytes.length, 0); } finally { fs.closeSync(fd); }
      Object.assign(result, { sourceFile: source, scriptPreview: scriptPreview(bytes), previewTruncated: program.bytes > bytes.length,
        previewEncoding: "ASCII with hexadecimal escapes for other bytes", description: "Original DOS batch source and file metadata." });
    }
    fs.writeFileSync(path.join(outputRoot, "inspection.json"), JSON.stringify(result, null, 2) + "\n");
    entry.moduleData = { ...entry.moduleData, nativeInspectionRoot: outputRoot };
    context.onEntryChange?.({ moduleData: entry.moduleData });
    return result;
  } catch (error) {
    fs.rmSync(outputRoot, { recursive: true, force: true });
    throw error;
  }
}

async function decompile(entry, payload, context, dependencies = {}) {
  throwIfAborted(context.signal);
  const program = resolveProgram(entry);
  if (program.format === "bat") return inspectExecutable(entry, payload, context);
  return Native.inspect(entry, payload || {}, context, { ...dependencies, moduleId: "dosbox", resolveInput: () => program.executablePath,
    ...(program.format === "com" ? { analysisProfile: { raw: true, architecture: "x86", bits: 16, loadAddress: 256, entryAddress: 256,
      language: "x86:LE:16:Real Mode" } } : {}) });
}

function revealExport(entry, _payload, context) {
  const outputRoot = entry.moduleData?.nativeInspectionRoot, root = gameDirectory(entry, context);
  if (!path.isAbsolute(outputRoot || "") || !fs.existsSync(outputRoot) || !fs.statSync(outputRoot).isDirectory() ||
      !inside(fs.realpathSync(root), fs.realpathSync(outputRoot))) throw new Error("No DOS program export is available.");
  getUiServices(context).shell.showItemInFolder(outputRoot);
  return { outputRoot };
}

module.exports = { inspectExecutable, decompile, revealExport };
