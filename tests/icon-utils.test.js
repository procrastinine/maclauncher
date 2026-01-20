const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const IconUtils = require("../src/main/icon-utils");

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function touch(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "");
}

test("pickBestExeCandidate favors the game name over helper executables", () => {
  const candidates = ["Setup.exe", "MyGameLauncher.exe", "MyGame.exe"];
  const pick = IconUtils.pickBestExeCandidate(candidates, "My Game", "MyGame");
  assert.equal(pick, "MyGame.exe");
});

test("pickBestExeCandidate returns the only candidate", () => {
  const candidates = ["Solo.exe"];
  const pick = IconUtils.pickBestExeCandidate(candidates, "Solo", "Solo");
  assert.equal(pick, "Solo.exe");
});

test("findBestExePath selects the best exe in a directory", () => {
  const root = makeTempDir("maclauncher-icon-");
  try {
    touch(path.join(root, "Uninstall.exe"));
    touch(path.join(root, "CoolGame.exe"));
    touch(path.join(root, "CoolGameLauncher.exe"));
    const pick = IconUtils.findBestExePath(root, "Cool Game");
    assert.equal(pick, path.join(root, "CoolGame.exe"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("findAppBundleIconPath prefers the plist icon name", () => {
  const root = makeTempDir("maclauncher-app-");
  const appPath = path.join(root, "Test.app");
  try {
    const plistPath = path.join(appPath, "Contents", "Info.plist");
    const iconPath = path.join(appPath, "Contents", "Resources", "MyIcon.icns");
    fs.mkdirSync(path.dirname(plistPath), { recursive: true });
    fs.mkdirSync(path.dirname(iconPath), { recursive: true });
    fs.writeFileSync(
      plistPath,
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<plist version="1.0"><dict>` +
        `<key>CFBundleIconFile</key><string>MyIcon</string>` +
        `</dict></plist>\n`
    );
    fs.writeFileSync(iconPath, "");
    assert.equal(IconUtils.findAppBundleIconPath(appPath), iconPath);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("extractExeIconImage returns null for non-exe files", () => {
  const root = makeTempDir("maclauncher-exe-");
  const filePath = path.join(root, "not-exe.bin");
  try {
    fs.writeFileSync(filePath, "not-an-exe");
    assert.equal(IconUtils.extractExeIconImage(filePath), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
