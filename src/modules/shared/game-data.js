const crypto = require("node:crypto");
const path = require("node:path");

const GAMES_DIR_NAME = "games";

function createGameId() {
  return crypto.randomBytes(16).toString("hex");
}

function resolveGamesRoot(userDataDir) {
  return path.join(userDataDir, GAMES_DIR_NAME);
}

function resolveGameDir(userDataDir, gameId) {
  return path.join(resolveGamesRoot(userDataDir), String(gameId || ""));
}

function resolveGameDataPath(userDataDir, gameId) {
  return path.join(resolveGameDir(userDataDir, gameId), "game.json");
}

function resolveGameCheatsPath(userDataDir, gameId) {
  return path.join(resolveGameDir(userDataDir, gameId), "cheats.json");
}

function resolveGameIconsDir(userDataDir, gameId) {
  return path.join(resolveGameDir(userDataDir, gameId), "icons");
}

function resolveGameLogsDir(userDataDir, gameId) {
  return path.join(resolveGameDir(userDataDir, gameId), "logs");
}

function resolveGameModuleDir(userDataDir, gameId, moduleId) {
  return path.join(resolveGameDir(userDataDir, gameId), "modules", String(moduleId || ""));
}

function resolveGameRuntimeDir(userDataDir, gameId, runtimeId) {
  return path.join(resolveGameDir(userDataDir, gameId), "runtimes", String(runtimeId || ""));
}

function resolveGamePartitionDir(userDataDir, gameId) {
  return path.join(resolveGameDir(userDataDir, gameId), "partition");
}

module.exports = {
  GAMES_DIR_NAME,
  createGameId,
  resolveGamesRoot,
  resolveGameDir,
  resolveGameDataPath,
  resolveGameCheatsPath,
  resolveGameIconsDir,
  resolveGameLogsDir,
  resolveGameModuleDir,
  resolveGameRuntimeDir,
  resolveGamePartitionDir
};
