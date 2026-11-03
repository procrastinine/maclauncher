// Backcompat: MacLauncher v0.5.1 EasyRPG private saves/config and writable-input.
// Runs only in the persisted once-per-game migration, never import/Play/upkeep.
// Remove when profiles containing these released layouts are no longer supported.
const fs = require("node:fs");
const path = require("node:path");
const GameData = require("../../shared/game-data");
const Writable = require("../../shared/backcompat/writable-input");
const Arguments = require("../../shared/runtime/launch-arguments");
const manifest = require("../manifest.json");

// Only a verified released private config.ini needs a visible path override.
// The plain-data patch is committed by the runner only after recovery succeeds.
function privateConfigPatch(entry, context, root) {
  const gameArgs = Arguments.parse(entry.launchArguments || "");
  let appArgs = entry.runtimeSettings?.easyrpg?.appArgs || context.runtimeSettings?.appArgs;
  if (!Array.isArray(appArgs)) {
    const Settings = require("../../../core/runtime-settings");
    const resolved = context.userDataDir
      ? Settings.createRuntimeSettingsStore({ userDataDir: context.userDataDir }).resolveForEntry(entry, context.settings, manifest, "easyrpg")
      : Settings.resolveRuntimeSettingsForEntry(entry, context.settings, manifest, "easyrpg");
    appArgs = resolved?.appArgs || [];
  }
  if ([...gameArgs, ...appArgs].some(value => /^(?:--config-path(?:=|$)|-c(?:=|$))/.test(value))) return null;
  return { runtimeSettings: { easyrpg: { appArgs: [...appArgs, "--config-path", root] } } };
}

function roots(entry, { userDataDir }) {
  if (!/^[A-Za-z0-9_-]+$/.test(entry.gameId || "") || !path.isAbsolute(userDataDir || ""))
    throw new Error("EasyRPG backcompat requires a saved game and absolute profile folder.");
  const original = Writable.sourceEntry(entry), sourceRoot = original.contentRootDir || original.gamePath;
  if (!path.isAbsolute(sourceRoot || "")) throw new Error("The released EasyRPG project folder is unavailable.");
  return { directory: GameData.resolveGameModuleDir(userDataDir, entry.gameId, "easyrpg"), sourceRoot, original };
}

function legacyGameMirrors(entry, context) {
  const { directory, sourceRoot } = roots(entry, context);
  const override = path.isAbsolute(entry.saveDirOverride || "") ? path.resolve(entry.saveDirOverride) : null;
  const contains = (parent, child) => {
    const relative = path.relative(parent, child);
    return relative === "" || relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
  };
  const config = path.join(directory, "config");
  let configSource = sourceRoot;
  let hasPrivateConfig = false;
  // An absolute path into the retired configuration tree is an authored
  // dependency. Do not remove its backing files or silently rewrite the INI.
  for (const name of ["config.ini", "config_sdl1.ini"]) {
    const file = path.join(config, name);
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024 || fs.readFileSync(file, "utf8").includes(directory)) configSource = null;
      else if (name === "config.ini") hasPrivateConfig = true;
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  if (!hasPrivateConfig && configSource !== null) {
    let directory;
    try {
      directory = fs.opendirSync(config);
      if (directory.readSync()) configSource = null;
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    finally { directory?.closeSync(); }
  }
  const entryPatch = hasPrivateConfig && configSource !== null ? privateConfigPatch(entry, context, sourceRoot) : null;
  return [
    ...Writable.legacyGameMirrors(entry, context),
    { mirrorRoot: path.join(directory, "saves"), sourceRoot },
    { mirrorRoot: config, sourceRoot: configSource, ...(entryPatch ? { entryPatch } : {}) }
  ].filter(({ mirrorRoot }) => !override || !contains(mirrorRoot, override) && !contains(override, mirrorRoot));
}

module.exports = { legacyGameMirrors };
