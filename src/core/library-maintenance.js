const fs = require("node:fs");

function selectLibraryEntries(games, gamePaths) {
  if (!Array.isArray(gamePaths) || gamePaths.some(value => typeof value !== "string")) {
    throw new Error("Expected a list of game paths.");
  }
  const byPath = new Map(games.map(game => [game.gamePath, game]));
  const paths = [...new Set(gamePaths)];
  for (const gamePath of paths) if (!byPath.has(gamePath)) throw new Error("Game not found in library: " + gamePath);
  return paths.map(gamePath => byPath.get(gamePath));
}

function isMissingGamePath(gamePath, stat = fs.statSync) {
  try { stat(gamePath); return false; }
  catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return true;
    throw error;
  }
}

function findMissingGames(games, gamePaths, stat = fs.statSync) {
  return selectLibraryEntries(games, gamePaths).filter(game => isMissingGamePath(game.gamePath, stat)).map(game => game.gamePath);
}

async function trashLibraryGames(entries, trashItem, stat = fs.statSync) {
  const removedPaths = [], failures = [];
  for (const entry of entries) {
    try {
      if (!isMissingGamePath(entry.gamePath, stat)) await trashItem(entry.gamePath);
      removedPaths.push(entry.gamePath);
    } catch (error) {
      failures.push({ gamePath: entry.gamePath, error: String(error?.message || error) });
    }
  }
  return { removedPaths, failures };
}

module.exports = { selectLibraryEntries, findMissingGames, trashLibraryGames };
