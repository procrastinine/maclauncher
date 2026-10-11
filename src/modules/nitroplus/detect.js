const { inspectGame } = require("./inspect");

function detectGame(context) {
  if (context.isAppBundle) return null;
  const data = inspectGame(context.rootDir, { inputPath: context.inputPath, detection: context.detection });
  if (!data) return null;
  return { moduleId: "nitroplus", engine: "nitroplus", name: data.title,
    gamePath: context.rootDir, contentRootDir: context.rootDir, runtimeId: "npengine", moduleData: data,
    detectionEvidence: [{ type: "validated-npa-v1-index", path: data.scriptArchivePath, entries: data.scriptCount },
      { type: data.bootValidated ? "validated-nss-boot" : "declared-nss-boot", path: data.bootScript },
      ...(data.originalRunner ? [{ type: "original-pe-version", path: data.originalRunnerPath, source: data.originalRunner.source }] : [])] };
}
module.exports = { detectGame };
