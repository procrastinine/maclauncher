const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function stableIdForPath(input) {
  return crypto.createHash("sha256").update(String(input || "")).digest("hex").slice(0, 12);
}

function stablePartitionId(gamePath, mode = "protected") {
  const h = crypto.createHash("sha256").update(String(gamePath || "")).digest("hex").slice(0, 16);
  const suffix = mode === "unrestricted" ? "unrestricted-" : "";
  return `persist:maclauncher-game-${suffix}${h}`;
}

function safeRm(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {}
}

function readDirSafe(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function removeIfEmpty(dir) {
  try {
    const entries = fs.readdirSync(dir);
    if (entries.length === 0) fs.rmdirSync(dir);
  } catch {}
}

function removeCheatFileAndLogs(filePath) {
  if (!filePath) return;
  safeRm(filePath);
  safeRm(`${filePath}.tools-bootstrap.log`);
  safeRm(`${filePath}.tools-runtime.log`);
}

function cleanupCheatsFiles({ userDataDir, moduleId, gamePath } = {}) {
  if (!userDataDir || !moduleId || !gamePath) return false;
  const id = stableIdForPath(gamePath);
  const moduleCheatsDir = path.join(userDataDir, "modules", moduleId, "cheats");
  const moduleFile = path.join(moduleCheatsDir, `${id}.json`);

  removeCheatFileAndLogs(moduleFile);
  removeIfEmpty(moduleCheatsDir);
  return true;
}

function cleanupIconCache({ userDataDir, gamePath } = {}) {
  if (!userDataDir || !gamePath) return false;
  const id = stableIdForPath(gamePath);
  const dir = path.join(userDataDir, "icons");
  const entries = readDirSafe(dir);
  if (entries.length === 0) return false;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.startsWith(`${id}-`)) continue;
    safeRm(path.join(dir, entry.name));
  }
  removeIfEmpty(dir);
  return true;
}

function cleanupMkxpzLogs({ userDataDir, gamePath } = {}) {
  if (!userDataDir || !gamePath) return false;
  const id = stableIdForPath(gamePath);
  const logDir = path.join(userDataDir, "logs");
  safeRm(path.join(logDir, `rgss-mkxpz-${id}.log`));
  safeRm(path.join(logDir, `rgss-mkxpz-${id}.json`));
  return true;
}

function cleanupPartitionData({ userDataDir, gamePath } = {}) {
  if (!userDataDir || !gamePath) return false;
  const partitionDir = path.join(userDataDir, "Partitions");
  const ids = [
    stablePartitionId(gamePath, "protected"),
    stablePartitionId(gamePath, "unrestricted")
  ];

  for (const id of ids) {
    const trimmed = id.replace(/^persist:/, "");
    safeRm(path.join(partitionDir, trimmed));
    safeRm(path.join(partitionDir, id));
  }
  return true;
}

function cleanupLauncherGameData({ userDataDir, moduleId, gamePath } = {}) {
  if (!userDataDir || !gamePath) return false;
  cleanupCheatsFiles({ userDataDir, moduleId, gamePath });
  cleanupIconCache({ userDataDir, gamePath });
  cleanupMkxpzLogs({ userDataDir, gamePath });
  cleanupPartitionData({ userDataDir, gamePath });
  return true;
}

module.exports = {
  cleanupCheatsFiles,
  cleanupIconCache,
  cleanupMkxpzLogs,
  cleanupPartitionData,
  cleanupLauncherGameData,
  stableIdForPath,
  stablePartitionId
};
