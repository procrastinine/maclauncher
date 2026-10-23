const GameStore = require("./game-store");
const Cleanup = require("./game-data-cleanup");
const fs = require("node:fs");
const GameData = require("../modules/shared/game-data");

function inUseError() {
  return Object.assign(new Error("Stop the game or wait for its current action to finish."), { code: "GAME_IN_USE" });
}

function createGameRemoval({ userDataDir, registry, lifecycle, listRuntimeManagers, isGameRunning = () => false, logger = console, trashItem, readSettings = () => ({}), resolveModuleId = entry => entry.moduleId || entry.engine || "unknown" }) {
  return async function removeGameData(entry, { trash = false, ignoreMissingSource = false } = {}) {
    if (!entry?.gameId || !entry.gamePath) throw new Error("Game removal requires a persisted library entry.");
    return lifecycle.remove(entry, async () => {
      // Resolve module paths after acquiring exclusive ownership.
      const current = GameStore.readGameRecord(userDataDir, entry.gameId);
      if (!current) throw Object.assign(new Error("Game not found in library."), { code: "GAME_NOT_FOUND" });
      const assertAvailable = () => { if (isGameRunning(current)) throw inUseError(); };
      assertAvailable();
      if (trash) {
        if (typeof trashItem !== "function") throw new Error("A Trash service is required to remove original game files.");
        let missing = false;
        if (ignoreMissingSource) {
          try { fs.statSync(current.gamePath); }
          catch (error) { if (["ENOENT", "ENOTDIR"].includes(error.code)) missing = true; else throw error; }
        }
        if (!missing) await trashItem(current.gamePath);
      }
      assertAvailable();
      const moduleId = resolveModuleId(current);
      const context = { entry: current, gamePath: current.gamePath, gameId: current.gameId, moduleId, userDataDir, logger, settings: readSettings() };
      for (const manager of listRuntimeManagers()) {
        if (typeof manager?.cleanupGameData !== "function") continue;
        try { await manager.cleanupGameData(context); }
        catch (error) {
          logger.warn?.(`[cleanup] runtime ${manager.id}`, error.message);
          throw new Error("Game data could not be removed. The library entry was kept so removal can be retried.", { cause: error });
        }
      }
      const mod = registry.getModule(moduleId);
      if (typeof mod?.cleanupGameData === "function") {
        try { await mod.cleanupGameData(current, context); }
        catch (error) {
          logger.warn?.(`[cleanup] module ${moduleId}`, error.message);
          throw new Error("Game data could not be removed. The library entry was kept so removal can be retried.", { cause: error });
        }
      }
      assertAvailable();
      Cleanup.cleanupLauncherGameData({ userDataDir, gameId: current.gameId });
      if (fs.existsSync(GameData.resolveGameDir(userDataDir, current.gameId))) throw new Error("Game data could not be removed. Check its folder permissions and try again.");
      return { gameId: current.gameId, gamePath: current.gamePath, originalTrashed: trash };
    });
  };
}

module.exports = { createGameRemoval, inUseError };
