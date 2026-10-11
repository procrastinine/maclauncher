const { inspectGame } = require("./inspect");
const manifest = require("./manifest.json");

function detectGame(context) {
  if (context?.isAppBundle || !context?.rootDir) return null;
  const data = inspectGame(context.rootDir, { inputPath: context.inputPath, detection: context.detection });
  if (!data) return null;
  return { moduleId: "mages", engine: "mages", gameType: "scripted", name: data.title,
    gamePath: data.originalRunnerPath || data.contentRootDir, contentRootDir: data.contentRootDir,
    runtimeId: manifest.runtime.default, moduleData: data,
    detectionEvidence: [
      { type: "validated-mpk-archive", path: data.scriptArchivePath, format: data.archiveFormat },
      { type: "validated-sc3-program", path: `${data.scriptArchivePath}!/${data.boot.filename}`, id: data.boot.id, codeBytes: data.boot.codeBytes },
      ...(data.originalRunner ? [{ type: "original-pe-version", path: data.originalRunnerPath, source: data.originalRunner.source,
        fileVersion: data.originalRunner.fileVersion, productVersion: data.originalRunner.productVersion }] : []) ] };
}

module.exports = { detectGame };
