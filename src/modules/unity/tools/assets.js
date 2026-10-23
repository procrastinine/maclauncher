const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const GameData = require("../../shared/game-data");
const manager = require("./assetripper-manager");
const Session = require("./assetripper-session");
const { confirmToolInstall } = require("../../shared/runtime/tool-install");
const { withRuntimeUse } = require("../../../core/coordinated-runtime-managers");
const { throwIfAborted } = require("../../shared/runtime/download-utils");

const sessions = new Map();
const pendingActions = new Map();
function serializeAction(entry, context, work) {
  const key = sessionKey(entry, context), previous = pendingActions.get(key) || Promise.resolve();
  const operation = previous.then(work);
  const settled = operation.catch(() => {}).finally(() => { if (pendingActions.get(key) === settled) pendingActions.delete(key); });
  pendingActions.set(key, settled); return operation;
}
function rootFor(entry, context) {
  if (!/^[A-Za-z0-9_-]+$/.test(entry.gameId || "") || !path.isAbsolute(context.userDataDir || "")) throw new Error("Asset tools require a game in the library.");
  return path.join(GameData.resolveGameModuleDir(context.userDataDir, entry.gameId, "unity"), "assets");
}
function dataFor(entry) {
  const dataRoot = entry.moduleData?.dataRoot;
  if (!path.isAbsolute(dataRoot || "") || dataRoot.includes("\0") || !fs.statSync(dataRoot).isDirectory()) throw new Error("Unity game data was not found.");
  return dataRoot;
}
async function ensureTool(entry, payload, context, dependencies = {}) {
  const selectedManager = dependencies.manager || manager;
  let selected = selectedManager.resolveSelection(entry, context.settings, context.userDataDir, { version: payload?.toolVersion });
  if (selected.ready) return { manager: selectedManager, install: selected.install };
  await confirmToolInstall(context, { manager: selectedManager, version: selected.version, requiresDownload: true,
    detail: "Required to inspect or export Unity game assets." });
  const install = await selectedManager.installRuntime({ ...context, version: selected.version });
  context.onRuntimeStateChange?.({ managerId: selectedManager.id });
  return { manager: selectedManager, install };
}
async function withSession(entry, payload, context, work, dependencies = {}) {
  const dataRoot = dataFor(entry), root = rootFor(entry, context);
  const selected = await ensureTool(entry, payload, context, dependencies);
  const identity = { managerId: selected.manager.id, sectionId: "default", version: selected.install.version, sourcePath: selected.install.installDir };
  return (dependencies.withRuntimeUse || withRuntimeUse)([identity], async use => {
    throwIfAborted(context.signal);
    const workspace = path.join(root, "workspace", selected.install.version);
    const session = await (dependencies.startSession || Session.startSession)(selected.install, workspace, { signal: context.signal,
      onSpawn: child => Promise.all([use.bind(child.pid), context.onToolProcessSpawn?.(child, { stopOnLauncherExit: true })]) });
    try {
      await use.retainUntilClosed(session.child);
      await (dependencies.localRequest || Session.localRequest)(session, "/LoadFolder", { Path: dataRoot }, { signal: context.signal });
      return await work(session, selected.install, root);
    } catch (error) { session.close(); await session.waitClosed(); throw error; }
  }, { userDataDir: context.userDataDir });
}
function sessionKey(entry, context) { return context.userDataDir + ":" + entry.gameId; }
function updateSessionFlag(entry, context, active) {
  entry.moduleData = { ...entry.moduleData, assetInspectorRunning: active };
  context.onEntryChange?.({ moduleData: entry.moduleData });
}
async function openInspectorOnce(entry, payload, context, dependencies = {}) {
  const key = sessionKey(entry, context), existing = sessions.get(key);
  if (existing?.isOpen()) { await context.ui?.shell?.openExternal?.(existing.url); return { toolVersion: existing.version, running: true }; }
  return withSession(entry, payload, context, async (session, install) => {
    session.version = install.version; sessions.set(key, session); updateSessionFlag(entry, context, true);
    session.child.once("close", () => { if (sessions.get(key) === session) { sessions.delete(key); updateSessionFlag(entry, context, false); } });
    await context.ui?.shell?.openExternal?.(session.url);
    return { toolVersion: install.version, running: true, pid: session.child.pid };
  }, dependencies);
}
async function closeInspectorOnce(entry, _payload, context) {
  const key = sessionKey(entry, context), session = sessions.get(key);
  if (session) { session.close(); await session.waitClosed(); sessions.delete(key); }
  updateSessionFlag(entry, context, false);
  return { running: false };
}
async function exportAssetsOnce(entry, payload, context, dependencies = {}) {
  if (sessions.get(sessionKey(entry, context))?.isOpen()) throw new Error("Close the asset inspector before exporting assets.");
  return withSession(entry, payload, context, async (session, install, root) => {
    const exports = path.join(root, "exports"); fs.mkdirSync(exports, { recursive: true });
    const temporary = fs.mkdtempSync(path.join(exports, ".export-")), outputRoot = path.join(exports, "assets");
    const backup = path.join(exports, ".previous-" + crypto.randomUUID()); let moved = false;
    try {
      await (dependencies.localRequest || Session.localRequest)(session, "/Export/PrimaryContent", { Path: temporary }, { signal: context.signal });
      throwIfAborted(context.signal);
      if (!fs.readdirSync(temporary).length) throw new Error("AssetRipper did not export assets. See " + session.logPath + ".");
      const result = { outputRoot, toolVersion: install.version, toolSourceRevision: install.upstreamRevision,
        toolArchiveSha256: install.archiveSha256, createdAt: new Date().toISOString() };
      fs.writeFileSync(path.join(temporary, "export.json"), JSON.stringify(result, null, 2));
      if (fs.existsSync(outputRoot)) { fs.renameSync(outputRoot, backup); moved = true; }
      try { fs.renameSync(temporary, outputRoot); }
      catch (error) { if (moved) fs.renameSync(backup, outputRoot); throw error; }
      if (moved) fs.rmSync(backup, { recursive: true, force: true });
      entry.moduleData = { ...entry.moduleData, exportedAssetsRoot: outputRoot, assetExporterVersion: install.version };
      context.onEntryChange?.({ moduleData: entry.moduleData }); return result;
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); session.close(); await session.waitClosed(); }
  }, dependencies);
}
async function revealAssets(entry, _payload, context) {
  const expected = path.join(rootFor(entry, context), "exports", "assets");
  if (entry.moduleData?.exportedAssetsRoot !== expected || !fs.existsSync(expected)) throw new Error("No exported assets are available.");
  await context.ui?.shell?.openPath?.(expected); return { outputRoot: expected };
}
module.exports = { openInspector, closeInspector, exportAssets, revealAssets, __test: { ensureTool, withSession, sessions, rootFor, dataFor } };

function openInspector(entry, payload, context, dependencies) {
  return serializeAction(entry, context, () => openInspectorOnce(entry, payload, context, dependencies));
}
function closeInspector(entry, payload, context) {
  return serializeAction(entry, context, () => closeInspectorOnce(entry, payload, context));
}
function exportAssets(entry, payload, context, dependencies) {
  return serializeAction(entry, context, () => exportAssetsOnce(entry, payload, context, dependencies));
}
