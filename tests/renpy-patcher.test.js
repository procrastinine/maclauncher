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

test("Ren'Py layout hints prefer legacy SDK folders without changing existing modern game choices", t => {
  const root = makeTempDir("renpy-layout-order-"); t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const sdk = path.join(root, "7.3.5"), game = path.join(root, "game");
  for (const directory of [sdk, game]) for (const name of ["darwin-x86_64", "py2-mac-universal"]) {
    writeFile(path.join(directory, "lib", name, "renpy"), "program");
  }
  assert.equal(Patcher.findMacLibDir(sdk, 7).name, "darwin-x86_64");
  assert.equal(Patcher.findMacLibDir(game, 7).name, "py2-mac-universal");
  assert.equal(Patcher.findMacLibDir(game, 7, {version: "6.99.12"}).name, "darwin-x86_64");
  assert.equal(Patcher.findMacLibDir(sdk, 7, {version: "7.4.0"}).name, "py2-mac-universal");
});

test("Ren'Py unknown library names use bounded Mac executable discovery and actual CPU slices", async t => {
  const {image, ARM64, X64} = require("./fixtures/macho-image");
  const Architecture = require("../src/modules/shared/runtime/architecture");
  const root = makeTempDir("renpy-layout-content-"); t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  for (const name of ["python", "renpy"]) writeFile(path.join(root, "lib", "linux-future", name), "\x7fELF");
  fs.mkdirSync(path.join(root, "lib", "py3-mac-universal")); // Empty stale folders must not hide working content.
  function mac(name, cpu) {
    for (const program of ["python", "renpy"]) writeFile(path.join(root, "lib", name, program), image({cpu, fileType: 2, installName: null}));
  }
  mac("too/deep/to/search/runtime", ARM64);
  assert.equal(Patcher.findMacLibDir(root, 8), null);
  mac("py314-mac-future-arm", ARM64); mac("py314-mac-future-intel", X64);
  for (const [arch, name] of [["arm64", "py314-mac-future-arm"], ["x64", "py314-mac-future-intel"]]) {
    Architecture.withArchitecture(arch, () => assert.equal(Patcher.findMacLibDir(root, 8).name, name));
  }
  fs.writeFileSync(path.join(root, Patcher.SDK_LAYOUT_FILE), JSON.stringify({macLibDirName: "py314-mac-future-intel"}));
  mac("py3-mac-universal", ARM64);
  assert.equal(Patcher.findMacLibDir(root, 8).name, "py314-mac-future-intel", "A recorded SDK choice survives a later extra layout");
});

test("Ren'Py legacy SDK patch records the Darwin platform and preserves game launch names", t => {
  const root = makeTempDir("renpy-darwin-patch-"); t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const sdkDir = path.join(root, "sdk"), gameDir = path.join(root, "game"), userDataDir = path.join(root, "profile");
  writeFile(path.join(sdkDir, "lib", "darwin-x86_64", "renpy"), "program");
  writeFile(path.join(gameDir, "MyGame.sh"), "#!/bin/sh\n");
  const options = {userDataDir, gameId: "darwin-game", gamePath: gameDir, contentRootDir: gameDir,
    renpyBaseName: "MyGame", renpyMajor: 7, sdkInstallDir: sdkDir, sdkVersion: "7.3.5"};
  const status = Patcher.patchGame(options);
  assert.equal(status.patched, true);
  assert.equal(status.platform, "darwin-x86_64");
  assert.equal(Patcher.readPatchMeta(userDataDir, options.gameId).macLibDirName, "darwin-x86_64");
  assert.equal(fs.readFileSync(path.join(gameDir, "lib", "darwin-x86_64", "MyGame"), "utf8"), "program");
  assert.equal(Patcher.unpatchGame(options).patched, false);
});

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

test("Ren'Py patching downloads the patch SDK only after consent", async t => {
  const RenPy = require("../src/modules/renpy/main");
  const PatchSdk = require("../src/modules/renpy/runtime/patch-sdk");
  const userDataDir = makeTempDir("maclauncher-renpy-user-"), gameDir = makeTempDir("maclauncher-renpy-game-");
  t.after(() => { fs.rmSync(userDataDir, { recursive: true, force: true }); fs.rmSync(gameDir, { recursive: true, force: true }); });
  writeFile(path.join(gameDir, "MyGame.sh"), "#!/bin/sh\n");
  const downloads = t.mock.method(PatchSdk, "preparePatchSdk", async () => { throw new Error("download attempted"); });
  const entry = { gameId: "consent-renpy", gamePath: gameDir, contentRootDir: gameDir,
    moduleData: { baseName: "MyGame", major: 8, version: "8.2.1" } };
  await assert.rejects(RenPy.actions.patch(entry, {}, { userDataDir }), /canceled/);
  await assert.rejects(RenPy.actions.patch(entry, {}, { userDataDir, confirmRuntimeInstall: async () => false }), /canceled/);
  assert.equal(downloads.mock.callCount(), 0);
  const plans = [];
  await assert.rejects(RenPy.actions.patch(entry, {}, { userDataDir, confirmRuntimeInstall: async plan => { plans.push(plan); return true; } }),
    /download attempted/);
  assert.equal(downloads.mock.callCount(), 1);
  assert.equal(plans[0].label, "Ren'Py patch SDK");
});
