// Released v0.5.1 environment keys adopt into stable per-game Windows profiles.
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const Backcompat = require("../src/modules/crossover/backcompat");
const names = {crossover: ["bottles", "bottlePath", "local-1111111111111111-win10_64", "local-2222222222222222-win10_64", "win10_64"], sikarugir: ["prefixes", "prefixPath", "11111111111111111111-win10", "22222222222222222222-win10", "win10"]};
function fixture(t, runtimeId) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "windows-profiles-backcompat-")));t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const userDataDir = path.join(root, "profile"), [folder, field, a, b, key] = names[runtimeId], parent = path.join(userDataDir, "games/stable-game/runtimes", runtimeId, folder);
  return {root, userDataDir, runtimeId, field, parent, a: path.join(parent, a), b: path.join(parent, b), target: path.join(parent, key), entry: {gameId: "stable-game", moduleId: "unity", gamePath: path.join(root, "source"), runtimeData: {}}};
}
function put(directory, bytes, time = 1700000000000) {
  fs.mkdirSync(path.join(directory, "drive_c/users/player"), {recursive: true});
  fs.writeFileSync(path.join(directory, "drive_c/users/player/save.dat"), bytes);fs.writeFileSync(path.join(directory, "user.reg"), bytes);
  fs.utimesSync(path.join(directory, "user.reg"), new Date(time), new Date(time));
  return fs.statSync(path.join(directory, "drive_c/users/player/save.dat")).ino;
}
for (const runtimeId of Object.keys(names)) test("stable Windows profile migration prefers recorded last use and preserves other " + runtimeId + " profiles", t => {
  const f = fixture(t, runtimeId), ino = put(f.a, "recorded profile", 1600000000000);put(f.b, "newer timestamp, not recorded", 1800000000000);
  f.entry.runtimeData[runtimeId] = {[f.field]: f.a};
  fs.mkdirSync(path.join(f.a, "dosdevices"));fs.symlinkSync("../drive_c", path.join(f.a, "dosdevices/c:"));fs.symlinkSync("/", path.join(f.a, "dosdevices/z:"));
  f.entry.defaultSaveDir = path.join(f.a, "drive_c/users/player");f.entry.saveDirOverride = path.join(f.a, "drive_c/users/player/override");
  f.entry.saveLocations = [{directory: f.entry.defaultSaveDir}, {directory: "/unrelated/game-save"}];
  const snapshot = JSON.stringify(f.entry), result = Backcompat.migrateLegacyGameData(f.entry, f);
  assert.equal(result.complete, true, result.reason);assert.equal(JSON.stringify(f.entry), snapshot, "the hook returns a data patch without editing its snapshot");
  assert.equal(fs.existsSync(f.a), false);assert.equal(fs.readFileSync(path.join(f.target, "drive_c/users/player/save.dat"), "utf8"), "recorded profile");
  assert.equal(fs.statSync(path.join(f.target, "drive_c/users/player/save.dat")).ino, ino, "the profile is renamed, never copied");
  assert.equal(fs.readlinkSync(path.join(f.target, "dosdevices/c:")), "../drive_c");assert.equal(fs.realpathSync(path.join(f.target, "dosdevices/c:")), path.join(f.target, "drive_c"));assert.equal(fs.readlinkSync(path.join(f.target, "dosdevices/z:")), "/");
  assert.equal(fs.readFileSync(path.join(f.b, "drive_c/users/player/save.dat"), "utf8"), "newer timestamp, not recorded");
  assert.equal(result.entryPatch.runtimeData[runtimeId][f.field], f.target);assert.deepEqual(result.entryPatch.runtimeData[runtimeId].retainedWindowsProfiles.map(row => row.path), [f.b]);
  assert.equal(result.entryPatch.defaultSaveDir, path.join(f.target, "drive_c/users/player"));assert.equal(result.entryPatch.saveDirOverride, path.join(f.target, "drive_c/users/player/override"));
  assert.deepEqual(result.entryPatch.saveLocations, [{directory: path.join(f.target, "drive_c/users/player")}, {directory: "/unrelated/game-save"}]);
});
test("stable Windows profile migration falls back to registry times and refuses ties or unknown use", t => {
  const f = fixture(t, "sikarugir");put(f.a, "earlier", 1600000000000);put(f.b, "later", 1800000000000);
  assert.equal(Backcompat.migrateLegacyGameData(f.entry, f).complete, true);assert.equal(fs.readFileSync(path.join(f.target, "user.reg"), "utf8"), "later");
  const tied = fixture(t, "crossover");put(tied.a, "one");put(tied.b, "two");
  const tie = Backcompat.migrateLegacyGameData(tied.entry, tied);assert.equal(tie.complete, false);assert.match(tie.reason, /last used at the same time/);assert.equal(fs.existsSync(tied.target), false);assert.ok(fs.existsSync(tied.a));assert.ok(fs.existsSync(tied.b));
  fs.unlinkSync(path.join(tied.a, "user.reg"));const unknown = Backcompat.migrateLegacyGameData(tied.entry, tied);assert.equal(unknown.complete, false);assert.match(unknown.reason, /could not tell which earlier Windows environment was used last/);
});
test("stable Windows profile migration keeps an existing stable profile and never remaps unmoved paths", t => {
  const f = fixture(t, "sikarugir");put(f.a, "old");const ino = put(f.target, "stable");f.entry.runtimeData.sikarugir = {prefixPath: f.a};f.entry.defaultSaveDir = path.join(f.a, "drive_c/users/player");
  const result = Backcompat.migrateLegacyGameData(f.entry, f);assert.equal(result.complete, true, result.reason);assert.equal(result.entryPatch.runtimeData.sikarugir.prefixPath, f.target);
  assert.equal(result.entryPatch.defaultSaveDir, undefined);assert.equal(fs.statSync(path.join(f.target, "drive_c/users/player/save.dat")).ino, ino);assert.ok(fs.existsSync(f.a));
});
test("stable Windows profile migration retains unsafe links, absolute internal drive mappings and failed renames", t => {
  const f = fixture(t, "crossover");put(f.a, "safe bytes");f.entry.runtimeData.crossover = {bottlePath: f.a};fs.mkdirSync(path.join(f.a, "dosdevices"));fs.symlinkSync(path.join(f.a, "drive_c"), path.join(f.a, "dosdevices/c:"));
  const absolute = Backcompat.migrateLegacyGameData(f.entry, f);assert.equal(absolute.complete, false);assert.match(absolute.reason, /points into the earlier Windows environment by its full path/);assert.ok(fs.existsSync(f.a));
  fs.unlinkSync(path.join(f.a, "dosdevices/c:"));t.mock.method(fs, "renameSync", () => {throw Error("controlled adoption failure");});
  const failed = Backcompat.migrateLegacyGameData(f.entry, f);assert.equal(failed.complete, false);assert.match(failed.reason, /controlled adoption failure/);assert.equal(fs.readFileSync(path.join(f.a, "user.reg"), "utf8"), "safe bytes");assert.equal(fs.existsSync(f.target), false);
  fs.renameSync.mock.restore();fs.symlinkSync(f.a, f.b);const linked = Backcompat.migrateLegacyGameData(f.entry, f);assert.equal(linked.complete, false);assert.match(linked.reason, /is a symbolic link or not a folder/);
});
test("stable Windows profile migration does nothing for entries without earlier environments", t => {
  const f = fixture(t, "sikarugir");assert.deepEqual(Backcompat.migrateLegacyGameData(f.entry, f), {complete: true});assert.equal(fs.existsSync(f.userDataDir), false);
});


