const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const GameData = require("../src/modules/shared/game-data");
const {
  ensurePartitionSymlink,
  cleanupLauncherGameData,
  cleanupOrphanedPartitions,
  stablePartitionId
} = require("../src/main/cleanup-utils");

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function hasPath(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

test("cleanupLauncherGameData removes per-game launcher data", () => {
  const userDataDir = makeTempDir("maclauncher-cleanup-utils-");
  const gameId = "game-cleanup";
  const gameDir = GameData.resolveGameDir(userDataDir, gameId);
  const otherGameDir = GameData.resolveGameDir(userDataDir, "game-keep");
  fs.mkdirSync(gameDir, { recursive: true });
  fs.mkdirSync(otherGameDir, { recursive: true });
  fs.writeFileSync(path.join(gameDir, "cheats.json"), "{}");
  fs.mkdirSync(path.join(gameDir, "icons"), { recursive: true });
  fs.writeFileSync(path.join(gameDir, "icons", "icon-app.png"), "icon");
  fs.mkdirSync(path.join(gameDir, "logs"), { recursive: true });
  fs.writeFileSync(path.join(gameDir, "logs", "rgss-mkxpz.log"), "log");
  fs.writeFileSync(path.join(otherGameDir, "keep.txt"), "keep");

  const partitionsDir = path.join(userDataDir, "Partitions");
  const partitionName = stablePartitionId(gameId).replace("persist:", "");
  const partitionUnrestricted = stablePartitionId(gameId, "unrestricted").replace("persist:", "");
  fs.mkdirSync(path.join(partitionsDir, partitionName), { recursive: true });
  fs.mkdirSync(path.join(partitionsDir, partitionUnrestricted), { recursive: true });
  fs.mkdirSync(path.join(partitionsDir, "keep-me"), { recursive: true });

  cleanupLauncherGameData({ userDataDir, gameId });

  assert.ok(!fs.existsSync(gameDir));
  assert.ok(fs.existsSync(otherGameDir));

  assert.ok(!fs.existsSync(path.join(partitionsDir, partitionName)));
  assert.ok(!fs.existsSync(path.join(partitionsDir, partitionUnrestricted)));
  assert.ok(fs.existsSync(path.join(partitionsDir, "keep-me")));

  fs.rmSync(userDataDir, { recursive: true, force: true });
});

test("cleanupOrphanedPartitions removes missing symlink targets", () => {
  const userDataDir = makeTempDir("maclauncher-cleanup-orphans-");
  try {
    const partitionsDir = path.join(userDataDir, "Partitions");
    fs.mkdirSync(partitionsDir, { recursive: true });

    const liveTarget = path.join(userDataDir, "games", "game-live", "partition");
    fs.mkdirSync(liveTarget, { recursive: true });
    const liveLink = path.join(partitionsDir, "maclauncher-game-live");
    fs.symlinkSync(liveTarget, liveLink, "dir");

    const orphanLink = path.join(partitionsDir, "persist:maclauncher-game-orphan");
    fs.symlinkSync("missing-target", orphanLink, "dir");

    const otherLink = path.join(partitionsDir, "other-partition");
    fs.symlinkSync("missing-other", otherLink, "dir");

    const removed = cleanupOrphanedPartitions({ userDataDir });

    assert.equal(removed, 1);
    assert.ok(fs.existsSync(liveLink));
    assert.ok(!fs.existsSync(orphanLink));
    assert.ok(hasPath(otherLink));
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("ensurePartitionSymlink creates per-game partition links", () => {
  const userDataDir = makeTempDir("maclauncher-partition-link-");
  const gameId = "game-link";
  const partitionId = stablePartitionId(gameId);
  const result = ensurePartitionSymlink({ userDataDir, gameId, partitionId });
  assert.equal(result.ok, true);

  const partitionName = partitionId.replace("persist:", "");
  const partitionPath = path.join(userDataDir, "Partitions", partitionName);
  const targetDir = GameData.resolveGamePartitionDir(userDataDir, gameId);
  const stat = fs.lstatSync(partitionPath);
  assert.ok(stat.isSymbolicLink());
  const resolved = fs.readlinkSync(partitionPath);
  const resolvedTarget = path.resolve(path.dirname(partitionPath), resolved);
  assert.equal(resolvedTarget, path.resolve(targetDir));
  assert.ok(fs.existsSync(targetDir));

  fs.rmSync(userDataDir, { recursive: true, force: true });
});

test("ensurePartitionSymlink replaces partition directories", () => {
  const userDataDir = makeTempDir("maclauncher-partition-replace-");
  const gameId = "game-replace";
  const partitionId = stablePartitionId(gameId);
  const partitionName = partitionId.replace("persist:", "");
  const partitionPath = path.join(userDataDir, "Partitions", partitionName);
  fs.mkdirSync(partitionPath, { recursive: true });
  fs.writeFileSync(path.join(partitionPath, "legacy.txt"), "legacy");

  const result = ensurePartitionSymlink({ userDataDir, gameId, partitionId });
  assert.equal(result.ok, true);

  const stat = fs.lstatSync(partitionPath);
  assert.ok(stat.isSymbolicLink());
  const targetDir = GameData.resolveGamePartitionDir(userDataDir, gameId);
  assert.ok(!fs.existsSync(path.join(targetDir, "legacy.txt")));

  fs.rmSync(userDataDir, { recursive: true, force: true });
});
