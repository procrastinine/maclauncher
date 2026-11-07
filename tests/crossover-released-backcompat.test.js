// Released v0.5.1 game/ recovery into the current original-path launch route.
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const Backcompat = require("../src/modules/crossover/backcompat");
const {retireLegacyGameMirror} = require("../src/core/backcompat/legacy-game-mirrors");
const Detection = require("../src/modules/crossover/detect");
const CrossOver = require("../src/modules/crossover/runtime/launch"), Wine = require("../src/modules/crossover/sikarugir/launch");
const Manager = require("../src/modules/crossover/runtime/manager"), Temporal = require("../src/modules/crossover/temporal");

function put(file, bytes) {fs.mkdirSync(path.dirname(file), {recursive: true});fs.writeFileSync(file, bytes);return file;}
function pe(file) {
  const bytes = Buffer.alloc(1024);
  bytes.writeUInt16LE(0x5a4d);bytes.writeUInt32LE(128, 60);bytes.writeUInt32LE(0x4550, 128);
  bytes.writeUInt16LE(0x14c, 132);bytes.writeUInt16LE(1, 134);bytes.writeUInt16LE(240, 148);bytes.writeUInt16LE(2, 150);
  bytes.writeUInt16LE(0x10b, 152);bytes.writeUInt16LE(2, 220);return put(file, bytes);
}
function nativeHeader(file, architecture = "arm64") {
  const bytes = Buffer.alloc(32);bytes.writeUInt32LE(0xfeedfacf);bytes.writeUInt32LE(architecture === "arm64" ? 0x0100000c : 0x01000007, 4);bytes.writeUInt32LE(2, 12);
  return put(file, bytes);
}
function fixture(t, runtimeId) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "windows-released-backcompat-")));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const userDataDir = path.join(root, "profile"), sourceRoot = path.join(root, "original"), original = pe(path.join(sourceRoot, "Game.exe"));
  const entry = {...Detection.decorateEntry({gameId: "released-windows", moduleId: "unity", gamePath: sourceRoot, importPath: original}), runtimeId};
  entry.runtimeData[runtimeId] = {...entry.runtimeData[runtimeId], sourceRoot};
  // v0.5.1 stageGameFiles: runtimeDirectory/game and sibling layoutVersion 2 receipt.
  const directory = path.join(userDataDir, "games", entry.gameId, "runtimes", runtimeId), mirrorRoot = path.join(directory, "game");
  put(path.join(mirrorRoot, "Game.exe"), fs.readFileSync(original));
  put(path.join(mirrorRoot, "Portable/Save01.dat"), "released private portable save");
  put(path.join(mirrorRoot, "settings.ini"), "released private config");
  put(path.join(sourceRoot, "settings.ini"), "existing original config");
  put(path.join(directory, "game-files.json"), JSON.stringify({sourceRoot, files: {}, fileCount: 1, layoutVersion: 2}));
  t.mock.method(Temporal, "resolvePlan", () => null);t.mock.method(Temporal, "resolveScenePlan", () => null);
  return {root, userDataDir, sourceRoot, original, entry, directory, mirrorRoot};
}
// A Windows launch path resolves through the profile's own drive mapping.
function driveTarget(profile, windowsPath) {
  const [drive, ...parts] = windowsPath.split("\\");
  return path.join(fs.realpathSync(path.join(profile, "dosdevices", drive.toLowerCase())), ...parts.filter(Boolean));
}
function unchangedFile(file) {const info = fs.statSync(file);return {bytes: fs.readFileSync(file).toString("hex"), ino: info.ino, mtimeMs: info.mtimeMs};}

