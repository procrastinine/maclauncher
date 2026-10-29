const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const GameData = require("../../shared/game-data");
const { manager } = require("./sff-manager");
const { confirmToolInstall } = require("../../shared/runtime/tool-install");
const { runToolCommand } = require("../../shared/runtime/tool-command");
const { throwIfAborted } = require("../../shared/runtime/download-utils");
const { withRuntimeUse } = require("../../../core/coordinated-runtime-managers");

function listSources(root) {
  const files = []; let entries = 0;
  function visit(directory, depth = 0) {
    if (depth > 32) throw new Error("SFF source directory is too deeply nested.");
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      if (++entries > 50000) throw new Error("SFF source scan exceeds the supported directory limit.");
      if (item.name.startsWith(".")) continue;
      const file = path.join(directory, item.name);
      if (item.isDirectory()) visit(file, depth + 1);
      else if (item.isFile() && /\.sff$/i.test(item.name)) {
        files.push(path.relative(root, file));
        if (files.length > 1024) throw new Error("SFF export exceeds the 1,024 archive limit.");
      }
    }
  }
  visit(root); return files.sort();
}
async function exportSpritesOnce(entry, payload, context) {
  if (!/^[A-Za-z0-9_-]+$/.test(entry.gameId || "") || !path.isAbsolute(context.userDataDir || "")) throw new Error("Sprite export requires a game in the library.");
  const root = fs.realpathSync(entry.contentRootDir || entry.gamePath), files = listSources(root);
  if (!files.length) throw new Error("No SFF sprite archives were found in this game.");
  let selection = manager.resolveSelection(entry, context.settings, context.userDataDir, { version: payload?.toolVersion });
  if (!selection.ready) {
    await confirmToolInstall(context, { manager, version: selection.version, requiresDownload: true });
    await manager.installRuntime({ ...context, version: selection.version }); context.onRuntimeStateChange?.();
    selection = manager.resolveSelection(entry, context.settings, context.userDataDir, { version: selection.version });
  }
  if (!selection.ready) throw new Error(selection.reason);
  const parent = path.join(GameData.resolveGameModuleDir(context.userDataDir, entry.gameId, "ikemen"), "exports"); fs.mkdirSync(parent, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(parent, ".sprites-")), outputRoot = path.join(parent, "sprites");
  try {
    const request = path.join(temporary, "request.json");
    fs.writeFileSync(request, JSON.stringify({ installDir: selection.install.installDir, sourceRoot: root, files, outputRoot: temporary }));
    const environment = { ...process.env, ELECTRON_RUN_AS_NODE: "1" }; delete environment.NODE_OPTIONS; delete environment.NODE_PATH;
    await withRuntimeUse([{ managerId: manager.id, sectionId: "default", version: selection.version, sourcePath: selection.install.installDir }],
      async use => runToolCommand(process.execPath, ["--max-old-space-size=1024", path.join(__dirname, "sff-worker.cjs"), request], {
        cwd: temporary, env: environment, logPath: path.join(temporary, "sff.log"), signal: context.signal, timeout: 600000,
        onSpawn: child => Promise.all([use.bind(child.pid), context.onToolProcessSpawn?.(child)]) }), { userDataDir: context.userDataDir });
    throwIfAborted(context.signal);
    const report = JSON.parse(fs.readFileSync(path.join(temporary, "sprites-export.json"), "utf8")); fs.rmSync(request);
    if (!Number.isInteger(report.sprites) || report.sprites < 1) throw new Error("SFF Tools did not export any sprites.");
    const previous = path.join(parent, ".previous-" + crypto.randomUUID()), existed = fs.existsSync(outputRoot);
    if (existed) fs.renameSync(outputRoot, previous);
    try { fs.renameSync(temporary, outputRoot); } catch (error) { if (existed) fs.renameSync(previous, outputRoot); throw error; }
    if (existed) fs.rmSync(previous, { recursive: true, force: true });
    entry.moduleData = { ...entry.moduleData, spriteExportRoot: outputRoot }; context.onEntryChange?.({ moduleData: entry.moduleData });
    return { outputRoot, toolVersion: report.toolVersion, files: report.files, sprites: report.sprites, failed: report.failed,
      ...(report.failed ? { exportWarning: "Some sprites or archives could not be decoded. See sprites-export.json for details." } : {}) };
  } catch (error) {
    const failed = path.join(parent, "sprites-failure"); fs.rmSync(failed, { recursive: true, force: true });
    fs.rmSync(path.join(temporary, "request.json"), { force: true }); fs.renameSync(temporary, failed);
    error.message += " Details: " + failed; throw error;
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
const running = new Set();
async function exportSprites(entry, payload, context) {
  const key = JSON.stringify([context.userDataDir, entry.gameId]);
  if (running.has(key)) throw new Error("A sprite export is already running for this game.");
  running.add(key);
  try { return await exportSpritesOnce(entry, payload, context); }
  finally { running.delete(key); }
}
module.exports = { exportSprites, listSources };
