const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const Backcompat = require("../src/modules/fvp/backcompat");
const Prepare = require("../src/modules/fvp/prepare");
const {retireLegacyGameMirror} = require("../src/core/backcompat/legacy-game-mirrors");

function released(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "fvp-backcompat-"));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const profile = path.join(root, "profile"), original = path.join(root, "Original");fs.mkdirSync(profile);fs.mkdirSync(original);
  const entry = {gameId: "released", moduleId: "fvp", gamePath: original, contentRootDir: original, saveDirOverride: null};
  const context = {userDataDir: profile}, moduleRoot = Prepare.directoryFor(entry, context), saves = path.join(moduleRoot, "saves");
  fs.mkdirSync(saves, {recursive: true});
  entry.defaultSaveDir = saves;entry.saveLocations = [{directory: saves, role: "primary", source: "RFVP private saves", confidence: "exact"}];
  entry.moduleData = {preparationDirectory: path.join(moduleRoot, "play")};
  return {root, profile, original, entry, context, moduleRoot, saves};
}

test("released active FVP adapter and save identities are not retired", t => {
  const f = released(t);fs.writeFileSync(path.join(f.saves, "rfvp_s000.bin"), "released slot");
  fs.mkdirSync(path.join(f.moduleRoot, "play"));
  const before = JSON.stringify(f.entry);
  assert.deepEqual(Backcompat.legacyGameMirrors(f.entry, f.context), []);
  assert.equal(JSON.stringify(f.entry), before);
  assert.equal(fs.readFileSync(path.join(f.saves, "rfvp_s000.bin"), "utf8"), "released slot");
  assert.equal(Prepare.saveDirectory(f.entry, f.context), f.saves);
});

test("replaced FVP view recovers missing bytes and preserves differing originals", async t => {
  const f = released(t), previous = path.join(f.moduleRoot, ".previous-1234");fs.mkdirSync(previous);
  fs.writeFileSync(path.join(previous, "user.cfg"), "private settings");fs.writeFileSync(path.join(previous, "extra.dat"), "sole bytes");
  fs.writeFileSync(path.join(f.original, "user.cfg"), "original settings");
  const before = JSON.stringify(f.entry), [descriptor] = Backcompat.legacyGameMirrors(f.entry, f.context);
  assert.equal(descriptor.mirrorRoot, previous);assert.equal(descriptor.sourceRoot, f.original);
  const result = await retireLegacyGameMirror(descriptor, f.context);
  assert.equal(result.complete, true);assert.equal(fs.existsSync(previous), false);
  assert.equal(fs.readFileSync(path.join(f.original, "extra.dat"), "utf8"), "sole bytes");
  assert.equal(fs.readFileSync(path.join(f.original, "user.cfg"), "utf8"), "original settings");
  const conflict = result.recoveredFiles.find(file => file.startsWith(path.join(f.original, "user.cfg.MacLauncher-conflict-")));
  assert.ok(conflict);assert.equal(fs.readFileSync(conflict, "utf8"), "private settings");assert.equal(fs.lstatSync(conflict).isSymbolicLink(), false);
  assert.equal(JSON.stringify(f.entry), before, "active released save/config identity stays unchanged");
});

test("FVP without replaced views performs no original-tree migration probe", t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "fvp-backcompat-absent-"));t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const original = path.join(root, "missing-original"), profile = path.join(root, "profile");fs.mkdirSync(profile);
  const lstat = fs.lstatSync, realpath = fs.realpathSync;
  t.mock.method(fs, "lstatSync", (file, ...args) => { assert.equal(String(file).startsWith(original), false);return lstat(file, ...args); });
  t.mock.method(fs, "realpathSync", (file, ...args) => { assert.equal(String(file).startsWith(original), false);return realpath(file, ...args); });
  assert.deepEqual(Backcompat.legacyGameMirrors({gameId: "never", gamePath: original}, {userDataDir: profile}), []);
  assert.equal(fs.existsSync(original), false);
});
