// Compatibility for the private Prosper layout shipped in v0.5.1.
// Invoked only by the shared one-time migration for existing entries. Remove
// this module when migrations from that released layout are no longer supported.
const path = require("node:path");
const fs = require("node:fs");
const Writable = require("../../shared/backcompat/writable-input");
const { gameDirectory, resolveSaveLocations, acceptsOriginalExecutable } = require("../prepare");

function defaultConfigPath(entry, environment = process.env) {
  const config = environment.XDG_CONFIG_HOME || (environment.HOME && path.join(environment.HOME, ".config"));
  if (!/^[\w-]+$/.test(entry?.gameId || "") || !path.isAbsolute(config || ""))
    throw new Error("Prosper configuration requires a saved game and an absolute user configuration directory.");
  return path.join(config, "prosper", "games", entry.gameId, "prosper-app.conf");
}
function contains(root, file) {
  const relative = path.relative(root, file);
  return !relative || relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
}
function legacyGameMirrors(entry, context) {
  const original = Writable.sourceRoot(entry);
  const baseline = context.games?.find(game => game.gameId === entry.gameId) || entry;
  const explicit = Boolean(baseline.saveDirOverride || baseline.runtimeData?.prosper?.saveDirOverride ||
    context.runtimeSettings?.configPath || baseline.runtimeSettings?.prosper?.configPath ||
    process.env.PROSPER_SAVE0 || process.env.PROSPER_SAVEDATA_DIR || process.env.PROSPER_APP_CONFIG);
  const root = gameDirectory(entry, context), configRoot = path.join(root, "home", ".config", "prosper");
  let hasPrivateConfig = false;
  try { hasPrivateConfig = fs.lstatSync(path.join(configRoot, "prosper-app.conf")).isFile(); }
  catch (error) { if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error; }
  const releasedSaveRoute = { directory: configRoot,
    entryPatch: { runtimeSettings: { prosper: { configPath: path.join(configRoot, "prosper-app.conf") } } },
    proven: hasPrivateConfig && (baseline.moduleId === "anyps5" || baseline.gameType === "ps5") && baseline.moduleData?.inspectionOnly !== true && ["elf", "self"].includes(baseline.moduleData?.format), explicit };
  if (!path.isAbsolute(original || "")) return hasPrivateConfig ? [{ mirrorRoot: configRoot, sourceRoot: null, releasedSaveRoute }] : [];
  const override = (entry.runtimeId === "prosper" && entry.saveDirOverride) || entry.runtimeData?.prosper?.saveDirOverride || null;
  const roots = resolveSaveLocations({ ...entry, saveDirOverride: override }, context).directories.map(row => row.directory), descriptors = [];
  const data = process.env.XDG_DATA_HOME || (process.env.HOME && path.join(process.env.HOME, ".local", "share"));
  const creation = (anchor, target) => path.isAbsolute(anchor || "") && contains(anchor, target) && path.resolve(anchor) !== path.resolve(target)
    ? { createSourceWithin: anchor } : {};
  if (entry.moduleData?.inputLayout !== "anyps5-prepared" && acceptsOriginalExecutable(entry.moduleData?.executablePath))
    descriptors.push({ mirrorRoot: path.join(root, "app0"), sourceRoot: original });
  for (const [index, name] of ["savedata0", "memory"].entries())
    if (path.isAbsolute(roots[index])) descriptors.push({ mirrorRoot: path.join(root, "saves", name), sourceRoot: roots[index], ...creation(data, roots[index]) });
  const config = process.env.XDG_CONFIG_HOME || (process.env.HOME && path.join(process.env.HOME, ".config"));
  const configPath = context.runtimeSettings?.configPath || entry.runtimeSettings?.prosper?.configPath || process.env.PROSPER_APP_CONFIG ||
    (path.isAbsolute(config || "") ? defaultConfigPath(entry) : null);
  if (!process.env.PROSPER_APP_CONFIG && (!configPath || path.basename(configPath) === "prosper-app.conf")) {
    const mirrorRoot = configRoot;
    const sourceRoot = configPath ? path.dirname(configPath) : null, entryPatch = { runtimeSettings: { ...entry.runtimeSettings,
      prosper: { ...entry.runtimeSettings?.prosper, configPath } } };
    descriptors.push({ mirrorRoot, sourceRoot, ...(sourceRoot ? creation(config, sourceRoot) : {}),
      ...(hasPrivateConfig ? { ...(sourceRoot ? { entryPatch } : {}), releasedSaveRoute } : {}) });
  }
  const temporary = fs.realpathSync("/tmp");
  const tempRoot = process.env.PROSPER_TEMP0 ? path.resolve(original, process.env.PROSPER_TEMP0) : path.join(temporary, "prosper-temp0");
  descriptors.push({ mirrorRoot: path.join(root, "tmp"), sourceRoot: tempRoot, ...creation(temporary, tempRoot) });
  if (!entry.saveDirOverride)
    descriptors.push({ mirrorRoot: path.join(root, "saves", "download0"),
      sourceRoot: process.env.PROSPER_DOWNLOAD0 ? path.resolve(original, process.env.PROSPER_DOWNLOAD0) : path.join(temporary, "prosper-download0"),
      ...(!process.env.PROSPER_DOWNLOAD0 ? { createSourceWithin: temporary } : {}) });
  const captures = path.resolve(original, process.env.PROSPER_CAPTURE_DIR || ".");
  descriptors.push({ mirrorRoot: path.join(root, "captures"), sourceRoot: captures, ...creation(original, captures) });
  return descriptors.filter(({ mirrorRoot, sourceRoot }) => (sourceRoot === null || !contains(mirrorRoot, sourceRoot) && !contains(sourceRoot, mirrorRoot)) &&
    !(entry.saveDirOverride && (contains(mirrorRoot, entry.saveDirOverride) || contains(entry.saveDirOverride, mirrorRoot))));
}

module.exports = { legacyGameMirrors };
