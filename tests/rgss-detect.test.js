const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { detectGame } = require("../src/modules/rgss/detect");

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, "utf8");
}

test("detectGame parses Game.ini metadata", () => {
  const root = makeTempDir("maclauncher-rgss-");
  try {
    writeFile(
      path.join(root, "Game.ini"),
      ["[Game]", "Title=RGSS Title", "RTP=RPGVX", "Library=RGSS202E.dll"].join("\n")
    );
    writeFile(path.join(root, "Game.exe"), "");

    const detected = detectGame({ rootDir: root });
    assert.equal(detected.gameType, "rgss");
    assert.equal(detected.name, "RGSS Title");
    assert.equal(detected.moduleData.rtpId, "RPGVX");
    assert.equal(detected.moduleData.rgssVersion, "RGSS2");
    assert.equal(detected.moduleData.execName, "Game");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("detectGame prefers Game.ini base for execName even when exe differs", () => {
  const root = makeTempDir("maclauncher-rgss-");
  try {
    writeFile(
      path.join(root, "Game.ini"),
      ["[Game]", "Title=Alt Title", "Library=RGSS301.dll"].join("\n")
    );
    writeFile(path.join(root, "Custom.exe"), "");

    const detected = detectGame({ rootDir: root });
    assert.equal(detected.moduleData.execName, "Game");
    assert.equal(detected.moduleData.rgssVersion, "RGSS3");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("detectGame uses RTP hint when library is missing", () => {
  const root = makeTempDir("maclauncher-rgss-");
  try {
    writeFile(path.join(root, "Game.ini"), ["[Game]", "RTP=RPGVXAce"].join("\n"));

    const detected = detectGame({ rootDir: root });
    assert.equal(detected.moduleData.rgssVersion, "RGSS3");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("detectGame falls back to scripts data when Game.ini is missing", () => {
  const root = makeTempDir("maclauncher-rgss-");
  try {
    writeFile(path.join(root, "Data", "Scripts.rvdata2"), "");

    const detected = detectGame({ rootDir: root });
    assert.equal(detected.moduleData.rgssVersion, "RGSS3");
    assert.equal(detected.moduleData.rtpId, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("RGSS executable drops recognize adjacent encrypted archives without an INI or DLL", () => {
  for (const [ext, version] of [["rgssad", "RGSS1"], ["rgss2a", "RGSS2"], ["RGSS3A", "RGSS3"]]) {
    const root = makeTempDir("maclauncher-rgss-archive-");
    try {
      const exePath = path.join(root, "Custom.exe");
      writeFile(exePath, "MZ");
      writeFile(path.join(root, `Custom.${ext}`), "RGSSAD");
      const detected = detectGame({ rootDir: root, inputPath: exePath, stat: fs.statSync(exePath) });
      assert.equal(detected.moduleData.rgssVersion, version);
      assert.equal(detected.moduleData.execName, "Custom");
      assert.equal(detected.gamePath, root);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("RGSS detects lowercase game.ini and rejects an unrelated INI-free exe", () => {
  const root = makeTempDir("maclauncher-rgss-case-");
  try {
    writeFile(path.join(root, "game.ini"), "[Game]\nLibrary=RGSS301.dll\nTitle=Lowercase");
    assert.equal(detectGame({ rootDir: root }).name, "Lowercase");
    fs.rmSync(path.join(root, "game.ini"));
    writeFile(path.join(root, "Game.exe"), "MZ");
    assert.equal(detectGame({ rootDir: root }), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
