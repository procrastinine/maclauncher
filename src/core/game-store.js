const fs = require("node:fs");
const path = require("node:path");

const GameData = require("../modules/shared/game-data");
const { readJsonObject, writeJsonAtomic } = require("./json-files");

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function readJsonFile(filePath) {
  return readJsonObject(filePath);
}

function validateGameId(gameId) {
  if (typeof gameId !== "string" || !/^[0-9A-Za-z_-]+$/.test(gameId)) {
    throw new Error("Invalid gameId for game record.");
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
  return entries.filter(entry => entry.isDirectory() && /^[0-9A-Za-z_-]+$/.test(entry.name)).map(entry => entry.name);
}

function readGameRecord(userDataDir, gameId) {
  if (!gameId) return null;
  validateGameId(gameId);
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
  validateGameId(gameId);
  const dir = GameData.resolveGameDir(userDataDir, gameId);
  ensureDir(dir);
  const infoPath = GameData.resolveGameDataPath(userDataDir, gameId);
  const payload = { ...record, gameId: String(gameId) };
  writeJsonAtomic(infoPath, payload);
  return infoPath;
}

function setGameNotes(userDataDir, gameId, notes) {
  if (typeof notes !== "string" || notes.length > 65536 || Buffer.byteLength(notes, "utf8") > 256 * 1024) {
    throw new Error("Game notes must be text with at most 65,536 characters.");
  }
  const record = readGameRecord(userDataDir, gameId);
  if (!record) throw new Error("Game not found in library.");
  const next = { ...record, notes, updatedAt: Date.now() };
  writeGameRecord(userDataDir, next);
  return next;
}

function deleteGameData(userDataDir, gameId) {
  if (!gameId) return false;
  validateGameId(gameId);
  const dir = GameData.resolveGameDir(userDataDir, gameId);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function setGameLaunchArguments(userDataDir, gameId, launchArguments) {
  if (typeof launchArguments !== "string") throw new Error("Launch arguments must be text.");
  require("../modules/shared/runtime/launch-arguments").parse(launchArguments);
  const record = readGameRecord(userDataDir, gameId);
  if (!record) throw new Error("Game not found in library.");
  const next = { ...record, launchArguments, updatedAt: Date.now() };
  writeGameRecord(userDataDir, next);
  return next;
}

function setGameNetworkAccess(userDataDir, gameId, networkAccess) {
  if (typeof networkAccess !== "boolean")
    throw new Error("Network access must be enabled or disabled.");
  const record = readGameRecord(userDataDir, gameId);
  if (!record) throw new Error("Game not found in library.");
  const next = { ...record, networkAccess, updatedAt: Date.now() };
  writeGameRecord(userDataDir, next);
  return next;
}

module.exports = {
  listGameIds,
  readGameRecord,
  loadGames,
  writeGameRecord,
  setGameNotes,
  setGameLaunchArguments,
  setGameNetworkAccess,
  deleteGameData
};
