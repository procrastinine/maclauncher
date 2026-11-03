const fs = require("node:fs");
const path = require("node:path");
const manifest = require("./manifest.json");
const { detectGame } = require("./detect");
const manager = require("./runtime/manager");
const GameData = require("../shared/game-data");
const Architecture = require("../shared/runtime/architecture");
const Native = require("../shared/runtime/local-native");
const { spawnForegroundNativeGame } = require("../shared/runtime/native-focus");

const RUNTIME_ID = "xash3d-fwgs";

function gameDirectory(entry, context) {
  if (!/^[A-Za-z0-9_-]+$/.test(entry.gameId || "") || !path.isAbsolute(context.userDataDir || "")) throw new Error("Xash3D FWGS requires a saved game entry and launcher data directory.");
  return GameData.resolveGameModuleDir(context.userDataDir, entry.gameId, manifest.id);
}
function saveDirectory(entry, context) {
  const directory = entry.saveDirOverride || path.join(entry.contentRootDir || entry.gamePath, entry.moduleData.gameFolder, "save");
  if (!path.isAbsolute(directory) || /[\0\r\n]/.test(directory)) throw new Error("Xash3D FWGS save location must be an absolute local directory.");
  return directory;
}
// The explicit save adapter replaces only aliases; ordinary files and folders
// remain intact and prevent an ambiguous replacement.
function link(target, file) {
  let stat = null;
  try { stat = fs.lstatSync(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (stat?.isSymbolicLink()) {
    if (fs.readlinkSync(file) === target) return;
    fs.unlinkSync(file);
  } else if (stat) return;
  fs.symlinkSync(target, file, "dir");
}
function nativeLibrary(directory, name, architecture) {
  const suffix = architecture === "x64" ? "amd64" : "arm64", cpu = architecture === "x64" ? "x86_64" : "arm64";
  for (const filename of [`${name}_${suffix}.dylib`, `${name}.dylib`]) {
    const file = path.join(directory, filename);
    try { if (fs.statSync(file).isFile() && Native.readMachOArchitectures(file, { allowLibrary: true }).includes(cpu)) return file; }
    catch (error) { if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error; }
  }
  return null;
}
// Library overrides let the engine use its original writable game root without
// staging the game or adding runtime aliases to the imported folder.
function prepareLaunch(entry, context, install) {
  const detected = detectGame({ inputPath: entry.gamePath, rootDir: entry.gamePath, stat: fs.statSync(entry.gamePath) });
  if (!detected) throw new Error("The Half-Life game files are incomplete, or the mod's game library is not available for this Mac.");
  const directory = gameDirectory(entry, context), saveRoot = saveDirectory(entry, context);
  const gameFolder = detected.moduleData.gameFolder, engineGame = path.join(path.dirname(install.executablePath), "valve");
  const architecture = Architecture.selectedArchitecture(), originalGame = path.join(detected.contentRootDir, gameFolder);
  const server = detected.moduleData.gameLibrary === "Half-Life"
    ? nativeLibrary(path.join(engineGame, "dlls"), "hl", architecture) : path.join(originalGame, detected.moduleData.gameLibrary);
  const client = nativeLibrary(path.join(originalGame, "cl_dlls"), "client", architecture) ||
    nativeLibrary(path.join(engineGame, "cl_dlls"), "client", architecture);
  if (!server || !client) throw new Error("The Xash3D FWGS runtime is missing its native game libraries.");
  let dataRoot = detected.contentRootDir;
  // Upstream's save directory is fixed relative to the writable game root.
  // A requested custom folder needs this narrow adapter; default Play does not.
  if (entry.saveDirOverride && path.resolve(entry.saveDirOverride) !== path.resolve(originalGame, "save")) {
    dataRoot = path.join(directory, "data");
    fs.mkdirSync(path.join(dataRoot, gameFolder), { recursive: true });
    fs.mkdirSync(saveRoot, { recursive: true });
    link(saveRoot, path.join(dataRoot, gameFolder, "save"));
  }
  entry.defaultSaveDir = saveRoot;
  const environment = { ...process.env, XASH3D_BASEDIR: dataRoot };
  if (dataRoot !== detected.contentRootDir) environment.XASH3D_RODIR = detected.contentRootDir;
  else delete environment.XASH3D_RODIR;
  const extras = path.join(engineGame, "extras.pk3");
  if (fs.existsSync(extras)) environment.XASH3D_EXTRAS_PAK1 = extras;
  return { directory: detected.contentRootDir, dataRoot, saveRoot, gameFolder, root: detected.contentRootDir, environment,
    args: ["-game", gameFolder, "-dll", server, "-clientlib", client] };
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
      args: [...launch.args, ...(context.gameArguments || [])],
      options: { cwd: launch.directory, env: launch.environment }, needsRosetta: selected.install.needsRosetta });
  },
  cleanupGameData: (entry, context) => { fs.rmSync(gameDirectory(entry, context), { recursive: true, force: true }); return true; },
  actions: {
    runtimeStatus: (entry, _payload, context) => manager.resolveSelection(entry, context.settings, context.userDataDir)
  },
  __test: { prepareLaunch, link, saveDirectory }
};