for (const runtimeId of ["crossover", "sikarugir"]) test("released " + runtimeId + " bytes recover into the actual current working directory and preserve Windows profile identity", async t => {
  const f = fixture(t, runtimeId), version = runtimeId === "crossover" ? "local-0123456789abcdef" : "WS12WineSikarugir11.0_1", context = {userDataDir: f.userDataDir, settings: {}, runtimeSettings: {}};
  let profile, dependencies;
  if (runtimeId === "crossover") {
    const crossoverRoot = path.join(f.root, "CrossOver.app/Contents/SharedSupport/CrossOver");
    const install = {appPath: path.join(f.root, "CrossOver.app"), crossoverRoot, needsRosetta: false,
      executablePath: nativeHeader(path.join(crossoverRoot, "bin/wine")), serverPath: nativeHeader(path.join(crossoverRoot, "bin/wineserver")),
      loaderPath: nativeHeader(path.join(crossoverRoot, "bin/wineloader")), bottleToolPath: nativeHeader(path.join(crossoverRoot, "bin/cxbottle"))};
    t.mock.method(Manager, "resolveSelection", () => ({ready: true, version, install}));
    // Released runtime/launch.js:356; unchanged application + environment bottle key.
    profile = path.join(f.directory, "bottles", version + "-win10_64");
    put(path.join(profile, "cxbottle.conf"), "[Bottle]\n");put(path.join(profile, "system.reg"), "released registry");
    dependencies = {run: async () => assert.fail("completed released bottle must not execute setup")};
  } else {
    const wineRoot = path.join(f.root, "wine/wswine.bundle");
    const install = {installDir: path.dirname(wineRoot), wineRoot, needsRosetta: false,
      executablePath: nativeHeader(path.join(wineRoot, "bin/wine"), "x64"), serverPath: nativeHeader(path.join(wineRoot, "bin/wineserver"), "x64"), capabilities: {msync: false, esync: false}};
    // Released sikarugir/launch.js:316-320; unchanged engine + Windows-version key.
    const identity = crypto.createHash("sha256").update(JSON.stringify([version, null])).digest("hex").slice(0, 20);
    profile = path.join(f.directory, "prefixes", identity + "-win10");
    put(path.join(profile, "system.reg"), "released registry");put(path.join(profile, "user.reg"), "released user registry");
    put(path.join(profile, "maclauncher-prefix.json"), JSON.stringify({schemaVersion: 1, windowsVersion: "win10"}));
    dependencies = {manager: {resolveSelection: () => ({ready: true, version, install})}, host: {platform: "darwin", hardwareArch: "arm64", macOSVersion: "26.0"},
      rosetta: {isAvailable: () => true, ensure: () => assert.fail("no Rosetta operation")},
      prepareGraphicsView: async () => ({executablePath: install.executablePath, serverPath: install.serverPath, graphicsBackend: "wined3d", env: {}, capabilities: install.capabilities}),
      run: async () => assert.fail("completed released prefix must not execute setup")};
  }
  f.entry.runtimeData[runtimeId][runtimeId === "crossover" ? "bottlePath" : "prefixPath"] = profile;
  const oldProfile = profile;
  const profileSave = put(path.join(profile, "drive_c/users/player/profile.sav"), "released Windows profile save"), before = unchangedFile(profileSave);
  const descriptors = Backcompat.legacyGameMirrors(f.entry, f), descriptor = descriptors.find(row => row.mirrorRoot === f.mirrorRoot);
  assert.ok(descriptor, "the released root has an exact declared recovery descriptor");
  const result = await retireLegacyGameMirror(descriptor, {userDataDir: f.userDataDir});
  assert.equal(result.complete, true, result.reason);
  assert.equal(fs.existsSync(f.mirrorRoot), false, "the sole private bytes have been recovered before root retirement");
  const adoption = Backcompat.migrateLegacyGameData(f.entry, {userDataDir: f.userDataDir});
  assert.equal(adoption.complete, true, adoption.reason);Object.assign(f.entry, adoption.entryPatch);
  profile = path.join(f.directory, runtimeId === "crossover" ? "bottles/win10_64" : "prefixes/win10");
  assert.equal(fs.existsSync(oldProfile), false, "the old environment is adopted in place, not copied");
  const launch = await (runtimeId === "crossover" ? CrossOver : Wine).prepareLaunch(f.entry, context, dependencies);
  assert.equal(launch.gameRoot, f.sourceRoot);assert.equal(launch.workingDirectory, f.sourceRoot);assert.equal(launch.executablePath, f.original);
  assert.equal(fs.readFileSync(path.join(launch.workingDirectory, "Portable/Save01.dat"), "utf8"), "released private portable save", "recovered bytes sit in the actual current relative load path");
  assert.equal(fs.readFileSync(path.join(launch.workingDirectory, "settings.ini"), "utf8"), "existing original config");
  const conflicts = fs.readdirSync(launch.workingDirectory).filter(name => name.startsWith("settings.ini.MacLauncher-conflict-"));
  assert.equal(conflicts.length, 1);assert.equal(fs.readFileSync(path.join(launch.workingDirectory, conflicts[0]), "utf8"), "released private config");
  assert.equal(launch.bottlePath || launch.prefixPath, profile, "released per-game Windows save environment adopts its stable identity");
  assert.deepEqual(unchangedFile(path.join(profile, "drive_c/users/player/profile.sav")), before, "migration and current planning leave profile bytes, inode and mtime unchanged");
  assert.equal(descriptors.some(row => row.mirrorRoot === profile || profile.startsWith(row.mirrorRoot + path.sep)), false);
  assert.equal(driveTarget(profile, launch.windowsWorkingDirectory), fs.realpathSync(launch.workingDirectory));
  assert.equal(driveTarget(profile, launch.windowsExecutablePath), fs.realpathSync(f.original));
  if (runtimeId === "crossover") {
    assert.equal(launch.args[launch.args.indexOf("--workdir") + 1], launch.windowsWorkingDirectory);
    assert.equal(launch.args[launch.args.indexOf("--") + 1], launch.windowsExecutablePath);
  } else {
    assert.deepEqual(launch.args.slice(0, 5), ["start.exe", "/d", launch.windowsWorkingDirectory, "/exec", launch.windowsExecutablePath]);
    const markerPath = path.join(profile, "maclauncher-prefix.json"), marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    assert.equal(typeof marker.runtimeIdentity, "string");assert.ok(marker.runtimeIdentity.length > 0);
    const recorded = unchangedFile(markerPath);
    await Wine.prepareLaunch(f.entry, context, dependencies);
    assert.deepEqual(unchangedFile(markerPath), recorded, "recorded identity is reused without setup or another marker write");
    const saves = require("../src/modules/crossover/sikarugir/provider").resolveSaveLocations(f.entry, context);
    assert.equal(saves.primaryDirectory, launch.workingDirectory);assert.ok(saves.directories.some(row => row.directory === path.join(profile, "drive_c/users")));
  }
});

test("released fixed-name camera views remain explicitly blocked with their backing baseline intact", t => {
  const f = fixture(t, "crossover"), view = path.join(f.directory, "temporal-camera");
  put(path.join(view, "Portable/Save02.dat"), "unresolved camera save");
  fs.symlinkSync(path.join(f.mirrorRoot, "Portable"), path.join(view, "Assets"));
  assert.throws(() => Backcompat.legacyGameMirrors(f.entry, f), /CrossOver graphics launch folder at runtimes\/crossover\/temporal-camera that cannot be recovered automatically/);
  assert.equal(fs.readFileSync(path.join(view, "Portable/Save02.dat"), "utf8"), "unresolved camera save");
  assert.equal(fs.readFileSync(path.join(f.mirrorRoot, "Portable/Save01.dat"), "utf8"), "released private portable save");
});
