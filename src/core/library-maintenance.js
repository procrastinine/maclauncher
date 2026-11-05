const fs = require("node:fs");
const GameAvailability = require("./game-availability");

function selectLibraryEntries(games, gamePaths) {
  if (!Array.isArray(gamePaths) || gamePaths.some(value => typeof value !== "string")) {
    throw new Error("Expected a list of game paths.");
  }
  const byPath = new Map(games.map(game => [game.gamePath, game]));
  const paths = [...new Set(gamePaths)];
  for (const gamePath of paths) if (!byPath.has(gamePath)) throw new Error("Game not found in library: " + gamePath);
  return paths.map(gamePath => byPath.get(gamePath));
}

// Files on a disconnected drive count as missing; unreadable files do not.
function isMissingGamePath(gamePath, stat = fs.statSync) {
  const availability = GameAvailability.checkGameAvailabilitySync({ gamePath }, { statSync: stat });
  if (availability.reason === "missing") return true;
  if (!availability.available) throw GameAvailability.unavailableError(availability);
  return false;
}

// Games whose files are not found, including those on a disconnected drive,
// from shared availability results in entry order. Unreadable or unresponsive
// files are unavailable but not missing.
function missingGamePaths(entries, results) {
  return entries.filter((entry, index) => results[index]?.reason === "missing").map(entry => entry.gamePath);
}

async function trashLibraryGames(entries, trashItem, stat = fs.statSync) {
  const removedPaths = [], failures = [];
  for (const entry of entries) {
    try {
      require("../modules/shared/writable-input").assertPreservesExternalEnvironments(entry, entry.gamePath);
      if (!isMissingGamePath(entry.gamePath, stat)) await trashItem(entry.gamePath);
      removedPaths.push(entry.gamePath);
    } catch (error) {
      failures.push({ gamePath: entry.gamePath, error: String(error?.message || error) });
    }
  }
  return { removedPaths, failures };
}

module.exports = { selectLibraryEntries, missingGamePaths, trashLibraryGames };
