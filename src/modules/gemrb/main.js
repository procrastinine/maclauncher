const GameIdentity = require("../shared/runtime/game-identity");
const fs = require("node:fs");
const path = require("node:path");
const NativeFocus = require("../shared/runtime/native-focus");
const manifest = require("./manifest.json");
const { detectGame } = require("./detect");
const manager = require("./runtime/manager");
const GameData = require("../shared/game-data");
const { resolveInstalledEnvironment } = require("../shared/runtime/bundled-native");
const { runtimeVersionChoices } = require("../shared/runtime/version-choices");

function moduleDirectory(entry, context) {
  if (!entry.gameId || !context.userDataDir || !/^[A-Za-z0-9_-]+$/.test(entry.gameId)) throw new Error("GemRB requires a persisted game id and launcher data directory.");
  return GameData.resolveGameModuleDir(context.userDataDir, entry.gameId, manifest.id);
}
function configValue(value) {
  const text = String(value);
  if (/[\r\n\0]/.test(text)) throw new Error("GemRB configuration paths must not contain newlines or NUL bytes.");
  return text;
}
function prepareLaunch(entry, context, install) {
  const directory = moduleDirectory(entry, context);
  const root = entry.contentRootDir || entry.gamePath;
  const detected = detectGame({ inputPath: root, rootDir: root, stat: fs.statSync(root) });
  if (!detected) throw new Error("Infinity Engine game files are incomplete or invalid.");
  if (detected.moduleData.compatibility === "unsupported-format") throw new Error("This Infinity Engine GAME data format is unsupported by the pinned GemRB runtime.");
  const settings = context.runtimeSettings || {};
  const customGameType = String(settings.customGameType || detected.moduleData.bundledGameProfile || "").trim();
  if (customGameType && !/^[a-z][a-z0-9_-]{0,63}$/.test(customGameType)) throw new Error("Custom GemRB game profile must be a safe lowercase identifier.");
  const gameType = customGameType || (settings.gameType && settings.gameType !== "auto" ? settings.gameType : detected.moduleData.gameType);
  if (!customGameType && !["auto", "bg1", "bg2", "iwd", "iwd2", "pst", "demo"].includes(gameType)) throw new Error("Unsupported GemRB game type.");
  const width = Number(settings.width || 800), height = Number(settings.height || 600);
  if (![width, height].every(value => Number.isInteger(value) && value >= 320 && value <= 16384)) throw new Error("Invalid GemRB resolution.");
  const saveRoot = entry.saveDirOverride || root;
  if (!path.isAbsolute(saveRoot)) throw new Error("GemRB save location must be absolute.");
  const cacheRoot = path.join(directory, "cache");
  fs.mkdirSync(cacheRoot, { recursive: true });
  const config = { GamePath: root, GameType: gameType, SavePath: saveRoot, CachePath: cacheRoot,
    Width: width, Height: height, FullScreen: settings.fullscreen ? 1 : 0,
    EnableCheatKeys: settings.enableCheatKeys ? 1 : 0 };
  const resolvedInstall = install || manager.resolveSelection(entry, context.settings, context.userDataDir).install;
  if (resolvedInstall && path.basename(path.dirname(resolvedInstall.executablePath)) === "MacOS") {
    const contents = path.dirname(path.dirname(resolvedInstall.executablePath));
    const resources = path.join(contents, "Resources"), plugins = path.join(contents, "PlugIns");
    if (fs.existsSync(resources)) { config.GemRBPath = resources; config.GUIScriptsPath = resources; }
    if (fs.existsSync(plugins)) config.PluginsPath = plugins;
  }
  for (const [key, setting] of [["GemRBPath", "dataDir"], ["GUIScriptsPath", "scriptsDir"], ["PluginsPath", "pluginsDir"]]) {
    const value = settings[setting];
    if (value) {
      if (!path.isAbsolute(value) || !fs.statSync(value).isDirectory()) throw new Error(`${key} must be an existing absolute directory.`);
      config[key] = value;
    }
  }
  const bundledScriptsRoot = settings.scriptsDir || detected.moduleData.bundledScriptsRoot;
  if (bundledScriptsRoot && fs.existsSync(path.join(bundledScriptsRoot, "GUIScripts"))) {
    config.GUIScriptsPath = bundledScriptsRoot;
  }
  const configPath = path.join(directory, "GemRB.cfg");
  const text = Object.entries(config).map(([key, value]) => `${key}=${configValue(value)}`).join("\n") + "\n";
  let previous;
  try { previous = fs.readFileSync(configPath, "utf8"); } catch {}
  if (previous !== text) {
    const temp = path.join(directory, ".GemRB.cfg.tmp");
    fs.writeFileSync(temp, text);
    fs.renameSync(temp, configPath);
  }
  entry.defaultSaveDir = root;
  return { configPath, saveRoot, cacheRoot, directory, config, root };
}

