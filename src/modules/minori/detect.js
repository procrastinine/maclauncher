const { inspectGame } = require("./inspect");
function detectGame(context) {
  if (!context?.rootDir || context.isAppBundle) return null;
  const data = inspectGame(context.rootDir, { inputPath: context.inputPath, detection: context.detection });
  if (!data) return null;
  return { moduleId: "minori", engine: "minori", gameType: "scripted", gamePath: context.rootDir,
    contentRootDir: context.rootDir, name: data.title, runtimeId: "reminori", moduleData: data,
    detectionEvidence: data.archives.map(archive => ({ type: "minori-paz-companion-header", path: archive.path,
      bytes: archive.bytes, indexBytes: archive.indexBytes, prefix: archive.prefix, xorKey: archive.xorKey })) };
}
module.exports = { detectGame };
