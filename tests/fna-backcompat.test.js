const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const Fna = require("../src/modules/fna/backcompat");

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-fna-mirrors-"));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const userDataDir = path.join(directory, "profile"), sourceRoot = path.join(directory, "original");
  const root = path.join(userDataDir, "games", "saved-game", "modules", "fna");
  return {directory, userDataDir, sourceRoot, root,
    entry: {gameId: "saved-game", moduleId: "fna", gamePath: path.join(sourceRoot, "Game.exe")}};
}

test("FNA declares only legacy overlay children and the shared view without inspecting original bytes", t => {
  const f = fixture(t), overlay = path.join(f.root, "overlays", "runtime"), previous = path.join(f.root, "previous-overlays", "older");
  const current = ["assemblies", "steam-api", "decompiled", "runtimes"];
  for (const directory of [overlay, previous, ...current.map(name => path.join(f.root, name))]) fs.mkdirSync(directory, {recursive: true});
  const privateFiles = ["Game.dll", "MacLauncherFnaHost.dll", "Game.runtimeconfig.json", "save.dat", ".maclauncher-fna.json"];
  for (const name of privateFiles) fs.writeFileSync(path.join(previous, name), "private " + name);
  fs.writeFileSync(path.join(f.root, "overlays", "not-a-directory"), "unrelated");
  const stat = fs.lstatSync, read = fs.readFileSync;
  t.mock.method(fs, "lstatSync", (file, ...args) => {
    assert.ok(!String(file).startsWith(f.sourceRoot), "discovery must not inspect the original game");
    return stat(file, ...args);
  });
  t.mock.method(fs, "readFileSync", (file, ...args) => {
    assert.ok(!String(file).startsWith(f.directory + path.sep), "descriptor discovery must not read game or private file bytes");
    return read(file, ...args);
  });
  t.mock.method(fs, "readdirSync", () => {throw Error("discovery must use bounded iteration");});
  const descriptors = Fna.legacyGameMirrors(f.entry, f);
  assert.deepEqual(descriptors.map(item => item.mirrorRoot).sort(), [path.join(f.root, "writable-input", "files"), overlay, previous].sort());
  for (const item of descriptors) {
    assert.equal(item.sourceRoot, f.sourceRoot);
    if (item.mirrorRoot !== path.join(f.root, "writable-input", "files"))
      assert.deepEqual(item.generated, [".maclauncher-fna.json", ".maclauncher-fna-baseline.json", ".maclauncher-fna-carried-forward.json"]);
    assert.ok(!(item.generated || []).some(name => privateFiles.slice(0, 4).includes(name)));
  }
  t.mock.restoreAll();
  for (const name of privateFiles) assert.equal(fs.readFileSync(path.join(previous, name), "utf8"), "private " + name);
  for (const name of current) assert.ok(fs.statSync(path.join(f.root, name)).isDirectory());
});

test("FNA maps an old shared assembly path lexically and forces its own module directory", t => {
  const f = fixture(t), viewRoot = path.join(f.root, "writable-input", "files");
  const overlay = path.join(f.root, "overlays", "runtime");fs.mkdirSync(overlay, {recursive: true});
  f.entry.moduleId = "some-other-module";
  f.entry.moduleData = {assemblyPath: path.join(viewRoot, "bin", "Game.dll"),
    writableInput: {schemaVersion: 1, root: viewRoot, sourceRoot: f.sourceRoot}};
  assert.deepEqual(Fna.legacyGameMirrors(f.entry, f), [
    {mirrorRoot: viewRoot, sourceRoot: f.sourceRoot},
    {mirrorRoot: overlay, sourceRoot: path.join(f.sourceRoot, "bin"),
      generated: [".maclauncher-fna.json", ".maclauncher-fna-baseline.json", ".maclauncher-fna-carried-forward.json"]}
  ]);
  assert.deepEqual(fs.readdirSync(f.root), ["overlays"]);
  assert.equal(fs.existsSync(f.sourceRoot), false);
});

test("FNA uses the original assembly directory rather than a file or unrelated content root", t => {
  const f = fixture(t);
  f.entry.moduleData = {assemblyPath: path.join(f.sourceRoot, "bin", "Game.dll")};
  f.entry.contentRootDir = path.join(f.directory, "unrelated");
  assert.equal(Fna.legacyGameMirrors(f.entry, f)[0].sourceRoot, path.join(f.sourceRoot, "bin"));
  delete f.entry.moduleData;
  assert.equal(Fna.legacyGameMirrors(f.entry, f)[0].sourceRoot, f.sourceRoot);
  assert.equal(fs.existsSync(f.userDataDir), false);
});

test("FNA rejects overlay aliases and module-parent aliases without following them", t => {
  const f = fixture(t), external = path.join(f.directory, "external");fs.mkdirSync(external);
  fs.mkdirSync(path.join(f.root, "overlays"), {recursive: true});
  fs.symlinkSync(external, path.join(f.root, "overlays", "alias"), "dir");
  assert.throws(() => Fna.legacyGameMirrors(f.entry, f), /FNA game is a symbolic link, so it was left in place/);
  fs.unlinkSync(path.join(f.root, "overlays", "alias"));
  fs.rmdirSync(path.join(f.root, "overlays"));
  fs.symlinkSync(external, path.join(f.root, "overlays"), "dir");
  assert.throws(() => Fna.legacyGameMirrors(f.entry, f), /aliases/);
  assert.deepEqual(fs.readdirSync(external), []);
});

