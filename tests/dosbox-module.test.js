const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { detectGame, inspectDosProgram } = require("../src/modules/dosbox/detect");
const { prepareGame, driveDirectory } = require("../src/modules/dosbox/prepare");

function temporary(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "dosbox-module-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
function mz(signature) {
  const bytes = Buffer.alloc(512); bytes.write("MZ"); bytes.writeUInt16LE(1, 4); bytes.writeUInt16LE(4, 8);
  if (signature) { bytes.writeUInt32LE(128, 0x3c); bytes.write(signature, 128); }
  return bytes;
}
function detect(file) {
  const stat = fs.statSync(file);
  return detectGame({ inputPath: file, rootDir: stat.isDirectory() ? file : path.dirname(file), stat, isAppBundle: false });
}
test("DOS detection validates executable content and separates Windows and OS/2 programs", t => {
  const root = temporary(t), file = path.join(root, "GAME.EXE");
  fs.writeFileSync(file, mz()); assert.equal(detect(file).moduleData.bits, 16);
  for (const signature of ["PE\0\0", "NE", "LX", "LE"]) {
    fs.writeFileSync(file, mz(signature)); assert.equal(detect(file), null, signature);
  }
  const extender = mz("LE"); extender.writeUInt16LE(3, 138); fs.writeFileSync(file, extender);
  assert.equal(detect(file).moduleData.bits, 32);
  fs.writeFileSync(file, Buffer.from("MZinvalid")); assert.equal(detect(file), null);
});
test("DOS imports COM/BAT directly and explains ambiguous folders without selecting a setup utility", t => {
  const root = temporary(t), com = path.join(root, "GAME.COM"), bat = path.join(root, "PLAY.BAT");
  fs.writeFileSync(com, Buffer.from([0xb8, 0, 0x4c, 0xcd, 0x21]));
  assert.equal(detect(root).moduleData.format, "com");
  fs.writeFileSync(bat, "@echo off\r\nGAME.COM\r\n");
  assert.equal(detect(bat).moduleData.format, "bat");
  assert.throws(() => detect(root), error => error.code === "DETECTION_CONFLICT");
  fs.writeFileSync(com, Buffer.from([127, 69, 76, 70])); assert.equal(detect(com), null);
  assert.equal(detect(bat), null, "A batch file needs a matching DOS program rather than a Windows-style script alone");
  fs.writeFileSync(bat, "#!/bin/sh\necho hello"); assert.equal(detect(bat), null);
});
test("DOS preparation uses the original program directory without walking or copying game files", async t => {
  const root = temporary(t), source = path.join(root, "Game original"); fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, "GAME.EXE"), mz()); fs.writeFileSync(path.join(source, "DATA.DAT"), "old");
  fs.writeFileSync(path.join(source, "GAME.SAV"), "original save");
  const entry = { ...detect(path.join(source, "GAME.EXE")), gameId: "game-1" }, context = { userDataDir: path.join(root, "profile") };
  assert.equal(fs.existsSync(context.userDataDir), false);
  assert.equal(driveDirectory(entry, context), source);
  const readdir = t.mock.method(fs, "readdirSync", () => assert.fail("Play does not enumerate the game or old mirrors"));
  const launch = await prepareGame(entry, context);
  assert.equal(launch.executable, path.join(source, "GAME.EXE"));
  assert.equal(launch.drive, source);
  assert.equal(fs.existsSync(path.join(launch.directory, "drive-c")), false);
  assert.equal(fs.existsSync(path.join(launch.directory, "files.json")), false);
  fs.writeFileSync(path.join(launch.drive, "GAME.SAV"), "new save");
  fs.writeFileSync(path.join(source, "DATA.DAT"), "updated game data");
  await prepareGame(entry, context);
  assert.equal(fs.readFileSync(path.join(launch.drive, "DATA.DAT"), "utf8"), "updated game data");
  assert.equal(fs.readFileSync(path.join(launch.drive, "GAME.SAV"), "utf8"), "new save");
  assert.equal(entry.defaultSaveDir, launch.drive);
  assert.equal(fs.statSync(launch.executable).ino, fs.statSync(path.join(source, "GAME.EXE")).ino);
  readdir.mock.restore();
});
test("DOS helper preparation rejects linked module ancestors before writing outside the profile", async t => {
  const root = temporary(t), source = path.join(root, "game"), outside = path.join(root, "outside");
  fs.mkdirSync(source); fs.mkdirSync(outside); fs.writeFileSync(path.join(source, "GAME.EXE"), mz());
  fs.writeFileSync(path.join(outside, "keep.txt"), "unchanged");
  const entry = { ...detect(path.join(source, "GAME.EXE")), gameId: "linked-modules" };
  const userDataDir = path.join(root, "profile"), gameRoot = path.join(userDataDir, "games", entry.gameId);
  fs.mkdirSync(gameRoot, { recursive: true }); fs.symlinkSync(outside, path.join(gameRoot, "modules"));
  await assert.rejects(prepareGame(entry, { userDataDir }), /alias|symbolic|link/i);
  assert.deepEqual(fs.readdirSync(outside), ["keep.txt"]);
  assert.equal(fs.readFileSync(path.join(outside, "keep.txt"), "utf8"), "unchanged");
  assert.equal(fs.existsSync(path.join(outside, "dosbox")), false);
  assert.equal(fs.existsSync(path.join(source, "dosbox.conf")), false);
});
test("DOS explicit override preserves the released writable drive and excludes active migration trees", async t => {
  const root = temporary(t), source = path.join(root, "game"); fs.mkdirSync(source); fs.writeFileSync(path.join(source, "GAME.EXE"), mz());
  const entry = { ...detect(path.join(source, "GAME.EXE")), gameId: "game-2" }, context = { userDataDir: path.join(root, "profile") };
  entry.saveDirOverride = path.join(root, "selected-saves");
  fs.mkdirSync(entry.saveDirOverride); fs.writeFileSync(path.join(entry.saveDirOverride, "GAME.SAV"), "selected save");
  const legacy = path.join(context.userDataDir, "games", entry.gameId, "modules", "dosbox", "drive-c");
  fs.mkdirSync(legacy, { recursive: true }); fs.writeFileSync(path.join(legacy, "GAME.SAV"), "legacy save");
  fs.writeFileSync(path.join(source, "DATA.DAT"), "old asset");
  const launch = await prepareGame(entry, context);
  assert.equal(launch.drive, entry.saveDirOverride);
  assert.equal(launch.executable, path.join(entry.saveDirOverride, "GAME.EXE"));
  assert.deepEqual(fs.readFileSync(launch.executable), mz());
  assert.equal(entry.saveDirOverride, path.join(root, "selected-saves"));
  assert.equal(fs.readFileSync(path.join(entry.saveDirOverride, "GAME.SAV"), "utf8"), "selected save");
  assert.equal(fs.readFileSync(path.join(legacy, "GAME.SAV"), "utf8"), "legacy save");
  assert.equal(require("../src/modules/dosbox/main").resolveSaveLocations(entry).primaryDirectory, entry.saveDirOverride);
  fs.writeFileSync(path.join(source, "DATA.DAT"), "updated asset bytes");
  await prepareGame(entry, context);
  assert.equal(fs.readFileSync(path.join(launch.drive, "DATA.DAT"), "utf8"), "updated asset bytes");
  assert.equal(fs.readFileSync(path.join(launch.drive, "GAME.SAV"), "utf8"), "selected save");
  assert.equal(fs.existsSync(path.join(source, "GAME.SAV")), false);
  const Backcompat = require("../src/modules/dosbox/backcompat");
  assert.deepEqual(Backcompat.legacyGameMirrors(entry, context).map(row => row.mirrorRoot), [legacy]);
  for (const override of [legacy, path.dirname(legacy), path.join(legacy, "nested")])
    assert.deepEqual(Backcompat.legacyGameMirrors({ ...entry, saveDirOverride: override }, context), []);
  const Module = require("../src/modules/dosbox/main"), command = Module.__test.launchArguments(entry, { ...context, gameArguments: ["-test"] }, launch, "0.83.0");
  assert.ok(command.args.includes(`mount c "${entry.saveDirOverride}"`));
  await assert.rejects(prepareGame({ ...entry, saveDirOverride: path.join(source, "output") }, context), /outside the original/);
});
test("DOS launch keeps configuration private and transports game arguments without runtime flag injection", t => {
  const Module = require("../src/modules/dosbox/main"), root = temporary(t);
  const launch = { directory: root, drive: path.join(root, "drive-c"), executable: path.join(root, "drive-c", "GAME.EXE") };
  const result = Module.__test.launchArguments({}, { runtimeSettings: {}, gameArguments: [] }, launch, "0.83.0");
  assert.deepEqual(result.args, ["-noprimaryconf", "-nolocalconf", "-conf", path.join(root, "dosbox.conf"), launch.executable]);
  assert.match(fs.readFileSync(result.configPath, "utf8"), /cycles=auto/);
  const command = Module.__test.launchArguments({}, { runtimeSettings: { cycles: "5000" }, gameArguments: ["--conf", "space value"] }, launch, "0.78.0");
  assert.equal(command.args.filter(arg => arg === "--conf").length, 0);
  assert.ok(command.args.includes('GAME.EXE --conf "space value"'));
  assert.ok(command.args.includes(`mount c "${path.dirname(launch.executable)}"`));
  assert.throws(() => Module.__test.launchArguments({}, { runtimeSettings: { cycles: "auto\n[autoexec]" } }, launch, "0.83.0"), /cycles/);
  assert.throws(() => Module.__test.dosArgument("arg > output"), /redirection/);
});

test("DOS detection uses bounded offline headers and stays behind recognized game engines", t => {
  const root = temporary(t), file = path.join(root, "GAME.EXE"); fs.writeFileSync(file, mz());
  const reads = [], detected = inspectDosProgram(file, { stat: fs.statSync, readBytes: (name, offset, size) => {
    reads.push({ offset, size }); return fs.readFileSync(name).subarray(offset, offset + size);
  } });
  assert.equal(detected.format, "exe"); assert.deepEqual(reads, [{ offset: 0, size: 64 }]);
  fs.writeFileSync(path.join(root, "WINDOWS.EXE"), mz("PE\0\0"));
  assert.throws(() => detect(root), error => error.code === "DETECTION_CONFLICT");
  const Registry = require("../src/modules/registry");
  assert.equal(Registry.detectGame(file).moduleId, "dosbox");
  fs.writeFileSync(path.join(root, "RESOURCE.MAP"), "map"); fs.writeFileSync(path.join(root, "RESOURCE.000"), "data");
  assert.equal(Registry.detectGame(file).moduleId, "scummvm");
});
