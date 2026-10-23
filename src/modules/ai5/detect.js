const path = require("node:path");
const { inspectGame } = require("./inspect");

function detectGame(context) {
  if (context.isAppBundle) return null;
  try {
    const data = inspectGame(context.rootDir, { inputPath: context.inputPath, detection: context.detection });
    if (!data) return null;
    // Loose bytecode has no identifying magic. Require an independently named
    // AI5WIN original runner before claiming a loose-script-only directory.
    if (!data.archive && !data.detectedVersionSource) return null;
    return { moduleId: "ai5", engine: "ai5", gamePath: context.rootDir, contentRootDir: context.rootDir,
      name: data.gameProfileLabel || data.title || path.basename(context.rootDir), runtimeId: "ai5", moduleData: data,
      detectionEvidence: [{ type: "validated-ai5-config", path: data.iniPath },
        ...(data.archive ? [{ type: "validated-ai5-script-index", path: data.scriptArchivePath, scheme: data.archive.scheme, entries: data.archive.count }] : []),
        ...(data.gameProfile ? [{ type: "declared-ai5-profile", profile: data.gameProfile, source: data.profileSource }] : [])] };
  } catch (error) { if (error.code === "DETECTION_LIMIT") throw error; return null; }
}

module.exports = { detectGame };