test("stable Windows profile migration persists an earlier adoption when a later rename fails", t => {
  const f = fixture(t, "crossover"), wineParent = path.join(f.userDataDir, "games/stable-game/runtimes/sikarugir/prefixes"), wineOld = path.join(wineParent, "11111111111111111111-win10");
  put(f.a, "bottle save");put(wineOld, "prefix save");f.entry.runtimeData = {crossover: {bottlePath: f.a}, sikarugir: {prefixPath: wineOld}};
  f.entry.defaultSaveDir = path.join(f.a, "drive_c/users/player");const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (from, to) => {if (from === wineOld) throw Error("second adoption denied");return rename(from, to);});
  const result = Backcompat.migrateLegacyGameData(f.entry, f);
  assert.equal(result.complete, true, result.reason);assert.equal(result.entryPatch.runtimeData.crossover.bottlePath, f.target);assert.equal(result.entryPatch.defaultSaveDir, path.join(f.target, "drive_c/users/player"));
  assert.equal(result.entryPatch.runtimeData.sikarugir.prefixPath, wineOld);assert.ok(result.entryPatch.runtimeData.sikarugir.retainedWindowsProfiles.some(row => row.path === wineOld && row.blocked));
  assert.ok(result.retained.some(row => row.path === wineOld && row.blocked));assert.equal(fs.readFileSync(path.join(wineOld, "user.reg"), "utf8"), "prefix save");
});


test("stable Windows profile migration honors a recorded empty environment without merging older saves", t => {
  const f = fixture(t, "sikarugir");fs.mkdirSync(f.a, {recursive: true});put(f.b, "older retained save");f.entry.runtimeData.sikarugir = {prefixPath: f.a};
  const result = Backcompat.migrateLegacyGameData(f.entry, f);assert.equal(result.complete, true, result.reason);assert.equal(result.entryPatch.runtimeData.sikarugir.prefixPath, f.target);
  assert.deepEqual(fs.readdirSync(f.target), []);assert.equal(fs.readFileSync(path.join(f.b, "user.reg"), "utf8"), "older retained save");
});
