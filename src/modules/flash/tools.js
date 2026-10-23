const fs = require("node:fs");
const path = require("node:path");
const Tool = require("./runtime/ffdec-manager");
const GameData = require("../shared/game-data");
const Native = require("../shared/runtime/local-native");
const { throwIfAborted } = require("../shared/runtime/download-utils");
const { getUiServices } = require("../shared/ui-services");

function source(entry) {
  const file = entry.moduleData?.swfPath || entry.gamePath;
  if (!path.isAbsolute(file || "") || path.extname(file).toLowerCase() !== ".swf" || !fs.statSync(file).isFile())
    throw new Error("Flash .swf file not found.");
  return file;
}
function exportRoot(entry, context) {
  return path.join(GameData.resolveGameModuleDir(context.userDataDir, entry.gameId, "flash"), "exports");
}
async function exportGame(entry, payload = {}, context, dependencies = {}) {
  const swf = source(entry), parent = exportRoot(entry, context);
  fs.mkdirSync(parent, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(parent, ".export-"));
  const outputDir = path.join(parent, payload.assets ? "assets" : "scripts"), logPath = path.join(temporary, "export.log");
  fs.writeFileSync(logPath, "JPEXS FFDec\n");
  let backup;
  try {
    const sourceSha256 = Native.hashFile(swf);
    const result = await (dependencies.run || Tool.core.run)(context, payload, { cwd: temporary, logPath,
      javaArgs: ["-Djava.awt.headless=true"], args: ["-config", "check.updates.enabled=false", "-onerror", "abort",
        "-export", payload.assets ? "script,image,shape,sound,font,text,binaryData" : "script", temporary, swf] });
    throwIfAborted(context.signal);
    if (Native.hashFile(swf) !== sourceSha256) throw new Error("The Flash file changed during export. Try again.");
    const record = { outputDir, ...result, sourcePath: swf, sourceSha256, exportedAt: new Date().toISOString(),
      resources: payload.assets ? "scripts-and-assets" : "scripts" };
    fs.writeFileSync(path.join(temporary, "export.json"), JSON.stringify(record, null, 2));
    if (fs.existsSync(outputDir)) { backup = outputDir + ".previous-" + Date.now(); fs.renameSync(outputDir, backup); }
    fs.renameSync(temporary, outputDir);
    if (backup) fs.rmSync(backup, { recursive: true, force: true });
    entry.moduleData = { ...entry.moduleData, ffdecExportDir: outputDir, ffdecVersion: result.toolVersion };
    context.onEntryChange?.({ moduleData: entry.moduleData }); return record;
  } catch (error) {
    if (backup) { fs.rmSync(outputDir, { recursive: true, force: true }); fs.renameSync(backup, outputDir); }
    throw error;
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
function revealExport(entry, _payload, context) {
  const root = entry.moduleData?.ffdecExportDir;
  if (!root || !path.resolve(root).startsWith(exportRoot(entry, context) + path.sep) || !fs.existsSync(path.join(root, "export.json")))
    throw new Error("Export Flash scripts or assets first.");
  getUiServices(context).shell.showItemInFolder(root); return { outputDir: root };
}
module.exports = { exportGame, revealExport, source };
