const fs = require("node:fs");
const path = require("node:path");
const manifest = require("./manifest.json");
const { detectGame } = require("./detect");
const manager = require("./runtime/manager");
const GameData = require("../shared/game-data");
const { spawnForegroundNativeGame } = require("../shared/runtime/native-focus");

const RUNTIME_ID = "xash3d-fwgs";

function gameDirectory(entry, context) {
  if (!/^[A-Za-z0-9_-]+$/.test(entry.gameId || "") || !path.isAbsolute(context.userDataDir || "")) throw new Error("Xash3D FWGS requires a saved game entry and launcher data directory.");
  return GameData.resolveGameModuleDir(context.userDataDir, entry.gameId, manifest.id);
}
function saveDirectory(entry, context) {
  const directory = entry.saveDirOverride || path.join(gameDirectory(entry, context), "saves");
  if (!path.isAbsolute(directory) || /[\0\r\n]/.test(directory)) throw new Error("Xash3D FWGS save location must be an absolute local directory.");
  return directory;
}
// Points `file` at the `target` folder. A real folder in its place is kept
// unless it is empty, so files written there are never removed.
function link(target, file) {
  let stat = null;
  try { stat = fs.lstatSync(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (stat?.isSymbolicLink()) {
    if (fs.readlinkSync(file) === target) return;
    fs.unlinkSync(file);
  } else if (stat?.isDirectory()) {
    try { fs.rmdirSync(file); } catch { return; }
  } else if (stat) fs.unlinkSync(file);
  fs.symlinkSync(target, file, "dir");
}
// The engine reads the imported folder as its read-only root and writes its
// configuration, logs and saves to a private root. Half-Life's folder there
// links the game libraries of the selected runtime, and the game's `save`
// folder links the save location.
function prepareLaunch(entry, context, install) {
  const detected = detectGame({ inputPath: entry.gamePath, rootDir: entry.gamePath, stat: fs.statSync(entry.gamePath) });
  if (!detected) throw new Error("The Half-Life game files are incomplete, or the mod's game library is not available for this Mac.");
  const directory = gameDirectory(entry, context), dataRoot = path.join(directory, "data"), saveRoot = saveDirectory(entry, context);
  const gameFolder = detected.moduleData.gameFolder, engineGame = path.join(path.dirname(install.executablePath), "valve");
  fs.mkdirSync(path.join(dataRoot, "valve"), { recursive: true });
  fs.mkdirSync(path.join(dataRoot, gameFolder), { recursive: true });
  fs.mkdirSync(saveRoot, { recursive: true });
  let libraries = [];
  try { libraries = fs.readdirSync(engineGame, { withFileTypes: true }).filter(item => item.isDirectory()); } catch {}
  for (const item of libraries) link(path.join(engineGame, item.name), path.join(dataRoot, "valve", item.name));
  link(saveRoot, path.join(dataRoot, gameFolder, "save"));
  entry.defaultSaveDir = saveRoot;
  const environment = { ...process.env, XASH3D_BASEDIR: dataRoot, XASH3D_RODIR: detected.contentRootDir };
  const extras = path.join(engineGame, "extras.pk3");
  if (fs.existsSync(extras)) environment.XASH3D_EXTRAS_PAK1 = extras;
  return { directory, dataRoot, saveRoot, gameFolder, root: detected.contentRootDir, environment };
}

module.exports = { id: manifest.id, manifest, detectGame, runtimeManagers: [manager],
  normalizeRuntimeId: () => RUNTIME_ID,
  onImport: (entry, context) => { entry.defaultSaveDir = saveDirectory(entry, context); },
  ensureRuntime: (entry, context) => {
    const selected = manager.resolveSelection(entry, context.settings, context.userDataDir);
    return selected.ready ? null : { managerId: manager.id, version: selected.version, ...(selected.discoveryRequired ? { discoveryRequired: true } : {}), installOptions: {} };
  },
  launchRuntime: async (runtimeId, entry, context) => {
    if (runtimeId !== RUNTIME_ID) return null;
    const selected = manager.resolveSelection(entry, context.settings, context.userDataDir);
    if (!selected.ready) throw new Error(selected.reason);
    const launch = prepareLaunch(entry, context, selected.install);
    context.onEntryChange?.(entry);
    return spawnForegroundNativeGame({ context, executablePath: selected.install.executablePath,
      args: ["-game", launch.gameFolder, ...(context.gameArguments || [])],
      options: { cwd: launch.directory, env: launch.environment }, needsRosetta: selected.install.needsRosetta });
  },
  cleanupGameData: (entry, context) => { fs.rmSync(gameDirectory(entry, context), { recursive: true, force: true }); return true; },
  actions: {
    runtimeStatus: (entry, _payload, context) => manager.resolveSelection(entry, context.settings, context.userDataDir)
  },
  __test: { prepareLaunch, link, saveDirectory }
};
