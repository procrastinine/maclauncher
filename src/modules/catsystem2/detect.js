const path = require("node:path");
const { inspectGame } = require("./inspect");

function detectGame(context) {
  if (context?.isAppBundle || !context?.rootDir) return null;
  try {
    const data = inspectGame(context.rootDir, { inputPath: context.inputPath, detection: context.detection });
    if (!data) return null;
    return { moduleId: "catsystem2", engine: "catsystem2", gameType: "scripted", gamePath: context.inputPath || context.rootDir,
      contentRootDir: data.dataRoot, runtimeId: "catsystem2-tools", name: path.basename(context.rootDir), moduleData: data,
      detectionEvidence: [{ type: "validated-kif-scene-index-extent", path: data.sceneArchivePath, format: "KIF-64" },
        { type: "identified-original-runner", path: data.originalRunnerPath, source: data.detectedVersionSource }] };
  } catch (error) { if (error.code === "DETECTION_LIMIT") throw error; return null; }
}
module.exports = { detectGame };
