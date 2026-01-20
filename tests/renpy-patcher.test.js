const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const Patcher = require("../src/modules/renpy/runtime/patcher");

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, "utf8");
}

test("Ren'Py patcher installs and removes runtime libs", () => {
  const userDataDir = makeTempDir("maclauncher-renpy-user-");
  const gameDir = makeTempDir("maclauncher-renpy-game-");
  const sdkDir = makeTempDir("maclauncher-renpy-sdk-");

  try {
    const sdkLibDir = path.join(sdkDir, "lib", "py3-mac-x86_64");
    writeFile(path.join(sdkLibDir, "renpy"), "");
    writeFile(path.join(gameDir, "MyGame.sh"), "#!/bin/sh\n");

    const status = Patcher.patchGame({
      userDataDir,
      gamePath: gameDir,
      contentRootDir: gameDir,
      renpyBaseName: "MyGame",
      renpyMajor: 8,
      sdkInstallDir: sdkDir,
      sdkVersion: "8.2.1",
      renpyVersion: "8.2.1"
    });

    assert.equal(status.patched, true);
    assert.equal(status.details.baseBinaryExists, true);

    const libDir = path.join(gameDir, "lib", "py3-mac-x86_64");
    const baseBinary = path.join(libDir, "MyGame");
    assert.ok(fs.existsSync(libDir));
    assert.ok(fs.existsSync(baseBinary));

    const meta = Patcher.readPatchMeta(userDataDir, gameDir);
    assert.ok(meta);
    assert.equal(meta.renpyBaseName, "MyGame");
    assert.equal(meta.sdkVersion, "8.2.1");

    const unpatched = Patcher.unpatchGame({
      userDataDir,
      gamePath: gameDir,
      contentRootDir: gameDir,
      renpyBaseName: "MyGame",
      renpyMajor: 8
    });

    assert.equal(unpatched.patched, false);
    assert.equal(Patcher.readPatchMeta(userDataDir, gameDir), null);
    assert.equal(fs.existsSync(libDir), false);
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(gameDir, { recursive: true, force: true });
    fs.rmSync(sdkDir, { recursive: true, force: true });
  }
});

test("Ren'Py patcher treats legacy majors as py2", () => {
  const userDataDir = makeTempDir("maclauncher-renpy-user-");
  const gameDir = makeTempDir("maclauncher-renpy-game-");
  const sdkDir = makeTempDir("maclauncher-renpy-sdk-");

  try {
    const sdkLibDir = path.join(sdkDir, "lib", "py2-mac-x86_64");
    writeFile(path.join(sdkLibDir, "renpy"), "");
    writeFile(path.join(gameDir, "MyGame.sh"), "#!/bin/sh\n");

    const status = Patcher.patchGame({
      userDataDir,
      gamePath: gameDir,
      contentRootDir: gameDir,
      renpyBaseName: "MyGame",
      renpyMajor: 6,
      sdkInstallDir: sdkDir,
      sdkVersion: "7.4.11",
      renpyVersion: "6.99.12"
    });

    assert.equal(status.patched, true);

    const libDir = path.join(gameDir, "lib", "py2-mac-x86_64");
    const baseBinary = path.join(libDir, "MyGame");
    assert.ok(fs.existsSync(libDir));
    assert.ok(fs.existsSync(baseBinary));
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(gameDir, { recursive: true, force: true });
    fs.rmSync(sdkDir, { recursive: true, force: true });
  }
});
