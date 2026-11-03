const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const Module = require("../src/modules/crossover/backcompat");

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "crossover-mirror-descriptors-")));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const userDataDir = path.join(root, "profile"), sourceRoot = path.join(root, "original");
  return {root, userDataDir, sourceRoot, entry: {gameId: "windows-game", gamePath: sourceRoot, runtimeData: {crossover: {sourceRoot}}}};
}

test("Windows mirror descriptors cover only obsolete general game roots with exact original paths", t => {
  const f = fixture(t), alternate = path.join(f.root, "second-original");
  f.entry.runtimeData.sikarugir = {sourceRoot: alternate};
  const rows = Module.legacyGameMirrors(f.entry, f);
  assert.deepEqual(rows, [
    {mirrorRoot: path.join(f.userDataDir, "games/windows-game/runtimes/crossover/game"), sourceRoot: f.sourceRoot, generated: []},
    {mirrorRoot: path.join(f.userDataDir, "games/windows-game/runtimes/sikarugir/game"), sourceRoot: alternate, generated: []}
  ]);
  const currentSource = fs.readFileSync(require.resolve("../src/modules/crossover/main"), "utf8");
  assert.doesNotMatch(currentSource, /legacyGameMirrors|backcompat/, "ordinary module source contains no legacy hook or backcompat import");
  assert.equal(fs.existsSync(f.userDataDir), false, "descriptor construction creates no profile or mirror");
});

test("descriptor discovery never scans originals or runtime folders and leaves live inputs out", t => {
  const f = fixture(t), directory = path.join(f.userDataDir, "games/windows-game/runtimes/sikarugir");
  for (const name of ["bottles", "prefixes", "runtime-view", "temporal-camera-11111111-1111-1111-1111-111111111111"]) fs.mkdirSync(path.join(directory, name), {recursive: true});
  const receipt = path.join(directory, "game-files.json");fs.writeFileSync(receipt, "sibling receipt remains");
  t.mock.method(fs, "readdirSync", () => assert.fail("descriptor discovery must not enumerate a directory"));
  assert.equal(Module.legacyGameMirrors(f.entry, f).length, 2);
  assert.equal(fs.readFileSync(receipt, "utf8"), "sibling receipt remains");
});

test("an existing legacy camera view leaves migration pending without interpreting proxies or links", t => {
  const f = fixture(t), directory = path.join(f.userDataDir, "games/windows-game/runtimes/crossover"), view = path.join(directory, "temporal-camera");
  fs.mkdirSync(view, {recursive: true});fs.writeFileSync(path.join(view, "Save01.dat"), "private save");
  fs.symlinkSync(path.join(directory, "game/Assets"), path.join(view, "Assets"));
  const receipt = path.join(directory, "temporal-camera.json");fs.writeFileSync(receipt, "uninterpreted proxy receipt");
  assert.throws(() => Module.legacyGameMirrors(f.entry, f), /CrossOver graphics launch folder at runtimes\/crossover\/temporal-camera that cannot be recovered automatically/);
  assert.equal(fs.readFileSync(path.join(view, "Save01.dat"), "utf8"), "private save");
  assert.equal(fs.readFileSync(receipt, "utf8"), "uninterpreted proxy receipt");
  assert.equal(fs.readlinkSync(path.join(view, "Assets")), path.join(directory, "game/Assets"));
});

test("legacy original projections and unknown view links are retained rather than declared generated", t => {
  const f = fixture(t), directory = path.join(f.userDataDir, "games/windows-game/runtimes/sikarugir");
  fs.mkdirSync(directory, {recursive: true});fs.symlinkSync(f.sourceRoot, path.join(directory, "temporal-original"));
  assert.throws(() => Module.legacyGameMirrors(f.entry, f), /Sikarugir graphics launch folder at runtimes\/sikarugir\/temporal-original/);
  assert.equal(fs.readlinkSync(path.join(directory, "temporal-original")), f.sourceRoot);
});

test("single-file imports use the containing original folder without inspecting it", t => {
  const f = fixture(t);delete f.entry.runtimeData;f.entry.gamePath = path.join(f.sourceRoot, "Game.exe");
  assert.ok(Module.legacyGameMirrors(f.entry, f).every(row => row.sourceRoot === f.sourceRoot));
  assert.deepEqual(Module.legacyGameMirrors({gamePath: f.sourceRoot}, f), []);
});

test("legacy writable paths map lexically to original roots and explicit baseline saves stay protected", t => {
  const f = fixture(t), writable = path.join(f.userDataDir, "games/windows-game/modules/crossover/writable-input/files");
  f.entry.moduleData = {writableInput: {schemaVersion: 1, root: writable, sourceRoot: f.sourceRoot}};
  f.entry.contentRootDir = path.join(writable, "fallback");
  f.entry.runtimeData = {crossover: {sourceRoot: path.join(writable, "CrossOver")}, sikarugir: {sourceRoot: path.join(writable, "Sikarugir")}};
  const recorded = Module.legacyGameMirrors(f.entry, f);
  assert.deepEqual(recorded.map(row => row.sourceRoot), [path.join(f.sourceRoot, "CrossOver"), path.join(f.sourceRoot, "Sikarugir")]);
  delete f.entry.runtimeData;
  assert.ok(Module.legacyGameMirrors(f.entry, f).every(row => row.sourceRoot === path.join(f.sourceRoot, "fallback")));
  assert.equal(f.entry.contentRootDir, path.join(writable, "fallback"), "descriptor normalization does not mutate the saved entry");
  const crossover = recorded[0].mirrorRoot, sikarugir = recorded[1].mirrorRoot;
  for (const override of [crossover, path.join(crossover, "Saves"), path.dirname(crossover)]) {
    f.entry.saveDirOverride = override;
    assert.deepEqual(Module.legacyGameMirrors(f.entry, f).map(row => row.mirrorRoot), [sikarugir]);
  }
  f.entry.saveDirOverride = f.userDataDir;
  assert.deepEqual(Module.legacyGameMirrors(f.entry, f), []);
  assert.equal(fs.existsSync(f.userDataDir), false, "normalization and save protection inspect no source or profile bytes");
});


test("shared Windows backcompat handles other modules and retains unknown-source legacy data", t => {
  const f = fixture(t);
  f.entry.moduleId = "unity";
  assert.equal(Module.legacyGameMirrors(f.entry, f).length, 2, "engine entries keep their recorded Windows provider roots");
  const unrelated = {gameId: "renpy-missing", moduleId: "renpy"};
  const list = fs.readdirSync;
  t.mock.method(fs, "readdirSync", () => assert.fail("shared discovery must not enumerate sources or runtime folders"));
  assert.deepEqual(Module.legacyGameMirrors(unrelated, f), [], "no source and no old roots needs no migration");
  const root = path.join(f.userDataDir, "games", unrelated.gameId, "runtimes/crossover/game");
  fs.mkdirSync(root, {recursive: true});const save = path.join(root, "Save01.dat");fs.writeFileSync(save, "sole private save");
  assert.throws(() => Module.legacyGameMirrors(unrelated, f), /CrossOver game copy at runtimes\/crossover\/game, and its original Windows game folder is unknown/);
  assert.equal(fs.readFileSync(save, "utf8"), "sole private save");
  fs.readdirSync.mock.restore();
  assert.deepEqual(list(root), ["Save01.dat"]);
  assert.throws(() => Module.legacyGameMirrors({...unrelated, gameId: "../escape"}, f), /saved game and launcher data directory/);
  assert.throws(() => Module.legacyGameMirrors(unrelated, {userDataDir: "relative"}), /saved game and launcher data directory/);
});
