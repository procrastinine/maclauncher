const { inspectGame } = require("./inspect");

function detectGame(context) {
  if (context?.isAppBundle || !context?.rootDir) return null;
  const data = inspectGame(context.rootDir, { inputPath: context.inputPath, detection: context.detection });
  if (!data) return null;
  return { moduleId: "bgi", engine: "bgi", gameType: "scripted", gamePath: context.inputPath || context.rootDir,
    contentRootDir: context.rootDir, name: data.title, runtimeId: "bgi-tools", moduleData: data,
    detectionEvidence: [{ type: "validated-bgi-archive", path: data.bootArchivePath, format: data.archiveFormat },
      { type: "validated-buriko-program", path: `${data.bootArchivePath}!/${data.bootScript}`, codeOffset: data.boot.codeOffset, codeBytes: data.boot.codeBytes }] };
}

module.exports = { detectGame };
