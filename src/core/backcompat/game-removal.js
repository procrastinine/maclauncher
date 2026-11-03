// Released private-game mirrors (0.5.1): recovery runs once. This module reads
// only its persisted diagnostics on explicit removal, never during Play or
// upkeep. Delete after the supported releases can no longer leave these roots.
const path = require("node:path");
const GameData = require("../../modules/shared/game-data");

function retainedGameDataRemoval(entry, settings, userDataDir) {
  const ids = new Set([entry.gameId, entry.id, entry.gamePath].filter(Boolean));
  const gameRoot = GameData.resolveGameDir(userDataDir, entry.gameId), retained = [];
  const overlaps = root => {
    if (typeof root !== "string" || !path.isAbsolute(root)) return true;
    const directory = path.resolve(root);
    return directory === gameRoot || directory.startsWith(gameRoot + path.sep) || gameRoot.startsWith(directory + path.sep);
  };
  for (const state of Object.values(settings?.dataMigrations || {})) {
    for (const item of state?.retained || []) {
      if (!ids.has(item?.id)) continue;
      const failures = Array.isArray(item.failures) && item.failures.length ? item.failures : [{ reason: "Recovery did not finish." }];
      for (const failure of failures) if (overlaps(failure?.mirrorRoot)) retained.push({
        mirrorRoot: typeof failure?.mirrorRoot === "string" && path.isAbsolute(failure.mirrorRoot) ? path.resolve(failure.mirrorRoot) : null,
        reason: String(failure?.reason || "Recovery did not finish.")
      });
    }
  }
  return retained.length ? { gameId: entry.gameId, retained } : null;
}

function assertRetainedGameDataRemoval(entry, settings, userDataDir, acknowledgment) {
  const required = retainedGameDataRemoval(entry, settings, userDataDir);
  if (required && JSON.stringify(acknowledgment) !== JSON.stringify(required))
    throw Object.assign(new Error("Some game files were retained after recovery could not finish. Preserve or recover those files, or explicitly confirm their removal."),
      { code: "GAME_DATA_RETAINED" });
}

module.exports = { retainedGameDataRemoval, assertRetainedGameDataRemoval };
