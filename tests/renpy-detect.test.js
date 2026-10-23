const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { detectGame } = require("../src/modules/renpy/detect");

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, "utf8");
}

test("detectGame returns moduleData for full Ren'Py roots", () => {
  const root = makeTempDir("maclauncher-renpy-detect-");
  try {
    fs.mkdirSync(path.join(root, "renpy"), { recursive: true });
    fs.mkdirSync(path.join(root, "game"), { recursive: true });
    writeFile(path.join(root, "renpy", "vc_version.py"), 'version = "8.1.0"');
    writeFile(path.join(root, "MyGame.sh"), "");

    const detected = detectGame({ rootDir: root, inputPath: root });

    assert.equal(detected.engine, "renpy");
    assert.equal(detected.moduleData.version, "8.1.0");
    assert.equal(detected.moduleData.major, 8);
    assert.equal(detected.moduleData.baseName, "MyGame");
    assert.equal(detected.moduleData.gameOnly, false);
    assert.equal(detected.renpyVersion, undefined);
    assert.equal(detected.renpyMajor, undefined);
    assert.equal(detected.renpyBaseName, undefined);
    assert.equal(detected.renpyGameOnly, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("detectGame marks game-only folders and parses script_version", () => {
  const root = makeTempDir("maclauncher-renpy-game-only-");
  try {
    const gameDir = path.join(root, "game");
    fs.mkdirSync(gameDir, { recursive: true });
    writeFile(path.join(gameDir, "script.rpy"), "label start:\n  return\n");
    writeFile(path.join(gameDir, "script_version.txt"), "7, 4, 11");

    const detected = detectGame({ rootDir: gameDir, inputPath: gameDir });

    assert.equal(detected.engine, "renpy");
    assert.equal(detected.moduleData.version, "7.4.11");
    assert.equal(detected.moduleData.major, 7);
    assert.equal(detected.moduleData.baseName, null);
    assert.equal(detected.moduleData.gameOnly, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
