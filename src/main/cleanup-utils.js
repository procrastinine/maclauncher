const fs = require("node:fs");
const path = require("node:path");

const GameData = require("../modules/shared/game-data");

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function stablePartitionId(gameId, mode = "protected") {
  const id = String(gameId || "").replace(/[^0-9A-Za-z_-]+/g, "");
  const suffix = mode === "unrestricted" ? "unrestricted-" : "";
  return `persist:maclauncher-game-${suffix}${id || "unknown"}`;
}

function safeRm(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {}
}

function resolveSymlinkTarget(linkPath) {
  try {
    const stat = fs.lstatSync(linkPath);
    if (!stat.isSymbolicLink()) return null;
    const link = fs.readlinkSync(linkPath);
    return path.resolve(path.dirname(linkPath), link);
  } catch {
    return null;
  }
}

function ensurePartitionSymlink({ userDataDir, gameId, partitionId, logger } = {}) {
  if (!userDataDir || !gameId || !partitionId) {
    logger?.warn?.("[partition] missing userData/gameId/partitionId");
    return { ok: false, partitionPath: null, targetDir: null };
  }

  const partitionsDir = path.join(userDataDir, "Partitions");
  const trimmed = String(partitionId).replace(/^persist:/, "");
  const partitionPath = path.join(partitionsDir, trimmed);
  const targetDir = GameData.resolveGamePartitionDir(userDataDir, gameId);
  const resolvedTarget = path.resolve(targetDir);

  ensureDir(partitionsDir);
  ensureDir(targetDir);

  const existingTarget = resolveSymlinkTarget(partitionPath);
  if (existingTarget && path.resolve(existingTarget) === resolvedTarget) {
    return { ok: true, partitionPath, targetDir };
  }

  try {
    fs.lstatSync(partitionPath);
    safeRm(partitionPath);
  } catch {}

  try {
    fs.symlinkSync(targetDir, partitionPath, "dir");
  } catch (err) {
    logger?.warn?.("[partition] symlink create failed", String(err?.message || err));
  }

  const resolved = resolveSymlinkTarget(partitionPath);
  if (resolved && path.resolve(resolved) === resolvedTarget) {
    return { ok: true, partitionPath, targetDir };
  }

  logger?.warn?.("[partition] symlink missing or invalid", {
    partitionPath,
    targetDir
  });
  return { ok: false, partitionPath, targetDir };
}

function cleanupPartitionData({ userDataDir, gameId } = {}) {
  if (!userDataDir || !gameId) return false;
  const partitionDir = path.join(userDataDir, "Partitions");
  const ids = [
    stablePartitionId(gameId, "protected"),
    stablePartitionId(gameId, "unrestricted")
  ];

  for (const id of ids) {
    const trimmed = id.replace(/^persist:/, "");
    safeRm(path.join(partitionDir, trimmed));
    safeRm(path.join(partitionDir, id));
  }
  return true;
}

function cleanupOrphanedPartitions({ userDataDir } = {}) {
  if (!userDataDir) return 0;
  const partitionsDir = path.join(userDataDir, "Partitions");
  let entries = [];
  try {
    entries = fs.readdirSync(partitionsDir, { withFileTypes: true });
  } catch {
    return 0;
  }

  let removed = 0;
  for (const entry of entries) {
    if (!entry.isSymbolicLink()) continue;
    const name = String(entry.name || "");
    const isMaclauncher =
      name.startsWith("maclauncher-game-") || name.startsWith("persist:maclauncher-game-");
    if (!isMaclauncher) continue;
    const fullPath = path.join(partitionsDir, name);
    let target = null;
    try {
      target = fs.readlinkSync(fullPath);
    } catch {
      continue;
    }
    const resolved = path.resolve(partitionsDir, target);
    if (fs.existsSync(resolved)) continue;
    safeRm(fullPath);
    removed += 1;
  }
  return removed;
}

function cleanupGameDir({ userDataDir, gameId } = {}) {
  if (!userDataDir || !gameId) return false;
  const gameDir = GameData.resolveGameDir(userDataDir, gameId);
  safeRm(gameDir);
  return true;
}

function cleanupLauncherGameData({ userDataDir, gameId } = {}) {
  if (!userDataDir || !gameId) return false;
  cleanupPartitionData({ userDataDir, gameId });
  cleanupGameDir({ userDataDir, gameId });
  return true;
}

module.exports = {
  ensurePartitionSymlink,
  cleanupPartitionData,
  cleanupOrphanedPartitions,
  cleanupGameDir,
  cleanupLauncherGameData,
  stablePartitionId
};
