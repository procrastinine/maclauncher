const Inspect = require("./inspect");
function detectGame(context) {
  if (!context?.rootDir || context.isAppBundle) return null;
  const data = Inspect.inspectGame(context.rootDir, { inputPath: context.inputPath, detection: context.detection });
  if (!data) return null;
  return { moduleId: "fvp", engine: "fvp", gameType: "scripted", runtimeId: "rfvp", name: data.title,
    gamePath: context.rootDir, contentRootDir: context.rootDir, moduleData: data,
    detectionEvidence: [{ type: "validated-fvp-script-descriptor", path: data.scriptPath, syscallCount: data.syscallCount },
      ...data.archives.map(archive => ({ type: "validated-fvp-pack-index", path: archive.path, entries: archive.count }))] };
}
module.exports = { detectGame };
