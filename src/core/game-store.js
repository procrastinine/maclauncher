const fs = require("node:fs");
const path = require("node:path");

const GameData = require("../modules/shared/game-data");
const { readJsonObject, readJsonDocument, writeJsonAtomic } = require("./json-files");
const CURRENT_RECORD_SCHEMA_VERSION = 2;
const MODULES_ROOT = path.resolve(__dirname, "../modules");
const MODULE_DEFAULT = "module-default";

// A module's default icon is stored as a reference, iconSource
// "module-default" without a path, and resolved against the running app's
// modules when the record is read. Records never hold a path into the app.
function moduleDefaultIcon(moduleId) {
  return typeof moduleId === "string" && /^[0-9A-Za-z_-]+$/.test(moduleId) ? path.join(MODULES_ROOT, moduleId, "resources", "icon.png") : null;
}
function readIcon(record) {
  const former = require("./backcompat/module-icon-paths").formerModuleIcon(record.iconPath);
  if (former) return { ...record, iconPath: moduleDefaultIcon(former), iconSource: MODULE_DEFAULT };
  return !record.iconPath && record.iconSource === MODULE_DEFAULT ? { ...record, iconPath: moduleDefaultIcon(record.moduleId) } : record;
}
function storedIcon(record) {
  const moduleIcon = record.iconSource === MODULE_DEFAULT || require("./backcompat/module-icon-paths").formerModuleIcon(record.iconPath);
  return moduleIcon && record.iconPath !== undefined ? { ...record, iconPath: null, iconSource: MODULE_DEFAULT } : record;
}

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

function readGameRecord(userDataDir, gameId, options = {}) {
  if (!gameId) return null;
  validateGameId(gameId);
  const infoPath = GameData.resolveGameDataPath(userDataDir, gameId);
  const record = readJsonFile(infoPath);
  if (!record) return null;
  record.gameId = String(gameId);
  if (typeof record.schemaVersion === "number" && record.schemaVersion >= CURRENT_RECORD_SCHEMA_VERSION) return readIcon(record);
  const upgraded = require("./backcompat/record-conversions").upgradeLoadedRecord(userDataDir, record, next => writeGameRecord(userDataDir, next),
    {...options, currentVersion: CURRENT_RECORD_SCHEMA_VERSION});
  return upgraded && typeof upgraded === "object" ? readIcon(upgraded) : upgraded;
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
  const payload = storedIcon({ ...record, gameId: String(gameId) });
  // An unreadable record is left out of the library, and a later import of the
  // same source can reuse its game ID. Keep a damaged record beside it before
  // it is replaced, and refuse the write after a read error.
  readJsonDocument(infoPath);
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
  require("../modules/shared/writable-input").assertPreservesExternalEnvironments(readGameRecord(userDataDir, gameId), dir);
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

// One translator's environment values for a game, checked against the
// translator's declaration. Values are literal text; null removes a variable
// inherited from the global values, and empty values remove the translator.
function setGameTranslatorEnvironment(userDataDir, gameId, translatorId, values, { declarations = [] } = {}) {
  const Contract = require("../modules/shared/runtime/translator-environment.mjs");
  const declaration = declarations.find(item => item.id === translatorId);
  if (!declaration) throw new Error("Unknown translator.");
  const normalized = Contract.normalizeValues(values, { declarations: [declaration] });
  const record = readGameRecord(userDataDir, gameId);
  if (!record) throw new Error("Game not found in library.");
  const { translatorEnvironment: previous, ...rest } = record;
  const store = Contract.withValues(previous, translatorId, normalized);
  const next = { ...rest, ...(Object.keys(store).length ? { translatorEnvironment: store } : {}), updatedAt: Date.now() };
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

// A per-game policy overrides the launcher's Steam startup preference.
function setGameSteamClientStart(userDataDir, gameId, startSteamClient) {
  if (startSteamClient !== null && typeof startSteamClient !== "boolean" && !["ask", "automatic", "never"].includes(startSteamClient))
    throw new Error("Steam client on Play must be Ask, Start automatically, Don't start or inherited.");
  const record = readGameRecord(userDataDir, gameId);
  if (!record) throw new Error("Game not found in library.");
  const { startSteamClient: _previous, ...rest } = record;
  const next = { ...rest, ...(startSteamClient === null ? {} : { startSteamClient }), updatedAt: Date.now() };
  writeGameRecord(userDataDir, next);
  return next;
}

module.exports = {
  CURRENT_RECORD_SCHEMA_VERSION,
  listGameIds,
  readGameRecord,
  loadGames,
  writeGameRecord,
  setGameNotes,
  setGameLaunchArguments,
  setGameTranslatorEnvironment,
  setGameNetworkAccess,
  setGameSteamClientStart,
  deleteGameData
};