const NearInfinity = require("./runtime/near-infinity-manager");
module.exports = { id: manifest.id, manifest, detectGame, runtimeManagers: [manager, NearInfinity],
  normalizeRuntimeId: () => "gemrb",
  resolveSaveLocations: entry => ({ primaryDirectory: entry.contentRootDir || entry.gamePath }),
  ensureRuntime: (entry, context) => {
    const root = entry.contentRootDir || entry.gamePath;
    const detected = detectGame({ inputPath: root, rootDir: root, stat: fs.statSync(root) });
    if (!detected) throw new Error("Infinity Engine game files are incomplete or invalid.");
    if (detected.moduleData.compatibility === "unsupported-format") throw new Error("This Infinity Engine GAME format is unsupported by the selected GemRB runtime.");
    const selection = manager.resolveSelection(entry, context.settings, context.userDataDir);
    if (selection.version === "0.9.5-cli-v1") throw new Error("GemRB CLI v1 can crash while loading scripts. Select Automatic in Runtime Settings to use the current Included runtime.");
    return selection.ready ? null : { managerId: "gemrb", version: selection.version, ...(selection.discoveryRequired ? { discoveryRequired: true } : {}), installOptions: {} };
  },
  onImport: entry => { entry.defaultSaveDir = entry.contentRootDir || entry.gamePath; },
  onRuntimeChange: entry => { entry.defaultSaveDir = entry.contentRootDir || entry.gamePath; },
  launchRuntime: async (runtimeId, entry, context) => {
    if (runtimeId !== "gemrb") return null;
    const selected = manager.resolveSelection(entry, context.settings, context.userDataDir);
    if (!selected.ready) throw new Error(selected.reason);
    const launch = prepareLaunch(entry, context, selected.install);
    context.onEntryChange?.(entry);
    const environment = GameIdentity.environment(entry, { ...process.env, ...resolveInstalledEnvironment(selected.install), PYTHONDONTWRITEBYTECODE: "1" });
    return NativeFocus.spawnForegroundNativeGame({ context, executablePath: selected.install.executablePath, args: ["-c", launch.configPath, ...(context.gameArguments || [])],
      options: { cwd: launch.root, env: environment }, needsRosetta: selected.install.needsRosetta });
  },
  cleanupGameData: (entry, context) => {
    fs.rmSync(moduleDirectory(entry, context), { recursive: true, force: true });
    return true;
  },
  settingsActions: {
    listRuntimeVersions: (_payload, context) => runtimeVersionChoices(manifest, manager, context)
  },
  actions: {
    listRuntimeVersions: (_entry, _payload, context) => runtimeVersionChoices(manifest, manager, context),
    openInspector: (entry, payload, context) => {
      const root = entry.contentRootDir || entry.gamePath;
      const key = fs.readdirSync(root).find(name => name.toLowerCase() === "chitin.key");
      if (!key || !fs.statSync(path.join(root, key)).isFile()) throw new Error("The Infinity Engine resource index was not found.");
      return NearInfinity.core.run(context, payload || {}, { gui: true, cwd: root,
        javaArgs: ["-Dapple.laf.useScreenMenuBar=true"], args: ["-no-update", "-no-launch-game", path.join(root, key)] });
    },
    runtimeStatus: (entry, _payload, context) => manager.resolveSelection(entry, context.settings, context.userDataDir),
    registerRuntime: (entry, payload, context) => {
      const installed = manager.core.registerLocal({ userDataDir: context.userDataDir,
        version: payload?.version || context.runtimeSettings?.version || manager.resolveSelection(entry, context.settings, context.userDataDir).version,
        runtimePath: payload?.runtimePath || context.runtimeSettings?.runtimePath });
      entry.runtimeData = { ...entry.runtimeData, gemrb: { ...entry.runtimeData?.gemrb, version: installed.version } };
      context.onRuntimeStateChange?.();
      return installed;
    },
    prepareConfig: (entry, _payload, context) => prepareLaunch(entry, context),
    inspectGame: entry => require("./inspect").inspectGame(entry.contentRootDir || entry.gamePath)
  },
  __test: { prepareLaunch, configValue }
};
