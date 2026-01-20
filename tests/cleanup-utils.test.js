const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  cleanupLauncherGameData,
  stableIdForPath,
  stablePartitionId
} = require("../src/main/cleanup-utils");

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("cleanupLauncherGameData removes per-game launcher data", () => {
  const userDataDir = makeTempDir("maclauncher-cleanup-utils-");
  const moduleId = "tyrano";
  const gamePath = "/Games/TestGame";
  const id = stableIdForPath(gamePath);

  const moduleCheatsDir = path.join(userDataDir, "modules", moduleId, "cheats");
  fs.mkdirSync(moduleCheatsDir, { recursive: true });
  const moduleCheatsFile = path.join(moduleCheatsDir, `${id}.json`);
  fs.writeFileSync(moduleCheatsFile, "{}");
  fs.writeFileSync(`${moduleCheatsFile}.tools-bootstrap.log`, "bootstrap");
  fs.writeFileSync(`${moduleCheatsFile}.tools-runtime.log`, "runtime");

  const iconsDir = path.join(userDataDir, "icons");
  fs.mkdirSync(iconsDir, { recursive: true });
  const matchingIcon = path.join(iconsDir, `${id}-app.png`);
  const keepIcon = path.join(iconsDir, "keep-app.png");
  fs.writeFileSync(matchingIcon, "icon");
  fs.writeFileSync(keepIcon, "icon");

  const logsDir = path.join(userDataDir, "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  const mkxpLog = path.join(logsDir, `rgss-mkxpz-${id}.log`);
  const mkxpSnapshot = path.join(logsDir, `rgss-mkxpz-${id}.json`);
  const keepLog = path.join(logsDir, "main.log");
  fs.writeFileSync(mkxpLog, "log");
  fs.writeFileSync(mkxpSnapshot, "{}");
  fs.writeFileSync(keepLog, "main");

  const partitionsDir = path.join(userDataDir, "Partitions");
  const partitionName = stablePartitionId(gamePath).replace("persist:", "");
  const partitionUnrestricted = stablePartitionId(gamePath, "unrestricted").replace("persist:", "");
  fs.mkdirSync(path.join(partitionsDir, partitionName), { recursive: true });
  fs.mkdirSync(path.join(partitionsDir, partitionUnrestricted), { recursive: true });
  fs.mkdirSync(path.join(partitionsDir, "keep-me"), { recursive: true });

  cleanupLauncherGameData({ userDataDir, moduleId, gamePath });

  assert.ok(!fs.existsSync(moduleCheatsFile));
  assert.ok(!fs.existsSync(`${moduleCheatsFile}.tools-bootstrap.log`));
  assert.ok(!fs.existsSync(`${moduleCheatsFile}.tools-runtime.log`));
  assert.ok(!fs.existsSync(moduleCheatsDir));

  assert.ok(!fs.existsSync(matchingIcon));
  assert.ok(fs.existsSync(keepIcon));
  assert.ok(fs.existsSync(iconsDir));

  assert.ok(!fs.existsSync(mkxpLog));
  assert.ok(!fs.existsSync(mkxpSnapshot));
  assert.ok(fs.existsSync(keepLog));

  assert.ok(!fs.existsSync(path.join(partitionsDir, partitionName)));
  assert.ok(!fs.existsSync(path.join(partitionsDir, partitionUnrestricted)));
  assert.ok(fs.existsSync(path.join(partitionsDir, "keep-me")));

  fs.rmSync(userDataDir, { recursive: true, force: true });
});