test("FNA rejects oversized discovery and closes its bounded iterator", t => {
  const f = fixture(t), overlay = path.join(f.root, "overlays", "one");fs.mkdirSync(overlay, {recursive: true});
  let reads = 0, closes = 0;
  t.mock.method(fs, "opendirSync", file => {
    assert.equal(file, path.dirname(overlay));
    return {readSync() {reads++;return {name: "one"};}, closeSync() {closes++;}};
  });
  assert.throws(() => Fna.legacyGameMirrors(f.entry, f), /FNA game hold too many entries to recover automatically, so they were left in place/);
  assert.equal(reads, 1025);assert.equal(closes, 1);
  assert.ok(fs.statSync(overlay).isDirectory());
});

test("FNA rejects unsafe game identities and unresolved private source paths without creating data", t => {
  const f = fixture(t);
  assert.throws(() => Fna.legacyGameMirrors({...f.entry, gameId: "../escape"}, f), /location of this FNA game is unknown.*left in place/);
  assert.throws(() => Fna.legacyGameMirrors({...f.entry, gamePath: "relative.exe"}, f), /location of this FNA game is unknown.*left in place/);
  assert.throws(() => Fna.legacyGameMirrors({...f.entry, gamePath: path.join(f.root, "overlays", "old", "Game.exe")}, f), /original folder of this FNA game is inside the MacLauncher data folder.*left in place/);
  assert.equal(fs.existsSync(f.userDataDir), false);
});

test("FNA backcompat descriptors are absent from the normal Play module", () => {
  const main = require("../src/modules/fna/main");
  assert.equal(Object.hasOwn(main, "legacyGameMirrors"), false);
  assert.equal(typeof Fna.legacyGameMirrors, "function");
  const source = fs.readFileSync(require.resolve("../src/modules/fna/main"), "utf8");
  assert.doesNotMatch(source, /require\(["'][^"']*backcompat[^"']*["']\)/);
  assert.doesNotMatch(source, /\blegacyGameMirrors\b/);
});

for (const [layout, name] of [["overlays", "released-runtime.converted.arm64-il"], ["previous-overlays", "released-runtime-1700000000000"]]) {
  test("released FNA " + layout + " restores missing Save/config bytes and preserves original conflicts", async t => {
    const f = fixture(t), directory = fs.realpathSync(f.directory);
    const userDataDir = path.join(directory, "profile"), sourceRoot = path.join(directory, "Original", "bin");
    const mirrorRoot = path.join(userDataDir, "games", "saved-game", "modules", "fna", layout, name);
    fs.mkdirSync(sourceRoot, {recursive: true});fs.mkdirSync(path.join(mirrorRoot, "Save"), {recursive: true});
    const originalConfig = path.join(sourceRoot, "settings.ini");fs.writeFileSync(originalConfig, "original current config");
    const privateFiles = {"Save/slot.sav": "released saved progress", "Game.exe.config": "released missing config",
      "settings.ini": "released differing config", "MacLauncherFnaHost.dll": "retained released host bytes"};
    for (const [name, bytes] of Object.entries(privateFiles)) fs.writeFileSync(path.join(mirrorRoot, name), bytes);
    fs.writeFileSync(path.join(mirrorRoot, ".maclauncher-fna.json"), JSON.stringify({schemaVersion: 2, source: sourceRoot}));
    const descriptors = Fna.legacyGameMirrors({gameId: "saved-game", gamePath: path.join(sourceRoot, "Game.exe")}, {userDataDir});
    const descriptor = descriptors.find(item => item.mirrorRoot === mirrorRoot);
    assert.ok(descriptor);assert.equal(descriptor.sourceRoot, sourceRoot);
    const {retireLegacyGameMirror} = require("../src/core/backcompat/legacy-game-mirrors");
    const result = await retireLegacyGameMirror(descriptor, {userDataDir});assert.equal(result.complete, true, result.reason);
    assert.equal(fs.readFileSync(path.join(sourceRoot, "Save", "slot.sav"), "utf8"), privateFiles["Save/slot.sav"]);
    assert.equal(fs.readFileSync(path.join(sourceRoot, "Game.exe.config"), "utf8"), privateFiles["Game.exe.config"]);
    assert.equal(fs.readFileSync(path.join(sourceRoot, "MacLauncherFnaHost.dll"), "utf8"), privateFiles["MacLauncherFnaHost.dll"]);
    assert.equal(fs.readFileSync(originalConfig, "utf8"), "original current config");
    const conflicts = fs.readdirSync(sourceRoot).filter(name => name.startsWith("settings.ini.MacLauncher-conflict-"));
    assert.equal(conflicts.length, 1);assert.equal(fs.readFileSync(path.join(sourceRoot, conflicts[0]), "utf8"), privateFiles["settings.ini"]);
    assert.equal(fs.existsSync(path.join(sourceRoot, ".maclauncher-fna.json")), false);
    assert.equal(fs.existsSync(mirrorRoot), false);
    fs.rmSync(userDataDir, {recursive: true});
    assert.equal(fs.readFileSync(path.join(sourceRoot, "Save", "slot.sav"), "utf8"), "released saved progress");
    assert.equal(fs.readFileSync(path.join(sourceRoot, conflicts[0]), "utf8"), "released differing config");
  });
}
