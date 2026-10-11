const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const GameData = require("../src/modules/shared/game-data");
const { cleanupNwjsGameData } = require("../src/modules/shared/web/runtime/nwjs-cleanup");

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("cleanupNwjsGameData removes wrapper/profile/app data for a game", () => {
  const userDataDir = makeTempDir("maclauncher-nwjs-cleanup-");
  const gameId = "game-nwjs";

  const runtimeRoot = GameData.resolveGameRuntimeDir(userDataDir, gameId, "nwjs");
  const patchedRuntimeRoot = GameData.resolveGameRuntimeDir(userDataDir, gameId, "nwjs-patched");
  const wrapperRoot = path.join(runtimeRoot, "wrappers");
  const patchedWrapperRoot = path.join(patchedRuntimeRoot, "wrappers");
  const profileRoot = path.join(runtimeRoot, "profiles");
  const patchedProfileRoot = path.join(patchedRuntimeRoot, "profiles");
  const appsRoot = path.join(runtimeRoot, "apps");
  const patchedAppsRoot = path.join(patchedRuntimeRoot, "apps");
  const keepRoot = GameData.resolveGameRuntimeDir(userDataDir, "game-keep", "nwjs");

  fs.mkdirSync(path.join(wrapperRoot, "wrapper"), { recursive: true });
  fs.mkdirSync(path.join(patchedWrapperRoot, "wrapper"), { recursive: true });
  fs.mkdirSync(path.join(profileRoot, "0.1.0-osx-x64-sdk"), { recursive: true });
  fs.mkdirSync(path.join(patchedProfileRoot, "0.1.0-osx-x64-sdk"), { recursive: true });
  fs.mkdirSync(path.join(appsRoot, "wrapper.app"), { recursive: true });
  fs.mkdirSync(path.join(patchedAppsRoot, "wrapper.app"), { recursive: true });
  fs.mkdirSync(path.join(keepRoot, "wrappers", "keep-me"), { recursive: true });

  const removed = cleanupNwjsGameData({ userDataDir, gameId });
  assert.equal(removed, true);

  assert.ok(!fs.existsSync(runtimeRoot));
  assert.ok(!fs.existsSync(patchedRuntimeRoot));
  assert.ok(fs.existsSync(keepRoot));

  fs.rmSync(userDataDir, { recursive: true, force: true });
});
