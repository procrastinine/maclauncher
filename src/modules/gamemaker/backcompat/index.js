// MacLauncher v0.5.1 GameMaker saves/classic writable layouts. Registry discovery
// composes this hook; the persisted one-time per-game data migration alone runs
// it. Remove after these released layouts are retired and retained diagnostics
// are explicitly resolved. Current import/preparation/Play never calls this file.
const path = require("node:path");
const fs = require("node:fs");
const GameData = require("../../shared/game-data");
const GameMaker = require("../main");
const { applySaveIdentity } = require("../../../core/save-identity");
const LaunchArguments = require("../../shared/runtime/launch-arguments");

function legacyGameMirrors(entry, context) {
  const { userDataDir } = context;
  const original = entry.moduleData?.dataPath;
  if (!path.isAbsolute(original || "") || !path.isAbsolute(userDataDir || "") || !/^[A-Za-z0-9_-]{1,128}$/.test(entry.gameId || "")) return [];
  const root = GameData.resolveGameModuleDir(userDataDir, entry.gameId, "gamemaker");
  // This hook is called only by the shared one-time migration. Normal Play
  // neither creates nor probes these obsolete roots.
  const override = typeof entry.saveDirOverride === "string" && entry.saveDirOverride ? path.resolve(entry.saveDirOverride) : null;
  const runtimeId = entry.runtimeId || (entry.moduleData?.executionKind === "classic" ? "opengmk" : "butterscotch");
  let explicit = Boolean(entry.saveDirOverride);
  try { explicit ||= LaunchArguments.parse(entry.launchArguments || "").some(arg => /^--?(?:save[-_a-z]*|working-directory|gamedir|gamefile)(?:=|$)/i.test(arg)); }
  catch { explicit = true; }
  let official = entry;
  // Only the released official save root warrants its host-identity lookup.
  // Do not apply a new identity until that descriptor's recovery succeeds.
  if (fs.existsSync(path.join(root, "official-saves"))) official = applySaveIdentity(entry, {
    games: context.games || [], context,
    describe: (current, ctx) => current.gameId === entry.gameId
      ? GameMaker.resolveSaveIdentity({ ...current, runtimeId: "official-studio" }, { ...ctx, runtimeId: "official-studio" })
      : context.describeSaveIdentity?.(current, ctx) || (["gamemaker"].includes(current.moduleId || current.engine) ? GameMaker.resolveSaveIdentity(current, ctx) : null)
  });
  return ["saves", "official-saves", "classic/writable"].map(relative => {
    const sourceRoot = override || (relative === "official-saves" ? official.runtimeData?.["official-studio"]?.saveDirOverride || null : path.dirname(original));
    const locations = GameMaker.resolveSaveLocations(relative === "official-saves" ? official : entry, { runtimeId });
    const entryPatch = relative === "official-saves"
      ? { ...(official.runtimeData ? { runtimeData: official.runtimeData } : {}), ...(runtimeId === "official-studio" ? { defaultSaveDir: locations.primaryDirectory, saveLocations: locations.directories } : {}) }
      : ["opengmk", "butterscotch"].includes(runtimeId) ? { defaultSaveDir: locations.primaryDirectory, saveLocations: locations.directories } : {};
    const gameDirectory = path.isAbsolute(entry.nativeAppPath || "") ? path.dirname(entry.nativeAppPath) : path.dirname(original);
    const mirrorRoot = path.join(root, relative);
    const supportedRoute = relative === "saves" && runtimeId === "butterscotch" || relative === "classic/writable" && runtimeId === "opengmk";
    const proven = supportedRoute && path.isAbsolute(entry.defaultSaveDir || "") && path.resolve(entry.defaultSaveDir) === mirrorRoot;
    return { mirrorRoot, sourceRoot, entryPatch,
      ...(proven ? { releasedSaveRoute: { directory: mirrorRoot, entryPatch: { saveDirOverride: mirrorRoot }, proven, explicit } } : {}),
      ...(sourceRoot && (override || relative === "official-saves") ? { createSourceWithin: sourceRoot.startsWith(gameDirectory + path.sep) ? gameDirectory : path.dirname(sourceRoot) } : {}) };
  })
    .filter(({ mirrorRoot }) => !override || !(override === mirrorRoot || override.startsWith(mirrorRoot + path.sep) || mirrorRoot.startsWith(override + path.sep)));
}


module.exports = { legacyGameMirrors };
