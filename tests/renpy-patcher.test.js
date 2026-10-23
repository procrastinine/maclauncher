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
  const gameId = "game-renpy";

  try {
    const sdkLibDir = path.join(sdkDir, "lib", "py3-mac-x86_64");
    writeFile(path.join(sdkLibDir, "renpy"), "");
    writeFile(path.join(gameDir, "MyGame.sh"), "#!/bin/sh\n");

    const status = Patcher.patchGame({
      userDataDir,
      gameId,
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

    const meta = Patcher.readPatchMeta(userDataDir, gameId);
    assert.ok(meta);
    assert.equal(meta.renpyBaseName, "MyGame");
    assert.equal(meta.sdkVersion, "8.2.1");

    const unpatched = Patcher.unpatchGame({
      userDataDir,
      gameId,
      gamePath: gameDir,
      contentRootDir: gameDir,
      renpyBaseName: "MyGame",
      renpyMajor: 8
    });

    assert.equal(unpatched.patched, false);
    assert.equal(Patcher.readPatchMeta(userDataDir, gameId), null);
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
  const gameId = "game-renpy-2";

  try {
    const sdkLibDir = path.join(sdkDir, "lib", "py2-mac-x86_64");
    writeFile(path.join(sdkLibDir, "renpy"), "");
    writeFile(path.join(gameDir, "MyGame.sh"), "#!/bin/sh\n");

    const status = Patcher.patchGame({
      userDataDir,
      gameId,
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

test("copied Ren'Py SDK aliases survive SDK removal and preserve configured external references", t => {
  const userDataDir = makeTempDir("maclauncher-renpy-user-");
  const gameDir = makeTempDir("maclauncher-renpy-overlay-");
  const sdkDir = makeTempDir("maclauncher-renpy-sdk-");
  for (const directory of [userDataDir, gameDir, sdkDir]) {
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  }
  const sdkLibDir = path.join(sdkDir, "lib", "py3-mac-universal");
  writeFile(path.join(sdkLibDir, "renpy.real"), "runtime binary");
  fs.symlinkSync("renpy.real", path.join(sdkLibDir, "renpy"));
  writeFile(path.join(sdkLibDir, "Libraries", "libdemo.1.dylib"), "library bytes");
  writeFile(path.join(userDataDir, "external-config"), "configured data");
  fs.symlinkSync("Libraries/libdemo.1.dylib", path.join(sdkLibDir, "libdemo.dylib"));
  fs.symlinkSync(path.join(userDataDir, "external-config"), path.join(sdkLibDir, "external-config"));
  const originalLauncherMode = fs.statSync(path.join(sdkLibDir, "renpy.real")).mode;
  Patcher.patchGame({ userDataDir, gameId: "copy-fixture", gamePath: gameDir,
    contentRootDir: gameDir, renpyBaseName: "Player", renpyMajor: 8, sdkInstallDir: sdkDir });
  assert.equal(fs.readlinkSync(path.join(sdkLibDir, "libdemo.dylib")), "Libraries/libdemo.1.dylib");
  assert.equal(fs.readFileSync(path.join(sdkLibDir, "renpy"), "utf8"), "runtime binary");
  assert.equal(fs.statSync(path.join(sdkLibDir, "renpy.real")).mode, originalLauncherMode);
  fs.rmSync(sdkDir, { recursive: true, force: true });
  const installed = path.join(gameDir, "lib", "py3-mac-universal");
  assert.equal(fs.readlinkSync(path.join(installed, "renpy")), "renpy.real");
  assert.ok(fs.statSync(path.join(installed, "renpy")).mode & 0o111);
  assert.equal(fs.readlinkSync(path.join(installed, "libdemo.dylib")), "Libraries/libdemo.1.dylib");
  assert.equal(fs.readFileSync(path.join(installed, "libdemo.dylib"), "utf8"), "library bytes");
  assert.equal(fs.readlinkSync(path.join(installed, "external-config")), path.join(userDataDir, "external-config"));
  assert.equal(fs.readFileSync(path.join(installed, "external-config"), "utf8"), "configured data");
});
