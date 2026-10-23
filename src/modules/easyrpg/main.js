const fs = require("node:fs");
const path = require("node:path");
const manifest = require("./manifest.json");
const { detectGame, inspectProject } = require("./detect");
const manager = require("./runtime/manager");
const { compareVersions } = require("./runtime/catalog");
const GameData = require("../shared/game-data");
const Tools = require("./tools");

function gameDirectory(entry, context) {
  if (!/^[A-Za-z0-9_-]+$/.test(entry?.gameId || "") || !path.isAbsolute(context?.userDataDir || ""))
    throw new Error("EasyRPG requires a saved game entry and launcher data directory.");
  return GameData.resolveGameModuleDir(context.userDataDir, entry.gameId, manifest.id);
}

function saveDirectory(entry, context) {
  const directory = entry.saveDirOverride || path.join(gameDirectory(entry, context), "saves");
  if (!path.isAbsolute(directory) || directory.includes("\0")) throw new Error("The EasyRPG save location must be an absolute path.");
  return directory;
}

function seedSaves(root, directory, moduleDir) {
  const marker = path.join(moduleDir, "saves-imported.json");
  if (fs.existsSync(marker)) return;
  for (const file of fs.readdirSync(root, { withFileTypes: true })) {
    if (!file.isFile() || !/^Save\d+\.lsd$/i.test(file.name)) continue;
    const target = path.join(directory, file.name);
    if (!fs.existsSync(target)) fs.copyFileSync(path.join(root, file.name), target, fs.constants.COPYFILE_EXCL);
  }
  fs.writeFileSync(marker, JSON.stringify({ sourceRoot: root }));
}

function stringValue(value, label) {
  if (typeof value !== "string" || value.includes("\0") || value.length > 4096) throw new Error(`Invalid ${label}.`);
  return value.trim();
}

function launchArguments(entry, context, { version = manager.DEFAULT_VERSION } = {}) {
  const root = entry.contentRootDir || entry.gamePath;
  if (!inspectProject(root)) throw new Error("The RPG Maker database or map tree is missing or invalid.");
  const directory = gameDirectory(entry, context);
  const saves = saveDirectory(entry, context);
  const config = path.join(directory, "config");
  const settings = context.runtimeSettings || {};
  const args = ["--project-path", root, "--save-path", saves, "--config-path", config, "--no-log-color"];
  if (compareVersions(version, "0.8.1") >= 0) args.push("--log-file", path.join(directory, "easyrpg.log"));
  if (settings.fullscreen === true) args.push("--fullscreen");
  else args.push("--window");
  const scaling = settings.scaling || "integer";
  if (!["nearest", "integer", "bilinear"].includes(scaling)) throw new Error("Invalid EasyRPG scaling mode.");
  args.push("--scaling", scaling);
  if (settings.noAudio === true) args.push("--no-audio");
  if (settings.showFps === true) args.push("--show-fps");
  for (const key of ["encoding", "language"]) {
    if (settings[key]) args.push(`--${key}`, stringValue(settings[key], `EasyRPG ${key}`));
  }
  if (settings.soundfont) {
    const soundfont = stringValue(settings.soundfont, "EasyRPG MIDI soundfont");
    if (!path.isAbsolute(soundfont)) throw new Error("The EasyRPG MIDI soundfont path must be absolute.");
    args.push("--soundfont", soundfont);
  }
  const engine = settings.engine || "auto";
  if (!["auto", "rpg2k", "rpg2kv150", "rpg2ke", "rpg2k3", "rpg2k3v105", "rpg2k3e"].includes(engine))
    throw new Error("Invalid RPG Maker engine mode.");
  if (engine !== "auto") args.push("--engine", engine);
  const rtpPaths = settings.rtpPaths || [];
  if (!Array.isArray(rtpPaths) || rtpPaths.length > 32) throw new Error("Invalid EasyRPG RTP paths.");
  for (const value of rtpPaths) {
    const rtp = stringValue(value, "EasyRPG RTP path");
    if (!path.isAbsolute(rtp)) throw new Error("EasyRPG RTP paths must be absolute.");
    args.push("--rtp-path", rtp);
  }
  const extra = settings.appArgs || [];
  if (!Array.isArray(extra) || extra.length > 128) throw new Error("Invalid EasyRPG game arguments.");
  for (const arg of [...extra.map(value => stringValue(value, "EasyRPG game argument")), ...(context.gameArguments || [])]) {
    if (/^(?:--(?:project-path|save-path|config-path|log-file)(?:=|$)|-c(?:=|$))/.test(arg))
      throw new Error("Game arguments cannot change the EasyRPG project, save, configuration or log paths.");
    args.push(arg);
  }
  fs.mkdirSync(saves, { recursive: true });
  fs.mkdirSync(config, { recursive: true });
  seedSaves(root, saves, directory);
  entry.defaultSaveDir = saves;
  return { args, directory, saves };
}

module.exports = { id: manifest.id, manifest, detectGame, runtimeManagers: [manager],
  normalizeRuntimeId: () => "easyrpg",
  ensureRuntime: (entry, context) => {
    if (!inspectProject(entry.contentRootDir || entry.gamePath)) throw new Error("The RPG Maker database or map tree is missing or invalid.");
    const selection = manager.resolveSelection(entry, context.settings, context.userDataDir);
    return selection.ready ? null : { managerId: "easyrpg", version: selection.version, installOptions: {} };
  },
  onImport: (entry, context) => { entry.defaultSaveDir = saveDirectory(entry, context); },
  onRuntimeChange: (entry, context) => { entry.defaultSaveDir = saveDirectory(entry, context); },
  launchRuntime: async (runtimeId, entry, context) => {
    if (runtimeId !== "easyrpg") return null;
    const selection = manager.resolveSelection(entry, context.settings, context.userDataDir);
    if (!selection.ready) throw new Error(selection.reason);
    const launch = launchArguments(entry, context, selection);
    context.onEntryChange?.(entry);
    return context.spawnDetachedChecked(selection.install.executablePath, launch.args,
      { cwd: launch.directory }, selection.install.needsRosetta);
  },
  cleanupGameData: (entry, context) => { fs.rmSync(gameDirectory(entry, context), { recursive: true, force: true }); return true; },
  save: { extensions: [".lsd"] },
  actions: {
    runtimeStatus: (entry, _payload, context) => manager.resolveSelection(entry, context.settings, context.userDataDir),
    exportProjectJson: (entry, payload, context) => Tools.exportProject(entry, payload, context, "json"),
    exportProjectText: (entry, payload, context) => Tools.exportProject(entry, payload, context, "text"),
    revealExport: Tools.revealExport,
    inspectProject: entry => {
      const project = inspectProject(entry.contentRootDir || entry.gamePath);
      if (!project) throw new Error("The RPG Maker database or map tree is missing or invalid.");
      return { ...project, compatibility: project.hasDynRpg ? "DynRPG plug-ins may require the original Windows runtime." : "RPG Maker 2000/2003 data" };
    }
  },
  __test: { gameDirectory, saveDirectory, launchArguments, seedSaves }
};
