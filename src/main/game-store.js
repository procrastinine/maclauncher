const fs = require("node:fs");
const path = require("node:path");

const GameData = require("../modules/shared/game-data");

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function readJsonFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function listGameIds(userDataDir) {
  const root = GameData.resolveGamesRoot(userDataDir);
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter(entry => entry.isDirectory()).map(entry => entry.name);
}

function readGameRecord(userDataDir, gameId) {
  if (!gameId) return null;
  const infoPath = GameData.resolveGameDataPath(userDataDir, gameId);
  const record = readJsonFile(infoPath);
  if (!record) return null;
  record.gameId = String(gameId);
  return record;
}

function loadGames(userDataDir) {
  const out = [];
  const ids = listGameIds(userDataDir);
  for (const gameId of ids) {
    const record = readGameRecord(userDataDir, gameId);
    if (!record) continue;
    out.push(record);
  }
  return out;
}

function writeGameRecord(userDataDir, record) {
  if (!record || typeof record !== "object") throw new Error("Missing game record.");
  const gameId = record.gameId;
  if (!gameId) throw new Error("Missing gameId for game record.");
  const dir = GameData.resolveGameDir(userDataDir, gameId);
  ensureDir(dir);
  const infoPath = GameData.resolveGameDataPath(userDataDir, gameId);
  const payload = { ...record, gameId: String(gameId) };
  fs.writeFileSync(infoPath, JSON.stringify(payload, null, 2), "utf8");
  return infoPath;
}

function deleteGameData(userDataDir, gameId) {
  if (!gameId) return false;
  const dir = GameData.resolveGameDir(userDataDir, gameId);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  listGameIds,
  readGameRecord,
  loadGames,
  writeGameRecord,
  deleteGameData
};
