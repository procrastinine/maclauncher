const fs = require("node:fs");
const path = require("node:path");
const { readBytecode } = require("./bytecode");

function detectGame(context) {
  if (context.isAppBundle) return null;
  let bytecodePath = null;
  if (context.stat?.isFile()) {
    if (/\.(hl|dat)$/i.test(context.inputPath)) bytecodePath = context.inputPath;
    else if (/\.exe$/i.test(context.inputPath)) bytecodePath = path.join(context.rootDir, "hlboot.dat");
    else return null;
  } else {
    const boot = path.join(context.rootDir, "hlboot.dat");
    if (fs.existsSync(boot)) bytecodePath = boot;
    else {
      const candidates = fs.readdirSync(context.rootDir).filter(name => /\.hl$/i.test(name));
      if (candidates.length === 1) bytecodePath = path.join(context.rootDir, candidates[0]);
    }
  }
  if (!bytecodePath) return null;
  try {
    let metadata;
    try { metadata = readBytecode(bytecodePath); }
    catch (error) {
      if (!error.message.startsWith("Unsupported HashLink bytecode version")) throw error;
      const header = Buffer.alloc(4), fd = fs.openSync(bytecodePath, "r");
      try { fs.readSync(fd, header, 0, 4, 0); } finally { fs.closeSync(fd); }
      metadata = { version: header[3], nativeLibraries: [], inspectionScope: "header-only", unsupportedBytecode: true };
    }
    const root = path.dirname(bytecodePath);
    return { moduleId: "hashlink", engine: "hashlink", gamePath: root,
      name: path.basename(root), contentRootDir: root, runtimeId: "hashlink",
      moduleData: { bytecodePath, bytecodeVersion: metadata.version,
        detectedVersion: String(metadata.version), detectedVersionSource: "HLB header (bytecode format)",
        detectedVersionConfidence: "high", versionKind: "bytecode-format",
        nativeLibraries: metadata.nativeLibraries, nativeAbi: metadata.nativeAbi || null, inspectionScope: metadata.inspectionScope,
        compatibility: metadata.unsupportedBytecode ? "unsupported-bytecode-version" : "format-supported; matching-native-modules-required" } };
  } catch {
    return null;
  }
}

module.exports = { detectGame };
