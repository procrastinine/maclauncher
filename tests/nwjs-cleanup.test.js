const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { cleanupNwjsGameData, stableIdForPath } = require("../src/modules/shared/web/runtime/nwjs-cleanup");

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("cleanupNwjsGameData removes wrapper/profile/app data for a game", () => {
  const userDataDir = makeTempDir("maclauncher-nwjs-cleanup-");
  const moduleId = "mv";
  const gamePath = "/Games/TestGame";
  const id = stableIdForPath(gamePath);

  const wrapperRoot = path.join(userDataDir, "modules", moduleId, "nwjs", "wrappers");
  const patchedWrapperRoot = path.join(userDataDir, "modules", moduleId, "nwjs-patched", "wrappers");
  const profileRoot = path.join(userDataDir, "modules", moduleId, "nwjs", "profiles");
  const patchedProfileRoot = path.join(userDataDir, "modules", moduleId, "nwjs-patched", "profiles");
  const appsRoot = path.join(userDataDir, "modules", moduleId, "nwjs", "apps");
  const patchedAppsRoot = path.join(userDataDir, "modules", moduleId, "nwjs-patched", "apps");
  const keepWrapper = path.join(wrapperRoot, "keep-me");

  fs.mkdirSync(path.join(wrapperRoot, id), { recursive: true });
  fs.mkdirSync(path.join(wrapperRoot, `${id}-legacy`), { recursive: true });
  fs.mkdirSync(path.join(patchedWrapperRoot, id), { recursive: true });
  fs.mkdirSync(keepWrapper, { recursive: true });
  fs.mkdirSync(path.join(profileRoot, id, "0.1.0-osx-x64-sdk"), { recursive: true });
  fs.mkdirSync(path.join(patchedProfileRoot, id, "0.1.0-osx-x64-sdk"), { recursive: true });
  fs.mkdirSync(path.join(appsRoot, `${id}.app`), { recursive: true });
  fs.mkdirSync(path.join(patchedAppsRoot, `${id}.app`), { recursive: true });

  const removed = cleanupNwjsGameData({ userDataDir, moduleId, gamePath });
  assert.equal(removed, true);

  assert.ok(!fs.existsSync(path.join(wrapperRoot, id)));
  assert.ok(!fs.existsSync(path.join(wrapperRoot, `${id}-legacy`)));
  assert.ok(!fs.existsSync(path.join(patchedWrapperRoot, id)));
  assert.ok(!fs.existsSync(path.join(profileRoot, id)));
  assert.ok(!fs.existsSync(path.join(patchedProfileRoot, id)));
  assert.ok(!fs.existsSync(path.join(appsRoot, `${id}.app`)));
  assert.ok(!fs.existsSync(path.join(patchedAppsRoot, `${id}.app`)));
  assert.ok(fs.existsSync(keepWrapper));

  fs.rmSync(userDataDir, { recursive: true, force: true });
});
