const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { inspectStudio, inspectClassic, hashFile } = require("./inspect");
const GameData = require("../shared/game-data");

function resolveOutputRoot(entry, context) {
  if (!context?.userDataDir || !/^[A-Za-z0-9_-]{1,128}$/.test(entry?.gameId || "")) throw new Error("Missing or invalid game data location.");
  const root = path.resolve(GameData.resolveGameModuleDir(context.userDataDir, entry.gameId, "gamemaker"));
  const relative = path.relative(path.resolve(context.userDataDir), root);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Invalid GameMaker output directory.");
  let current = path.resolve(context.userDataDir);
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error("GameMaker output directory contains a symlink.");
    fs.mkdirSync(current, { recursive: true });
  }
  return root;
}

function resolveDataPath(entry) {
  const value = entry?.moduleData?.dataPath;
  if (typeof value !== "string" || !path.isAbsolute(value) || !fs.statSync(value).isFile()) throw new Error("GameMaker data file was not found.");
  return value;
}

function inspectEntry(entry, includeNames = true) {
  const dataPath = resolveDataPath(entry);
  const inspection = entry?.moduleData?.executionKind === "classic" ? inspectClassic(dataPath) : inspectStudio(dataPath, { includeNames });
  if (!inspection) throw new Error("GameMaker Classic runner signature is no longer present.");
  return { ...inspection, sourcePath: dataPath, sourceSha256: hashFile(dataPath) };
}

function exportInspection(entry, context) {
  const inspection = inspectEntry(entry);
  const output = fs.mkdtempSync(path.join(resolveOutputRoot(entry, context), "inspection-"));
  const reportPath = path.join(output, "inspection.json");
  fs.writeFileSync(reportPath, JSON.stringify({ schemaVersion: 1, inspectedAt: new Date().toISOString(), ...inspection }, null, 2));
  return { outputDir: output, reportPath, executionKind: inspection.executionKind, compatibility: inspection.compatibility, reason: inspection.reasons.join(" "), sourceSha256: inspection.sourceSha256 };
}

function exportChunks(entry, context) {
  const inspection = inspectEntry(entry);
  if (inspection.format !== "gamemaker-studio-form") throw new Error("Classic assets need GM8Decompiler; they are not Studio FORM chunks.");
  const output = fs.mkdtempSync(path.join(resolveOutputRoot(entry, context), "chunks-"));
  const fd = fs.openSync(inspection.sourcePath, "r");
  const files = [];
  try {
    const block = Buffer.alloc(1024 * 1024);
    for (const chunk of inspection.chunks) {
      const filename = `${String(files.length).padStart(3, "0")}-${chunk.id}.bin`;
      const dest = fs.openSync(path.join(output, filename), "wx");
      const hash = crypto.createHash("sha256");
      try {
        let remaining = chunk.size;
        let position = chunk.dataOffset;
        while (remaining > 0) {
          const size = Math.min(remaining, block.length);
          if (fs.readSync(fd, block, 0, size, position) !== size) throw new Error("GameMaker data changed during export.");
          fs.writeFileSync(dest, block.subarray(0, size));
          hash.update(block.subarray(0, size));
          position += size;
          remaining -= size;
        }
      } finally { fs.closeSync(dest); }
      files.push({ filename, chunk: chunk.id, sourceOffset: chunk.dataOffset, bytes: chunk.size, sha256: hash.digest("hex") });
    }
    if (hashFile(inspection.sourcePath) !== inspection.sourceSha256) throw new Error("GameMaker data changed during export.");
    fs.writeFileSync(path.join(output, "manifest.json"), JSON.stringify({
      schemaVersion: 1, exportedAt: new Date().toISOString(), sourcePath: inspection.sourcePath,
      sourceSha256: inspection.sourceSha256, wadVersion: inspection.wadVersion,
      representation: "raw-chunk-payloads-with-original-absolute-pointers", files
    }, null, 2));
    return { outputDir: output, chunkCount: files.length, sourceSha256: inspection.sourceSha256 };
  } catch (error) {
    fs.rmSync(output, { recursive: true, force: true });
    throw error;
  } finally { fs.closeSync(fd); }
}

module.exports = { resolveOutputRoot, resolveDataPath, inspectEntry, exportInspection, exportChunks };
