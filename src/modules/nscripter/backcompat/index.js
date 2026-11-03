// Backcompat: MacLauncher 0.5.1 native NScripter module saves/config and schema-1 views.
// Runs only in the persisted one-time existing-game migration, never import/Play.
// Delete when upgrades from these released layouts are no longer supported.
const os = require("node:os");
const path = require("node:path");
const GameData = require("../../shared/game-data");
const Writable = require("../../shared/backcompat/writable-input");
const LaunchArguments = require("../../shared/runtime/launch-arguments");

function nativeSaveRoot(entry) {
  const args = LaunchArguments.parse(entry.launchArguments || "");
  let identifier, explicitSave, hasIdentifier = false;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--gameid") { hasIdentifier = true; identifier = args[++index]; }
    else if (args[index].startsWith("--gameid=")) { hasIdentifier = true; identifier = args[index].slice(9); }
    else if (["--save", "-s"].includes(args[index])) explicitSave = args[++index];
  }
  if (!hasIdentifier) {
    identifier = entry.gameId;
    // The upstream parser accepts two tokens, not --gameid=id.
    entry.launchArguments = (entry.launchArguments ? entry.launchArguments + " " : "") + "--gameid " + identifier;
    LaunchArguments.parse(entry.launchArguments);
  }
  if (explicitSave) {
    if (!path.isAbsolute(explicitSave)) throw new Error("The authored EN save argument has no absolute recovery destination.");
    return explicitSave;
  }
  if (!identifier || identifier === "." || identifier === ".." || /[\\/\0]/.test(identifier))
    throw new Error("The authored EN game identifier has no contained native save destination.");
  return entry.saveDirOverride || path.join(os.homedir(), "Library", "Application Support", identifier);
}

function legacyGameMirrors(entry, context) {
  const { userDataDir } = context;
  const sourceRoot = Writable.sourceRoot(entry);
  if (!path.isAbsolute(userDataDir || "") || !/^[A-Za-z0-9_-]{1,128}$/.test(entry.gameId || "")) return [];
  const root = GameData.resolveGameModuleDir(userDataDir, entry.gameId, "nscripter");
  const privateSaves = path.join(root, "saves");
  const baseline = context.games?.find(game => game.gameId === entry.gameId) || entry;
  let explicit = Boolean(baseline.saveDirOverride);
  try {
    explicit ||= LaunchArguments.parse(baseline.launchArguments || "").some(arg =>
      /^--(?:save(?:-dir)?|gameid)(?:=|$)/.test(arg) || arg === "-s");
  } catch { explicit = true; }
  const releasedSaveRoute = {
    directory: privateSaves, entryPatch: { saveDirOverride: privateSaves },
    proven: ["onsyuri_mac", "onscripter_en"].includes(baseline.runtimeId) && baseline.defaultSaveDir === privateSaves,
    explicit
  };
  const pending = () => [{ mirrorRoot: privateSaves, sourceRoot: null, releasedSaveRoute }];
  if (!path.isAbsolute(sourceRoot || "")) return releasedSaveRoute.proven ? pending() : [];
  let saveRoot = entry.saveDirOverride || sourceRoot;
  let entryPatch;
  // Released EN supplied a launcher game identity. Persist it once as ordinary
  // authored argument text; current Play needs no compatibility reader.
  if (entry.runtimeId === "onscripter_en") {
    const next = { ...entry };
    try { saveRoot = nativeSaveRoot(next); }
    catch { return pending(); }
    entryPatch = { launchArguments: next.launchArguments || "" };
  }
  entryPatch = { ...entryPatch, defaultSaveDir: saveRoot,
    saveLocations: [{ directory: saveRoot, label: "Saves", source: "Native interpreter" }] };
  const standardParent = path.join(os.homedir(), "Library", "Application Support");
  const relative = path.relative(standardParent, saveRoot);
  const createSourceWithin = relative && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative)
    ? standardParent : null;
  const overlaps = mirror => typeof entry.saveDirOverride === "string" && path.isAbsolute(entry.saveDirOverride) &&
    [path.relative(mirror, entry.saveDirOverride), path.relative(entry.saveDirOverride, mirror)]
      .some(relative => relative === "" || relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
  return [
    { mirrorRoot: privateSaves, sourceRoot: saveRoot, entryPatch, releasedSaveRoute,
      ...(createSourceWithin ? { createSourceWithin } : {}) },
    ...["yuri", "onscripter-en"].map(name => ({ mirrorRoot: path.join(root, name), sourceRoot })),
    ...(entry.moduleData?.writableInput?.schemaVersion === 1 ? Writable.legacyGameMirrors(entry, { userDataDir }) : [])
  ].filter(row => !overlaps(row.mirrorRoot));
}

module.exports = { legacyGameMirrors };
