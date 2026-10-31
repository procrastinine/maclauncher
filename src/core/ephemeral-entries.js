const fs = require("node:fs");
const path = require("node:path");
const GameData = require("../modules/shared/game-data");

// An ephemeral library entry exists only while its session runs, such as a
// window that receives graphics. Its game directory holds the record, the
// prepared graphics plan and live controls like any other entry, plus this
// marker. The directory is deleted when the session ends, and a directory
// left by a crash is deleted at the next start, so nothing accumulates.
const MARKER = "ephemeral";

function markerPath(userDataDir, gameId) {
  return path.join(GameData.resolveGameDir(userDataDir, gameId), MARKER);
}

function mark(userDataDir, gameId) {
  const file = markerPath(userDataDir, gameId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "", { flag: "w", mode: 0o600 });
  return file;
}

function isEphemeral(userDataDir, entry) {
  if (!entry?.gameId || !/^[0-9A-Za-z_-]+$/.test(entry.gameId)) return false;
  try { return fs.lstatSync(markerPath(userDataDir, entry.gameId)).isFile(); } catch { return false; }
}

// Deletes one marked entry's directory and the prepared graphics rows of its
// plan. An unmarked directory is never touched.
function remove(userDataDir, gameId) {
  if (!isEphemeral(userDataDir, { gameId })) return false;
  const directory = GameData.resolveGameDir(userDataDir, gameId);
  try { require("../modules/shared/effects/prepared-rows").forget(directory); } catch {}
  fs.rmSync(directory, { recursive: true, force: true });
  return true;
}

// Startup sweep: every marked directory belongs to a session that ended with
// the previous launcher process.
function sweep(userDataDir, { keep = () => false } = {}) {
  const root = GameData.resolveGamesRoot(userDataDir), removed = [];
  let names = [];
  try { names = fs.readdirSync(root); } catch { return removed; }
  for (const gameId of names) {
    if (!/^[0-9A-Za-z_-]+$/.test(gameId) || keep(gameId)) continue;
    try { if (remove(userDataDir, gameId)) removed.push(gameId); } catch {}
  }
  return removed;
}

module.exports = { MARKER, mark, isEphemeral, remove, sweep };
