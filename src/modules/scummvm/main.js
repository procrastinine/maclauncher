const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const manifest = require("./manifest.json");
const { detectGame, GAME_ID } = require("./detect");
const manager = require("./runtime/manager");
const toolsManager = require("./runtime/tools-manager");
const Tools = require("./tools");
const GameData = require("../shared/game-data");
const { spawnForegroundNativeGame } = require("../shared/runtime/native-focus");
const { confirmToolInstall } = require("../shared/runtime/tool-install");
const { withRuntimeMutation, withRuntimeUse } = require("../../core/coordinated-runtime-managers");
const execute = promisify(execFile);

function gameDirectory(entry, context) {
  if (!/^[A-Za-z0-9_-]+$/.test(entry.gameId || "") || !path.isAbsolute(context.userDataDir || "")) throw new Error("ScummVM requires a saved game entry and launcher data directory.");
  return GameData.resolveGameModuleDir(context.userDataDir, entry.gameId, manifest.id);
}
function saveDirectory(entry, context) {
  const directory = entry.saveDirOverride || path.join(gameDirectory(entry, context), "saves");
  if (!path.isAbsolute(directory) || /[\0\r\n]/.test(directory)) throw new Error("ScummVM save location must be an absolute local directory.");
  return directory;
}
function prepareLaunch(entry, context) {
  const directory = gameDirectory(entry, context), saveRoot = saveDirectory(entry, context);
  const root = entry.contentRootDir || entry.gamePath;
  if (!path.isAbsolute(root || "") || !fs.statSync(root).isDirectory() || /[\0\r\n]/.test(root)) throw new Error("ScummVM game data directory is missing or invalid.");
  fs.mkdirSync(directory, { recursive: true });
  fs.mkdirSync(saveRoot, { recursive: true });
  const configPath = path.join(directory, "scummvm.ini"), logPath = path.join(directory, "scummvm.log");
  // Keep engine preferences isolated from any independently installed ScummVM.
  // Every run disables upstream automatic update checks; Refresh belongs to the
  // runtime manager and selected runtime versions must stay immutable.
  let config = "[scummvm]\n";
  try {
    if (fs.statSync(configPath).size <= 1024 * 1024) config = fs.readFileSync(configPath, "utf8");
  } catch {}
  if (!/^\[scummvm\]\s*$/mi.test(config)) config = "[scummvm]\n" + config;
  config = config.replace(/^updates_check\s*=.*(?:\r?\n|$)/gmi, "");
  config = config.replace(/^\[scummvm\]\s*$/mi, "[scummvm]\nupdates_check=0");
  const temporary = `${configPath}.tmp`;
  fs.writeFileSync(temporary, config); fs.renameSync(temporary, configPath);
  entry.defaultSaveDir = saveRoot;
  return { directory, root, saveRoot, configPath, logPath };
}
function runtimeArgs(settings = {}) {
  const args = [settings.fullscreen ? "--fullscreen" : "--no-fullscreen",
    settings.aspectRatio !== false ? "--aspect-ratio" : "--no-aspect-ratio",
    settings.filtering ? "--filtering" : "--no-filtering"];
  for (const [key, option] of [["language", "language"], ["graphicsMode", "gfx-mode"], ["renderer", "renderer"]]) {
    const value = String(settings[key] || "").trim();
    if (!value || value === "auto") continue;
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(value)) throw new Error(`Invalid ScummVM ${key} setting.`);
    args.push(`--${option}=${value}`);
  }
  for (const [key, option] of [["musicVolume", "music-volume"], ["speechVolume", "speech-volume"], ["sfxVolume", "sfx-volume"]]) {
    if (settings[key] === undefined) continue;
    if (!Number.isInteger(settings[key]) || settings[key] < 0 || settings[key] > 255) throw new Error("ScummVM audio volume must be from 0 to 255.");
    args.push(`--${option}=${settings[key]}`);
  }
  const gameId = String(settings.gameId || "").trim();
  if (gameId && !GAME_ID.test(gameId)) throw new Error("ScummVM game ID is invalid.");
  return { args, gameId };
}
function parseDetection(output, root) {
  const matches = [];
  for (const line of String(output).split(/\r?\n/)) {
    const match = /^([a-z][a-z0-9_-]*:[a-z0-9][a-z0-9_-]*)\s{2,}(.+?)\s{2,}(.+?)\s*$/i.exec(line);
    if (match && path.resolve(match[3]) === path.resolve(root)) matches.push({ gameId: match[1], description: match[2].trim() });
  }
  return [...new Map(matches.map(match => [match.gameId, match])).values()];
}
async function inspectWithRuntime(entry, context, { run = execute } = {}) {
  let selection = manager.resolveSelection(entry, context.settings, context.userDataDir);
  if (!selection.ready) {
    if (!selection.version && !selection.discoveryRequired) throw new Error(selection.reason);
    await confirmToolInstall(context, { manager, version: selection.version, detail: "Required to identify the game edition." });
    if (!selection.version) {
      await manager.refreshCatalog({ userDataDir: context.userDataDir, signal: context.signal, logger: context.logger, force: true });
      context.onRuntimeStateChange?.();
      selection = manager.resolveSelection(entry, context.settings, context.userDataDir);
      if (!selection.version) throw new Error("No ScummVM versions are available to download.");
    }
    await withRuntimeMutation({ managerId: manager.id, version: selection.version }, () => manager.installRuntime({
      userDataDir: context.userDataDir, version: selection.version, signal: context.signal, downloads: context.downloads, logger: context.logger }), { userDataDir: context.userDataDir });
    context.onRuntimeStateChange?.();
    selection = manager.resolveSelection(entry, context.settings, context.userDataDir);
  }
  if (!selection.ready) throw new Error(selection.reason);
  if (selection.install.needsRosetta && context.ensureRosetta) await context.ensureRosetta();
  return withRuntimeUse([{ managerId: manager.id, version: selection.version }], async use => {
    if (!manager.resolveSelection(entry, context.settings, context.userDataDir).ready) throw new Error("ScummVM changed before game identification. Try again.");
    const launch = prepareLaunch(entry, context);
    const pending = run(selection.install.executablePath,
      [`--config=${launch.configPath}`, `--logfile=${launch.logPath}`, `--path=${launch.root}`, "--detect"],
      { cwd: launch.directory, signal: context.signal, timeout: 20000, maxBuffer: 2 * 1024 * 1024 });
    let result;
    try {
      if (pending.child?.pid) await Promise.all([use.bind(pending.child.pid), context.onToolProcessSpawn?.(pending.child)]);
      result = await pending;
    } catch (error) {
      pending.child?.kill(); await Promise.resolve(pending).catch(() => {}); throw error;
    }
    const games = parseDetection(result.stdout, launch.root);
    if (!games.length) throw new Error("The selected ScummVM version did not recognize these game files. Check the required files or select a newer runtime version.");
    entry.moduleData = { ...entry.moduleData, detectedGames: games, detectionRuntimeVersion: selection.version,
      ...(games.length === 1 ? { gameId: games[0].gameId, gameDescription: games[0].description } : {}) };
    context.onEntryChange?.(entry);
    return { version: selection.version, games, gameId: games[0].gameId, description: games[0].description, count: games.length };
  }, { userDataDir: context.userDataDir });
}

