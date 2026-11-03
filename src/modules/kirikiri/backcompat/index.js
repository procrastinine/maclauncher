// App v0.5.1 stored loose-project and XP3/KAG saves in each game's
// modules/kirikiri/saves folder. The original-game-mirrors-v1 migration uses
// these recovery hooks once. Pending released routes become ordinary visible
// settings; no Play hook or recurring legacy probes are needed.
// Remove this module when upgrades from that released layout are unsupported.
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const GameData = require("../../shared/game-data");
const Kiri = require("../main");
const { applySaveIdentity } = require("../../../core/save-identity");
const { parse } = require("../../shared/runtime/launch-arguments");

function legacyGameMirrors(entry, context) {
  const { userDataDir } = context;
  if (!path.isAbsolute(userDataDir || "") || !/^[A-Za-z0-9_-]+$/.test(entry.gameId || "")) return [];
  const mirrorRoot = path.join(GameData.resolveGameModuleDir(userDataDir, entry.gameId, "kirikiri"), "saves");
  const override = typeof entry.saveDirOverride === "string" && path.isAbsolute(entry.saveDirOverride) ? path.resolve(entry.saveDirOverride) : null;
  try { fs.lstatSync(mirrorRoot); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    if (entry.defaultSaveDir === mirrorRoot) { entry.defaultSaveDir = null; entry.saveLocations = []; }
    return [];
  }
  // An explicitly selected folder remains active, even inside old launcher data.
  if (override && (override === mirrorRoot || override.startsWith(mirrorRoot + path.sep))) return [];
  Object.assign(entry, applySaveIdentity(entry, { games: context.games || [], describe: Kiri.resolveSaveIdentity, context }));
  const fact = Kiri.resolveSaveIdentity(entry, context);
  if (!fact?.directory) throw new Error("KiriKiri save location is dynamic or unavailable; released private saves were retained for manual resolution.");
  const sourceRoot = fact.directory;
  entry.defaultSaveDir = sourceRoot;
  entry.saveLocations = [{ directory: sourceRoot, label: "KiriKiri saves" }];
  let createSourceWithin = os.homedir();
  if (!sourceRoot.startsWith(createSourceWithin + path.sep)) {
    createSourceWithin = path.dirname(sourceRoot);
    for (;;) {
      try {
        const stat = fs.lstatSync(createSourceWithin);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Save recovery requires a plain existing destination ancestor.");
        break;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        const parent = path.dirname(createSourceWithin);
        if (parent === createSourceWithin) throw error;
        createSourceWithin = parent;
      }
    }
  }
  return [{ mirrorRoot, sourceRoot, createSourceWithin }];
}

function migrateLegacyGameData(entry, context) {
  const { userDataDir, games = [], ownerSuccessfulDescriptors = [] } = context;
  if (!path.isAbsolute(userDataDir || "") || !/^[A-Za-z0-9_-]+$/.test(entry.gameId || "")) return null;
  // The runner keeps the loaded record unchanged until persistence. Its exact
  // released default, rather than the presence of an arbitrary folder, proves
  // that this game used the launcher's forced datapath.
  const baseline = games.find(game => game.gameId === entry.gameId);
  const mirrorRoot = path.join(GameData.resolveGameModuleDir(userDataDir, entry.gameId, "kirikiri"), "saves");
  if (baseline?.defaultSaveDir !== mirrorRoot || ownerSuccessfulDescriptors.some(row =>
    typeof row.mirrorRoot === "string" && path.resolve(row.mirrorRoot) === mirrorRoot)) return null;
  if (baseline.saveDirOverride) return null;
  for (const game of [baseline, entry]) {
    let args;
    try {
      const local = game.runtimeSettings?.krkrsdl2?.args || [];
      const global = context.settings?.modules?.kirikiri?.runtimeSettings?.krkrsdl2?.args || [];
      if (!Array.isArray(local) || !Array.isArray(global)) return null;
      args = [...local, ...global, ...parse(game.launchArguments || "")];
    } catch { return null; }
    if (args.some(arg => typeof arg !== "string" || /^-datapath(?:=|$)/i.test(arg))) return null;
  }
  // A retained root must still be a plain directory through every ancestor.
  // Never turn a link, missing root or out-of-bounds game ID into a Play route.
  let current = path.parse(mirrorRoot).root;
  for (const part of mirrorRoot.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Pending KiriKiri saves require a plain existing directory.");
  }
  return { complete: true, entryPatch: { saveDirOverride: mirrorRoot } };
}

module.exports = { legacyGameMirrors, migrateLegacyGameData };
