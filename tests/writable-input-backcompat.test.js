// Released writable-input schema 1 conversion runs only in the one-time migration.
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const Backcompat = require("../src/modules/shared/backcompat/writable-input");
test("legacy input records restore original content and save paths lexically without touching disk", t => {
  const sourceRoot = path.join(os.tmpdir(), "original-project"), root = path.join(os.tmpdir(), "retired-profile", "writable-input", "files");
  const external = path.join(os.tmpdir(), "chosen-saves");
  const entry = {gameId: "legacy", moduleId: "mv", gamePath: sourceRoot, importPath: sourceRoot,
    contentRootDir: root, indexDir: path.join(root, "www"), indexHtml: path.join(root, "www/index.html"),
    defaultSaveDir: path.join(root, "www/save"), saveDirOverride: external,
    saveLocations: [{directory: path.join(root, "www/save"), label: "Portable"}],
    moduleData: {writableInput: {schemaVersion: 1, root, sourceRoot, ready: true}}};
  const migrationModules = ["mv", "mz", "rgss"].map(id => ({id, ...require(`../src/modules/${id}/backcompat`)}));
  const userDataDir = path.join(os.tmpdir(), "retired-profile");
  const mocks = ["lstatSync", "statSync", "readFileSync", "realpathSync", "existsSync", "mkdirSync", "readdirSync", "writeFileSync"]
    .map(name => t.mock.method(fs, name, () => assert.fail(`Legacy path normalization must not call fs.${name}`)));
  try {
    const input = Backcompat.sourceEntry(entry);
    assert.equal(input.gameId, entry.gameId); assert.equal(input.gamePath, sourceRoot); assert.equal(input.importPath, sourceRoot);
    assert.equal(input.contentRootDir, sourceRoot); assert.equal(input.indexDir, path.join(sourceRoot, "www"));
    assert.equal(input.indexHtml, path.join(sourceRoot, "www/index.html"));
    assert.equal(input.defaultSaveDir, path.join(sourceRoot, "www/save"));
    assert.equal(input.saveLocations[0].directory, path.join(sourceRoot, "www/save"));
    assert.equal(input.saveDirOverride, external);
    assert.equal(entry.contentRootDir, root);
    assert.equal(Backcompat.sourceEntry(input), input);
    for (const module of migrationModules) {
      const descriptions = module.legacyGameMirrors({...entry, moduleId: module.id}, {userDataDir});
      assert.equal(descriptions.length, 1);
      assert.equal(descriptions[0].sourceRoot, sourceRoot);
      assert.equal(descriptions[0].mirrorRoot, path.join(userDataDir, "games", entry.gameId, "modules", module.id, "writable-input", "files"));
    }
  } finally { for (const mock of mocks) mock.mock.restore(); }
});

for (const moduleId of ["rgss", "mv", "mz"]) test(`schema1 ${moduleId} portable saves recover to current paths with conflicts preserved`, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "writable-backcompat-")));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const userDataDir = path.join(root, "profile"), gameId = "released-" + moduleId;
  const sourceRoot = path.join(userDataDir, "games", gameId, "containers", "inno", "extraction", "files");
  const mirrorRoot = path.join(userDataDir, "games", gameId, "modules", moduleId, "writable-input", "files");
  const relativeSave = moduleId === "rgss" ? "" : "www/save";
  const extension = moduleId === "rgss" ? "rvdata2" : moduleId === "mv" ? "rpgsave" : "rmmzsave";
  const saveName = "slot1." + extension, uniqueName = "slot2." + extension;
  const write = (base, relative, bytes) => {const file = path.join(base, relative); fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, bytes); return file;};
  const originalInstaller = write(root, "original-installer.exe", "unchanged installer");
  write(sourceRoot, path.join(relativeSave, saveName), "original conflict");
  write(mirrorRoot, path.join(relativeSave, saveName), "private conflict");
  write(mirrorRoot, path.join(relativeSave, uniqueName), "private only save");
  write(sourceRoot, "asset.dat", "original asset"); fs.symlinkSync(path.join(sourceRoot, "asset.dat"), path.join(mirrorRoot, "asset.dat"));
  const entry = {gameId, moduleId, gamePath: sourceRoot, importPath: originalInstaller, contentRootDir: mirrorRoot,
    defaultSaveDir: path.join(mirrorRoot, relativeSave), saveLocations: [{directory: path.join(mirrorRoot, relativeSave)}],
    ...(moduleId === "rgss" ? {} : {indexDir: path.join(mirrorRoot, "www"), indexHtml: path.join(mirrorRoot, "www/index.html")}),
    moduleData: {writableInput: {schemaVersion: 1, root: mirrorRoot, sourceRoot, ready: true}}};
  const hook = require(`../src/modules/${moduleId}/backcompat`).legacyGameMirrors;
  const {retireLegacyGameMirror} = require("../src/core/backcompat/legacy-game-mirrors");
  const descriptions = hook(entry, {userDataDir}); assert.equal(descriptions.length, 1);
  const result = await retireLegacyGameMirror(descriptions[0], {userDataDir});
  assert.equal(result.complete, true, result.reason); assert.equal(fs.existsSync(mirrorRoot), false);
  const current = Backcompat.sourceEntry(entry), expectedSave = path.join(sourceRoot, relativeSave);
  assert.equal(current.defaultSaveDir, expectedSave); assert.equal(current.saveLocations[0].directory, expectedSave);
  assert.equal(current.contentRootDir, sourceRoot); assert.equal(current.gameId, gameId);
  assert.equal(fs.readFileSync(path.join(expectedSave, uniqueName), "utf8"), "private only save");
  assert.equal(fs.lstatSync(path.join(expectedSave, uniqueName)).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(path.join(expectedSave, saveName), "utf8"), "original conflict");
  const conflict = fs.readdirSync(expectedSave).find(name => name.startsWith(saveName + ".MacLauncher-conflict-"));
  assert.ok(conflict); assert.equal(fs.readFileSync(path.join(expectedSave, conflict), "utf8"), "private conflict");
  assert.equal(fs.readFileSync(originalInstaller, "utf8"), "unchanged installer");
  // The saved current record, rather than a recurring old-layout reader,
  // supplies paths to subsequent ordinary Play preparation.
  const saved = JSON.parse(JSON.stringify(current));
  const prepare = moduleId === "rgss" ? require("../src/modules/rgss/writable-input").prepareInput
    : require("../src/modules/shared/mvmz/writable-input").prepareInput;
  assert.equal(prepare(saved, {}), saved); assert.equal(saved.defaultSaveDir, expectedSave);
});