module.exports = { id: manifest.id, manifest, detectGame, runtimeManagers: [manager, toolsManager],
  normalizeRuntimeId: () => "scummvm",
  onImport: (entry, context) => { entry.defaultSaveDir = saveDirectory(entry, context); },
  ensureRuntime: (entry, context) => {
    const selection = manager.resolveSelection(entry, context.settings, context.userDataDir);
    return selection.ready ? null : { managerId: "scummvm", version: selection.version, ...(selection.discoveryRequired ? { discoveryRequired: true } : {}), installOptions: {} };
  },
  launchRuntime: async (runtimeId, entry, context) => {
    if (runtimeId !== "scummvm") return null;
    let selection = manager.resolveSelection(entry, context.settings, context.userDataDir);
    if (!selection.ready) throw new Error(selection.reason);
    const graphics = await context.getGameEffectsEnvironment?.({needsRosetta:selection.install.needsRosetta});
    if (typeof graphics?.DYLD_INSERT_LIBRARIES === "string" && graphics.DYLD_INSERT_LIBRARIES.trim())
      selection = await manager.prepareForGraphics(selection,context);
    const launch = prepareLaunch(entry, context), options = runtimeArgs(context.runtimeSettings);
    const gameId = options.gameId || entry.moduleData?.gameId;
    if (gameId && !GAME_ID.test(gameId)) throw new Error("ScummVM game ID is invalid.");
    context.onEntryChange?.(entry);
    return spawnForegroundNativeGame({ context, executablePath: selection.install.executablePath,
      args: [`--config=${launch.configPath}`, `--logfile=${launch.logPath}`, `--savepath=${launch.saveRoot}`,
        `--path=${launch.root}`, ...options.args, ...(context.gameArguments || []), ...(gameId ? [gameId] : ["--auto-detect"])],
      options: { cwd: launch.directory }, needsRosetta: selection.install.needsRosetta });
  },
  cleanupGameData: (entry, context) => { fs.rmSync(gameDirectory(entry, context), { recursive: true, force: true }); return true; },
  actions: {
    runtimeStatus: (entry, _payload, context) => manager.resolveSelection(entry, context.settings, context.userDataDir),
    inspectGame: (entry, _payload, context) => inspectWithRuntime(entry, context),
    extractArchives: (entry, payload, context) => Tools.extractArchives(entry, payload, context),
    revealExtraction: (entry, _payload, context) => Tools.revealExtraction(entry, context)
  },
  __test: { prepareLaunch, runtimeArgs, parseDetection, inspectWithRuntime, saveDirectory }
};
