const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const manifest = require("./manifest.json");
const { detectGame } = require("./detect");
const { inspectPrograms } = require("./inspect");
const Archive = require("./archive");
const GameData = require("../shared/game-data");
const MsgTool = require("../shared/runtime/msg-tool");

function toolsRoot(entry, context) {
  if (!entry.gameId || !context.userDataDir) throw new Error("Import this game before exporting its Buriko programs.");
  return path.join(GameData.resolveGameModuleDir(context.userDataDir, entry.gameId, "bgi"), "exports");
}

function exportPrograms(entry, _payload, context) {
  const report = inspectPrograms(entry.contentRootDir), parent = toolsRoot(entry, context), destination = path.join(parent, `programs-${crypto.randomUUID()}`);
  fs.mkdirSync(parent, { recursive: true }); const staging = path.join(parent, `.export-${crypto.randomUUID()}`); fs.mkdirSync(staging);
  try {
    const archives = new Map();
    for (const program of report.programs) {
      if (!archives.has(program.archive)) archives.set(program.archive, Archive.inspectArchive(path.join(entry.contentRootDir, program.archive)));
      const archive = archives.get(program.archive), bytes = Archive.readMember(archive, archive.members.get(program.filename.toLowerCase()));
      if (bytes.length !== program.decodedBytes || crypto.createHash("sha256").update(bytes).digest("hex") !== program.sha256) throw new Error("Buriko program changed during export.");
      const directory = path.join(staging, path.basename(program.archive, path.extname(program.archive))); fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, program.filename), bytes, { flag: "wx" });
    }
    fs.writeFileSync(path.join(staging, "programs.json"), JSON.stringify(report, null, 2)); fs.renameSync(staging, destination);
    return { programCount: report.programCount, scriptBytes: report.scriptBytes, skippedArchives: report.skippedArchives, path: destination };
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}

module.exports = { id: manifest.id, manifest, detectGame, runtimeManagers: [MsgTool], normalizeRuntimeId: () => "bgi-tools",
  ensureRuntime: async () => { throw new Error("BGI is not yet supported for play. Program inspection and export are available in the inspector."); },
  launchRuntime: async () => { throw new Error("BGI is not yet supported for play. Program inspection and export are available in the inspector."); },
  actions: { inspectPrograms: entry => inspectPrograms(entry.contentRootDir), exportPrograms,
    exportText: (entry, payload, context) => require("./tools").exportText(entry, payload, context) } };
