const fs = require("node:fs");
const path = require("node:path");
const NativeFocus = require("../shared/runtime/native-focus");
const manifest = require("./manifest.json");
const { detectGame } = require("./detect");
const manager = require("./runtime/manager");
const GameData = require("../shared/game-data");
const { resolveInstalledEnvironment } = require("../shared/runtime/bundled-native");
const Native = require("../shared/runtime/local-native");
const RESOURCE_FILE = /\.(?:bif|biff|key|tlk|bam|tis|mos|wed|are|cre|itm|spl|wav|ogg|wmp|dlg|pro|vvc|eff|2da|ids|gam|bcs|bs|png|bmp|jpg|jpeg|gif|webp|pvrz|fnt|ttf|otf|mp3|flac|mve|webm|mp4)$/i;

function moduleDirectory(entry, context) {
  if (!entry.gameId || !context.userDataDir || !/^[A-Za-z0-9_-]+$/.test(entry.gameId)) throw new Error("GemRB requires a persisted game id and launcher data directory.");
  return GameData.resolveGameModuleDir(context.userDataDir, entry.gameId, manifest.id);
}
function configValue(value) {
  const text = String(value);
  if (/[\r\n\0]/.test(text)) throw new Error("GemRB configuration paths must not contain newlines or NUL bytes.");
  return text;
}
function stageGameAssets(source, destination, depth = 0) {
  if (depth > 32) throw new Error("Infinity Engine game directories are too deeply nested.");
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || /^(save|mpsave|cache)$/i.test(entry.name)) continue;
    const from = path.join(source, entry.name), to = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      if (path.resolve(destination).startsWith(path.resolve(from) + path.sep)) continue;
      stageGameAssets(from, to, depth + 1);
    }
    else if (entry.isFile()) {
      // Alias only known engine resources. Native mods write logs/path files and
      // settings outside SavePath, so unknown sidecars remain private copies.
      if (RESOURCE_FILE.test(entry.name)) fs.symlinkSync(from, to);
      else fs.copyFileSync(from, to);
    }
  }
}
function resolveStagedGameRoot(entry, directory) {
  const source = entry.contentRootDir || entry.gamePath, wrapper = path.join(directory, "game");
  const marker = path.join(directory, "game-root.json");
  let record;
  try { record = JSON.parse(fs.readFileSync(marker, "utf8")); } catch {}
  if (!record || record.source !== source || !fs.existsSync(wrapper)) {
    fs.mkdirSync(directory, { recursive: true });
    const temporary = fs.mkdtempSync(path.join(directory, ".game-"));
    try {
      stageGameAssets(source, temporary);
      fs.rmSync(wrapper, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      fs.renameSync(temporary, wrapper);
      fs.writeFileSync(marker, JSON.stringify({ layoutVersion: 4, source }));
    } finally { fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  }
  else if (record.layoutVersion !== 4) {
    // Upgrade only untouched resource copies. Keep logs, configuration edits,
    // extra player files and managed saves in place when shrinking an overlay.
    function aliasUnchangedResources(fromDir, toDir, depth = 0) {
      if (depth > 32) throw new Error("Infinity Engine game directories are too deeply nested.");
      for (const entry of fs.readdirSync(fromDir, { withFileTypes: true })) {
        const from = path.join(fromDir, entry.name), to = path.join(toDir, entry.name);
        if (entry.isDirectory() && fs.existsSync(to) && fs.lstatSync(to).isDirectory()) aliasUnchangedResources(from, to, depth + 1);
        else if (entry.isFile() && RESOURCE_FILE.test(entry.name) && fs.existsSync(to) && fs.lstatSync(to).isFile() && Native.hashFile(from) === Native.hashFile(to)) {
          fs.rmSync(to); fs.symlinkSync(from, to);
        }
      }
    }
    aliasUnchangedResources(source, wrapper);
    fs.writeFileSync(marker, JSON.stringify({ layoutVersion: 4, source }));
  }
  return wrapper;
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
  const saveRoot = entry.saveDirOverride || path.join(directory, "saves");
  if (!path.isAbsolute(saveRoot)) throw new Error("GemRB save location must be absolute.");
  const cacheRoot = path.join(directory, "cache");
  fs.mkdirSync(saveRoot, { recursive: true });
  fs.mkdirSync(cacheRoot, { recursive: true });
  const stagedRoot = resolveStagedGameRoot(entry, directory);
  const config = { GamePath: stagedRoot, GameType: gameType, SavePath: saveRoot, CachePath: cacheRoot,
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
    const scriptsRoot = path.join(directory, "scripts"), source = path.join(bundledScriptsRoot, "GUIScripts");
    const marker = path.join(directory, "scripts-source.json");
    let prior; try { prior = JSON.parse(fs.readFileSync(marker, "utf8")); } catch {}
    if (!prior || prior.source !== source || !fs.existsSync(path.join(scriptsRoot, "GUIScripts"))) {
      fs.mkdirSync(scriptsRoot, { recursive: true });
      // Python scripts can write nearby state. Keep only this small script tree
      // private, while large game resources use the resource overlay.
      copyScripts(source, path.join(scriptsRoot, "GUIScripts"));
      fs.writeFileSync(marker, JSON.stringify({ source }));
    }
    config.GUIScriptsPath = scriptsRoot;
  }
  const configPath = path.join(directory, "GemRB.cfg");
  const text = Object.entries(config).map(([key, value]) => `${key}=${configValue(value)}`).join("\n") + "\n";
  const temp = path.join(directory, ".GemRB.cfg.tmp");
  fs.writeFileSync(temp, text);
  fs.renameSync(temp, configPath);
  entry.defaultSaveDir = saveRoot;
  return { configPath, saveRoot, cacheRoot, directory, config, stagedRoot };
}

function copyScripts(source, destination, depth = 0) {
  if (depth > 16) throw new Error("GemRB GUI script directory is too deeply nested.");
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "__pycache__") continue;
    const from = path.join(source, entry.name), to = path.join(destination, entry.name);
    if (entry.isDirectory()) copyScripts(from, to, depth + 1);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

const NearInfinity = require("./runtime/near-infinity-manager");
module.exports = { id: manifest.id, manifest, detectGame, runtimeManagers: [manager, NearInfinity],
  normalizeRuntimeId: () => "gemrb",
  ensureRuntime: (entry, context) => {
    const root = entry.contentRootDir || entry.gamePath;
    const detected = detectGame({ inputPath: root, rootDir: root, stat: fs.statSync(root) });
    if (!detected) throw new Error("Infinity Engine game files are incomplete or invalid.");
    if (detected.moduleData.compatibility === "unsupported-format") throw new Error("This Infinity Engine GAME format is unsupported by the selected GemRB runtime.");
    const selection = manager.resolveSelection(entry, context.settings, context.userDataDir);
    if (selection.version === "0.9.5-cli-v1") throw new Error("GemRB CLI v1 can crash while loading scripts. Select Automatic in Runtime Settings to use the current Included runtime.");
    return selection.ready ? null : { managerId: "gemrb", version: selection.version, installOptions: {} };
  },
  onImport: (entry, context) => { entry.defaultSaveDir = path.join(moduleDirectory(entry, context), "saves"); },
  launchRuntime: async (runtimeId, entry, context) => {
    if (runtimeId !== "gemrb") return null;
    const selected = manager.resolveSelection(entry, context.settings, context.userDataDir);
    if (!selected.ready) throw new Error(selected.reason);
    const launch = prepareLaunch(entry, context, selected.install);
    context.onEntryChange?.(entry);
    const environment = { ...process.env, ...resolveInstalledEnvironment(selected.install), PYTHONDONTWRITEBYTECODE: "1" };
    return NativeFocus.spawnForegroundNativeGame({ context, executablePath: selected.install.executablePath, args: ["-c", launch.configPath],
      options: { cwd: launch.directory, env: environment }, needsRosetta: selected.install.needsRosetta });
  },
  cleanupGameData: (entry, context) => {
    fs.rmSync(moduleDirectory(entry, context), { recursive: true, force: true });
    return true;
  },
  actions: {
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
    inspectGame: entry => require("./inspect").inspectGame(entry.contentRootDir || entry.gamePath),
    buildRuntime: async (entry, payload, context) => {
      const installed = await require("./runtime/build").buildRuntime({
        userDataDir: context.userDataDir, sourcePath: payload?.sourcePath || context.runtimeSettings?.sourcePath, logger: context.logger });
      entry.runtimeData = { ...entry.runtimeData, gemrb: { ...entry.runtimeData?.gemrb, version: installed.version } };
      context.onRuntimeStateChange?.();
      return installed;
    }
  },
  __test: { prepareLaunch, configValue, stageGameAssets }
};
