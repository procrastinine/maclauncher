const fs = require("node:fs");

const GameData = require("../../game-data");

function safeRm(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {}
}

function cleanupNwjsGameData({ userDataDir, gameId } = {}) {
  if (!userDataDir || !gameId) return false;
  safeRm(GameData.resolveGameRuntimeDir(userDataDir, gameId, "nwjs"));
  safeRm(GameData.resolveGameRuntimeDir(userDataDir, gameId, "nwjs-patched"));

  return true;
}

module.exports = {
  cleanupNwjsGameData
};
