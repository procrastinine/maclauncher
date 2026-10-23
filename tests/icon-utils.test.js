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
    touch(path.join(appPath, "Contents", "Resources", "icon.icns"));
    assert.equal(IconUtils.findAppBundleIconPath(appPath), iconPath);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("app icons read binary plists and reject declared paths or symlinks outside the bundle", { skip: process.platform !== "darwin" }, t => {
  const root = makeTempDir("maclauncher-app-binary-"), app = path.join(root, "Suffixless"), resources = path.join(app, "Contents", "Resources");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(resources, { recursive: true });
  const plist = path.join(app, "Contents", "Info.plist"), declared = path.join(resources, "Real.icns"), fallback = path.join(resources, "icon.icns");
  fs.writeFileSync(plist, '<plist version="1.0"><dict><key>CFBundleIconFile</key><string>Real</string></dict></plist>'); touch(declared); touch(fallback);
  const result = require("node:child_process").spawnSync("/usr/bin/plutil", ["-convert", "binary1", plist]);
  assert.equal(result.status, 0); assert.equal(IconUtils.findAppBundleIconPath(app), declared);
  fs.rmSync(declared); const outside = path.join(root, "outside.icns"); touch(outside); fs.symlinkSync(outside, declared);
  assert.equal(IconUtils.findAppBundleIconPath(app), fallback);
  fs.writeFileSync(plist, '<plist><dict><key>CFBundleIconFile</key><string>../../../outside.icns</string></dict></plist>');
  assert.equal(IconUtils.findAppBundleIconPath(app), fallback);
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

test("standalone ICO decoding preserves DIB rows and alpha and skips an unsupported larger frame", () => {
  const dib = Buffer.alloc(64); dib.writeUInt32LE(40); dib.writeInt32LE(2, 4); dib.writeInt32LE(4, 8);
  dib.writeUInt16LE(1, 12); dib.writeUInt16LE(32, 14);
  Buffer.from([255, 0, 0, 255, 255, 255, 255, 255, 0, 0, 255, 255, 0, 255, 0, 255]).copy(dib, 40);
  dib[60] = 0x40;
  const ico = Buffer.alloc(6 + 32 + 40 + dib.length); ico.writeUInt16LE(1, 2); ico.writeUInt16LE(2, 4);
  ico[6] = 64; ico[7] = 64; ico.writeUInt32LE(40, 14); ico.writeUInt32LE(38, 18);
  ico[22] = 2; ico[23] = 2; ico.writeUInt16LE(32, 28); ico.writeUInt32LE(dib.length, 30); ico.writeUInt32LE(78, 34); dib.copy(ico, 78);
  const png = IconUtils.extractIcoPngBuffer(ico);
  assert.equal(IconUtils.isSupportedImageBuffer(png), true);
  const pixels = require("node:zlib").inflateSync(png.subarray(41, 41 + png.readUInt32BE(33)));
  assert.deepEqual([...pixels], [0, 255, 0, 0, 255, 0, 255, 0, 0, 0, 0, 0, 255, 255, 255, 255, 255, 255]);
  const invalid = Buffer.from(ico); invalid.writeUInt32LE(0xffffffff, 34);
  assert.equal(IconUtils.extractIcoPngBuffer(invalid), null);
  assert.equal(IconUtils.extractIcoPngBuffer(Buffer.alloc(8 * 1024 ** 2 + 1)), null);
});
